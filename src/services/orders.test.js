import { describe, it, expect } from 'vitest';
import { toUiOrder, ORDER_STATUSES } from './orders';

/**
 * The wire-shape contract between `toUiOrder` and everything that renders an
 * order.
 *
 * This exists because of a bug the server suite structurally could not catch.
 * `toUiOrder` renames most of the server's order fields on the way in --
 * `totalAmountPaise` becomes `totalAmount` in rupees, `createdAt` becomes
 * `timestamp`, and the `customer` / address objects are flattened to
 * `customerName` / `phone` / `address`. The Developer Console's Orders table
 * was written against the SERVER names, so it read `o.total`, `o.createdAt`,
 * `o.customer?.name` and `o.deliveryAddress?.phone` -- none of which this
 * mapper has ever produced. Every row rendered a zero total, an em dash for the
 * date, and the literal word "Customer" with no phone. Nothing threw, no
 * request failed, and `server/test/packs.test.js` -- which locks the pack
 * arithmetic -- had nothing to say about it, because the defect was entirely on
 * the client side of the boundary.
 *
 * So the assertions below are deliberately about NAMES and UNITS, not about
 * arithmetic. A rename here is a breaking change for every screen downstream,
 * and this is the file that should fail when someone makes one.
 */

/** A server order as `GET /api/orders` actually serialises one. */
function serverOrder(overrides = {}) {
  return {
    id: '65f000000000000000000001',
    orderNumber: 'VB12AB34',
    customerName: 'Ramesh Kumar',
    phone: '9876543210',
    address: '12 Test Lane, Mehdipatnam',
    status: 'Preparing',
    paymentMethod: 'cod',
    paymentStatus: 'pending',
    subtotalPaise: 24000,
    deliveryFeePaise: 1000,
    totalAmountPaise: 25000,
    createdAt: '2026-09-12T04:30:00.000Z',
    items: [
      { product: '65f0000000000000000000aa', name: 'Tomatoes', quantity: 2, unitPricePaise: 12000 },
    ],
    ...overrides,
  };
}

describe('toUiOrder wire shape', () => {
  it('exposes the money as rupees under totalAmount, not total', () => {
    const ui = toUiOrder(serverOrder());

    expect(ui.totalAmount).toBe(250);
    expect(ui.subtotal).toBe(240);
    expect(ui.deliveryFee).toBe(10);

    // The name the admin table used to read. If a future change introduces a
    // `total` alias, delete this line rather than leaving both names live --
    // two spellings of one number is how the original bug survived review.
    expect(ui.total).toBeUndefined();
  });

  it('exposes the placed-at moment as a numeric timestamp, not createdAt', () => {
    const ui = toUiOrder(serverOrder());

    expect(typeof ui.timestamp).toBe('number');
    expect(ui.timestamp).toBe(Date.parse('2026-09-12T04:30:00.000Z'));
    expect(ui.createdAt).toBeUndefined();

    // `new Date(ui.timestamp)` has to produce a real date: the table renders
    // exactly that, and an em dash was the visible symptom when it did not.
    expect(Number.isNaN(new Date(ui.timestamp).getTime())).toBe(false);
  });

  it('flattens the customer to customerName and phone, with no customer object', () => {
    const ui = toUiOrder(serverOrder());

    expect(ui.customerName).toBe('Ramesh Kumar');
    expect(ui.phone).toBe('9876543210');
    expect(ui.customer).toBeUndefined();
  });

  it('keeps the delivery address a string, so it is never read as an object', () => {
    const ui = toUiOrder(serverOrder());

    // Both names carry the same string. `deliveryAddress?.name` returning
    // undefined on a string -- rather than throwing -- is precisely why the
    // admin table failed silently.
    expect(ui.address).toBe('12 Test Lane, Mehdipatnam');
    expect(ui.deliveryAddress).toBe('12 Test Lane, Mehdipatnam');
    expect(typeof ui.deliveryAddress).toBe('string');
  });

  it('prices line items in rupees under price', () => {
    const ui = toUiOrder(serverOrder());

    expect(ui.items).toHaveLength(1);
    expect(ui.items[0]).toMatchObject({ name: 'Tomatoes', quantity: 2, price: 120 });
    // quantity x price is what the detail modal renders as the line total.
    expect(ui.items[0].quantity * ui.items[0].price).toBe(240);
  });

  it('identifies the order by its human order number', () => {
    const ui = toUiOrder(serverOrder());

    expect(ui.id).toBe('VB12AB34');
    expect(ui.serverId).toBe('65f000000000000000000001');
  });

  it('returns null for a missing order rather than an empty shell', () => {
    expect(toUiOrder(null)).toBeNull();
    expect(toUiOrder(undefined)).toBeNull();
  });

  it('survives an order with no items, money or date', () => {
    // Every screen renders a list before it renders a detail, so a partially
    // populated row must not throw on the way through the mapper.
    const ui = toUiOrder({ id: 'x', orderNumber: 'VB0', status: 'Pending' });

    expect(ui.totalAmount).toBe(0);
    expect(ui.subtotal).toBe(0);
    expect(ui.items).toEqual([]);
    expect(typeof ui.timestamp).toBe('number');
  });
});

/**
 * The status vocabulary, which is a contract with the server's enum.
 *
 * This exists because the Developer Console's Orders table kept its own copy of
 * this list and one entry in it -- 'Placed' -- has never been a member of
 * `ORDER_STATUSES` in `server/models/Order.js`. Nothing failed: the chip
 * rendered, `o.status === 'Placed'` matched no row, and the table went blank.
 * Worse, having a wrong entry disguised a missing one -- 'Pending', the state
 * every order is created in, had no chip at all, so the newest orders were the
 * ones an operator could not filter for.
 *
 * If the server's enum changes, this test is what should fail.
 */
describe('ORDER_STATUSES', () => {
  it('is exactly the server enum, in order', () => {
    expect(ORDER_STATUSES).toEqual([
      'Pending',
      'Preparing',
      'Out for Delivery',
      'Delivered',
      'Cancelled',
    ]);
  });

  it('does not contain a status the server has never had', () => {
    // The specific wrong value, named so a reintroduction is loud.
    expect(ORDER_STATUSES).not.toContain('Placed');
  });

  it('includes the state a new order is actually in', () => {
    expect(ORDER_STATUSES[0]).toBe('Pending');
  });
});
