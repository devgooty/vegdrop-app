'use strict';

/**
 * The demo seed must not run on a deployed host, and NODE_ENV is not allowed to
 * be the thing that decides it.
 *
 * This is not hypothetical. This project's own Railway deployment was serving
 * real traffic with NODE_ENV unset, so `config.isProduction` was false there and
 * `seedIfEmpty` created its demo accounts, markets, stalls — and, once the
 * Developer Console work landed, nine fabricated orders, a wallet ledger and a
 * VendorKyc marked `verified` — in the live database. The production log line
 * `[seed] created demo rider bank details.` is what gave it away.
 *
 * A test that only set NODE_ENV would have passed throughout. So these assert on
 * the platform markers, which the host injects and cannot forget.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { startTestServer, stopTestServer, resetDatabase } = require('./helpers');
const { seedIfEmpty } = require('../utils/seed');
const User = require('../models/User');
const Order = require('../models/Order');
const WalletTransaction = require('../models/WalletTransaction');
const VendorKyc = require('../models/VendorKyc');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

/**
 * The regression that broke removeDemoSeed.test.js: fabricated money landing in
 * whatever database seedIfEmpty happened to be pointed at. These rows now live
 * behind their own export, called only by the throwaway in-memory harness.
 */
test('seedIfEmpty fabricates no orders, ledger or KYC', async () => {
  await seedIfEmpty();

  assert.equal(await Order.countDocuments(), 0, 'the shared seeder must not invent orders');
  assert.equal(await WalletTransaction.countDocuments(), 0, 'an append-only ledger is not a fixture');
  assert.equal(
    await VendorKyc.countDocuments({ status: 'verified' }),
    0,
    'a verified KYC asserts a penny drop that never happened'
  );

  // It still does its real job.
  assert.ok(await User.countDocuments() > 0, 'demo accounts are still seeded locally');
});

/**
 * config/env.js is frozen at load and reads the markers once, so the guard can
 * only be observed from a fresh process — the same constraint devLogin.test.js
 * works around for its production check.
 */
test('a deploy marker disables the demo seed even when NODE_ENV is not production', () => {
  // dotenv writes a banner to stdout, so the payload is fenced rather than
  // being the whole of it.
  const probe = `
    const config = require('./server/config/env');
    process.stdout.write('<<' + JSON.stringify({
      isProduction: config.isProduction,
      isDeployed: config.isDeployed,
      marker: config.deployedMarker,
    }) + '>>');
  `;
  const parse = (result) => {
    const match = /<<(.*)>>/s.exec(result.stdout || '');
    assert.ok(match, `probe produced no payload: ${result.stdout} ${result.stderr}`);
    return JSON.parse(match[1]);
  };

  const run = (env) =>
    spawnSync(process.execPath, ['-e', probe], {
      cwd: path.join(__dirname, '..', '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'development',
        DEV_LOGIN: '',
        // Cleared so a marker inherited from the real shell cannot make the
        // control case below pass for the wrong reason.
        RAILWAY_ENVIRONMENT: '',
        RAILWAY_SERVICE_ID: '',
        VERCEL: '',
        RENDER: '',
        FLY_APP_NAME: '',
        DYNO: '',
        ...env,
      },
    });

  for (const marker of ['RAILWAY_ENVIRONMENT', 'RAILWAY_SERVICE_ID', 'VERCEL', 'RENDER', 'FLY_APP_NAME', 'DYNO']) {
    const out = parse(run({ [marker]: '1' }));
    assert.equal(out.isProduction, false, `${marker}: NODE_ENV still says development`);
    assert.equal(out.isDeployed, true, `${marker} must be recognised as a deployed host`);
    assert.equal(out.marker, marker);
  }

  // A developer machine carries none of them, and still gets its demo data.
  const local = parse(run({}));
  assert.equal(local.isDeployed, false);
  assert.equal(local.marker, null);
});
