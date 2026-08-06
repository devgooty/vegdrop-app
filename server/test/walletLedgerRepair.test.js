'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer, stopTestServer, resetDatabase, createUser } = require('./helpers');

const { migrateWalletLedgerSequence } = require('../db/migrations');
const WalletTransaction = require('../models/WalletTransaction');
const wallet = require('../services/wallet');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

/**
 * Two entries sharing a `seq` cannot be produced through wallet.credit/debit —
 * that is the whole point of the index this migration repairs. Reproducing the
 * historical bug means writing raw documents, which first requires the
 * partial unique index out of the way, exactly as it was genuinely absent in
 * production when this data was written.
 */
async function dropSeqIndex() {
  await WalletTransaction.collection.dropIndex('user_1_seq_1').catch(() => {});
}

async function rebuildSeqIndex() {
  return WalletTransaction.createIndexes();
}

let n = 0;
const uniq = () => `test:${Date.now().toString(36)}:${(n += 1)}`;

test('repairs a wallet ledger where a race left two entries at the same seq', async () => {
  const { user } = await createUser();
  await dropSeqIndex();

  const base = Date.now() - 60000;

  // Three genuine entries, chronological — then two more, both written against
  // the same stale tail (seq 4, balance computed from entry 3's ₹100), which is
  // exactly the shape the race produces: neither insert saw the other.
  await WalletTransaction.collection.insertMany([
    {
      user: user._id, type: 'credit', amountPaise: 10000, balanceAfterPaise: 10000,
      seq: 1, reason: 'promotional_credit', idempotencyKey: uniq(),
      createdAt: new Date(base), updatedAt: new Date(base),
    },
    {
      user: user._id, type: 'credit', amountPaise: 5000, balanceAfterPaise: 15000,
      seq: 2, reason: 'promotional_credit', idempotencyKey: uniq(),
      createdAt: new Date(base + 1000), updatedAt: new Date(base + 1000),
    },
    {
      user: user._id, type: 'debit', amountPaise: 5000, balanceAfterPaise: 10000,
      seq: 3, reason: 'order_payment', idempotencyKey: uniq(),
      createdAt: new Date(base + 2000), updatedAt: new Date(base + 2000),
    },
    // The race: both read balance=10000, seq=3 as the tail.
    {
      user: user._id, type: 'debit', amountPaise: 3000, balanceAfterPaise: 7000,
      seq: 4, reason: 'order_payment', idempotencyKey: uniq(),
      createdAt: new Date(base + 3000), updatedAt: new Date(base + 3000),
    },
    {
      user: user._id, type: 'credit', amountPaise: 2000, balanceAfterPaise: 12000,
      seq: 4, reason: 'promotional_credit', idempotencyKey: uniq(),
      createdAt: new Date(base + 4000), updatedAt: new Date(base + 4000),
    },
  ]);

  const result = await migrateWalletLedgerSequence();

  assert.equal(result.usersFixed, 1);
  /**
   * Only 1, not both racers: the chronologically-first of the pair (the ₹30
   * debit) read the correct tail before the race happened, so its stored seq
   * and balance already match what a true replay produces — nothing to touch.
   * Only the second (the ₹20 credit, which ignored the debit that landed
   * between it and what it actually read) is wrong.
   */
  assert.equal(result.entriesFixed, 1, 'only the entry whose seq or balance was actually wrong should be touched');
  assert.deepEqual(result.overdraftsFound, [], 'this fixture never goes negative');

  const repaired = await WalletTransaction.collection
    .find({ user: user._id })
    .sort({ seq: 1 })
    .toArray();

  assert.deepEqual(repaired.map((e) => e.seq), [1, 2, 3, 4, 5], 'seq is now unique and gapless');

  // Chronological order is preserved (createdAt), and each balance is the true
  // running sum: 10000 -> 15000 -> 10000 -> [debit 3000] 7000 -> [credit 2000] 9000.
  assert.deepEqual(
    repaired.map((e) => e.balanceAfterPaise),
    [10000, 15000, 10000, 7000, 9000]
  );

  // The index that could never build before now can.
  await assert.doesNotReject(rebuildSeqIndex());

  // And the derived balance the wallet actually reports matches the recomputed tail.
  assert.equal(await wallet.getBalancePaise(user._id), 9000);
});

test('is idempotent: a second run against already-repaired data finds nothing to fix', async () => {
  const { user } = await createUser();
  await dropSeqIndex();

  const base = Date.now() - 10000;
  await WalletTransaction.collection.insertMany([
    {
      user: user._id, type: 'credit', amountPaise: 5000, balanceAfterPaise: 5000,
      seq: 1, reason: 'promotional_credit', idempotencyKey: uniq(),
      createdAt: new Date(base), updatedAt: new Date(base),
    },
    {
      user: user._id, type: 'credit', amountPaise: 5000, balanceAfterPaise: 8000,
      seq: 1, reason: 'promotional_credit', idempotencyKey: uniq(),
      createdAt: new Date(base + 1000), updatedAt: new Date(base + 1000),
    },
  ]);

  const first = await migrateWalletLedgerSequence();
  assert.equal(first.entriesFixed, 1);

  const second = await migrateWalletLedgerSequence();
  assert.deepEqual(second, { usersFixed: 0, entriesFixed: 0, overdraftsFound: [] });

  await rebuildSeqIndex();
});

test('a chronological replay that goes negative is reported, not silently clamped', async () => {
  const { user } = await createUser();
  await dropSeqIndex();

  const base = Date.now() - 10000;
  await WalletTransaction.collection.insertMany([
    {
      user: user._id, type: 'credit', amountPaise: 5000, balanceAfterPaise: 5000,
      seq: 1, reason: 'promotional_credit', idempotencyKey: uniq(),
      createdAt: new Date(base), updatedAt: new Date(base),
    },
    // Two racing debits, both against the ₹50 tail — chronologically the
    // second could never have been afforded.
    {
      user: user._id, type: 'debit', amountPaise: 4000, balanceAfterPaise: 1000,
      seq: 2, reason: 'order_payment', idempotencyKey: uniq(),
      createdAt: new Date(base + 1000), updatedAt: new Date(base + 1000),
    },
    {
      user: user._id, type: 'debit', amountPaise: 4000, balanceAfterPaise: 1000,
      seq: 2, reason: 'order_payment', idempotencyKey: uniq(),
      createdAt: new Date(base + 2000), updatedAt: new Date(base + 2000),
    },
  ]);

  const result = await migrateWalletLedgerSequence();

  assert.equal(result.overdraftsFound.length, 1);
  assert.equal(result.overdraftsFound[0].balancePaise, -3000, 'the true chronological balance is reported as-is');

  const repaired = await WalletTransaction.collection
    .find({ user: user._id })
    .sort({ seq: 1 })
    .toArray();
  assert.deepEqual(repaired.map((e) => e.balanceAfterPaise), [5000, 1000, -3000]);

  await rebuildSeqIndex();
});
