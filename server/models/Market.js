'use strict';

const mongoose = require('mongoose');

/**
 * A physical vegetable market.
 *
 * This is what a customer picks — not a stall. The market holds the price sheet
 * (see MarketPrice) and contains the numbered stalls that actually fill an order.
 */
const marketSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true, maxlength: 80 },
    address: { type: String, required: true, trim: true, maxlength: 500 },

    /**
     * The market_owner who runs this market.
     *
     * Until this existed, `market_owner` was a global administrator: routes/orders.js
     * handed the role an empty filter, so every market owner could read every
     * market's orders, and "my market" had no meaning. Ownership is what scopes
     * the role down to the one market a person actually runs.
     *
     * Optional rather than required because markets predate this field and a
     * required one would fail to load them. An unowned market is administered by
     * `developer` alone, which is the pre-existing behaviour, not a new hole.
     */
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    /**
     * GeoJSON Point, [longitude, latitude] — that order, not lat/lng. Reversing
     * it puts an Indian market in the Indian Ocean and every distance query
     * quietly returns nothing.
     */
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: {
        type: [Number],
        required: true,
        validate: {
          validator: (v) =>
            Array.isArray(v) &&
            v.length === 2 &&
            v[0] >= -180 && v[0] <= 180 &&
            v[1] >= -90 && v[1] <= 90,
          message: 'coordinates must be [longitude, latitude] within valid ranges.',
        },
      },
    },

    /** How far this market will deliver. Used to decide which markets a customer sees. */
    serviceRadiusMeters: { type: Number, default: 6000, min: 100, max: 50000 },

    /** Owner-set trading hours switch. A closed market is never offered an order. */
    isOpen: { type: Boolean, default: true, index: true },
    isActive: { type: Boolean, default: true, index: true },

    /** Contact for the market office, shown to riders who cannot find a stall. */
    contactPhone: { type: String, default: '', maxlength: 20 },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true, versionKey: false },
    toObject: { virtuals: true, versionKey: false },
  }
);

// Required for $geoNear. Without it the nearby query throws rather than degrading.
marketSchema.index({ location: '2dsphere' });
marketSchema.index({ isActive: 1, isOpen: 1 });

marketSchema.virtual('id').get(function getId() {
  return this._id.toHexString();
});

/** Convenience for callers that think in lat/lng rather than GeoJSON order. */
marketSchema.virtual('lat').get(function lat() {
  return this.location?.coordinates?.[1] ?? null;
});
marketSchema.virtual('lng').get(function lng() {
  return this.location?.coordinates?.[0] ?? null;
});

module.exports = mongoose.model('Market', marketSchema);
