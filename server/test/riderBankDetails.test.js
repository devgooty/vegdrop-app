'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer, stopTestServer, resetDatabase, api, authenticatedUser, auth } = require('./helpers');

const RiderBankDetails = require('../models/RiderBankDetails');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

const VALID_DETAILS = {
  legalName: 'Ramesh Kumar',
  bankName: 'HDFC Bank',
  bankAccount: '123456789012',
  ifsc: 'HDFC0001234',
};

test('a rider with nothing on file gets null, not a 404', async () => {
  const { accessToken } = await authenticatedUser('delivery');

  const res = await api().get('/api/rider/bank-details').set(auth(accessToken));

  assert.equal(res.status, 200);
  assert.equal(res.body.data, null);
});

test('a rider can submit settlement details and read them back masked', async () => {
  const { accessToken } = await authenticatedUser('delivery');

  const submit = await api().put('/api/rider/bank-details').set(auth(accessToken)).send(VALID_DETAILS);

  assert.equal(submit.status, 200);
  assert.equal(submit.body.data.legalName, 'Ramesh Kumar');
  assert.equal(submit.body.data.bankName, 'HDFC Bank');
  assert.equal(submit.body.data.ifsc, 'HDFC0001234');
  assert.equal(submit.body.data.bankAccount, '••••9012');

  const status = await api().get('/api/rider/bank-details').set(auth(accessToken));
  assert.equal(status.body.data.bankAccount, '••••9012');
});

test('re-submitting replaces the previous details rather than adding a second record', async () => {
  const { accessToken, user } = await authenticatedUser('delivery');

  await api().put('/api/rider/bank-details').set(auth(accessToken)).send(VALID_DETAILS);
  const second = await api()
    .put('/api/rider/bank-details')
    .set(auth(accessToken))
    .send({ ...VALID_DETAILS, bankName: 'ICICI Bank', bankAccount: '999988887777' });

  assert.equal(second.status, 200);
  assert.equal(second.body.data.bankName, 'ICICI Bank');
  assert.equal(second.body.data.bankAccount, '••••7777');

  const count = await RiderBankDetails.countDocuments({ user: user.id });
  assert.equal(count, 1);
});

test('the bank account is encrypted at rest and never returned in full', async () => {
  const { accessToken } = await authenticatedUser('delivery');

  await api().put('/api/rider/bank-details').set(auth(accessToken)).send(VALID_DETAILS);

  const raw = await RiderBankDetails.findOne({}).select('+bankAccountEncrypted').lean();
  const serialized = JSON.stringify(raw);
  assert.ok(!serialized.includes(VALID_DETAILS.bankAccount), 'bank account found in plaintext');
  assert.ok(raw.bankAccountEncrypted.startsWith('v1.'));
  assert.equal(raw.bankAccountLast4, '9012');
});

test('malformed IFSC and account numbers are rejected', async () => {
  const { accessToken } = await authenticatedUser('delivery');

  const cases = [
    { ...VALID_DETAILS, ifsc: 'HDFC1001234' },
    { ...VALID_DETAILS, bankAccount: '12345' },
    { ...VALID_DETAILS, legalName: '' },
    { ...VALID_DETAILS, bankName: '' },
  ];

  for (const body of cases) {
    const res = await api().put('/api/rider/bank-details').set(auth(accessToken)).send(body);
    assert.equal(res.status, 400, `expected rejection for ${JSON.stringify(body)}`);
  }
});

test('a client cannot smuggle extra fields through the submit body', async () => {
  const { accessToken } = await authenticatedUser('delivery');

  const res = await api()
    .put('/api/rider/bank-details')
    .set(auth(accessToken))
    .send({ ...VALID_DETAILS, verifiedAt: new Date().toISOString() });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
});

test('one rider cannot see or overwrite another rider\'s details', async () => {
  const riderA = await authenticatedUser('delivery');
  const riderB = await authenticatedUser('delivery');

  await api().put('/api/rider/bank-details').set(auth(riderA.accessToken)).send(VALID_DETAILS);

  const bView = await api().get('/api/rider/bank-details').set(auth(riderB.accessToken));
  assert.equal(bView.body.data, null);

  await api()
    .put('/api/rider/bank-details')
    .set(auth(riderB.accessToken))
    .send({ ...VALID_DETAILS, bankName: 'Axis Bank', bankAccount: '111122223333' });

  const aView = await api().get('/api/rider/bank-details').set(auth(riderA.accessToken));
  assert.equal(aView.body.data.bankName, 'HDFC Bank');
});

test('a customer cannot reach the rider bank-details endpoints', async () => {
  const { accessToken } = await authenticatedUser('customer');

  const res = await api().get('/api/rider/bank-details').set(auth(accessToken));
  assert.equal(res.status, 403);
});
