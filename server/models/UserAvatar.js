'use strict';

const mongoose = require('mongoose');

/**
 * A profile photograph the account holder uploaded.
 *
 * WHY THIS IS NOT A FIELD ON User
 *
 * `middleware/auth.js` re-reads the whole User document on EVERY authenticated
 * request, so that a demotion or a suspension applies immediately. A base64
 * image on that document would be dragged through the hot path of every API
 * call in the system — and the three role apps poll orders every five seconds.
 * The same reasoning is spelled out at length on models/StallPhoto.js.
 *
 * Kept in its own collection, nothing on the auth path can touch it by
 * accident, which is a structural guarantee rather than a comment asking
 * future callers to remember.
 *
 * A preset avatar is NOT stored here: it is a short slug on `User.avatar`,
 * because it costs a dozen bytes and the client draws it from that key alone.
 */
const userAvatarSchema = new mongoose.Schema(
  {
    /** One photo per account; a new upload replaces it. */
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },

    /**
     * Base64 payload only — the `data:image/jpeg;base64,` prefix is stripped on
     * the way in and rebuilt by the `dataUri` virtual on the way out.
     */
    image: { type: String, required: true },

    /**
     * Restricted at the route to jpeg and webp. Never SVG — an SVG is a script
     * container, and this one is rendered back into a page.
     */
    mimeType: { type: String, required: true, enum: ['image/jpeg', 'image/webp'] },

    /** Decoded size, so the cap can be reported without re-decoding. */
    bytes: { type: Number, required: true, min: 1 },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true, versionKey: false },
    toObject: { virtuals: true, versionKey: false },
  }
);

/** `data:image/jpeg;base64,…`, the form an <img src> wants. */
userAvatarSchema.virtual('dataUri').get(function dataUri() {
  return `data:${this.mimeType};base64,${this.image}`;
});

module.exports = mongoose.model('UserAvatar', userAvatarSchema);
