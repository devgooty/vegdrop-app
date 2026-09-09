'use strict';

const mongoose = require('mongoose');

/**
 * The walked perimeter of a market, as a GeoJSON Polygon.
 *
 * Its own schema with `_id: false` rather than an inline object, for one
 * practical reason: an inline nested path in Mongoose materialises as `{}` on
 * every document whether or not anything was set, and a `boundary: {}` with no
 * `coordinates` is exactly the shape that makes `boundary?.coordinates?.[0]`
 * checks read as "present but empty" instead of "absent". A subdocument with
 * `default: null` is either a real polygon or null, with nothing in between.
 */
const boundarySchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['Polygon'], required: true, default: 'Polygon' },

    /**
     * One linear ring: [[[lng, lat], …, [lng, lat]]], first point repeated last.
     *
     * Exterior ring only — no holes. A market with a hole in it is not a thing,
     * and accepting the array-of-rings shape would mean validating rings we
     * have no way to capture.
     */
    coordinates: { type: [[[Number]]], required: true },
  },
  { _id: false }
);

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

    /**
     * The market's physical footprint, walked corner by corner by its owner.
     *
     * Null for every market that predates this field, and that has to keep
     * working: `services/geoFence.js` falls back to a radius around `location`
     * when there is no polygon, so an old market is joinable on looser terms
     * rather than not joinable at all. Requiring it would strand every existing
     * market and every shopkeeper trying to apply to one.
     *
     * `location` is NOT derived from this and is not replaced by it. The centre
     * point is what `$geoNear` ranks on for "markets near me", it is indexed for
     * that, and it is what a rider's map pin uses; the polygon answers a
     * different question — "is this person standing in the market" — and is
     * consulted only there.
     */
    boundary: { type: boundarySchema, default: null },

    /**
     * When the perimeter was last walked, and how many corners it took.
     *
     * Stored rather than derived because `coordinates[0].length` counts the
     * repeated closing point, so it is always one more than the number of times
     * the owner actually stopped and tapped — and a screen that says "12 points"
     * for an 11-corner walk is the kind of small lie that makes people distrust
     * the rest of the number.
     */
    boundaryCapturedAt: { type: Date, default: null },
    boundaryNodeCount: { type: Number, default: 0, min: 0 },

    /** Enclosed area in m², computed at capture. Shown to the owner as a sanity check. */
    boundaryAreaSqMeters: { type: Number, default: 0, min: 0 },

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

/**
 * Required for $geoNear. Without it the nearby query throws rather than
 * degrading.
 *
 * SINCE `boundary` WAS ADDED, EVERY `$geoNear` ON Market MUST NAME ITS `key`.
 *
 * There are now two 2dsphere indexes on this collection, and `$geoNear` will
 * not choose between them — it fails outright with `IndexNotFound`, which reads
 * like a missing index rather than an ambiguous one and sends you looking in
 * the wrong place. Ranking markets by distance always means distance to the
 * PIN, so those stages pass `key: 'location'`: see routes/markets.js /nearby
 * and services/sourcing.js. The identical trap is documented on User, which
 * grew a second geo index for the same kind of reason.
 */
marketSchema.index({ location: '2dsphere' });
marketSchema.index({ isActive: 1, isOpen: 1 });

/**
 * Lets Mongo answer "which market contains this point", and — more usefully
 * today — makes it validate the polygon on write.
 *
 * A 2dsphere index only covers documents that HAVE the field, so the markets
 * with a null boundary are simply not in it; no migration is needed and no
 * existing row can fail the build. New key shape, so `createIndexes` adds it
 * cleanly — the two-part change described in CLAUDE.md applies to altering an
 * index's options, which this is not.
 *
 * The validation is the point of adding it now. Mongo rejects a self-
 * intersecting or unclosed ring at insert time, which is a second opinion on
 * `validateBoundary` rather than a substitute for it: that function runs first
 * precisely so the owner gets "your walk crosses itself between points 4 and 9"
 * instead of a driver error surfacing as a 500.
 */
marketSchema.index({ boundary: '2dsphere' });

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
