'use strict';

const Product = require('../../models/Product');
const Order = require('../../models/Order');
const { ApiError } = require('../../middleware/errors');
const checkout = require('../checkout');
const sourcing = require('../sourcing');
const recipes = require('./recipes');
const proposals = require('./proposals');

const DELIVERY_FEE_PAISE = 2500;
const FREE_DELIVERY_THRESHOLD_PAISE = 30000;

const SELECT = 'name weight pricePaise stock owner sku catalogItem';

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The catalog product a vegetable is sold as.
 *
 * By SKU first — the platform catalog's own row — and only then by name, with
 * the produce entry's exclusions applied: a name search for "potato" also
 * finds Sweet Potato, and one for "onion" finds Spring Onion, and ordering
 * either for a recipe that needs the other is exactly the wrong vegetable at
 * the door. Shared (`owner: null`) rows are preferred over one shop's listing,
 * and a row in stock over one that is not.
 */
async function findCatalogProduct(produceKey, { shopId = null } = {}) {
  const spec = recipes.PRODUCE[produceKey];
  if (!spec) return null;

  /*
    An order placed with an independent shop must name that shop's OWN rows:
    checkout refuses a basket holding anything else (MIXED_SELLERS). So when a
    shop is selected, resolve the shared catalog row first and then follow
    `catalogItem` to the shop's instance of it — the same link basket coverage
    uses. A shop that does not stock the item has no row, and the line is
    reported as unavailable rather than failing at Confirm.
  */
  if (shopId) {
    const shared = await findCatalogProduct(produceKey);
    if (!shared) return null;
    return Product.findOne({
      owner: shopId,
      isActive: true,
      catalogItem: shared.catalogItem || shared._id,
    })
      .select(SELECT)
      .lean();
  }

  if (spec.sku) {
    const bySku = await Product.findOne({ sku: spec.sku, isActive: true, owner: null }).select(SELECT).lean();
    if (bySku) return bySku;
  }

  const candidates = await Product.find({
    isActive: true,
    name: { $regex: spec.match || `\\b${escapeRegex(produceKey)}\\b`, $options: 'i' },
  })
    .select(SELECT)
    .limit(20)
    .lean();

  const exclude = spec.exclude ? new RegExp(spec.exclude, 'i') : null;
  const usable = candidates.filter((p) => !exclude || !exclude.test(p.name));
  usable.sort(
    (a, b) =>
      (a.owner == null ? 0 : 1) - (b.owner == null ? 0 : 1) ||
      (b.stock > 0 ? 1 : 0) - (a.stock > 0 ? 1 : 0)
  );
  return usable[0] || null;
}

/**
 * Grams in one pack, read loosely: "500g", "1kg", and also "1 pc (approx 600g)".
 *
 * This deliberately differs from `packGrams` in src/services/packs.mjs, which
 * refuses a bracketed weight because it decides whether a SIZE PICKER may be
 * offered. Here the question is only how many packs cover a recipe, and an
 * approximate weight answers that well enough.
 */
function approxPackGrams(weight) {
  const m = String(weight || '').match(/(\d+(?:\.\d+)?)\s*(kg|g)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2].toLowerCase() === 'kg' ? n * 1000 : n;
}

function packsFor(grams, weight) {
  const perPack = approxPackGrams(weight);
  if (!perPack || !grams) return 1;
  return Math.min(99, Math.max(1, Math.ceil(grams / perPack - 0.1)));
}

async function searchCatalog({ query, limit = 8 }) {
  const q = String(query || '').trim();
  if (!q) return [];
  const cap = Math.min(20, Number(limit) || 8);

  // "bhindi", "aloo", "kakarakaya" — resolve through the produce vocabulary,
  // so a local name finds the product and "potato" does not return sweet potato.
  const keys = recipes.extractVegetables(q);
  let rows = [];
  if (keys.length) {
    for (const key of keys.slice(0, cap)) {
      const product = await findCatalogProduct(key);
      if (product) rows.push(product);
    }
  } else {
    rows = await Product.find({ isActive: true, name: { $regex: escapeRegex(q), $options: 'i' } })
      .select(SELECT)
      .limit(cap)
      .lean();
  }

  return rows.map((p) => ({
    productId: String(p._id),
    name: p.name,
    weight: p.weight,
    pricePaise: p.pricePaise,
    price: p.pricePaise / 100,
    stock: p.stock,
    inStock: p.stock > 0,
  }));
}

async function listMatchingRecipesTool({ vegetables, servings }) {
  const matches = recipes.listMatchingRecipes(vegetables || [], { limit: 5 });
  return { servings: servings || 2, matches };
}

async function findRecipesByNameTool({ dishName, servings }) {
  const matches = recipes.findRecipesByDishName(dishName || '', { limit: 5 });
  return { servings: servings || 2, matches };
}

async function getRecipeTool({ recipeId, servings }) {
  const detail = recipes.getRecipe(recipeId, servings);
  if (!detail) throw new ApiError(404, 'Recipe not found.', 'RECIPE_NOT_FOUND');
  return detail;
}

/**
 * Build a confirmable order preview from recipe ingredients (or explicit items).
 */
async function proposeOrderTool(user, { recipeId, servings, items, marketId, shopId, paymentMethod, haveVegetables }) {
  let lines = [];
  let pantry = [];
  let skipped = [];

  if (Array.isArray(items) && items.length > 0) {
    // Every field here is attacker-influenced: the customer's own message
    // steers the model's tool call. An id must be an id (a `{$ne: null}` went
    // into findOne and matched an arbitrary product), and a quantity must be a
    // whole number of packs — 2.5 reached Order.items and left Product.stock
    // on a half unit, which the schema then refuses to save ever again.
    const seen = new Set();
    for (const item of items.slice(0, 30)) {
      const id = typeof item?.productId === 'string' ? item.productId : '';
      if (!/^[0-9a-f]{24}$/i.test(id) || seen.has(id)) continue;
      seen.add(id);
      const product = await Product.findOne({ _id: id, isActive: true })
        .select('name weight pricePaise stock')
        .lean();
      if (!product) continue;
      const quantity = Math.min(99, Math.max(1, Math.round(Number(item.quantity)) || 1));
      lines.push({
        productId: String(product._id),
        name: product.name,
        weight: product.weight,
        quantity,
        unitPricePaise: product.pricePaise,
        lineTotalPaise: product.pricePaise * quantity,
      });
    }
  } else if (recipeId) {
    const detail = recipes.getRecipe(recipeId, servings || recipes.DEFAULT_SERVINGS);
    if (!detail) throw new ApiError(404, 'Recipe not found.', 'RECIPE_NOT_FOUND');

    // "Order MISSING ingredients" means what the customer said they already
    // have stays off the bill.
    const have = new Set((haveVegetables || []).map(recipes.normalizeVeg));

    // One line per vegetable: a recipe can list onion twice (masala + garnish).
    const needGrams = new Map();
    for (const ing of detail.ingredients) {
      if (ing.pantry) {
        if (!ing.optional && !/^(?:hot |warm |cold )?water$/i.test(ing.name)) pantry.push(ing.name);
        continue;
      }
      if (ing.optional) continue;
      if (have.has(ing.produce)) {
        skipped.push(ing.produce);
        continue;
      }
      needGrams.set(ing.produce, (needGrams.get(ing.produce) || 0) + ing.grams);
    }

    for (const [produceKey, grams] of needGrams) {
      const product = await findCatalogProduct(produceKey, { shopId });
      if (!product) {
        lines.push({
          productId: null,
          name: produceKey,
          quantity: null,
          missingFromCatalog: true,
          note: shopId ? 'this shop does not stock it' : `${grams} g needed`,
          ...(shopId ? { notSoldHere: true } : {}),
        });
        continue;
      }
      const quantity = packsFor(grams, product.weight);
      lines.push({
        productId: String(product._id),
        name: product.name,
        weight: product.weight,
        quantity,
        neededGrams: grams,
        unitPricePaise: product.pricePaise,
        lineTotalPaise: product.pricePaise * quantity,
        ...(product.stock < quantity ? { lowStock: true } : {}),
      });
    }
    skipped = [...new Set(skipped)];
    pantry = [...new Set(pantry)];
  } else {
    throw new ApiError(400, 'Provide a recipeId or items to propose an order.', 'VALIDATION_ERROR');
  }

  /*
    Re-price at the seller checkout will actually bill.

    A market order is billed from that market's own sheet, not the platform
    catalog (see checkout.js), so a preview priced from the catalog quoted one
    total and charged another — and with a wallet payment the difference came
    straight out of the customer's balance. The same sheet is the only thing
    that knows whether the market sells an item at all, so anything missing is
    marked here rather than failing at Confirm with MARKET_CANNOT_FILL.
  */
  if (marketId) {
    const sellable = lines.filter((l) => l.productId && !l.missingFromCatalog);
    // One call per line, because priceLinesAtMarket answers all-or-nothing for
    // the set it is given and we need to know WHICH line is missing.
    const prices = await Promise.all(
      sellable.map((l) =>
        sourcing.priceLinesAtMarket(marketId, [{ product: l.productId, quantity: l.quantity, lineId: l.productId }])
      )
    );
    sellable.forEach((line, i) => {
      const priced = prices[i];
      if (!priced) {
        line.missingFromCatalog = true;
        line.notSoldHere = true;
        line.note = 'this market is not selling it today';
        return;
      }
      line.unitPricePaise = priced.priced[0].sourcePricePaise;
      line.lineTotalPaise = line.unitPricePaise * line.quantity;
    });
  }

  const orderable = lines.filter((l) => l.productId && !l.missingFromCatalog);
  if (orderable.length === 0) {
    throw new ApiError(
      400,
      skipped.length
        ? 'You already have every vegetable this dish needs — nothing to order.'
        : 'None of those ingredients are on sale right now.',
      skipped.length ? 'NOTHING_TO_ORDER' : 'CATALOG_EMPTY_MATCH'
    );
  }

  // A market order is all-or-nothing at checkout, so a preview that quietly
  // dropped a line would be refused the moment they tapped Confirm.
  const notSold = lines.filter((l) => l.notSoldHere).map((l) => l.name);
  if (notSold.length) {
    throw new ApiError(
      400,
      marketId
        ? `This market is not selling ${notSold.join(', ')} today, so I can't build the full cart. Try another market, or add the rest from the shop.`
        : `This shop does not stock ${notSold.join(', ')}, and an order has to come from one shop. Pick a market or another shop for this dish.`,
      marketId ? 'MARKET_CANNOT_FILL' : 'SHOP_CANNOT_FILL'
    );
  }

  const subtotalPaise = orderable.reduce((sum, l) => sum + l.lineTotalPaise, 0);
  const deliveryFeePaise = subtotalPaise >= FREE_DELIVERY_THRESHOLD_PAISE ? 0 : DELIVERY_FEE_PAISE;
  const totalPaise = subtotalPaise + deliveryFeePaise;
  const method = paymentMethod === 'wallet' ? 'wallet' : 'cod';

  const payload = {
    items: orderable.map((l) => ({ productId: l.productId, quantity: l.quantity })),
    marketId: marketId || null,
    shopId: shopId || null,
    paymentMethod: method,
    preview: {
      lines,
      recipeId: recipeId || null,
      servings: recipeId ? recipes.clampServings(servings || recipes.DEFAULT_SERVINGS) : null,
      alreadyHave: skipped,
      fromYourKitchen: pantry,
      subtotalPaise,
      deliveryFeePaise,
      totalPaise,
      subtotal: subtotalPaise / 100,
      deliveryFee: deliveryFeePaise / 100,
      total: totalPaise / 100,
      paymentMethod: method,
    },
  };

  const proposalId = proposals.saveProposal(user._id, payload);
  return { proposalId, ...payload.preview, expiresInMinutes: 10 };
}

/**
 * Place a previewed order.
 *
 * The proposal is only consumed once `placeOrder` has succeeded. Taking it up
 * front meant any failure the customer could actually fix — no delivery address
 * saved, an item that had just sold out — destroyed the preview too, so the
 * Confirm button they were still looking at then answered "that preview
 * expired" for ever.
 */
async function confirmOrderTool(user, { proposalId, address, lat, lng }) {
  const deliveryAddress = String(address || '').trim();
  if (!deliveryAddress && proposals.peekProposal(proposalId, user._id)) {
    throw new ApiError(
      400,
      'Set your delivery address first — tap "Delivery to" at the top of the home screen.',
      'ADDRESS_REQUIRED'
    );
  }

  const payload = proposals.claimProposal(proposalId, user._id);
  if (!payload) {
    throw new ApiError(410, 'That order preview expired. Ask me to build it again.', 'PROPOSAL_EXPIRED');
  }

  let order;
  try {
    order = await checkout.placeOrder({
      user,
      items: payload.items,
      address: deliveryAddress,
      paymentMethod: payload.paymentMethod,
      marketId: payload.marketId || undefined,
      shopId: payload.shopId || undefined,
      lat,
      lng,
    });
  } catch (err) {
    proposals.releaseProposal(proposalId, user._id);
    throw err;
  }

  // Consumed only now: placeOrder has written the order, so a replayed confirm
  // must find nothing rather than place a second one.
  proposals.takeProposal(proposalId, user._id);

  return {
    orderId: order._id.toHexString(),
    orderNumber: order.orderNumber,
    status: order.status,
    itemCount: order.items.length,
    totalAmountPaise: order.totalAmountPaise,
    totalAmount: order.totalAmountPaise / 100,
    paymentMethod: order.paymentMethod,
  };
}

async function getOrderStatusTool(user, { orderId }) {
  /**
   * `customer`, not `user`. Order has no such path, and with strictQuery on an
   * unknown path is dropped rather than rejected — so this filter collapsed to
   * `{ _id: orderId }` and answered about ANY order to ANY signed-in caller.
   * The id arrives from a tool call the customer's own message steers, so it is
   * reachable: "what's the status of order <id>" read a stranger's order.
   */
  const order = await Order.findOne({ _id: orderId, customer: user._id })
    .select('orderNumber status paymentStatus totalAmountPaise fulfillment.status createdAt')
    .lean();
  if (!order) throw new ApiError(404, 'Order not found.', 'NOT_FOUND');
  return {
    orderId: String(order._id),
    orderNumber: order.orderNumber,
    status: order.status,
    fulfillmentStatus: order.fulfillment?.status || null,
    paymentStatus: order.paymentStatus,
    totalAmount: (order.totalAmountPaise || 0) / 100,
    createdAt: order.createdAt,
  };
}

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'list_matching_recipes',
      description:
        'Dishes from the VegDrop recipe book that can be made from vegetables the customer HAS. Use when they list vegetables or ask what to cook with something. Accepts local names (aloo, bhindi, vankaya).',
      parameters: {
        type: 'object',
        properties: {
          vegetables: { type: 'array', items: { type: 'string' } },
          servings: { type: 'number' },
        },
        required: ['vegetables'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_recipes_by_name',
      description:
        'Look up a dish in the VegDrop recipe book by name, regional name or description (gutti vankaya, aloo gobi, bendakaya fry, sambar). Always call this before answering how to cook a named dish. matchScore >= 90 with a clear lead means that dish; otherwise offer the matches as choices.',
      parameters: {
        type: 'object',
        properties: {
          dishName: { type: 'string' },
          servings: { type: 'number' },
        },
        required: ['dishName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_recipe',
      description:
        'Full tested recipe: ingredients scaled to servings (produce in grams, kitchen staples marked pantry), steps and tips. The app renders this as a card for the customer.',
      parameters: {
        type: 'object',
        properties: {
          recipeId: { type: 'string' },
          servings: { type: 'number' },
        },
        required: ['recipeId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_catalog',
      description:
        'Current VegDrop products with live price, pack size and stock. Use for any price or availability question — never state a price that did not come from here. Accepts local names.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_order',
      description:
        'Build a cart preview for a recipe\'s vegetables (pack counts worked out from the servings) or for explicit items. Pass haveVegetables with what the customer said they already have so it is not ordered again. Does NOT place an order — the customer confirms in the app.',
      parameters: {
        type: 'object',
        properties: {
          recipeId: { type: 'string' },
          servings: { type: 'number' },
          haveVegetables: { type: 'array', items: { type: 'string' } },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                productId: { type: 'string' },
                quantity: { type: 'integer' },
              },
            },
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_order_status',
      description: 'Look up one of this customer\'s orders.',
      parameters: {
        type: 'object',
        properties: { orderId: { type: 'string' } },
        required: ['orderId'],
      },
    },
  },
];

async function executeTool(user, name, args) {
  switch (name) {
    case 'list_matching_recipes':
      return listMatchingRecipesTool(args);
    case 'find_recipes_by_name':
      return findRecipesByNameTool(args);
    case 'get_recipe':
      return getRecipeTool(args);
    case 'search_catalog':
      return searchCatalog(args);
    case 'propose_order':
      return proposeOrderTool(user, args);
    case 'get_order_status':
      return getOrderStatusTool(user, args);
    default:
      throw new ApiError(400, `Unknown tool: ${name}`, 'UNKNOWN_TOOL');
  }
}

module.exports = {
  TOOL_DEFS,
  executeTool,
  findCatalogProduct,
  approxPackGrams,
  packsFor,
  searchCatalog,
  proposeOrderTool,
  confirmOrderTool,
  getOrderStatusTool,
  listMatchingRecipesTool,
  findRecipesByNameTool,
  getRecipeTool,
};
