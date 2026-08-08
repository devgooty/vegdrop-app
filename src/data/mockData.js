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
];
