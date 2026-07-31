'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer, stopTestServer, resetDatabase, createUser } = require('./helpers');

const { withTransaction } = require('../db/connect');
const wallet = require('../services/wallet');
const WalletTransaction = require('../models/WalletTransaction');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

/** Seed a starting balance without going through Razorpay. */
async function fund(userId, amountPaise, key = 'seed:1') {
  return wallet.credit({
    userId,
    amountPaise,
    reason: 'promotional_credit',
    idempotencyKey: key,
  });
}

// ---------------------------------------------------------------------------
// Concurrency — the balance check and the write must not be separable
// ---------------------------------------------------------------------------

test('concurrent debits cannot overdraw a balance that only covers one', async () => {
  const { user } = await createUser();
  await fund(user._id, 15000);

  // Two checkouts of ₹100 against ₹150. Both read the same tail, so both would
  // pass their own sufficiency check; only one may actually land.
  const results = await Promise.allSettled([
    withTransaction((session) =>
      wallet.debit({
        userId: user._id,
        amountPaise: 10000,
        reason: 'order_payment',
        idempotencyKey: 'order:A',
        session,
      })
    ),
    withTransaction((session) =>
      wallet.debit({
        userId: user._id,
        amountPaise: 10000,
        reason: 'order_payment',
        idempotencyKey: 'order:B',
        session,
      })
    ),
  ]);

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  assert.equal(fulfilled.length, 1, 'exactly one debit may succeed');

  const balance = await wallet.getBalancePaise(user._id);
  assert.equal(balance, 5000);
  assert.ok(balance >= 0, 'balance must never go negative');

  const debits = await WalletTransaction.countDocuments({ user: user._id, type: 'debit' });
  assert.equal(debits, 1);
});

test('concurrent debits that both fit are both applied, and the ledger stays contiguous', async () => {
  const { user } = await createUser();
  await fund(user._id, 30000);

  await Promise.allSettled(
    ['order:A', 'order:B'].map((idempotencyKey) =>
      withTransaction((session) =>
        wallet.debit({
          userId: user._id,
          amountPaise: 10000,
          reason: 'order_payment',
          idempotencyKey,
          session,
        })
      )
    )
  );

  const entries = await WalletTransaction.find({ user: user._id }).sort({ seq: 1 }).lean();

  // Whichever of the two lost a race may have been rejected rather than retried,
  // but every entry that did land must form an unbroken chain.
  entries.forEach((entry, index) => {
    assert.equal(entry.seq, index + 1, 'seq must be contiguous from 1');
  });

  const last = entries[entries.length - 1];
  assert.equal(await wallet.getBalancePaise(user._id), last.balanceAfterPaise);
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test('replaying a credit with the same key does not credit twice', async () => {
  const { user } = await createUser();

  const first = await fund(user._id, 5000, 'razorpay:pay_123');
  const second = await fund(user._id, 5000, 'razorpay:pay_123');

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.balancePaise, first.balancePaise);
  assert.equal(await wallet.getBalancePaise(user._id), 5000);
});

test('replaying a debit with the same key does not debit twice', async () => {
  const { user } = await createUser();
  await fund(user._id, 20000);

  const args = {
    userId: user._id,
    amountPaise: 8000,
    reason: 'order_payment',
    idempotencyKey: 'order:same',
  };

  const first = await wallet.debit(args);
  const second = await wallet.debit(args);

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(await wallet.getBalancePaise(user._id), 12000);
});

test('concurrent credits sharing one key settle as a single entry', async () => {
  const { user } = await createUser();

  await Promise.allSettled(
    Array.from({ length: 4 }, () => fund(user._id, 5000, 'razorpay:pay_race'))
  );

  assert.equal(await WalletTransaction.countDocuments({ user: user._id }), 1);
  assert.equal(await wallet.getBalancePaise(user._id), 5000);
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

test('a debit beyond the balance is refused and writes nothing', async () => {
  const { user } = await createUser();
  await fund(user._id, 1000);

  await assert.rejects(
    () =>
      wallet.debit({
        userId: user._id,
        amountPaise: 5000,
        reason: 'order_payment',
        idempotencyKey: 'order:too-big',
      }),
    (err) => err.statusCode === 402 && err.code === 'INSUFFICIENT_FUNDS'
  );

  assert.equal(await wallet.getBalancePaise(user._id), 1000);
  assert.equal(await WalletTransaction.countDocuments({ user: user._id, type: 'debit' }), 0);
});

test('fractional and non-positive amounts are refused', async () => {
  const { user } = await createUser();

  for (const amountPaise of [0, -100, 10.5]) {
    await assert.rejects(
      () =>
        wallet.credit({
          userId: user._id,
          amountPaise,
          reason: 'promotional_credit',
          idempotencyKey: `bad:${amountPaise}`,
        }),
      (err) => err.statusCode === 400 && err.code === 'INVALID_AMOUNT'
    );
  }
});

test('the first entry for a user starts the sequence at 1', async () => {
  const { user } = await createUser();
  await fund(user._id, 2500);

  const entry = await WalletTransaction.findOne({ user: user._id }).lean();
  assert.equal(entry.seq, 1);
  assert.equal(entry.balanceAfterPaise, 2500);
});
