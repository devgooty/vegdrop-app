/**
 * Static reference data.
 *
 * Only the category taxonomy survives here. `sampleProducts`, `initialOrders`,
 * `initialRegisteredUsers` and `initialScheduledOrders` were removed with the
 * code that seeded them into App, ShopkeeperApp and DeliveryApp: invented
 * produce, customers and orders rendered as real data on first paint and stayed
 * there whenever a fetch failed. Categories are different in kind — there is no
 * categories endpoint, and these are the aisles of a market rather than records
 * of anything.
 */

/** A specific Unsplash photo, sized for a small square chip or category tile. */
function producePhoto(id) {
  return `https://images.unsplash.com/photo-${id}?w=300&auto=format&fit=crop&q=80`;
}

/**
 * The everyday vegetable aisle, one tile per item rather than one broad
 * "Fresh Vegetables" bucket — mirrors what LoginPage.jsx scrolls on the
 * sign-in screen, so the same items a visitor sees before signing in are the
 * ones they can tap into on the home screen below.
 *
 * Photos are deliberately "a pile/bunch/basket of" shots, not single isolated
 * items on white — a lone potato on white reads as a product photo, a pile of
 * them reads as produce, which is the point of a market's vegetable aisle.
 * Two items (bottle gourd, cabbage) keep a single-item shot: no multi-piece
 * photo of either could be confirmed as the right vegetable rather than a
 * lookalike gourd or a mislabeled search result, and a wrong "group" photo is
 * worse than a correct single one.
 */
export const marketVegetables = [
  { slug: 'tomato', title: 'Tomato', imageUrl: producePhoto('1518977822534-7049a61ee0c2') },
  { slug: 'green-chilli', title: 'Chilli', imageUrl: producePhoto('1704473509931-971356e22feb') },
  { slug: 'peas', title: 'Peas', imageUrl: producePhoto('1690023614293-ac2ba2eb0731') },
  { slug: 'brinjal', title: 'Brinjal', imageUrl: producePhoto('1683543122945-513029986574') },
  { slug: 'cucumber', title: 'Cucumber', imageUrl: producePhoto('1694153192731-ab5445654427') },
  { slug: 'bottle-gourd', title: 'Bottle Gourd', imageUrl: producePhoto('1776653097091-47334b767dfa') },
  { slug: 'onion', title: 'Onion', imageUrl: producePhoto('1678954157605-38cc2f12c780') },
  { slug: 'cabbage', title: 'Cabbage', imageUrl: producePhoto('1583116935756-f66cd999cdbe') },
  { slug: 'cauliflower', title: 'Cauliflower', imageUrl: producePhoto('1784043437088-c86a43eb695d') },
  { slug: 'carrot', title: 'Carrot', imageUrl: producePhoto('1633380110125-f6e685676160') },
  { slug: 'beetroot', title: 'Beetroot', imageUrl: producePhoto('1639402480805-ea8ef529e028') },
  { slug: 'potato', title: 'Potato', imageUrl: producePhoto('1518977676601-b53f82aba655') },
  { slug: 'spinach', title: 'Spinach', imageUrl: producePhoto('1576045057995-568f588f82fb') },
  { slug: 'coriander', title: 'Coriander', imageUrl: producePhoto('1723810330043-dd05647294cb') },
  { slug: 'ginger', title: 'Ginger', imageUrl: producePhoto('1635843104103-ddd88e1c5141') },
  { slug: 'garlic', title: 'Garlic', imageUrl: producePhoto('1540148426945-6cf22a6b2383') },
  { slug: 'ridge-gourd', title: 'Ridge Gourd', imageUrl: producePhoto('1759156632043-eab44e007e67') },
  { slug: 'bitter-gourd', title: 'Bitter Gourd', imageUrl: producePhoto('1739903760939-743aec69a05f') },
  { slug: 'okra', title: 'Okra', imageUrl: producePhoto('1558408525-1092038389ae') },
  { slug: 'capsicum', title: 'Capsicum', imageUrl: producePhoto('1563565375-f3fdfdbefa83') },
  { slug: 'sweet-potato', title: 'Sweet Potato', imageUrl: producePhoto('1744659749700-c4213f840355') },
  { slug: 'green-beans', title: 'Green Beans', imageUrl: producePhoto('1567375698348-5d9d5ae99de0') },
  { slug: 'spring-onion', title: 'Spring Onion', imageUrl: producePhoto('1559836833-2a2c99b1f54f') },
  { slug: 'turnip', title: 'Turnip', imageUrl: producePhoto('1648291913186-951f2ef36c85') },
];

export const initialCategories = [
  {
    id: 1,
    slug: 'leafy-greens',
    title: 'Leafy Greens',
    imageUrl: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=300&auto=format&fit=crop&q=80',
    itemCount: 12,
    badge: 'Fresh Today',
  },
  {
    id: 2,
    slug: 'fresh-vegetables',
    title: 'Fresh Vegetables',
    imageUrl: 'https://images.unsplash.com/photo-1566385101042-1a0aa0c1268c?w=300&auto=format&fit=crop&q=80',
    itemCount: 24,
    badge: 'Popular',
  },
  {
    id: 3,
    slug: 'organic-fruits',
    title: 'Organic Fruits',
    imageUrl: 'https://images.unsplash.com/photo-1619566636858-adf3ef46400b?w=300&auto=format&fit=crop&q=80',
    itemCount: 18,
    badge: '100% Organic',
  },
  {
    id: 4,
    slug: 'exotic-imported',
    title: 'Exotic & Herbs',
    imageUrl: 'https://images.unsplash.com/photo-1608686207856-001b95cf60ca?w=300&auto=format&fit=crop&q=80',
    itemCount: 9,
    badge: 'Imported',
  },
  // Ids continue from 4 rather than restarting, so they can never collide
  // with a real product's `categoryId` written against the four aisles
  // above — CategoryDetailView filters products by `categoryId === category.id`,
  // and that match is production-load-bearing. No `itemCount` on these: unlike
  // the four above, that field is decorative dead weight nothing here can
  // compute honestly without a real per-category product count from the API —
  // omitted rather than invented.
  //
  // Not rendered as their own home-page tiles — every non-leafy item here is
  // a real Product under categoryId 2 (see SEED_PRODUCTS in
  // server/utils/seed.js), so it already shows up as an addable-to-cart card
  // in the "Fresh Vegetables" tile and carousel. These ids exist so a
  // shopkeeper's own category picker can still offer the exact vegetable
  // rather than only the umbrella bucket.
  ...marketVegetables.map((veg, i) => ({ id: 5 + i, slug: veg.slug, title: veg.title, imageUrl: veg.imageUrl })),
];
