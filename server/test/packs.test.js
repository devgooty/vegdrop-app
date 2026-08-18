'use strict';

/**
 * The rule that keeps the shown price and the charged price the same number.
 *
 * This tests a file under `src/`, which no other test here does, and it lives
 * in this directory because this is the only runner the project has. It belongs
 * with the server tests on merit as well as convenience: `packOptions` exists
 * to satisfy a SERVER contract. Checkout posts `{ productId, quantity }` and
 * the server recomputes every line from the catalog — so the only prices a
 * client may display are whole multiples of the pack price, and the only
 * quantities it may offer are whole numbers of packs. A change here is a
 * billing change.
 *
 * The bug it locks out: cards priced 250g/500g/750g/1kg by dividing the pack
 * price into a per-kilo rate, sent none of that to the server, and were billed
 * for one pack. A 250g pack of spinach shown as "1kg — ₹140" was charged ₹35.
 *
 * Imported dynamically because `src/` is ESM and this directory is CommonJS.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

let packs;
test.before(async () => {
  packs = await import('../../src/services/packs.mjs');
});

test('a bare weight is a pack that can be sold in multiples', () => {
  const { packGrams } = packs;
  assert.equal(packGrams('250g'), 250);
  assert.equal(packGrams('500g'), 500);
  assert.equal(packGrams('200g'), 200);
  assert.equal(packGrams('1kg'), 1000);
  assert.equal(packGrams('1.5kg'), 1500);
  assert.equal(packGrams(' 100 g '), 100);
});

test('a count with an approximate weight is sold by the piece, not the kilo', () => {
  const { packGrams } = packs;
  // Every one of these passed the old `weight.includes('g')` test, which is how
  // a single cauliflower came to be sold by the quarter-kilo.
  assert.equal(packGrams('1 pc (approx 600g)'), null);
  assert.equal(packGrams('1 bunch (approx 100g)'), null);
  assert.equal(packGrams('3 pcs (approx 500g)'), null);
  assert.equal(packGrams('2 pcs (approx 350g)'), null);
  assert.equal(packGrams('1 pc (approx 1kg)'), null);
  assert.equal(packGrams(''), null);
  assert.equal(packGrams(undefined), null);
});

test('sizes are whole multiples of the pack, labelled by total weight', () => {
  const options = packs.packOptions({ weight: '250g', price: 35 });

  assert.deepEqual(
    options.map((o) => [o.label, o.units, o.price]),
    [
      ['250g', 1, 35],
      ['500g', 2, 70],
      ['750g', 3, 105],
      ['1kg', 4, 140],
    ]
  );
});

test('a 1kg pack offers whole packs, never a quarter of one', () => {
  const options = packs.packOptions({ weight: '1kg', price: 35 });

  // The old picker offered 250g of this at ₹9 and the server charged ₹35.
  // A quarter pack is not something a stall can hand over, so it is not offered.
  assert.deepEqual(
    options.map((o) => o.label),
    ['1kg', '2kg', '3kg', '4kg']
  );
  assert.deepEqual(
    options.map((o) => o.price),
    [35, 70, 105, 140]
  );
});

test('a product sold by the piece gets no weight picker at all', () => {
  assert.deepEqual(packs.packOptions({ weight: '1 pc (approx 600g)', price: 35 }), []);
  assert.deepEqual(packs.packOptions({ weight: '1 bunch (approx 100g)', price: 12 }), []);
});

test('every offered price is exactly what the server will recompute', () => {
  /**
   * The whole contract in one assertion.
   *
   * The server prices an order line as `pricePaise × quantity`. The client
   * posts `quantity = units`. So for the two to agree, the displayed price must
   * be `price × units` with no rounding anywhere — which is why `packOptions`
   * multiplies the pack price rather than dividing it into a per-kilo rate and
   * multiplying back. `Math.round(35 / 0.25 * 0.75)` is 105, but
   * `Math.round(12 / 0.1 * 0.25)` is 30 against a true 3.
   */
  for (const weight of ['100g', '200g', '250g', '500g', '1kg']) {
    for (const price of [3, 35, 47, 199, 1234]) {
      for (const option of packs.packOptions({ weight, price })) {
        assert.equal(
          option.price,
          price * option.units,
          `${weight} @ ${price} × ${option.units} must be billable as ${option.units} packs`
        );
        assert.ok(Number.isInteger(option.units) && option.units >= 1);
      }
    }
  }
});

test('an old basket line with no units counts as one pack', () => {
  const { unitsOf } = packs;
  // Baskets persist across deploys. A line saved before `units` existed holds a
  // per-kilo price we cannot undo, but reading it as one pack is what the
  // server was already doing — so the fix changes nothing for it rather than
  // inventing a multiplier from a price we know to be wrong.
  assert.equal(unitsOf({}), 1);
  assert.equal(unitsOf({ units: undefined }), 1);
  assert.equal(unitsOf({ units: 0 }), 1);
  assert.equal(unitsOf({ units: -2 }), 1);
  assert.equal(unitsOf({ units: 1.5 }), 1);
  assert.equal(unitsOf({ units: 4 }), 4);
});

test('two sizes of one product are two basket rows', () => {
  const { packLineId } = packs;
  // Folding them together is what made a shopper who picked 1kg after 250g end
  // up with two 250g packs and no warning.
  assert.notEqual(packLineId('abc', 1), packLineId('abc', 4));
  assert.equal(packLineId('abc', 1), 'abc');
  assert.equal(packLineId('abc', 4), 'abc-x4');
});
