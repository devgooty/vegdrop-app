'use strict';

const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Market = require('../models/Market');
const Stall = require('../models/Stall');
const VendorKyc = require('../models/VendorKyc');
const RiderBankDetails = require('../models/RiderBankDetails');
const WalletTransaction = require('../models/WalletTransaction');
const StallEarning = require('../models/StallEarning');
const { requireAuth, requireRole } = require('../middleware/auth');
const { isConnected } = require('../db/connect');
const config = require('../config/env');
const { startOfMarketDay } = require('../utils/marketDay');

const router = express.Router();

/**
 * The market's timezone, in the form `$dateToString` accepts.
 *
 * Every date on this console is a market day, not a server day — see
 * `utils/marketDay.js`, whose header describes the exact bug this replaces.
 * The KPIs used the server's local midnight, the charts grouped by UTC, and the
 * weekday labels came off a third clock again; on a UTC host that filed every
 * order placed before 05:30 IST under the previous day, which is a good part of
 * a vegetable market's morning.
 *
 * Built from the same config value `startOfMarketDay` reads, so the aggregate
 * and the JS can never disagree about where a day starts.
 */
const MARKET_TZ_OFFSET_MS = config.marketDay.timezoneOffsetMinutes * 60 * 1000;
const MARKET_TZ = (() => {
  const mins = config.marketDay.timezoneOffsetMinutes;
  const abs = Math.abs(mins);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${mins < 0 ? '-' : '+'}${hh}:${mm}`;
})();

/** The market-local calendar date (YYYY-MM-DD) an instant falls on. */
function marketDateString(at) {
  return new Date(at.getTime() + MARKET_TZ_OFFSET_MS).toISOString().slice(0, 10);
}

/** The market-local weekday for a market-local date string. */
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function marketDayLabel(dateStr) {
  return DAY_LABELS[new Date(`${dateStr}T00:00:00Z`).getUTCDay()];
}

// All developer routes are strictly locked to the developer role
const developerGate = [requireAuth, requireRole('developer')];

/**
 * 1. Overview KPIs and Revenue Trends
 * GET /api/developer/overview
 */
router.get('/overview', ...developerGate, async (req, res, next) => {
  try {
    const now = new Date();
    const startOfToday = startOfMarketDay(now);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      totalUsersCount,
      roleCounts,
      totalOrdersCount,
      todayOrders,
      allTimeDeliveredOrders,
      sevenDayTrends,
      recentOrders,
      recentUsers,
      totalMarketsCount,
      totalStallsCount,
      pendingStallRequestsCount,
      pendingKycCount,
      commissionTotals,
      todayCommissionTotals
    ] = await Promise.all([
      User.countDocuments({ status: { $ne: 'deleted' } }),
      User.aggregate([
        { $match: { status: { $ne: 'deleted' } } },
        { $group: { _id: '$role', count: { $sum: 1 } } }
      ]),
      Order.countDocuments(),
      Order.find({ createdAt: { $gte: startOfToday } }).lean(),
      Order.aggregate([
        // Every non-cancelled order, stated the same way as the 30-day trend
        // below. The previous $in listed 'Placed', which is not a member of
        // ORDER_STATUSES, and silently omitted 'Pending' — so the lifetime
        // sales figure dropped every order that had not yet been picked up.
        { $match: { status: { $ne: 'Cancelled' } } },
        // Summed in paise and divided once at the end. Dividing each row first
        // accumulates float error across every order the platform has ever
        // taken, which is the drift integer paise exists to avoid.
        { $group: { _id: null, totalSalesPaise: { $sum: '$totalAmountPaise' }, count: { $sum: 1 } } }
      ]),
      Order.aggregate([
        {
          $match: {
            createdAt: { $gte: thirtyDaysAgo },
            status: { $ne: 'Cancelled' }
          }
        },
        {
          $group: {
            _id: {
              $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: MARKET_TZ }
            },
            revenuePaise: { $sum: '$totalAmountPaise' },
            orders: { $sum: 1 }
          }
        },
        { $sort: { _id: 1 } }
      ]),
      Order.find()
        .sort({ createdAt: -1 })
        .limit(10)
        .populate('customer', 'name phone')
        .lean(),
      User.find({ status: { $ne: 'deleted' } })
        .sort({ createdAt: -1 })
        .limit(8)
        .lean(),
      Market.countDocuments(),
      Stall.countDocuments({ status: 'approved' }),
      Stall.countDocuments({ status: 'pending' }),
      // Not 'pending' — VendorKyc.STATUSES has no such member, so this counted
      // zero forever. 'Awaiting verification' is draft (details in, nothing
      // sent) or penny_sent (transfer out, confirmation outstanding).
      VendorKyc.countDocuments({ status: { $in: ['draft', 'penny_sent'] } }),
      StallEarning.aggregate([
        { $group: { _id: null, commissionPaise: { $sum: '$commissionPaise' } } }
      ]),
      StallEarning.aggregate([
        { $match: { earnedAt: { $gte: startOfToday } } },
        { $group: { _id: null, commissionPaise: { $sum: '$commissionPaise' } } }
      ])
    ]);

    // Map role counts
    const rolesMap = { customer: 0, shopkeeper: 0, delivery: 0, market_owner: 0, developer: 0 };
    roleCounts.forEach((r) => {
      if (r._id && rolesMap[r._id] !== undefined) {
        rolesMap[r._id] = r.count;
      }
    });

    // Today's metrics. Accumulated in paise, divided once — same reason as the
    // lifetime aggregate above.
    const todayRevenuePaise = todayOrders
      .filter((o) => o.status !== 'Cancelled')
      .reduce((sum, o) => sum + (o.totalAmountPaise || 0), 0);
    const todayRevenue = todayRevenuePaise / 100;
    const todayOrdersCount = todayOrders.length;

    /**
     * Commission as recorded, not as guessed.
     *
     * This was `Math.round(allTimeSales * 0.1)` — a flat 10% of every sale, with
     * nothing behind it. `config.settlement.commissionBps` is the rate the
     * platform actually charges and it defaults to ZERO, so on a deployment that
     * has never set it the dashboard was reporting substantial revenue the
     * platform had not taken a paisa of.
     *
     * `StallEarning.commissionPaise` is what `services/settlement.js` withheld,
     * per delivered order, for market stalls and independent shops alike. It is
     * therefore lower than a percentage of gross sales, and correctly so:
     * commission is earned on delivery, not on placement.
     */
    const allTimeSales = (allTimeDeliveredOrders[0]?.totalSalesPaise || 0) / 100;
    const platformCommission = (commissionTotals[0]?.commissionPaise || 0) / 100;
    const todayCommission = (todayCommissionTotals[0]?.commissionPaise || 0) / 100;

    // Format 7/30 days trends for Recharts. `sevenDayTrends` covers 30 days;
    // the 7-day strip is the tail of it.
    const trendMap = new Map();
    sevenDayTrends.forEach((t) => {
      trendMap.set(t._id, { date: t._id, revenue: t.revenuePaise / 100, orders: t.orders });
    });

    // Walk back from the start of the market day, so the keys here are the same
    // market-local dates the aggregate grouped on.
    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
      const dateStr = marketDateString(new Date(startOfToday.getTime() - i * 24 * 60 * 60 * 1000));
      const entry = trendMap.get(dateStr) || { revenue: 0, orders: 0 };
      last7Days.push({
        name: marketDayLabel(dateStr),
        date: dateStr,
        revenue: entry.revenue,
        orders: entry.orders
      });
    }

    return res.json({
      success: true,
      data: {
        kpis: {
          totalUsers: totalUsersCount,
          customers: rolesMap.customer,
          shopkeepers: rolesMap.shopkeeper,
          deliveryPartners: rolesMap.delivery,
          marketOwners: rolesMap.market_owner,
          developers: rolesMap.developer,
          totalOrders: totalOrdersCount,
          todayOrders: todayOrdersCount,
          todaySales: todayRevenue,
          allTimeSales,
          platformCommission,
          todayCommission,
          totalMarkets: totalMarketsCount,
          activeStalls: totalStallsCount,
          pendingStallRequests: pendingStallRequestsCount,
          pendingKycs: pendingKycCount
        },
        charts: {
          last7Days,
          trends30Days: sevenDayTrends.map((t) => ({
            name: t._id.slice(5),
            date: t._id,
            revenue: t.revenuePaise / 100,
            orders: t.orders
          }))
        },
        recentOrders: recentOrders.map((o) => ({
          id: o.orderNumber || o._id.toString(),
          _id: o._id.toString(),
          customerName: o.customerName || o.customer?.name || 'Customer',
          customerPhone: o.phone || o.customer?.phone || '—',
          total: (o.totalAmountPaise || 0) / 100,
          status: o.status,
          itemCount: (o.items || []).length,
          createdAt: o.createdAt
        })),
        recentUsers: recentUsers.map((u) => ({
          id: u._id.toString(),
          name: u.name,
          phone: u.phone,
          email: u.email,
          role: u.role,
          status: u.status,
          createdAt: u.createdAt
        }))
      }
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * 2. Database Status & Collection Diagnostics
 * GET /api/developer/db-status
 */
router.get('/db-status', ...developerGate, async (req, res, next) => {
  try {
    const dbConnected = isConnected();
    const connState = mongoose.connection.readyState;
    const stateNames = ['Disconnected', 'Connected', 'Connecting', 'Disconnecting'];

    const collectionsInfo = await Promise.all([
      { name: 'Users', model: 'User', count: await User.countDocuments() },
      { name: 'Orders', model: 'Order', count: await Order.countDocuments() },
      { name: 'Products', model: 'Product', count: await Product.countDocuments() },
      { name: 'Markets', model: 'Market', count: await Market.countDocuments() },
      { name: 'Stalls', model: 'Stall', count: await Stall.countDocuments() },
      { name: 'Vendor KYC', model: 'VendorKyc', count: await VendorKyc.countDocuments() },
      { name: 'Rider Details', model: 'RiderBankDetails', count: await RiderBankDetails.countDocuments() },
      { name: 'Wallet Transactions', model: 'WalletTransaction', count: await WalletTransaction.countDocuments() }
    ]);

    const memUsage = process.memoryUsage();

    return res.json({
      success: true,
      data: {
        database: {
          connected: dbConnected,
          state: stateNames[connState] || 'Unknown',
          dbName: mongoose.connection.name || 'bazzar',
          host: mongoose.connection.host || 'localhost',
          port: mongoose.connection.port || 27017,
          collectionsCount: collectionsInfo.length,
          totalDocuments: collectionsInfo.reduce((acc, c) => acc + c.count, 0)
        },
        collections: collectionsInfo,
        server: {
          nodeVersion: process.version,
          uptimeSeconds: Math.floor(process.uptime()),
          memory: {
            rssMB: Math.round(memUsage.rss / 1024 / 1024),
            heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
            heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024)
          },
          /**
           * Both halves, because on this project's own host they disagree.
           *
           * NODE_ENV is unset on the Railway service, so this line alone told
           * the operator a live API was "development" — the precise reason
           * `config.requireRealServices` exists. `deployed` is the fact: a
           * platform marker the host injects and nobody can forget to set.
           */
          environment: process.env.NODE_ENV || 'unset',
          deployed: config.requireRealServices,
          revision: config.revision
        },
        timestamp: new Date().toISOString()
      }
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * 3. Usage Analytics (Daily active registrations / breakdown)
 * GET /api/developer/usage-analytics
 */
router.get('/usage-analytics', ...developerGate, async (req, res, next) => {
  try {
    const days = Number(req.query.days) || 7;
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const userActivity = await User.aggregate([
      { $match: { createdAt: { $gte: startDate }, status: { $ne: 'deleted' } } },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: MARKET_TZ } },
            role: '$role'
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.date': 1 } }
    ]);

    // Format into chart series
    const dateMap = new Map();
    userActivity.forEach((item) => {
      const { date, role } = item._id;
      if (!dateMap.has(date)) {
        dateMap.set(date, { date, customers: 0, shopkeepers: 0, delivery: 0, market_owners: 0 });
      }
      const entry = dateMap.get(date);
      if (role === 'customer') entry.customers += item.count;
      else if (role === 'shopkeeper') entry.shopkeepers += item.count;
      else if (role === 'delivery') entry.delivery += item.count;
      else if (role === 'market_owner') entry.market_owners += item.count;
    });

    const series = Array.from(dateMap.values()).map((entry) => ({
      ...entry,
      // `new Date('2026-09-12').getDay()` reads a UTC instant on the server's
      // own clock, so west of UTC it named the previous weekday.
      name: marketDayLabel(entry.date) || entry.date.slice(5)
    }));

    // Total counts by role
    const totalByRole = await User.aggregate([
      { $match: { status: { $ne: 'deleted' } } },
      { $group: { _id: '$role', count: { $sum: 1 } } }
    ]);

    return res.json({
      success: true,
      data: {
        series: series.length > 0 ? series : [
          { name: 'Today', customers: 0, shopkeepers: 0, delivery: 0, market_owners: 0 }
        ],
        roleDistribution: totalByRole.map((r) => ({ role: r._id, count: r.count }))
      }
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * 4. System Alerts & Action Items
 * GET /api/developer/alerts
 */
router.get('/alerts', ...developerGate, async (req, res, next) => {
  try {
    const alerts = [];

    // Check pending KYC
    // See the overview count: 'pending' is not a VendorKyc status.
    const pendingKyc = await VendorKyc.find({ status: { $in: ['draft', 'penny_sent'] } })
      .populate('user', 'name phone email')
      .limit(10)
      .lean();
    pendingKyc.forEach((kyc) => {
      alerts.push({
        id: `kyc-${kyc._id}`,
        type: 'kyc',
        severity: 'high',
        title: 'Pending Vendor KYC Verification',
        description: `Vendor ${kyc.user?.name || 'User'} (${kyc.user?.phone || '—'}) submitted bank details awaiting verification.`,
        actionLabel: 'Review KYC',
        actionTab: 'shopkeepers',
        timestamp: kyc.updatedAt || kyc.createdAt
      });
    });

    // Check pending stall requests
    const pendingStalls = await Stall.find({ status: 'pending' })
      .populate('owner', 'name phone')
      .populate('market', 'name address')
      .limit(10)
      .lean();
    pendingStalls.forEach((stall) => {
      alerts.push({
        id: `stall-${stall._id}`,
        type: 'stall',
        severity: 'medium',
        title: 'New Stall Application Pending',
        // `stall.name` is the trading name; there is no `stallName` field. Read
        // wrong it was always undefined, so this fell through to the applicant's
        // personal name and the alert never showed the business applying.
        description: `${stall.name || stall.owner?.name || 'Shopkeeper'} applied for a stall in ${stall.market?.name || 'Market'}.`,
        actionLabel: 'Review Stall',
        actionTab: 'shopkeepers',
        timestamp: stall.createdAt
      });
    });

    /**
     * Check out-of-stock products.
     *
     * The count is a real count and the names are a sample. Both used to come
     * from one `.limit(10)` query, so the title said "10 Products Out of Stock"
     * however many there were — a triage screen quoting its own page size as
     * the size of the problem.
     */
    const [outOfStockCount, outOfStockProducts] = await Promise.all([
      Product.countDocuments({ stock: 0 }),
      Product.find({ stock: 0 }).select('name').limit(3).lean()
    ]);
    if (outOfStockCount > 0) {
      alerts.push({
        id: 'out-of-stock-summary',
        type: 'inventory',
        severity: 'warning',
        title: `${outOfStockCount} Products Out of Stock`,
        description: `Items like ${outOfStockProducts.map((p) => p.name).join(', ')} are currently depleted.`,
        actionLabel: 'View Products',
        actionTab: 'overview',
        timestamp: new Date()
      });
    }

    // Check active unassigned orders.
    //
    // 'Pending', not 'Placed' (not an ORDER_STATUSES member), and `assignedTo`,
    // not `deliveryAgent` — there is no such field on Order, and strictQuery
    // drops an unknown path silently rather than erroring, so that clause
    // disappeared and every Preparing order was counted as unassigned whether a
    // rider held it or not. A real count for the same reason as the stock alert
    // above: this number is the whole point of the alert.
    const unassignedCount = await Order.countDocuments({
      status: { $in: ['Pending', 'Preparing'] },
      assignedTo: null
    });
    if (unassignedCount > 0) {
      alerts.push({
        id: 'unassigned-orders',
        type: 'orders',
        severity: 'high',
        title: `${unassignedCount} Unassigned Active Orders`,
        description: `Orders awaiting rider assignment or shop preparation.`,
        actionLabel: 'View Orders',
        actionTab: 'orders',
        timestamp: new Date()
      });
    }

    return res.json({
      success: true,
      data: {
        totalAlerts: alerts.length,
        alerts
      }
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * 5. Shopkeeper & Stall Directory
 * GET /api/developer/shopkeepers
 */
router.get('/shopkeepers', ...developerGate, async (req, res, next) => {
  try {
    const shopkeepers = await User.find({ role: 'shopkeeper', status: { $ne: 'deleted' } })
      .sort({ createdAt: -1 })
      .lean();

    const shopkeeperIds = shopkeepers.map((s) => s._id);

    const [stalls, kycs, productsCount] = await Promise.all([
      // `owner`, not `shopkeeper`. With strictQuery on, the unknown path was
      // dropped rather than rejected, so this filter collapsed to {} and
      // returned every stall in the database — and the map below then read
      // `.shopkeeper` off each one and threw. The route 500ed as soon as a
      // single Stall document existed.
      Stall.find({ owner: { $in: shopkeeperIds } }).populate('market', 'name').lean(),
      VendorKyc.find({ user: { $in: shopkeeperIds } }).lean(),
      Product.aggregate([
        { $match: { owner: { $in: shopkeeperIds } } },
        { $group: { _id: '$owner', count: { $sum: 1 } } }
      ])
    ]);

    const stallsByShopkeeper = new Map();
    stalls.forEach((st) => stallsByShopkeeper.set(st.owner.toString(), st));

    const kycByShopkeeper = new Map();
    kycs.forEach((k) => kycByShopkeeper.set(k.user.toString(), k));

    const prodCountMap = new Map();
    productsCount.forEach((p) => prodCountMap.set(p._id.toString(), p.count));

    const data = shopkeepers.map((s) => {
      const sId = s._id.toString();
      const stall = stallsByShopkeeper.get(sId);
      const kyc = kycByShopkeeper.get(sId);
      return {
        id: sId,
        name: s.name,
        phone: s.phone,
        email: s.email,
        status: s.status,
        // Key stays `stallName` (the admin client reads it); the source is
        // `stall.name`, which is what the field is actually called.
        stallName: stall?.name || '—',
        marketName: stall?.market?.name || '—',
        stallStatus: stall?.status || 'No Stall',
        kycStatus: kyc?.status || 'not_submitted',
        productsListed: prodCountMap.get(sId) || 0,
        joinedAt: s.createdAt
      };
    });

    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

/**
 * 6. Delivery Partners Analytics
 * GET /api/developer/riders
 */
router.get('/riders', ...developerGate, async (req, res, next) => {
  try {
    const riders = await User.find({ role: 'delivery', status: { $ne: 'deleted' } })
      .sort({ createdAt: -1 })
      .lean();

    const riderIds = riders.map((r) => r._id);

    const [bankDetails, deliveryCounts] = await Promise.all([
      RiderBankDetails.find({ user: { $in: riderIds } }).lean(),
      Order.aggregate([
        // `assignedTo`, not `deliveryAgent` — there is no such field on Order,
        // so this matched nothing and every rider was reported as having made
        // zero deliveries however many they had actually run.
        { $match: { assignedTo: { $in: riderIds } } },
        {
          $group: {
            _id: '$assignedTo',
            totalDeliveries: { $sum: 1 },
            completed: {
              $sum: { $cond: [{ $eq: ['$status', 'Delivered'] }, 1, 0] }
            }
          }
        }
      ])
    ]);

    const bankMap = new Map();
    bankDetails.forEach((b) => bankMap.set(b.user.toString(), b));

    const countMap = new Map();
    deliveryCounts.forEach((c) => countMap.set(c._id.toString(), c));

    const data = riders.map((r) => {
      const rId = r._id.toString();
      const bank = bankMap.get(rId);
      const counts = countMap.get(rId) || { totalDeliveries: 0, completed: 0 };
      return {
        id: rId,
        name: r.name,
        phone: r.phone,
        status: r.status,
        // Both of these live under `rider`, not at the top level. Read from the
        // wrong path they were constants: every rider always "Off Duty", every
        // rider always without a location — which is exactly the pair of facts
        // this screen exists to show.
        dutyStatus: r.rider?.dutyStatus === 'online' ? 'On Duty' : 'Off Duty',
        hasLocation: Boolean(r.rider?.lastLocation?.coordinates?.length),
        /**
         * Whether this rider may be dispatched at all.
         *
         * The reason this list is now a queue rather than a report: an
         * unapproved rider is somebody who self-registered minutes ago and is
         * waiting on a human, and nothing else in the product shows that.
         */
        approvalStatus: r.rider?.approvalStatus || 'pending',
        approvedAt: r.rider?.approvedAt || null,
        rejectionReason: r.rider?.rejectionReason || null,
        bankStatus: bank ? 'Configured' : 'Pending',
        completedDeliveries: counts.completed,
        totalAssigned: counts.totalDeliveries,
        joinedAt: r.createdAt
      };
    });

    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

/**
 * Clear a rider to carry real orders, or refuse them.
 *
 * This is the human step that self-registration deliberately leaves open. An
 * offer carries a customer's name, phone, home address and — on COD — their
 * cash, and `/auth/delivery/register/start` will mint a delivery account for
 * anyone who can prove a phone number. Somebody has to look.
 *
 * `developer` only, via `developerGate`, and NOT `market_owner`. A rider is not
 * scoped to a market — `findNearestRider` searches by proximity across all of
 * them — so a market owner clearing one would be clearing them to work a
 * competitor's market too. The same reasoning that narrowed account
 * administration to `developer` in routes/users.js.
 *
 * Both directions are reversible: a rejection can be approved later and an
 * approval withdrawn, which is why this is one route taking a decision rather
 * than two one-way doors.
 */
router.post('/riders/:id/approval', ...developerGate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { decision, reason } = req.body || {};

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'Not a valid rider id.' });
    }

    if (decision !== 'approved' && decision !== 'rejected') {
      return res
        .status(400)
        .json({ success: false, error: "decision must be 'approved' or 'rejected'." });
    }

    // Matched on the role as well as the id, so this endpoint can only ever
    // move a delivery account — it is not a general-purpose writer into the
    // user collection that happens to be reachable with any id.
    const rider = await User.findOne({ _id: id, role: 'delivery' });
    if (!rider) {
      return res.status(404).json({ success: false, error: 'No delivery account with that id.' });
    }

    rider.rider.approvalStatus = decision;
    rider.rider.approvedAt = decision === 'approved' ? new Date() : null;
    rider.rider.approvedBy = req.user._id;
    rider.rider.rejectionReason =
      decision === 'rejected' ? String(reason || '').slice(0, 300) : '';

    /**
     * Withdrawing approval takes them off duty in the same write.
     *
     * Leaving `dutyStatus: 'online'` on a rejected rider would be harmless to
     * dispatch — the query filters on approval too — but it would show them an
     * app that says they are working. It would also mean a later re-approval
     * silently put them straight back on duty without them asking.
     */
    if (decision === 'rejected') rider.rider.dutyStatus = 'offline';

    /**
     * Any live session is invalidated.
     *
     * `middleware/auth.js` compares the token's `tv` claim against the record,
     * so this forces the delivery app to re-establish and pick up the new
     * approval state on its next request rather than at token expiry — the
     * same reasoning as the suspension and promotion scripts.
     */
    rider.tokenVersion += 1;
    await rider.save();

    return res.json({
      success: true,
      data: {
        id: String(rider._id),
        approvalStatus: rider.rider.approvalStatus,
        rejectionReason: rider.rider.rejectionReason || null,
      },
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * 7. Payment Management & Wallet Ledger
 * GET /api/developer/payments
 */
router.get('/payments', ...developerGate, async (req, res, next) => {
  try {
    const [transactions, stats] = await Promise.all([
      WalletTransaction.find()
        .sort({ createdAt: -1 })
        .limit(100)
        .populate('user', 'name phone email role')
        .lean(),
      WalletTransaction.aggregate([
        {
          $group: {
            _id: '$type',
            // Paise in, one division at the end — this is the wallet ledger.
            totalPaise: { $sum: '$amountPaise' },
            count: { $sum: 1 }
          }
        }
      ])
    ]);

    let totalCredits = 0;
    let totalDebits = 0;
    let ledgerRows = 0;
    stats.forEach((s) => {
      ledgerRows += s.count;
      if (s._id === 'credit') totalCredits = s.totalPaise / 100;
      if (s._id === 'debit') totalDebits = s.totalPaise / 100;
    });

    return res.json({
      success: true,
      data: {
        summary: {
          /**
           * The whole ledger, not the hundred rows below it.
           *
           * This was `transactions.length`, capped by the `.limit(100)` on the
           * list — so once the ledger passed a hundred entries the screen read
           * "₹X net flow across 100 recorded transactions", attributing a
           * lifetime total to a single page. The credit and debit figures were
           * always whole-ledger; only the count was not.
           */
          totalTransactions: ledgerRows,
          shown: transactions.length,
          totalCredits,
          totalDebits,
          netFlow: totalCredits - totalDebits
        },
        transactions: transactions.map((t) => ({
          id: t._id.toString(),
          userName: t.user?.name || 'User',
          userPhone: t.user?.phone || '—',
          userRole: t.user?.role || 'customer',
          type: t.type,
          amount: (t.amountPaise || 0) / 100,
          balanceAfter: (t.balanceAfterPaise || 0) / 100,
          reason: t.reason,
          note: t.note,
          referenceId: t.referenceId,
          createdAt: t.createdAt
        }))
      }
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * 8. System State Dump for Inspection
 * GET /api/developer/dump
 */
router.get('/dump', ...developerGate, async (req, res, next) => {
  try {
    const [users, products, markets, stalls, orders, transactions] = await Promise.all([
      User.find({ status: { $ne: 'deleted' } }).limit(50).lean(),
      Product.find().limit(50).lean(),
      Market.find().limit(20).lean(),
      Stall.find().limit(30).lean(),
      Order.find().sort({ createdAt: -1 }).limit(30).lean(),
      WalletTransaction.find().sort({ createdAt: -1 }).limit(30).lean()
    ]);

    return res.json({
      success: true,
      data: {
        timestamp: new Date().toISOString(),
        /**
         * How much was sampled, which is not how much there is.
         *
         * Every query here is capped, so these were never totals — they were the
         * caps. Renamed rather than counted: `/db-status` already reports real
         * `countDocuments` per collection, and two endpoints answering the same
         * question differently is how one of them ends up wrong.
         */
        sampled: {
          users: users.length,
          products: products.length,
          markets: markets.length,
          stalls: stalls.length,
          orders: orders.length,
          walletTransactions: transactions.length
        },
        snapshot: {
          users: users.map((u) => ({ id: u._id, name: u.name, phone: u.phone, role: u.role, status: u.status })),
          /**
           * `pricePaise` and `categoryId` — the names the schema actually has.
           *
           * This read `p.price` and `p.category`. `price` is a virtual, and
           * `.lean()` does not run virtuals; `category` has never been a field
           * at all. Every product in the dump carried `price: undefined,
           * category: undefined`, in the one endpoint whose entire job is to
           * show what is in the database.
           */
          products: products.map((p) => ({
            id: p._id,
            name: p.name,
            pricePaise: p.pricePaise,
            price: (p.pricePaise ?? 0) / 100,
            stock: p.stock,
            categoryId: p.categoryId,
          })),
          markets: markets.map((m) => ({ id: m._id, name: m.name, address: m.address })),
          stalls: stalls.map((s) => ({
            id: s._id,
            stallName: s.name,
            stallNumber: s.stallNumber,
            status: s.status,
          })),
          // `total` likewise: the virtual is `totalAmount`, and `.lean()`
          // strips it either way.
          orders: orders.map((o) => ({
            id: o.orderNumber || o._id,
            totalAmountPaise: o.totalAmountPaise,
            total: (o.totalAmountPaise ?? 0) / 100,
            status: o.status,
            createdAt: o.createdAt,
          })),
          // Fetched, counted, and then dropped on the floor before.
          walletTransactions: transactions.map((t) => ({
            id: t._id,
            type: t.type,
            reason: t.reason,
            amountPaise: t.amountPaise,
            amount: (t.amountPaise ?? 0) / 100,
            createdAt: t.createdAt,
          }))
        }
      }
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
