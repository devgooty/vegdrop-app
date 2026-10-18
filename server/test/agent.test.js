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
const { getOrderStatusTool, searchCatalog, proposeOrderTool } = require('../services/agent/tools');

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
  assert.equal(byAlias[0].id, 'aloo-gobi');

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
  assert.ok(
    res.body.data.cards?.some((c) => c.type === 'recipe_match'),
    'expected dish suggestions for the vegetables'
  );
  assert.equal(await Order.countDocuments({}), 0, 'chat alone must not create orders');
});

test('propose then confirm places exactly one order', async () => {
  const customer = await authenticatedUser('customer');
  await seedTomatoPotato();

  // A named dish, then its vegetables. ("I have potato, tomato and onion"
  // would correctly leave all three out of the cart and have nothing to order.)
  const chat = await api()
    .post('/api/agent/chat')
    .set(auth(customer.accessToken))
    .send({
      messages: [{ role: 'user', content: 'How to make aloo tamatar ki sabzi' }],
    });
  assert.equal(chat.status, 200);
  assert.ok(chat.body.data.cards?.some((c) => c.type === 'recipe' && c.id === 'potato-tomato-curry'));

  const orderChat = await api()
    .post('/api/agent/chat')
    .set(auth(customer.accessToken))
    .send({
      messages: [
        { role: 'user', content: 'How to make aloo tamatar ki sabzi' },
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

/**
 * The assistant answers about YOUR order, and only yours.
 *
 * `get_order_status` filtered `{ _id: orderId, user: user._id }` — and Order
 * has no `user` path. With strictQuery on, an unknown path is dropped rather
 * than rejected, so the filter collapsed to `{ _id: orderId }` and the tool
 * reported any order in the database to any signed-in caller. The id comes from
 * a tool call the customer's own message steers, so nothing stopped someone
 * asking about a number that was not theirs.
 *
 * The tool is called directly rather than through `/agent/chat`: the route
 * needs a model to decide to call it, and the scoping is the thing under test.
 */
test('the catalog the helper reads is live, and carries stock level and rating', async () => {
  const tomato = await Product.create({
    sku: `TOM-LIVE-${Date.now()}`,
    categoryId: 2,
    name: 'Desi Tomatoes (Tamatar)',
    weight: '1kg',
    pricePaise: 4000,
    stock: 50,
    rating: 4.3,
    reviews: 18,
    owner: null,
  });

  const [first] = await searchCatalog({ query: 'tomato' });
  assert.equal(first.productId, String(tomato._id));
  assert.equal(first.pricePaise, 4000);
  assert.equal(first.inStock, true);
  assert.equal(first.stockLevel, 'ok');
  assert.equal(first.rating, 4.3);
  assert.equal(first.reviews, 18);

  // The price and the stock are read on the call, not cached from the last one:
  // a vendor quoting a rate that moved an hour ago is the failure this tool
  // exists to avoid.
  await Product.updateOne({ _id: tomato._id }, { $set: { pricePaise: 5500, stock: 2 } });
  const [again] = await searchCatalog({ query: 'tomato' });
  assert.equal(again.pricePaise, 5500);
  assert.equal(again.stockLevel, 'low');
  assert.equal(again.inStock, true);

  await Product.updateOne({ _id: tomato._id }, { $set: { stock: 0 } });
  const [sold] = await searchCatalog({ query: 'tomato' });
  assert.equal(sold.inStock, false);
  assert.equal(sold.stockLevel, 'out');
});

test('an unrated product is not reported as rated zero', async () => {
  // `rating` defaults to 0 on the model, and a helper handed 0 says the
  // tomatoes are rated nought out of five. Unrated has to be absent, not zero.
  await Product.create({
    sku: `TOM-NEW-${Date.now()}`,
    categoryId: 2,
    name: 'Desi Tomatoes (Tamatar)',
    weight: '1kg',
    pricePaise: 4000,
    stock: 10,
    owner: null,
  });
  const [row] = await searchCatalog({ query: 'tomato' });
  assert.equal(row.rating, null);
  assert.equal(row.reviews, 0);
});

test('a basket line carries the stock and rating it was priced against', async () => {
  const { tomato } = await seedTomatoPotato();
  await Product.updateOne({ _id: tomato._id }, { $set: { stock: 1, rating: 4.1, reviews: 7 } });
  const { user } = await authenticatedUser('customer');

  const preview = await proposeOrderTool(user, {
    items: [{ productId: String(tomato._id), quantity: 3 }],
  });
  const line = preview.lines.find((l) => l.productId === String(tomato._id));

  // The client adds to the cart from these numbers rather than from its own
  // catalog copy, which is served with a 30-second cache.
  assert.equal(line.stock, 1);
  assert.equal(line.rating, 4.1);
  assert.equal(line.reviews, 7);
  assert.equal(line.lowStock, true, 'three packs asked of a shop holding one');
});

test('the order-status tool refuses an order belonging to someone else', async () => {
  const mine = await authenticatedUser('customer');
  const theirs = await authenticatedUser('customer');

  const order = await Order.create({
    orderNumber: 'VBPRIVATE1',
    customer: theirs.user._id,
    customerName: theirs.user.name,
    phone: theirs.user.phone,
    address: '12 Someone Else Lane',
    items: [
      {
        product: theirs.user._id,
        name: 'Tomatoes',
        unitPricePaise: 4000,
        quantity: 1,
        lineTotalPaise: 4000,
      },
    ],
    subtotalPaise: 4000,
    totalAmountPaise: 4000,
    paymentMethod: 'cod',
    status: 'Pending',
  });

  const id = order._id.toHexString();

  // The owner can read it.
  const own = await getOrderStatusTool(theirs.user, { orderId: id });
  assert.equal(own.orderNumber, 'VBPRIVATE1');

  // Nobody else can. Before the fix this returned the same object.
  await assert.rejects(
    () => getOrderStatusTool(mine.user, { orderId: id }),
    (err) => err.statusCode === 404,
    'another customer must not be able to read this order'
  );
});

test('a shopkeeper cannot use the cooking assistant', async () => {
  const shop = await authenticatedUser('shopkeeper');
  const res = await api()
    .post('/api/agent/chat')
    .set(auth(shop.accessToken))
    .send({ messages: [{ role: 'user', content: 'potato tomato' }] });
  assert.equal(res.status, 403);
});
