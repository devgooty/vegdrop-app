'use strict';

const express = require('express');
const config = require('../config/env');
const Order = require('../models/Order');
const Stall = require('../models/Stall');
const StallInventory = require('../models/StallInventory');
const StallPhoto = require('../models/StallPhoto');
const MarketPrice = require('../models/MarketPrice');
const Product = require('../models/Product');
const { ApiError } = require('../middleware/errors');
const { validate, z, fields } = require('../middleware/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const { stallActionLimiter } = require('../middleware/rateLimit');
const sourcing = require('../services/sourcing');
const settlement = require('../services/settlement');

const router = express.Router();

/**
 * The shopkeeper's side of a market: see what has been offered, take what you
 * can fill, bag it.
 *
 * A running theme here is that a stall is NEVER shown the customer.
 * A stall is being asked "can you supply 2kg of tomatoes"; the name, phone and
 * address belong to the rider's job, not theirs. The projections below are
 * deliberately narrow rather than `order.toJSON()`.
 */

/**
 * Resolve the caller's stall once, for every route below.
 *
 * The ways this fails are told apart on purpose. A shopkeeper waiting on a
 * market owner and a shopkeeper who was turned down are in very different
 * situations, and answering both with "you do not have a stall yet" invites the
 * first to apply again — creating a duplicate request — and leaves the second
 * waiting for a decision that has already been made. The status is looked up
 * without the `isActive` filter precisely so those cases can be reported.
 */
async function loadStall(req, _res, next) {
  const stall = await Stall.findOne({ owner: req.user._id, status: { $in: ['pending', 'approved'] } });

  if (stall && stall.status === 'pending') {
    return next(
      new ApiError(
        403,
        'Your request to join this market is waiting for the market owner to approve it.',
        'STALL_PENDING',
        { marketId: String(stall.market), requestedAt: stall.requestedAt }
      )
    );
  }

  /**
   * Suspended: approved, but switched off by the market owner.
   *
   * A fourth situation, and the newest — see PATCH /markets/:id/stalls/:stallId.
   * It has to be told apart from the others for the same reason they are told
   * apart from each other, and more urgently: NO_STALL says "ask to join a
   * market to get one", which a suspended trader cannot act on. The partial
   * unique index on `owner` covers approved stalls, so applying elsewhere would
   * be refused with "you already run a stall" — leaving them bounced between two
   * messages that contradict each other and no way forward.
   *
   * Their stall still exists and can be switched back on, so the answer is the
   * one fact that is actually true and the one action that actually helps.
   */
  if (stall && !stall.isActive) {
    return next(
      new ApiError(
        403,
        'Your stall has been suspended by the market. Speak to the market office to trade again.',
        'STALL_SUSPENDED',
        { marketId: String(stall.market), stallNumber: stall.stallNumber }
      )
    );
  }

  if (!stall) {
    return next(
      new ApiError(404, 'You do not have a stall yet. Ask to join a market to get one.', 'NO_STALL')
    );
  }

  req.stall = stall;
  return next();
}

const stallGate = [requireAuth, requireRole('shopkeeper', 'developer'), loadStall];

/**
 * Shape one order for a stall's eyes: the goods, never the customer.
 *
 * `openLines` is what this stall is being ASKED for, which is not the same as
 * every unclaimed line. During a ranked round the order is split between
 * several stalls, and each is shown only its own slice — showing a shopkeeper
 * lines that were offered to someone else would invite them to tap accept on
 * work they cannot win. Once the cascade falls through to the market-wide open
 * pool, every unclaimed line is fair game again and all of them appear.
 */
function forStall(order, stallId) {
  const key = String(stallId);
  const mine = order.items.filter((i) => String(i.claim?.stall) === key);
  const openPool = Boolean(order.fulfillment?.stallOffer?.openPool);
  const open = order.items.filter(
    (i) => !i.claim?.stall && (openPool || String(i.offer?.stall) === key)
  );

  return {
    id: String(order._id),
    orderNumber: order.orderNumber,
    marketName: order.marketName,
    status: order.fulfillment?.status,
    // What the customer sees as the deadline to beat.
    sourcingDeadline: order.fulfillment?.sourcingDeadline,
    /**
     * The clock that actually matters to a shopkeeper: how long THIS round of
     * offers stays live. `sourcingDeadline` is only the market-wide backstop.
     */
    offerExpiresAt: order.fulfillment?.stallOffer?.expiresAt || null,
    /** True when these lines are up for grabs rather than reserved for us. */
    openPool,
    placedAt: order.createdAt,
    /** Lines this stall may still claim — see the note above. */
    openLines: open.map((i) => ({
      lineId: String(i.lineId),
      name: i.name,
      quantity: i.quantity,
      // The market's price, which is what this stall is paid — never the
      // customer's locked price, which may differ after a hop.
      unitPricePaise: i.sourcePricePaise,
    })),
    /** Lines this stall has committed to. */
    myLines: mine.map((i) => ({
      lineId: String(i.lineId),
      name: i.name,
      quantity: i.quantity,
      unitPricePaise: i.sourcePricePaise,
      auto: i.claim.auto,
      packedAt: i.claim.packedAt,
      collectedAt: i.claim.collectedAt,
    })),
    myTotalPaise: mine.reduce((sum, i) => sum + (i.sourcePricePaise || 0) * i.quantity, 0),
  };
}

// ---------------------------------------------------------------------------
// The stall itself
// ---------------------------------------------------------------------------

router.get('/me', ...stallGate, async (req, res) => {
  return res.json({ data: req.stall.toJSON() });
});

/**
 * Open/close the shutter, and switch automatic accepting on or off.
 *
 * Auto-accept only ever fires where the stall has declared stock for the line,
 * so switching it on without any inventory changes nothing — which is why the
 * response says how many lines are actually declared.
 */
router.patch(
  '/me',
  ...stallGate,
  validate({
    body: z
      .object({
        isOpen: z.boolean().optional(),
        autoAccept: z.boolean().optional(),
        name: fields.nonEmptyString(160).optional(),
        contactPhone: z.string().trim().max(20).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const update = { ...req.valid.body };
    if (Object.keys(update).length === 0) {
      throw new ApiError(400, 'No fields to update.', 'VALIDATION_ERROR');
    }

    const stall = await Stall.findByIdAndUpdate(
      req.stall._id,
      { $set: update },
      { returnDocument: 'after', runValidators: true }
    );

    const declaredLines = await StallInventory.countDocuments({ stall: stall._id, stock: { $gt: 0 } });

    return res.json({ data: { ...stall.toJSON(), declaredLines } });
  }
);

// ---------------------------------------------------------------------------
// Declared stock — what powers auto-accept
// ---------------------------------------------------------------------------

router.get('/me/inventory', ...stallGate, async (req, res) => {
  const rows = await StallInventory.find({ stall: req.stall._id })
    .populate('product', 'name weight image categoryId')
    .lean();

  return res.json({
    data: rows.map((row) => ({
      id: String(row._id),
      product: row.product
        ? { id: String(row.product._id), name: row.product.name, weight: row.product.weight, image: row.product.image }
        : null,
      stock: row.stock,
      updatedAt: row.updatedAt,
    })),
  });
});

router.put(
  '/me/inventory',
  ...stallGate,
  validate({
    body: z
      .object({
        items: z
          .array(
            z.object({ productId: fields.objectId, stock: z.number().int().min(0).max(1_000_000) }).strict()
          )
          .min(1)
          .max(300),
      })
      .strict(),
  }),
  async (req, res) => {
    const { items } = req.valid.body;

    const productIds = [...new Set(items.map((i) => i.productId))];
    const known = await Product.countDocuments({ _id: { $in: productIds }, isActive: true });
    if (known !== productIds.length) {
      throw new ApiError(400, 'One or more products do not exist.', 'PRODUCT_UNAVAILABLE');
    }

    await StallInventory.bulkWrite(
      items.map((row) => ({
        updateOne: {
          filter: { stall: req.stall._id, product: row.productId },
          update: { $set: { stock: row.stock, market: req.stall.market } },
          upsert: true,
        },
      }))
    );

    return res.json({ data: { updated: items.length } });
  }
);

/**
 * Everything the stock screen needs, in one request.
 *
 * Every product this market prices, each with the market owner's price, this
 * stall's declared stock (0 when it has declared none), and when this stall
 * last photographed it.
 *
 * The alternative was for the client to fetch /markets/:id/catalog and
 * /stalls/me/inventory and join them by product id. Joining server-side keeps
 * the screen to one request and, more usefully, means the picker and the stock
 * list are two filters over one list rather than two lists that can disagree:
 * `stock > 0` is what you are holding, `stock === 0` is what you could add.
 *
 * The price is READ-ONLY here and comes from MarketPrice, never from
 * `Product.pricePaise`. One price per product per market, set by the market
 * owner — a stall sells at it and cannot change it, which is why the screen
 * shows it as a fact rather than a field.
 */
router.get('/me/stock', ...stallGate, async (req, res) => {
  const [sheet, declared, photos] = await Promise.all([
    MarketPrice.find({ market: req.stall.market, isAvailable: true })
      .select('product pricePaise')
      .lean(),
    StallInventory.find({ stall: req.stall._id }).select('product stock').lean(),
    // `image` is deliberately NOT selected: this is a list of up to a few
    // hundred rows and the payload would be megabytes. The screen only needs to
    // know a photo exists and how old it is.
    StallPhoto.find({ stall: req.stall._id }).select('product takenAt').lean(),
  ]);

  const products = await Product.find({
    _id: { $in: sheet.map((row) => row.product) },
    isActive: true,
  })
    .select('name weight image categoryId isOrganic')
    .lean();

  const priceByProduct = new Map(sheet.map((r) => [String(r.product), r.pricePaise]));
  const stockByProduct = new Map(declared.map((r) => [String(r.product), r.stock]));
  const photoByProduct = new Map(photos.map((r) => [String(r.product), r.takenAt]));

  const data = products.map((p) => {
    const key = String(p._id);
    return {
      id: key,
      name: p.name,
      weight: p.weight,
      image: p.image,
      categoryId: p.categoryId,
      isOrganic: p.isOrganic,
      pricePaise: priceByProduct.get(key),
      price: priceByProduct.get(key) / 100,
      stock: stockByProduct.get(key) ?? 0,
      photoTakenAt: photoByProduct.get(key) || null,
    };
  });

  // Held first, then everything else, each alphabetically — the shopkeeper's
  // own table before the rest of the market's list.
  data.sort((a, b) => {
    if ((a.stock > 0) !== (b.stock > 0)) return a.stock > 0 ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return res.json({ data });
});

// ---------------------------------------------------------------------------
// Photographs of the actual produce
// ---------------------------------------------------------------------------

/**
 * A body parser for this route alone.
 *
 * The app-wide limit is 100 KB (see server/app.js), which is right for JSON but
 * far too small for an image — and base64 inflates by a third on top of the
 * decoded size. Widening the global limit to suit one route would raise the
 * ceiling on every endpoint in the system, so this is scoped here, exactly as
 * app.js scopes its raw-body hook to the two webhook paths.
 */
const photoBody = express.json({ limit: '1mb' });

/** `data:image/jpeg;base64,…` → the parts, or null if it is not one. */
function parseDataUri(value) {
  const match = /^data:(image\/(?:jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) return null;

  const [, mimeType, base64] = match;
  const buffer = Buffer.from(base64, 'base64');
  // Round-trip check: a truncated or padded string decodes without complaint
  // and would be stored as an image that never renders.
  if (buffer.length === 0 || buffer.toString('base64') !== base64) return null;

  return { mimeType, base64, bytes: buffer.length };
}

/**
 * Post today's photo of one product.
 *
 * Optional throughout: a stall that never uses this shows the catalog image and
 * behaves exactly as before. What it buys is that the customer sees the actual
 * produce rather than a stock photograph of the idea of it.
 *
 * The format allow-list is jpeg and webp, and the exclusions matter more than
 * the inclusions. SVG is a script container and this file is served back to
 * customers; PNG is lossless and would blow the size cap on any real photo.
 */
router.put(
  '/me/photos/:productId',
  ...stallGate,
  stallActionLimiter,
  photoBody,
  validate({
    params: z.object({ productId: fields.objectId }).strict(),
    body: z.object({ image: z.string().min(32).max(2_000_000) }).strict(),
  }),
  async (req, res) => {
    const { productId } = req.valid.params;

    const parsed = parseDataUri(req.valid.body.image);
    if (!parsed) {
      throw new ApiError(
        400,
        'Send a JPEG or WebP photo as a data URI.',
        'UNSUPPORTED_IMAGE'
      );
    }

    if (parsed.bytes > config.freshPhoto.maxBytes) {
      throw new ApiError(
        413,
        `That photo is ${Math.round(parsed.bytes / 1024)} KB. The limit is ${Math.round(config.freshPhoto.maxBytes / 1024)} KB.`,
        'PHOTO_TOO_LARGE'
      );
    }

    /**
     * The market must actually sell this product.
     *
     * Without it a stall could attach a photograph to any product id in the
     * system, and it would surface on another market's catalog through the
     * newest-photo-wins lookup.
     */
    const priced = await MarketPrice.exists({
      market: req.stall.market,
      product: productId,
      isAvailable: true,
    });
    if (!priced) {
      throw new ApiError(400, 'This market is not selling that product.', 'PRODUCT_UNAVAILABLE');
    }

    // Upsert on {stall, product}: today's photo replaces yesterday's rather
    // than accumulating a gallery nobody prunes.
    const photo = await StallPhoto.findOneAndUpdate(
      { stall: req.stall._id, product: productId },
      {
        $set: {
          market: req.stall.market,
          image: parsed.base64,
          mimeType: parsed.mimeType,
          bytes: parsed.bytes,
          takenAt: new Date(),
        },
      },
      { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true }
    );

    return res.json({
      data: { productId, takenAt: photo.takenAt, bytes: photo.bytes },
    });
  }
);

router.delete(
  '/me/photos/:productId',
  ...stallGate,
  validate({ params: z.object({ productId: fields.objectId }).strict() }),
  async (req, res) => {
    // Scoped to this stall, so the id in the URL cannot reach anyone else's.
    const result = await StallPhoto.deleteOne({
      stall: req.stall._id,
      product: req.valid.params.productId,
    });

    return res.json({ data: { removed: result.deletedCount > 0 } });
  }
);

// ---------------------------------------------------------------------------
// The live feed — this is the "alert"
// ---------------------------------------------------------------------------

/**
 * Everything this stall needs to look at right now.
 *
 * `offers` are the orders this stall is currently being ASKED about; `packing`
 * is work already committed to. The apps poll this on the same 5s cycle they
 * already use for orders, so an offer surfaces within five seconds of the round
 * opening — comfortably inside a two-minute window, which is why this needs no
 * push infrastructure.
 *
 * The query used to be every sourcing order in the market. It is now scoped to
 * offers addressed to this stall, plus orders that fell through to the
 * market-wide pool. That is the difference between a scramble and a cascade:
 * before, the fastest tapper won every order and a shopkeeper had no window in
 * which anything was meaningfully theirs to answer.
 */
router.get('/me/orders', ...stallGate, async (req, res) => {
  const [sourcingOrders, mine] = await Promise.all([
    Order.find({
      market: req.stall.market,
      'fulfillment.status': 'sourcing',
      // Only orders with something left to take.
      items: { $elemMatch: { 'claim.stall': null } },
      $or: [
        { 'items.offer.stall': req.stall._id },
        { 'fulfillment.stallOffer.openPool': true },
      ],
    })
      .select(
        'orderNumber marketName items fulfillment.status fulfillment.sourcingDeadline fulfillment.stallOffer createdAt'
      )
      .sort({ createdAt: 1 })
      .limit(50)
      .lean(),

    Order.find({
      'items.claim.stall': req.stall._id,
      'fulfillment.status': { $in: ['packing', 'awaiting_rider', 'collecting'] },
    })
      .select(
        'orderNumber marketName items fulfillment.status fulfillment.sourcingDeadline fulfillment.stallOffer createdAt'
      )
      .sort({ createdAt: 1 })
      .limit(50)
      .lean(),
  ]);

  return res.json({
    data: {
      offers: sourcingOrders.map((o) => forStall(o, req.stall._id)),
      packing: mine.map((o) => forStall(o, req.stall._id)),
      stall: {
        id: String(req.stall._id),
        stallNumber: req.stall.stallNumber,
        isOpen: req.stall.isOpen,
        autoAccept: req.stall.autoAccept,
        activeLoad: req.stall.activeLoad,
      },
    },
  });
});

// ---------------------------------------------------------------------------
// Accepting and packing
// ---------------------------------------------------------------------------

/**
 * Take some lines of an offered order.
 *
 * Its own route rather than the existing POST /orders/:id/claim, which is a
 * rider claiming a whole order for delivery — a different actor, a different
 * unit of work, and sharing them would eventually let one become the other.
 *
 * Partial success is normal: another stall may have taken one of the lines a
 * moment ago. The response says exactly what was won and what was lost so the
 * shopkeeper sees the truth rather than an optimistic echo of what they tapped.
 */
router.post(
  '/orders/:id/claim',
  ...stallGate,
  stallActionLimiter,
  validate({
    params: z.object({ id: fields.objectId }).strict(),
    body: z.object({ lineIds: z.array(fields.objectId).min(1).max(100) }).strict(),
  }),
  async (req, res) => {
    const order = await Order.findOne({
      _id: req.valid.params.id,
      market: req.stall.market,
    }).select('_id fulfillment.status');

    // 404 rather than 403: a stall must not be able to probe for orders in
    // markets it has nothing to do with.
    if (!order) throw new ApiError(404, 'Order not found.', 'NOT_FOUND');

    if (!req.stall.isOpen) {
      throw new ApiError(409, 'Your stall is closed. Open it before accepting orders.', 'STALL_CLOSED');
    }

    const result = await sourcing.claimLines({
      orderId: order._id,
      stallId: req.stall._id,
      stallNumber: req.stall.stallNumber,
      lineIds: req.valid.body.lineIds,
      auto: false,
      actorId: req.user._id,
      // A stall may only take what it was actually asked for. Without this the
      // ranking would be advisory — any stall could claim any line the moment
      // it appeared, which is exactly the scramble the cascade replaced.
      requireOffer: true,
    });

    if (result.won.length === 0) {
      const message =
        result.reason === 'NOT_SOURCING'
          ? 'That order has already moved on.'
          : result.reason === 'NOT_OFFERED'
            ? 'Those items are not offered to your stall.'
            : 'Another stall took those items first.';
      throw new ApiError(409, message, result.reason || 'ALREADY_TAKEN');
    }

    const fresh = await Order.findById(order._id).lean();
    return res.json({
      data: {
        ...forStall(fresh, req.stall._id),
        won: result.won.map((i) => String(i.lineId)),
        lost: result.lost.map(String),
        // True when this claim was the one that completed the order.
        locked: Boolean(result.promoted),
      },
    });
  }
);

/**
 * Turn an offer down.
 *
 * There was no way to do this before, because there were no offers to turn
 * down — every stall saw every order and simply ignored what it could not
 * fill. Now that an order is addressed to specific stalls, saying no promptly
 * is worth something: the lines move to the next-ranked stall immediately
 * instead of waiting out the rest of the two-minute window.
 *
 * A decline is remembered for as long as the order stays in this market, so
 * the cascade never circles back and asks again.
 */
router.post(
  '/orders/:id/decline',
  ...stallGate,
  stallActionLimiter,
  validate({ params: z.object({ id: fields.objectId }).strict() }),
  async (req, res) => {
    const order = await Order.findOne({
      _id: req.valid.params.id,
      market: req.stall.market,
    }).select('_id');

    // 404 rather than 403, matching the claim route: a stall must not be able
    // to probe for orders in markets it has nothing to do with.
    if (!order) throw new ApiError(404, 'Order not found.', 'NOT_FOUND');

    const result = await sourcing.declineRound({ orderId: order._id, stallId: req.stall._id });

    if (!result.declined) {
      throw new ApiError(409, 'That order is no longer offered to your stall.', result.reason || 'NOT_YOURS');
    }

    return res.json({ data: { declined: true } });
  }
);

/**
 * Bagged and ready for the rider.
 *
 * Scoped to lines this stall actually holds, so one shopkeeper cannot mark
 * another's lines packed and send a rider to a stall with nothing ready.
 */
router.post(
  '/orders/:id/pack',
  ...stallGate,
  stallActionLimiter,
  validate({
    params: z.object({ id: fields.objectId }).strict(),
    body: z.object({ lineIds: z.array(fields.objectId).min(1).max(100).optional() }).strict(),
  }),
  async (req, res) => {
    const order = await Order.findOne({
      _id: req.valid.params.id,
      'items.claim.stall': req.stall._id,
    }).lean();
    if (!order) throw new ApiError(404, 'Order not found.', 'NOT_FOUND');

    // No list means "everything I hold on this order", which is what the pack
    // button on the stall screen actually means.
    const lineIds =
      req.valid.body.lineIds ||
      order.items
        .filter((i) => String(i.claim?.stall) === String(req.stall._id) && !i.claim.packedAt)
        .map((i) => String(i.lineId));

    if (lineIds.length === 0) {
      throw new ApiError(409, 'Nothing left to pack on this order.', 'NOTHING_TO_PACK');
    }

    const result = await sourcing.packLines({
      orderId: order._id,
      stallId: req.stall._id,
      lineIds,
    });

    if (!result.order) {
      throw new ApiError(409, 'That order is not being packed right now.', result.reason || 'NOT_PACKING');
    }

    return res.json({ data: forStall(result.order.toJSON ? result.order.toJSON() : result.order, req.stall._id) });
  }
);

// ---------------------------------------------------------------------------
// Earnings
// ---------------------------------------------------------------------------

/**
 * What this stall is owed, what has already been paid, and when the rest lands.
 *
 * Nothing appears here until a customer has actually taken delivery. An order
 * that was accepted, packed, then cancelled pays nothing, because nothing was
 * sold — which is worth showing plainly rather than letting a shopkeeper wonder
 * where an order went.
 */
router.get('/me/earnings', ...stallGate, async (req, res) => {
  const [summary, recent] = await Promise.all([
    settlement.summaryForOwner(req.user._id),
    settlement.recentForOwner(req.user._id),
  ]);

  return res.json({ data: { ...summary, recent } });
});

/**
 * Take the held money now rather than waiting for it.
 *
 * Rate-limited on the shopkeeper, because this is the one route here that moves
 * money and a retry loop against it is worth bounding hard.
 */
router.post('/me/earnings/withdraw', ...stallGate, stallActionLimiter, async (req, res) => {
  // Throws 409 BELOW_MINIMUM with the shortfall when there is not enough yet.
  const result = await settlement.releaseEarly(req.user._id);
  const summary = await settlement.summaryForOwner(req.user._id);

  return res.json({ data: { ...result, ...summary } });
});

module.exports = router;
