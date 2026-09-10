'use strict';

/**
 * The health endpoint's job is narrow: answer without the database, and say
 * enough that a deploy can be confirmed from outside.
 *
 * The revision and uptime exist because "did my push actually go out?" had no
 * answer here — the Railway MCP token cannot see this service's deployments,
 * and neither can anyone without dashboard access. A SHA on a public,
 * unauthenticated route is the cheapest way to make that checkable.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer, stopTestServer, api } = require('./helpers');
const config = require('../config/env');

test.before(startTestServer);
test.after(stopTestServer);

test('health reports the running revision and uptime', async () => {
  const res = await api().get('/api/health');

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.database, 'connected');

  /**
   * A short SHA or null — never a full one, and never a branch name or tag.
   * Asserted as a shape rather than a value because it legitimately differs
   * between a checkout (read from .git) and CI (injected, or absent entirely).
   */
  if (res.body.revision !== null) {
    assert.match(res.body.revision, /^[0-9a-f]{7,12}$/, 'revision must be a short SHA');
  }
  assert.equal(res.body.revision, config.revision, 'must report what config resolved');

  assert.equal(typeof res.body.uptimeSeconds, 'number');
  assert.ok(res.body.uptimeSeconds >= 0, 'uptime cannot run backwards');
});

/**
 * The endpoint is mounted above the database gate and must not be moved below
 * it. A health check that needs the database cannot report the database being
 * down — it just times out, and the platform learns nothing.
 */
test('health does not require authentication', async () => {
  const res = await api().get('/api/health');
  assert.notEqual(res.status, 401);
});

/**
 * It carries no identity, so it must not leak one either. Anything scoped to a
 * user belongs behind auth; this route is readable by the whole internet.
 */
test('health exposes nothing identity-scoped', async () => {
  const res = await api().get('/api/health');
  const keys = Object.keys(res.body).sort();
  assert.deepEqual(keys, ['database', 'revision', 'status', 'timestamp', 'uptimeSeconds']);
});
