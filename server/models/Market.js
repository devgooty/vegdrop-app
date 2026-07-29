'use strict';

const mongoose = require('mongoose');

/**
 * A physical vegetable market containing many stalls.
 *
 * `location` is a GeoJSON Point in [longitude, latitude] order — that ordering is
 * GeoJSON's, not the [lat, lng] most map UIs use, and getting it backwards puts
 * an Indian market in the Indian Ocean. Conversion happens once, at the API
 * boundary in routes/markets.js.
 */

const marketSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    slug: { type: String, required: true, unique: true, index: true, trim: true, lowercase: true },

    address: { type: String, required: true, trim: true, maxlength: 500 },
    city: { type: String, required: true, trim: true, maxlength: 120, index: true },
    pincode: { type: String, default: '', trim: true, maxlength: 12 },

    location: {
      type: { type: String, enum: ['Point'], required: true, default: 'Point' },
      coordinates: {
        type: [Number], // [lng, lat]
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

    /**
     * How far this market will deliver. A customer outside every market's radius
     * is genuinely unserviceable, and telling them so beats a failed checkout.
     */
    serviceRadiusM: {
      type: Number,
      required: true,
      default: 5000,
      min: 100,
      max: 50_000,
      validate: { validator: Number.isInteger, message: 'serviceRadiusM must be an integer.' },
    },

    // Minutes from midnight, local time. 06:00 -> 360.
    opensAtMinute: { type: Number, default: 360, min: 0, max: 1439 },
    closesAtMinute: { type: Number, default: 1260, min: 0, max: 1439 },

    isActive: { type: Boolean, default: true, index: true },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true, versionKey: false },
    toObject: { virtuals: true, versionKey: false },
  }
);

marketSchema.index({ location: '2dsphere' });

marketSchema.virtual('id').get(function getId() {
  return this._id.toHexString();
});

/** Presentation view: map UIs want [lat, lng]. */
marketSchema.virtual('latitude').get(function latitude() {
  return this.location?.coordinates?.[1] ?? null;
});
marketSchema.virtual('longitude').get(function longitude() {
  return this.location?.coordinates?.[0] ?? null;
});

marketSchema.virtual('isOpenNow').get(function isOpenNow() {
  const now = new Date();
  const minute = now.getHours() * 60 + now.getMinutes();
  // A window that wraps past midnight (e.g. 22:00 -> 02:00) is still contiguous.
  if (this.closesAtMinute >= this.opensAtMinute) {
    return minute >= this.opensAtMinute && minute < this.closesAtMinute;
  }
  return minute >= this.opensAtMinute || minute < this.closesAtMinute;
});

module.exports = mongoose.model('Market', marketSchema);
