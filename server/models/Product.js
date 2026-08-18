'use strict';

const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    sku: { type: String, required: true, unique: true, index: true, trim: true },

    /**
     * The shopkeeper who listed this, for products belonging to an independent
     * shop's own catalog.
     *
     * Null means the shared platform catalog: the seeded rows, and anything a
     * market_owner or developer adds. Markets sell from that shared catalog and
     * override price through MarketPrice, so leaving this null is what keeps the
     * market path unchanged.
     */
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    /**
     * Which shared-catalog item this listing IS.
     *
     * A shop's listings are its own rows — `owner` is the shopkeeper and `sku` is
     * globally unique — so Ravi's tomatoes and Anand's tomatoes are two
     * documents with nothing in common but the word "tomatoes". That was fine
     * while a basket was built from one shop's catalog and could only ever be
     * ordered from that shop. It is not enough to answer "which nearby shop
     * stocks most of this basket", which needs the same item recognised across
     * shops.
     *
     * So a shop-owned row points at the `owner: null` catalog row it is an
     * instance of, and coverage becomes an exact indexed match rather than a
     * guess at names — which matter here, because names are free text in three
     * scripts and a WRONG match is worse than none: it routes an order to a shop
     * that then cannot fill it.
     *
     * Null on a shared catalog row, because such a row already IS the canonical
     * item. Null on a shop row means "not linked yet" — that listing is
     * invisible to coverage until someone links it, which is why
     * `migrateProductCatalogItem` reports how many it could not match and the
     * vendor panel flags them.
     */
    catalogItem: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      default: null,
      index: true,
    },

    categoryId: { type: Number, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },

    /**
     * The name in Telugu and Hindi.
     *
     * Optional, and deliberately not defaulted to `name`: an empty value has to
     * stay distinguishable from a real translation, because that is what lets
     * the client fall back to English for one product without every untranslated
     * row looking translated. `productName()` in src/i18n does that resolution.
     *
     * `name` stays required and stays English. It is what the shopkeeper panel,
     * order records and support conversations key on, and a product whose only
     * name is in a script the operator cannot read is a product nobody can help
     * a customer with.
     *
     * maxlength matches `name`, but note these are measured in UTF-16 code
     * units, and Telugu and Hindi both spend several per visible character —
     * 200 is generous for a product name in any of the three, so this is a sanity
     * bound rather than a real limit.
     */
    nameTe: { type: String, default: '', trim: true, maxlength: 200 },
    nameHi: { type: String, default: '', trim: true, maxlength: 200 },

    weight: { type: String, default: '', maxlength: 60 },

    // Integer paise. This is the authoritative price; clients never supply it.
    pricePaise: {
      type: Number,
      required: true,
      min: 0,
      validate: { validator: Number.isInteger, message: 'pricePaise must be an integer.' },
    },
    oldPricePaise: {
      type: Number,
      default: null,
      min: 0,
      validate: {
        validator: (v) => v === null || Number.isInteger(v),
        message: 'oldPricePaise must be an integer or null.',
      },
    },

    rating: { type: Number, default: 0, min: 0, max: 5 },
    reviews: { type: Number, default: 0, min: 0 },
    image: { type: String, default: '', maxlength: 2000 },
    isOrganic: { type: Boolean, default: false },

    stock: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: { validator: Number.isInteger, message: 'stock must be an integer.' },
    },

    isActive: { type: Boolean, default: true, index: true },

    /**
     * Who listed this, and therefore who may edit it.
     *
     * The catalog is one shared table with no per-row ownership, which was fine
     * while `shopkeeper` was a role an administrator handed out. Vendor
     * self-registration changed that: anyone who passes a penny drop reaches
     * `PATCH /api/products/:id`, and without this field that call could reprice,
     * restock or deactivate a competitor's entire listing.
     *
     * Null means nobody claimed it — seeded catalog and everything created
     * before this existed. Those stay editable by `market_owner` and `developer`
     * only, which is the safe reading of "unowned": a shared row is not the
     * property of whichever vendor reaches it first.
     */
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true, versionKey: false },
    toObject: { virtuals: true, versionKey: false },
  }
);

/**
 * The coverage query: of these catalog items, which does each of these shops
 * hold? Both fields are equality-matched together every time, so one compound
 * index serves it where the two single-field ones above cannot.
 *
 * New, so the `IndexKeySpecsConflict` trap in CLAUDE.md does not apply here —
 * there is no older definition of this index on any database to conflict with.
 */
productSchema.index({ catalogItem: 1, owner: 1 });

productSchema.virtual('id').get(function getId() {
  return this._id.toHexString();
});

/** Rupee views for presentation. Persistence stays in paise. */
productSchema.virtual('price').get(function price() {
  return this.pricePaise / 100;
});
productSchema.virtual('oldPrice').get(function oldPrice() {
  return this.oldPricePaise === null ? null : this.oldPricePaise / 100;
});

module.exports = mongoose.model('Product', productSchema);
