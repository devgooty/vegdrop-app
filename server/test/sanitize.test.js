'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const express = require('express');
const request = require('supertest');

const { sanitizeRequest } = require('../middleware/sanitize');

/**
 * A real Express app rather than the shared harness.
 *
 * The bug being guarded here is a property of Express itself: `req.query` is a
 * getter that re-parses the URL on every access and hands back a fresh object,
 * so deleting a key from what it returns edits a copy and the next read brings
 * the key back. Only a genuine Express request reproduces that — a hand-built
 * `req` with a plain object for `query` would pass against the broken
 * implementation. Nothing here touches the database, so no replica set is needed.
 */
function echoApp() {
  const app = express();
  app.use(express.json());
  app.use(sanitizeRequest);
  app.all('/echo', (req, res) => {
    res.json({ query: req.query, body: req.body });
  });
  return app;
}

// ---------------------------------------------------------------------------
// Query — the path that silently did nothing
// ---------------------------------------------------------------------------

test('an operator key in the query does not reach the route', async () => {
  const res = await request(echoApp()).get('/echo?$ne=1&page=2');

  assert.equal(res.status, 200);
  assert.equal(res.body.query.$ne, undefined, 'the operator key must not survive re-parsing');
  assert.equal(res.body.query.page, '2');
});

test('a repeated operator key, which parses to an array, is still stripped', async () => {
  const res = await request(echoApp()).get('/echo?$ne=1&$ne=2&page=3');

  assert.equal(res.body.query.$ne, undefined);
  assert.equal(res.body.query.page, '3');
});

test('bracket syntax does not nest under the default query parser', async () => {
  const res = await request(echoApp()).get('/echo?filter[$gt]=0');

  /**
   * Express 5 defaults `query parser` to `simple`, so values are only ever
   * strings or arrays of strings — `filter[$gt]` arrives as one flat key, not as
   * `{ filter: { $gt: '0' } }`. Recorded because it bounds the threat: a query
   * string cannot express a nested operator document at all unless someone
   * switches this app to the `extended` parser, at which point the recursive
   * scrub above starts carrying real weight.
   */
  assert.deepEqual(res.body.query, { 'filter[$gt]': '0' });
});

test('dotted query keys survive — Meta sends its handshake with them', async () => {
  const res = await request(echoApp()).get(
    '/echo?hub.mode=subscribe&hub.verify_token=secret&hub.challenge=12345'
  );

  assert.equal(res.body.query['hub.mode'], 'subscribe');
  assert.equal(res.body.query['hub.verify_token'], 'secret');
  assert.equal(res.body.query['hub.challenge'], '12345');
});

test('a clean query is passed through unchanged', async () => {
  const res = await request(echoApp()).get('/echo?limit=20&category=greens');

  assert.deepEqual(res.body.query, { limit: '20', category: 'greens' });
});

// ---------------------------------------------------------------------------
// Body and params — both hazards apply here
// ---------------------------------------------------------------------------

test('operator and dotted keys are stripped from the body', async () => {
  const res = await request(echoApp())
    .post('/echo')
    .send({ phone: '9876543210', $where: 'sleep(1)', 'user.role': 'developer' });

  assert.equal(res.body.body.$where, undefined);
  assert.equal(res.body.body['user.role'], undefined);
  assert.equal(res.body.body.phone, '9876543210');
});

test('operators nested in arrays within the body are stripped', async () => {
  const res = await request(echoApp())
    .post('/echo')
    .send({ items: [{ productId: 'abc', $ne: null }] });

  assert.equal(res.body.body.items[0].$ne, undefined);
  assert.equal(res.body.body.items[0].productId, 'abc');
});

test('a match-anything operator cannot be smuggled in as a nested body object', async () => {
  const res = await request(echoApp())
    .post('/echo')
    .send({ phone: { $ne: null } });

  // The classic auth-bypass shape: { phone: { $ne: null } } matches any record.
  assert.deepEqual(res.body.body.phone, {});
});
