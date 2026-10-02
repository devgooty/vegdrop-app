'use strict';

/**
 * How accurately the cooking assistant answers — without a model.
 *
 * Three layers, each of which has already been wrong in a way a 200 could not see:
 *
 * 1. The recipe book and produce vocabulary are data, and data drifts. Every
 *    recipe is checked for shape, for vegetables the catalog actually sells, and
 *    for names that belong to exactly one dish.
 * 2. The matcher's hard cases — the specific confusions it has made before
 *    ("butter" read as mutter/peas, "patta gobhi matar" as gobi matar, the
 *    Telugu name answered with the Hindi dish) — are pinned one by one.
 * 3. `fixtures/agentEvals*.json` are sets of real-phrased customer messages
 *    (English, Hinglish, Tenglish, Tamil-English) written and labelled WITHOUT
 *    sight of the matcher, so they measure the router rather than restating it.
 *    When adding phrasing support, add a fresh set rather than editing these. The thresholds below are the bar: most
 *    importantly, zero confident answers with the wrong dish, because a customer
 *    cannot tell a wrong recipe from a right one until dinner is ruined.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer, stopTestServer, resetDatabase, createUser } = require('./helpers');
const Product = require('../models/Product');

const recipes = require('../services/agent/recipes');
const tools = require('../services/agent/tools');
const { runLocalTurn, parseServings } = require('../services/agent/runTurn');
const Order = require('../models/Order');
// Each file was written by a separate author who had not seen the matcher.
const EVALS = [
  ...require('./fixtures/agentEvals.json').cases,
  ...require('./fixtures/agentEvalsNorth.json').cases,
];

test.before(startTestServer);
test.after(stopTestServer);
test.beforeEach(resetDatabase);

let userSeq = 0;
function freshUser() {
  userSeq += 1;
  return { _id: `accuracy-${userSeq}-${process.pid}` };
}

async function ask(text, user = freshUser()) {
  return runLocalTurn(user, [{ role: 'user', content: text }], {});
}

function recipeCard(res) {
  return (res.cards || []).find((c) => c.type === 'recipe') || null;
}

function matchIds(res) {
  return (res.cards || []).filter((c) => c.type === 'recipe_match').map((c) => c.id);
}

/* ------------------------------------------------------------ 1. the data */

test('every recipe has the fields, units and vegetables the assistant relies on', () => {
  const FIELDS = ['id', 'name', 'aliases', 'cuisine', 'type', 'vegan', 'difficulty', 'prepMinutes', 'cookMinutes', 'servesWith', 'ingredients', 'steps', 'tips'];
  const UNITS = new Set(['tsp', 'tbsp', 'cup', 'g', 'ml', 'pinch', 'sprig', 'pc', 'to taste']);
  const DAIRY = /\b(paneer|ghee|butter|curd|yogh?urt|cream|milk|cheese|dahi|malai)\b/i;
  const ids = new Set();

  assert.ok(recipes.RECIPES.length >= 80, `expected a full recipe book, got ${recipes.RECIPES.length}`);
  for (const r of recipes.RECIPES) {
    assert.ok(!ids.has(r.id), `duplicate id ${r.id}`);
    ids.add(r.id);
    for (const f of FIELDS) assert.ok(f in r, `${r.id} is missing ${f}`);
    assert.ok(r.steps.length >= 5 && r.steps.length <= 10, `${r.id} has ${r.steps.length} steps`);
    assert.ok(r.tips.length >= 1 && r.tips.length <= 3, `${r.id} has ${r.tips.length} tips`);
    // cookMinutes may be 0 — a raw chutney, raita or salad is never heated.
    const total = r.prepMinutes + r.cookMinutes;
    assert.ok(r.prepMinutes >= 0 && r.cookMinutes >= 0 && total > 0 && total <= 240, `${r.id} minutes ${r.prepMinutes}+${r.cookMinutes}`);

    let dairy = false;
    let mains = 0;
    for (const ing of r.ingredients) {
      if (ing.produce) {
        assert.ok(recipes.PRODUCE[ing.produce], `${r.id}: "${ing.produce}" is not a vegetable VegDrop sells`);
        assert.ok(ing.gramsPerServing > 0 && ing.gramsPerServing <= 400, `${r.id}: ${ing.item} ${ing.gramsPerServing} g per serving`);
        assert.ok(['main', 'aromatic', 'garnish'].includes(ing.role), `${r.id}: ${ing.item} role ${ing.role}`);
        if (ing.role === 'main') mains += 1;
      } else {
        assert.equal(ing.pantry, true, `${r.id}: ${ing.item} is neither produce nor pantry`);
        assert.ok(UNITS.has(ing.unit), `${r.id}: ${ing.item} unit ${ing.unit}`);
        if (ing.unit !== 'to taste') assert.ok(ing.qtyPerServing > 0, `${r.id}: ${ing.item} has no quantity`);
        if (DAIRY.test(ing.item) && !/coconut milk|peanut butter/i.test(ing.item) && !ing.optional) dairy = true;
      }
    }
    assert.ok(r.ingredients.some((i) => i.produce), `${r.id} orders nothing`);
    if (r.type !== 'dal') assert.ok(mains >= 1, `${r.id} has no main vegetable`);
    if (r.vegan) assert.ok(!dairy, `${r.id} is marked vegan but uses dairy`);
  }
});

test('a dish name or alias belongs to exactly one dish, and is never a bare vegetable', () => {
  const owner = new Map();
  const vegNames = new Set(Object.values(recipes.PRODUCE).flatMap((p) => p.aliases.map(recipes.normalize)));
  for (const r of recipes.RECIPES) {
    for (const alias of [r.name, ...r.aliases]) {
      const n = recipes.normalize(alias);
      assert.ok(!vegNames.has(n), `${r.id}: "${n}" is just a vegetable name`);
      assert.ok(!owner.has(n) || owner.get(n) === r.id, `"${n}" names both ${owner.get(n)} and ${r.id}`);
      owner.set(n, r.id);
    }
  }
});

test('each produce entry points at a real catalog SKU and its local names do not collide', () => {
  const seed = require('fs').readFileSync(require.resolve('../utils/seed'), 'utf8');
  const aliasOwner = new Map();
  for (const [key, spec] of Object.entries(recipes.PRODUCE)) {
    assert.ok(seed.includes(`'${spec.sku}'`), `${key}: SKU ${spec.sku} is not in the seed catalog`);
    for (const alias of spec.aliases) {
      const n = recipes.normalize(alias);
      assert.ok(!aliasOwner.has(n) || aliasOwner.get(n) === key, `"${n}" means both ${aliasOwner.get(n)} and ${key}`);
      aliasOwner.set(n, key);
    }
  }
});

/* --------------------------------------------------------- 2. hard cases */

test('vegetable names resolve to the right vegetable, including the look-alikes', () => {
  const cases = [
    ['bhindi', ['okra']],
    ['bendakaya', ['okra']],
    ['vankaya', ['brinjal']],
    ['aloo', ['potato']],
    ['sweet potato', ['sweet potato']],
    ['spring onion', ['spring onion']],
    ['patta gobi', ['cabbage']],
    ['phool gobi', ['cauliflower']],
    ['gobi', ['cauliflower']],
    ['kakarakaya and ullipaya', ['bitter gourd', 'onion']],
    ['tomatos', ['tomato']],
    ['plak', ['spinach']],
    ['paneer and butter', []],
  ];
  for (const [text, want] of cases) {
    assert.deepEqual(recipes.extractVegetables(text).sort(), [...want].sort(), text);
  }
});

test('named dishes resolve to the dish that was named, not a near miss', async () => {
  const cases = [
    ['how to make aloo gobi', 'aloo-gobi'],
    ['paneer butter masala', 'paneer-butter-masala'],
    ['palak paneer', 'palak-paneer'],
    ['dal tadka', 'dal-tadka'],
    ['gutti vankaya', 'gutti-vankaya-kura'],
    ['bendakaya fry', 'bendakaya-fry'],
    ['kakarakaya fry ela cheyali', 'kakarakaya-fry'],
    ['karela fry kaise banaye', 'karela-fry'],
    ['patta gobhi matar ki sabzi', 'cabbage-matar-sabzi'],
    ['gobi matar', 'gobi-matar'],
    ['dry aloo mattar for tiffin, no gravy', 'aloo-matar-sukhi'],
    ['plak paner recipe for 4 ppl', 'palak-paneer'],
    ['veg clear soup with celery', 'veg-clear-soup'],
    ['vendakkai mor kulambu', 'vendakkai-mor-kuzhambu'],
    ['palakura pappu', 'palakura-pappu'],
    ['tomato rasam', 'tomato-rasam'],
  ];
  for (const [text, id] of cases) {
    const res = await ask(text);
    assert.equal(recipeCard(res)?.id, id, `"${text}" → ${recipeCard(res)?.id || matchIds(res).join(',') || res.reply.slice(0, 60)}`);
  }
});

test('genuinely ambiguous names are offered as a choice, never guessed', async () => {
  for (const [text, both] of [
    ['bitter gourd fry', ['karela-fry', 'kakarakaya-fry']],
    ['lady finger fry', ['bhindi-fry', 'bendakaya-fry']],
  ]) {
    const res = await ask(text);
    assert.equal(recipeCard(res), null, `"${text}" must not pick one`);
    for (const id of both) assert.ok(matchIds(res).includes(id), `"${text}" should offer ${id}`);
  }
});

test('dishes the book does not have are admitted, not answered with a near miss', async () => {
  for (const text of ['rajma chawal', 'dosa', 'upma recipe', 'bagara baingan hyderabadi style']) {
    const res = await ask(text);
    assert.equal(recipeCard(res), null, `"${text}" got a recipe`);
    assert.match(res.reply, /don.t have a tested recipe/i, text);
  }
});

test('meat, egg and fish requests are redirected to vegetarian dishes', async () => {
  for (const text of ['chicken curry', 'egg fried rice', 'fish fry']) {
    const res = await ask(text);
    assert.match(res.reply, /vegetarian/i);
    assert.equal(recipeCard(res), null);
    assert.ok(matchIds(res).length > 0, `"${text}" should offer vegetarian alternatives`);
  }
});

test('health questions get no medical claims', async () => {
  const res = await ask('is karela good for diabetes');
  assert.match(res.reply, /can.t give medical/i);
  assert.doesNotMatch(res.reply, /\b(cures?|controls?|reduces?) (sugar|diabetes)/i);
});

test('"I have" lists dishes built on those vegetables, ranked by what they are about', async () => {
  const res = await ask('I have potato and cauliflower');
  assert.equal(recipeCard(res), null, 'having vegetables is not asking for one dish');
  assert.equal(matchIds(res)[0], 'aloo-gobi');

  const okra = await ask('what can I cook with bhindi');
  assert.ok(matchIds(okra).includes('bhindi-fry'));
  for (const id of matchIds(okra)) {
    assert.ok(recipes.mainVegetables(recipes.RECIPES.find((r) => r.id === id)).includes('okra'), `${id} is not an okra dish`);
  }
});

test('servings are read from the ways people say them and scale the recipe', async () => {
  assert.equal(parseServings('for 4 people'), 4);
  assert.equal(parseServings('gutti vankaya 4 mandiki'), 4);
  assert.equal(parseServings('6 logon ke liye'), 6);
  assert.equal(parseServings('buy 2 kg tomato'), null);

  const two = recipes.getRecipe('aloo-gobi', 2);
  const four = (await ask('aloo gobi for 4 members')).cards.find((c) => c.type === 'recipe');
  assert.equal(four.servings, 4);
  const potato2 = two.ingredients.find((i) => i.produce === 'potato').grams;
  const potato4 = four.ingredients.find((i) => i.produce === 'potato').grams;
  assert.ok(Math.abs(potato4 - potato2 * 2) <= 10, `potato ${potato2} g → ${potato4} g`);
});

test('recipe and match cards keep their card type — a dish type must not overwrite it', async () => {
  const res = await ask('aloo gobi');
  assert.equal(res.cards[0].type, 'recipe');
  assert.equal(res.cards[0].dishType, 'dry');
  const list = await ask('I have potato and cauliflower');
  assert.ok(list.cards.every((c) => c.type === 'recipe_match'));
});

test('common kitchen questions get the accurate answer, and unknown ones an honest "not sure"', async () => {
  assert.match((await ask('how long to boil potatoes')).reply, /20–25 min/);
  assert.match((await ask('how to stop bhindi getting sticky')).reply, /dry/i);
  assert.match((await ask('curry lo uppu ekkuva ayindi em cheyali')).reply, /salty/i);
  assert.match((await ask('too salty dal what to do')).reply, /raw potato .* removes very little/i);
  assert.match((await ask('can i freeze palak puree')).reply, /not sure/i);
});

test('bitter bottle gourd is told to throw it away, not to salt and squeeze it', async () => {
  // Bitter lauki is toxic and cooking does not fix it, so this answer must win
  // over the bitter-gourd one however the question is phrased.
  for (const text of [
    'how to remove bitterness from lauki',
    'lauki is bitter, how to make it less bitter',
    'lauki juice tastes bitter',
    'lauki kadwi hai kya karu',
    'sorakaya chedu ga undi',
  ]) {
    const res = await ask(text);
    assert.match(res.reply, /throw the WHOLE gourd away/, text);
    assert.doesNotMatch(res.reply, /rub with salt/i, text);
  }
  // …and the bitter-gourd answer is still given for bitter gourd.
  assert.match((await ask('how to reduce bitterness in karela')).reply, /Rub with salt/);
});

test('vegetables the customer says they do NOT have are never counted as had', () => {
  assert.deepEqual(recipes.extractVegetables('I have potato and tomato but no onion').sort(), ['potato', 'tomato']);
  assert.deepEqual(recipes.extractVegetables('I dont have onion and tomato'), []);
  assert.deepEqual(recipes.extractVegetables('i have everything except onion'), []);
  // Telugu/Tamil/Hindi put the negation after the noun.
  assert.deepEqual(recipes.extractVegetables('naa daggara bendakaya undi kani ullipaya ledu'), ['okra']);
  assert.deepEqual(recipes.extractVegetables('mere paas aloo hai par pyaz nahi hai'), ['potato']);
  assert.deepEqual(recipes.extractVegetables('vengayam illai, thakkali irukku'), ['tomato']);
});

test('meat and fish are recognised even when a vegetable name is one letter away', async () => {
  // `keema` is one edit from `keera` (cucumber) and was corrected into it.
  for (const text of ['keema matar kaise banaye', 'chicken curry', 'fish fry', 'prawns masala', 'meen kuzhambu']) {
    assert.match((await ask(text)).reply, /vegetarian/i, text);
  }
  // …while these are vegetarian requests that merely mention the word.
  assert.equal(recipeCard(await ask('veg cutlet without egg'))?.id, 'veg-cutlet');
  assert.equal(recipeCard(await ask('cabbage palya maadi kodi'))?.id, 'cabbage-poriyal');
  assert.ok(!/vegetarian/i.test((await ask('egg plant curry')).reply));
});

test('a confirm only settles the preview it answers', async () => {
  await Product.create([
    { sku: 'C-POT', categoryId: 2, name: 'Fresh Potato (Aloo)', weight: '1kg', pricePaise: 3000, stock: 50, owner: null },
    { sku: 'C-CAU', categoryId: 2, name: 'Cauliflower (Phool Gobi)', weight: '1 pc (approx 600g)', pricePaise: 3500, stock: 50, owner: null },
    { sku: 'C-TOM', categoryId: 2, name: 'Desi Tomatoes (Tamatar)', weight: '1kg', pricePaise: 4000, stock: 50, owner: null },
    { sku: 'C-ON', categoryId: 2, name: 'Fresh Red Onions (Pyaaz)', weight: '1kg', pricePaise: 4500, stock: 50, owner: null },
  ]);
  const ctx = { address: 'Benz Circle, Vijayawada', paymentMethod: 'cod' };
  // A real document: placing an order calls methods on it.
  const { user } = await createUser({ role: 'customer' });

  await ask('aloo gobi', user);
  const preview = await runLocalTurn(user, [{ role: 'user', content: 'order missing ingredients' }], ctx);
  assert.ok(preview.proposedOrder?.proposalId, preview.reply);

  // The conversation moves on, and a later "yes" answers THAT, not the cart.
  await ask('palak paneer', user);
  const stale = await runLocalTurn(user, [{ role: 'user', content: 'yes' }], ctx);
  assert.equal(await Order.countDocuments({}), 0, `"yes" placed a stale order: ${stale.reply}`);

  // Cancelling revokes it on the server too.
  const again = await runLocalTurn(user, [{ role: 'user', content: 'order missing ingredients' }], ctx);
  assert.ok(again.proposedOrder?.proposalId);
  await runLocalTurn(user, [{ role: 'user', content: 'cancel' }], ctx);
  await runLocalTurn(user, [{ role: 'user', content: 'yes' }], ctx);
  assert.equal(await Order.countDocuments({}), 0, 'a cancelled preview was still placed');

  // An immediate confirm does place it.
  const live = await runLocalTurn(user, [{ role: 'user', content: 'order missing ingredients' }], ctx);
  assert.ok(live.proposedOrder?.proposalId);
  const placed = await runLocalTurn(user, [{ role: 'user', content: 'confirm' }], ctx);
  assert.match(placed.reply, /Order placed/, placed.reply);
  assert.equal(await Order.countDocuments({}), 1);
});

test('a confirm that fails for a reason the customer can fix keeps the preview', async () => {
  await Product.create({ sku: 'C-POT2', categoryId: 2, name: 'Fresh Potato (Aloo)', weight: '1kg', pricePaise: 3000, stock: 50, owner: null });
  const { user } = await createUser({ role: 'customer' });
  const preview = await tools.proposeOrderTool(user, { items: [{ productId: String((await Product.findOne({ sku: 'C-POT2' }))._id), quantity: 1 }] });

  await assert.rejects(
    () => tools.confirmOrderTool(user, { proposalId: preview.proposalId }),
    (err) => err.code === 'ADDRESS_REQUIRED'
  );
  // Still redeemable once they set an address — it used to be destroyed.
  const placed = await tools.confirmOrderTool(user, { proposalId: preview.proposalId, address: 'Benz Circle, Vijayawada' });
  assert.ok(placed.orderNumber);
  assert.equal(placed.itemCount, 1);
  // …and not twice.
  await assert.rejects(() => tools.confirmOrderTool(user, { proposalId: preview.proposalId, address: 'Benz Circle' }));
  assert.equal(await Order.countDocuments({}), 1);
});

test('a quantity from the model is a whole number of packs, and an id must be an id', async () => {
  const tomato = await Product.create({ sku: 'Q-TOM', categoryId: 2, name: 'Desi Tomatoes (Tamatar)', weight: '1kg', pricePaise: 4000, stock: 50, owner: null });
  const user = freshUser();

  // 2.5 reached Order.items and left Product.stock on a half unit, after which
  // the product could never be saved again.
  const preview = await tools.proposeOrderTool(user, { items: [{ productId: String(tomato._id), quantity: 2.5 }] });
  assert.equal(preview.lines[0].quantity, 3);
  assert.ok(Number.isInteger(preview.totalPaise));

  // A query object in place of an id matched an arbitrary product.
  await assert.rejects(() => tools.proposeOrderTool(user, { items: [{ productId: { $ne: null }, quantity: 1 }] }));
});

/* ------------------------------------------------------ catalog + orders */

test('an ingredient maps to the product that IS it, never a look-alike', async () => {
  await Product.create([
    { sku: 'T-SWEET', categoryId: 2, name: 'Sweet Potato (Shakarkandi)', weight: '500g', pricePaise: 4000, stock: 10, owner: null },
    { sku: 'T-POT', categoryId: 2, name: 'Fresh Potato (Aloo)', weight: '1kg', pricePaise: 3000, stock: 10, owner: null },
    { sku: 'T-SPRING', categoryId: 2, name: 'Spring Onion (Hara Pyaaz)', weight: '1 bunch (approx 150g)', pricePaise: 2000, stock: 10, owner: null },
    { sku: 'T-ONION', categoryId: 2, name: 'Fresh Red Onions (Pyaaz)', weight: '1kg', pricePaise: 4500, stock: 10, owner: null },
  ]);
  assert.equal((await tools.findCatalogProduct('potato')).name, 'Fresh Potato (Aloo)');
  assert.equal((await tools.findCatalogProduct('sweet potato')).name, 'Sweet Potato (Shakarkandi)');
  assert.equal((await tools.findCatalogProduct('onion')).name, 'Fresh Red Onions (Pyaaz)');
  assert.equal((await tools.findCatalogProduct('spring onion')).name, 'Spring Onion (Hara Pyaaz)');
});

test('pack counts cover what the recipe needs without over-ordering', () => {
  assert.equal(tools.packsFor(300, '1kg'), 1);
  assert.equal(tools.packsFor(600, '500g'), 2);
  assert.equal(tools.packsFor(520, '500g'), 1, 'a few grams over one pack is still one pack');
  assert.equal(tools.packsFor(900, '1 pc (approx 600g)'), 2);
  assert.equal(tools.packsFor(5, '1 bunch (approx 100g)'), 1);
  assert.equal(tools.approxPackGrams('1 pc (approx 600g)'), 600);
});

test('the prices answer comes from the live catalog', async () => {
  await Product.create({ sku: 'T-OKRA', categoryId: 2, name: 'Fresh Okra (Bhindi)', weight: '500g', pricePaise: 3500, stock: 10, owner: null });
  const res = await ask('bhindi price entha');
  assert.match(res.reply, /Fresh Okra \(Bhindi\).*₹35 per 500g/);
});

test('"order missing ingredients" leaves out what the customer said they have', async () => {
  await Product.create([
    { sku: 'T-POT2', categoryId: 2, name: 'Fresh Potato (Aloo)', weight: '1kg', pricePaise: 3000, stock: 10, owner: null },
    { sku: 'T-CAU', categoryId: 2, name: 'Cauliflower (Phool Gobi)', weight: '1 pc (approx 600g)', pricePaise: 3500, stock: 10, owner: null },
    { sku: 'T-TOM', categoryId: 2, name: 'Desi Tomatoes (Tamatar)', weight: '1kg', pricePaise: 4000, stock: 10, owner: null },
  ]);
  const user = freshUser();
  await ask('I have potato and cauliflower', user);
  await ask('1', user);
  const res = await ask('order missing ingredients', user);
  assert.ok(res.proposedOrder?.proposalId, res.reply);
  const ordered = res.proposedOrder.lines.filter((l) => l.productId).map((l) => l.name);
  assert.ok(!ordered.some((n) => /potato|cauliflower/i.test(n)), `ordered what they have: ${ordered}`);
  assert.ok(ordered.some((n) => /tomato/i.test(n)), `did not order tomato: ${ordered}`);
  assert.deepEqual(res.proposedOrder.alreadyHave.sort(), ['cauliflower', 'potato']);
  assert.ok(res.proposedOrder.fromYourKitchen.length > 0, 'spices should be listed as from your kitchen');
});

/* ---------------------------------------------------- 3. the blind set */

test('blind customer messages: the bar the router must clear', async () => {
  await Product.create({ sku: 'T-ONION2', categoryId: 2, name: 'Fresh Red Onions (Pyaaz)', weight: '1kg', pricePaise: 4500, stock: 10, owner: null });

  const tally = { dishExact: 0, dishListed: 0, dishWrong: [], dishMiss: [], dishTotal: 0, otherPass: 0, otherFail: [], otherTotal: 0 };
  for (const c of EVALS) {
    const res = await ask(c.text);
    const card = recipeCard(res);
    const list = matchIds(res);
    if (c.intent === 'dish') {
      const want = c.anyOf || [c.recipeId];
      tally.dishTotal += 1;
      if (card) (want.includes(card.id) ? (tally.dishExact += 1) : tally.dishWrong.push(`${c.text} → ${card.id}`));
      else if (list.some((id) => want.includes(id))) tally.dishListed += 1;
      else tally.dishMiss.push(c.text);
      continue;
    }
    tally.otherTotal += 1;
    const ok = {
      have: () => list.length > 0 || (card && res.reply),
      unknown_dish: () => !card && /don.t have a tested recipe/i.test(res.reply),
      nonveg: () => /vegetarian/i.test(res.reply),
      greeting: () => /^hi/i.test(res.reply),
      health: () => /medical/i.test(res.reply),
      price: () => /₹|couldn.t find|which vegetable/i.test(res.reply),
      question: () => !/cooking helper 🥕/.test(res.reply) && !card,
      order: () => true,
    }[c.intent];
    if (ok && ok()) tally.otherPass += 1;
    else tally.otherFail.push(`[${c.intent}] ${c.text} → ${res.reply.split('\n')[0].slice(0, 60)}`);
  }

  // The one that matters most: never confidently the wrong dish.
  assert.deepEqual(tally.dishWrong, [], 'confidently answered with the wrong dish');
  assert.ok(tally.dishExact / tally.dishTotal >= 0.95, `dish exact ${tally.dishExact}/${tally.dishTotal}; misses: ${tally.dishMiss}`);
  assert.ok((tally.dishExact + tally.dishListed) / tally.dishTotal >= 0.98, `dish found ${tally.dishExact + tally.dishListed}/${tally.dishTotal}`);
  assert.ok(tally.otherPass / tally.otherTotal >= 0.95, `other intents ${tally.otherPass}/${tally.otherTotal}: ${tally.otherFail.join(' | ')}`);
});
