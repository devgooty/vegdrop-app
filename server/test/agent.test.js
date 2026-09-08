'use strict';

/**
 * Cooking assistant — recipes, propose, confirm.
 *
 * Confirm is the only path that creates an Order. Propose must never invent one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startTestServer,
  stopTestServer,
  resetDatabase,
  api,
  auth,
  authenticatedUser,
} = require('./helpers');

const Product = require('../models/Product');
const Order = require('../models/Order');
const { listMatchingRecipes, extractVegetables } = require('../services/agent/recipes');

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

async function seedTomatoPotato() {
  const tomato = await Product.create({
    sku: `TOM-${Date.now()}`,
    categoryId: 2,
    name: 'Desi Tomatoes (Tamatar)',
    weight: '1kg',
    pricePaise: 4000,
    stock: 50,
    owner: null,
  });
  const potato = await Product.create({
    sku: `POT-${Date.now()}`,
    categoryId: 2,
    name: 'Fresh Potato',
    weight: '1kg',
    pricePaise: 3000,
    stock: 50,
    owner: null,
  });
  const onion = await Product.create({
    sku: `ONI-${Date.now()}`,
    categoryId: 2,
    name: 'Red Onion',
    weight: '1kg',
    pricePaise: 3500,
    stock: 50,
    owner: null,
  });
  return { tomato, potato, onion };
}

test('recipe matcher finds dishes from vegetable names', () => {
  const veg = extractVegetables('I have potato, tomato and onion');
  assert.ok(veg.includes('potato'));
  assert.ok(veg.includes('tomato'));
  assert.ok(veg.includes('onion'));

  const matches = listMatchingRecipes(veg);
  assert.ok(matches.length >= 1);
  assert.ok(matches.some((m) => /potato/i.test(m.name) || /tomato/i.test(m.name)));
});

test('recipe matcher finds dishes by dish name', () => {
  const { findRecipesByDishName } = require('../services/agent/recipes');
  const byAlias = findRecipesByDishName('aloo gobi');
  assert.ok(byAlias.length >= 1);
  assert.match(byAlias[0].name, /potato|cauliflower/i);

  const byTitle = findRecipesByDishName('cabbage fry');
  assert.equal(byTitle[0].id, 'cabbage-fry');
});

test('a customer can chat with a dish name without placing an order', async () => {
  const customer = await authenticatedUser('customer');

  const res = await api()
    .post('/api/agent/chat')
    .set(auth(customer.accessToken))
    .send({
      messages: [{ role: 'user', content: 'Make cabbage fry for 2 people' }],
    });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.data.reply, /cabbage/i);
  assert.ok(
    res.body.data.cards?.some((c) => c.type === 'recipe' || c.type === 'recipe_match'),
    'expected a recipe card'
  );
  assert.equal(await Order.countDocuments({}), 0);
});

test('a customer can chat for recipe matches without placing an order', async () => {
  const customer = await authenticatedUser('customer');
  await seedTomatoPotato();

  const res = await api()
    .post('/api/agent/chat')
    .set(auth(customer.accessToken))
    .send({
      messages: [{ role: 'user', content: 'I have potato, tomato and onion' }],
    });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.data.reply, /option|found|curry|dish/i);
  assert.equal(await Order.countDocuments({}), 0, 'chat alone must not create orders');
});

test('propose then confirm places exactly one order', async () => {
  const customer = await authenticatedUser('customer');
  await seedTomatoPotato();

  const chat = await api()
    .post('/api/agent/chat')
    .set(auth(customer.accessToken))
    .send({
      messages: [{ role: 'user', content: 'I have potato, tomato and onion' }],
    });
  assert.equal(chat.status, 200);

  const orderChat = await api()
    .post('/api/agent/chat')
    .set(auth(customer.accessToken))
    .send({
      messages: [
        { role: 'user', content: 'I have potato, tomato and onion' },
        { role: 'assistant', content: chat.body.data.reply },
        { role: 'user', content: 'order missing ingredients' },
      ],
      context: { address: 'Benz Circle, Vijayawada', paymentMethod: 'cod' },
    });

  assert.equal(orderChat.status, 200, JSON.stringify(orderChat.body));
  assert.ok(orderChat.body.data.proposedOrder?.proposalId, 'preview must include proposalId');
  assert.equal(await Order.countDocuments({}), 0, 'propose must not place');

  const confirm = await api()
    .post('/api/agent/confirm-order')
    .set(auth(customer.accessToken))
    .send({
      proposalId: orderChat.body.data.proposedOrder.proposalId,
      address: 'Benz Circle, Vijayawada',
    });

  assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
  assert.ok(confirm.body.data.orderNumber);
  assert.equal(await Order.countDocuments({}), 1);
});

test('a shopkeeper cannot use the cooking assistant', async () => {
  const shop = await authenticatedUser('shopkeeper');
  const res = await api()
    .post('/api/agent/chat')
    .set(auth(shop.accessToken))
    .send({ messages: [{ role: 'user', content: 'potato tomato' }] });
  assert.equal(res.status, 403);
});
