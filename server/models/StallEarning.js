'use strict';

const mongoose = require('mongoose');

/**
 * What a SELLER is owed for one order — a market stall, or an independent shop.
 *
 * The name is historical: this started out stall-only, and renaming the model
 * would rename the collection under it. Read `stall` and `shop` as the two
 * shapes one obligation can take, exactly one of which is ever set.
 *
 * The shop case was missing entirely, and it lost real money. A wallet-paid
 * order at an independent shop debited the customer and recorded nothing, so
 * the shopkeeper was never paid — no obligation existed for the release sweep
 * to find. Both sellers reach their money by the same route now.
 *
 * Created at the moment the customer takes delivery — never before. A seller
 * that accepted and packed an order that was then cancelled is owed nothing,
 * because nothing was sold.
 *
 * From there the money is HELD (`pending`) for a configurable window, then
 * released into the shopkeeper's wallet automatically. The hold exists because
 * a delivery can still go wrong after it lands, and unpaid money is far easier
 * to withhold than paid money is to recover.
 *
 * This is a record of an obligation, not the money itself. The money is the
 * WalletTransaction written when this is released, and that transaction's
 * idempotency key is derived from this document's id — so a stall cannot be
 * paid twice for the same order no matter how many times the release runs.
 */
const earningLineSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, maxlength: 200 },
    quantity: { type: Number, required: true, min: 1 },
    // The market's price, which is what the stall is paid — not the customer's
    // locked price, which can differ once an order has hopped markets.
    unitPricePaise: { type: Number, required: true, min: 0 },
    lineTotalPaise: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const stallEarningSchema = new mongoose.Schema(
  {
    /**
     * The market stall that supplied these lines, when the seller was one.
     *
     * Null for an independent shop. Optional rather than required so the one
     * model can carry both, and `{ order, stall }` below still enforces one
     * obligation per seller per order in either shape.
     */
    stall: { type: mongoose.Schema.Types.ObjectId, ref: 'Stall', default: null, index: true },
    stallNumber: { type: String, default: null, maxlength: 24 },

    /**
     * The independent shop that supplied the whole order, when the seller was
     * one. A User id, because in this model the shop IS the shopkeeper — the
     * same reasoning as `Order.shop`.
     *
     * Exactly one of `stall` and `shop` is set; the validator below is what
     * stops a half-built obligation being written that neither payout path
     * would recognise.
     */
    shop: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    /**
     * The shopkeeper who gets paid, denormalised from the stall.
     *
     * Held here rather than looked up at release time on purpose: if a stall
     * changes hands, money earned under the previous owner must still go to the
     * previous owner. For a shop it is simply the shop itself.
     */
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** The market the stall trades in. Null for an independent shop. */
    market: { type: mongoose.Schema.Types.ObjectId, ref: 'Market', default: null },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    orderNumber: { type: String, required: true, maxlength: 40 },

    lines: { type: [earningLineSchema], required: true },

    grossPaise: { type: Number, required: true, min: 0 },
    commissionPaise: { type: Number, required: true, min: 0, default: 0 },
    /** What actually reaches the wallet. gross − commission. */
    netPaise: { type: Number, required: true, min: 0 },

    status: {
      type: String,
      required: true,
      enum: ['pending', 'released'],
      default: 'pending',
      index: true,
    },

    /** When the customer took delivery. The hold is measured from here. */
    earnedAt: { type: Date, required: true },
    /** When it becomes payable without asking. */
    releaseAt: { type: Date, required: true },
    releasedAt: { type: Date, default: null },
    /** True when the shopkeeper asked for it before the hold expired. */
    releasedEarly: { type: Boolean, default: false },

    /** The ledger entry that actually moved the money. */
    walletTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'WalletTransaction', default: null },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true, versionKey: false },
    toObject: { virtuals: true, versionKey: false },
  }
);

/**
 * Exactly one seller, and it must be the one the owner was derived from.
 *
 * A document with neither is unpayable; one with both is ambiguous about which
 * catalog priced it. Enforced here rather than at the call site because
 * settlement now has two entry points writing this shape.
 */
stallEarningSchema.pre('validate', function requireExactlyOneSeller() {
  // Throws rather than calling a `next` callback: Mongoose 9 middleware is
  // promise-based, and a one-argument hook here is handed `undefined`.
  const hasStall = Boolean(this.stall);
  const hasShop = Boolean(this.shop);
  if (hasStall === hasShop) {
    throw new Error('A StallEarning must name exactly one of `stall` or `shop`.');
  }
  if (hasStall && !this.market) {
    throw new Error('A stall earning must record the market it was earned in.');
  }
});

/**
 * One earning per seller per order.
 *
 * This is the guard that makes recording idempotent: a redelivered or replayed
 * completion collides on the index instead of creating a second obligation.
 *
 * It covers the shop case too, without a second index. A shop order writes one
 * document with `stall: null`, and MongoDB treats null as a value in a unique
 * index — so a replay presents the same `{ order, null }` pair and collides.
 * The reverse index (`{ order, shop }`) would NOT work: a market order can have
 * four stall earnings, all with `shop: null`, and they would collide with each
 * other.
 */
stallEarningSchema.index({ order: 1, stall: 1 }, { unique: true });

/** The release sweep: everything due, oldest first. */
stallEarningSchema.index({ status: 1, releaseAt: 1 });
/** The shopkeeper's own earnings screen. */
stallEarningSchema.index({ owner: 1, status: 1, earnedAt: -1 });

stallEarningSchema.virtual('id').get(function getId() {
  return this._id.toHexString();
});
stallEarningSchema.virtual('net').get(function net() {
  return this.netPaise / 100;
});

module.exports = mongoose.model('StallEarning', stallEarningSchema);
