'use strict';

const mongoose = require('mongoose');

/**
 * A GeoJSON Point, shared by every model that carries a position.
 *
 * Always attach it with `default: undefined`:
 *
 *   lastLocation: { type: geoPointSchema, default: undefined }
 *
 * Without that, Mongoose eagerly materialises `{ type: 'Point', coordinates: [] }`
 * on every document. An empty coordinate array is not valid GeoJSON, and a
 * 2dsphere index rejects it outright ("Can't extract geo keys") — so a single
 * unset position would fail the insert of every document in the collection.
 * Absent, the index simply skips the document.
 *
 * Coordinates are [longitude, latitude], in that order. Reversing them is the
 * classic bug here: it puts an Indian market in the Indian Ocean, and every
 * distance query then quietly returns nothing rather than erroring.
 */
const geoPointSchema = new mongoose.Schema(
  {
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
  { _id: false }
);

/** Build a Point from the lat/lng order humans and browser APIs actually use. */
function pointFromLatLng(lat, lng) {
  return { type: 'Point', coordinates: [lng, lat] };
}

module.exports = geoPointSchema;
module.exports.geoPointSchema = geoPointSchema;
module.exports.pointFromLatLng = pointFromLatLng;
