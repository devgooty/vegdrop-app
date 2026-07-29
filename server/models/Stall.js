'use strict';

const mongoose = require('mongoose');

/**
 * A single vendor's stall inside a market.
 *
 * This is the unit of ownership. Before stalls existed, `Product` had no owner
 * at all and any account holding the `shopkeeper` role could edit the entire
 * catalog — including other vendors' prices and stock. Every catalog write is
 * now scoped through the stall's `owner`.
 *
 * A shopkeeper owns at most one stall per market, enforced by a unique index, so
 * "which stall is this request acting as?" always has one answer.
 */

const stallSchema = new mongoose.Schema(
  {
    market: { type: mongoose.Schema.Types.ObjectId, ref: 'Market', required: true, index: true },

    // Human-facing identifier the rider reads off a sign: "B-12".
    stallNumber: { type: String, required: true, trim: true, maxlength: 20 },
    name: { type: String, required: true, trim: true, maxlength: 160 },

    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    phone: { type: String, required: true, trim: true, maxlength: 20 },

    /**
     * Optional precise pin. Large markets are a maze; the market centroid is not
     * enough to find one stall. Falls back to the market's location when unset.
     */
    location: {
      /**
       * No default on `type`. Defaulting it stamps every stall with
       * `location: { type: 'Point' }` and no coordinates, which a 2dsphere index
       * rejects outright ("Point must be an array or object") — so one stall
       * saved without a pin would break indexing for the whole collection.
       * The pre-validate hook below drops the subdocument entirely instead.
       */
      type: { type: String, enum: ['Point'] },
      coordinates: {
        type: [Number], // [lng, lat]
        default: undefined,
        validate: {
          validator: (v) =>
            v === undefined ||
            (Array.isArray(v) && v.length === 2 &&
              v[0] >= -180 && v[0] <= 180 && v[1] >= -90 && v[1] <= 90),
          message: 'coordinates must be [longitude, latitude] within valid ranges.',
        },
      },
    },

    /** Vendor-controlled: a stall closing for lunch should stop taking orders. */
    isOpen: { type: Boolean, default: true, index: true },
    /** Operator-controlled: suspension survives anything the vendor toggles. */
    isActive: { type: Boolean, default: true, index: true },

    // Median seconds to accept, used to show the customer an honest wait.
    avgAcceptSeconds: { type: Number, default: 0, min: 0 },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true, versionKey: false },
    toObject: { virtuals: true, versionKey: false },
  }
);

// One vendor, one stall per market — makes "act as my stall" unambiguous.
stallSchema.index({ market: 1, owner: 1 }, { unique: true });
stallSchema.index({ market: 1, stallNumber: 1 }, { unique: true });
stallSchema.index({ location: '2dsphere' }, { sparse: true });

/**
 * A stall with no pin stores no `location` at all, rather than a half-formed
 * point. Partial GeoJSON is not indexable, and an absent field is — the sparse
 * 2dsphere index simply skips it and the rider falls back to the market centroid.
 */
stallSchema.pre('validate', function dropEmptyLocation() {
  const coordinates = this.location?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length !== 2) {
    this.location = undefined;
  } else if (!this.location.type) {
    this.location.type = 'Point';
  }
});

stallSchema.virtual('id').get(function getId() {
  return this._id.toHexString();
});

/** A stall only takes orders when the vendor AND the operator both allow it. */
stallSchema.virtual('acceptsOrders').get(function acceptsOrders() {
  return this.isActive && this.isOpen;
});

module.exports = mongoose.model('Stall', stallSchema);
