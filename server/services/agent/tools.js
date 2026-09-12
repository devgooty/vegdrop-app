'use strict';

const Product = require('../../models/Product');
const Order = require('../../models/Order');
const { ApiError } = require('../../middleware/errors');
const checkout = require('../checkout');
const recipes = require('./recipes');
const proposals = require('./proposals');

const DELIVERY_FEE_PAISE = 2500;
const FREE_DELIVERY_THRESHOLD_PAISE = 30000;

/**
 * Resolve a vegetable/ingredient name to an active platform catalog product.
 * Prefers owner:null shared catalog rows.
 */
async function findCatalogProduct(name) {
  const needle = recipes.normalizeVeg(name);
  const products = await Product.find({
    isActive: true,
    owner: null,
    name: { $regex: needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' },
  })
    .select('name weight pricePaise stock')
    .limit(5)
    .lean();

  if (products.length === 0) {
    // Fall back to any active listing (shop-owned) if the platform seed is empty.
    return Product.findOne({
      isActive: true,
      name: { $regex: needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' },
    })
      .select('name weight pricePaise stock owner')
      .lean();
  }
  return products[0];
}

async function searchCatalog({ query, limit = 8 }) {
  const q = String(query || '').trim();
  if (!q) return [];
  const rows = await Product.find({
    isActive: true,
    name: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' },
  })
    .select('name weight pricePaise stock owner')
    .limit(Math.min(20, limit))
    .lean();

  return rows.map((p) => ({
    productId: String(p._id),
    name: p.name,
    weight: p.weight,
    pricePaise: p.pricePaise,
    price: p.pricePaise / 100,
    stock: p.stock,
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
async function proposeOrderTool(user, { recipeId, servings, items, marketId, shopId, paymentMethod }) {
  let lines = [];

  if (Array.isArray(items) && items.length > 0) {
    for (const item of items) {
      const product = await Product.findOne({ _id: item.productId, isActive: true })
        .select('name weight pricePaise stock')
        .lean();
      if (!product) continue;
      const quantity = Math.min(99, Math.max(1, Number(item.quantity) || 1));
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
    const detail = recipes.getRecipe(recipeId, servings || 2);
    if (!detail) throw new ApiError(404, 'Recipe not found.', 'RECIPE_NOT_FOUND');

    for (const ing of detail.ingredients) {
      const product = await findCatalogProduct(ing.name);
      if (!product) {
        lines.push({
          productId: null,
          name: ing.name,
          quantity: null,
          missingFromCatalog: true,
          note: `${ing.quantity} ${ing.unit} needed`,
        });
        continue;
      }
      // Rough pack count: at least 1 pack per ingredient for the serving size.
      const quantity = Math.min(99, Math.max(1, Math.ceil(Number(ing.quantity) || 1)));
      if (product.stock < quantity) {
        lines.push({
          productId: String(product._id),
          name: product.name,
          weight: product.weight,
          quantity,
          unitPricePaise: product.pricePaise,
          lineTotalPaise: product.pricePaise * quantity,
          lowStock: true,
        });
        continue;
      }
      lines.push({
        productId: String(product._id),
        name: product.name,
        weight: product.weight,
        quantity,
        unitPricePaise: product.pricePaise,
        lineTotalPaise: product.pricePaise * quantity,
      });
    }
  } else {
    throw new ApiError(400, 'Provide a recipeId or items to propose an order.', 'VALIDATION_ERROR');
  }

  const orderable = lines.filter((l) => l.productId && !l.missingFromCatalog);
  if (orderable.length === 0) {
    throw new ApiError(
      400,
      'None of those ingredients are in the catalog right now.',
      'CATALOG_EMPTY_MATCH'
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

async function confirmOrderTool(user, { proposalId, address, lat, lng }) {
  const payload = proposals.takeProposal(proposalId, user._id);
  if (!payload) {
    throw new ApiError(410, 'That order preview expired. Ask me to build it again.', 'PROPOSAL_EXPIRED');
  }

  const deliveryAddress = String(address || user.address || '').trim();
  if (!deliveryAddress) {
    throw new ApiError(
      400,
      'Add a delivery address in your profile (or send one) before placing the order.',
      'ADDRESS_REQUIRED'
    );
  }

  const order = await checkout.placeOrder({
    user,
    items: payload.items,
    address: deliveryAddress,
    paymentMethod: payload.paymentMethod,
    marketId: payload.marketId || undefined,
    shopId: payload.shopId || undefined,
    lat,
    lng,
  });

  return {
    orderId: order._id.toHexString(),
    orderNumber: order.orderNumber,
    status: order.status,
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
      description: 'Find curries/dishes that can be made from the vegetables the user has.',
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
        'Find a dish by name when the user asks for a specific curry (e.g. cabbage fry, aloo gobi, sambar). Prefer this over vegetable matching when they name a dish.',
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
      description: 'Get full steps and scaled ingredients for one recipe.',
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
      description: 'Search VegDrop products by name.',
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
        'Build a cart preview for recipe ingredients or explicit items. Does NOT place an order. User must confirm separately.',
      parameters: {
        type: 'object',
        properties: {
          recipeId: { type: 'string' },
          servings: { type: 'number' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                productId: { type: 'string' },
                quantity: { type: 'number' },
              },
            },
          },
          marketId: { type: 'string' },
          shopId: { type: 'string' },
          paymentMethod: { type: 'string', enum: ['cod', 'wallet'] },
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
  searchCatalog,
  proposeOrderTool,
  confirmOrderTool,
  getOrderStatusTool,
  listMatchingRecipesTool,
  findRecipesByNameTool,
  getRecipeTool,
};
