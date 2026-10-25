'use strict';

/**
 * What the cooking assistant is allowed to say about a product.
 *
 * `productView` is the one shape a product reaches the chat in, and every
 * field on it can be read out to a customer — so the rules are about what is
 * honest to say, not about formatting. It is pure, so unlike the rest of the
 * agent suite these need no in-memory MongoDB.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { productView } = require('../services/agent/tools');

/** A catalog row as Mongo hands it over, with only the fields this reads. */
function row(overrides = {}) {
  return {
    _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    name: 'Desi Tomatoes (Tamatar)',
    weight: '1kg',
    pricePaise: 4000,
    stock: 40,
    rating: 0,
    reviews: 0,
    ...overrides,
  };
}

test('an unrated product is not a product rated zero', () => {
  // `rating` defaults to 0 on the model. A helper handed 0 tells a customer
  // the tomatoes are rated nought out of five, which is a claim nobody made.
  assert.equal(productView(row()).rating, null);
  assert.equal(productView(row({ rating: 0, reviews: 12 })).rating, null, 'no rating, despite reviews');
  assert.equal(productView(row({ rating: 4.5, reviews: 0 })).rating, null, 'a rating from nobody');
  assert.equal(productView(row({ rating: 4.5, reviews: 12 })).rating, 4.5);
});

test('the review count travels with the rating', () => {
  // 4.5 from two people is not 4.5 from two hundred, and a rating with no
  // count invites the customer to read it as the latter.
  assert.equal(productView(row({ rating: 4.5, reviews: 12 })).reviews, 12);
  assert.equal(productView(row()).reviews, 0);
});

test('stock is reported as a level, and sold out is never offerable', () => {
  assert.deepEqual(
    [0, 1, 3, 4, 40].map((stock) => productView(row({ stock })).stockLevel),
    ['out', 'low', 'low', 'ok', 'ok'],
    'the low-stock boundary moved'
  );
  assert.equal(productView(row({ stock: 0 })).inStock, false);
  assert.equal(productView(row({ stock: 1 })).inStock, true);
});

test('a missing or malformed stock reads as sold out, not as plenty', () => {
  // Failing the other way would have the helper offering something the shop
  // may not have, which is worse than declining something it does.
  assert.equal(productView(row({ stock: undefined })).stock, 0);
  assert.equal(productView(row({ stock: undefined })).inStock, false);
  assert.equal(productView(row({ stock: null })).inStock, false);
});

test('the price is carried in paise and in rupees, from the same number', () => {
  // Rupees exist only at the boundary; both must come off `pricePaise` so a
  // quote and a bill can never disagree.
  const view = productView(row({ pricePaise: 4050 }));
  assert.equal(view.pricePaise, 4050);
  assert.equal(view.price, 40.5);
  assert.equal(view.weight, '1kg', 'a price without its pack size is not a price here');
});

test('the id is a string, because it reaches the model as JSON', () => {
  assert.equal(typeof productView(row()).productId, 'string');
});
