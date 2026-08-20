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
const { requireAuth, requireRole } = require('../middleware/auth');
const { isConnected } = require('../db/connect');

const router = express.Router();

// All developer routes are strictly locked to the developer role
const developerGate = [requireAuth, requireRole('developer')];

/**
 * 1. Overview KPIs and Revenue Trends
 * GET /api/developer/overview
 */
router.get('/overview', ...developerGate, async (req, res, next) => {
  try {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
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
      pendingKycCount
    ] = await Promise.all([
      User.countDocuments({ status: { $ne: 'deleted' } }),
      User.aggregate([
        { $match: { status: { $ne: 'deleted' } } },
        { $group: { _id: '$role', count: { $sum: 1 } } }
      ]),
      Order.countDocuments(),
      Order.find({ createdAt: { $gte: startOfToday } }).lean(),
      Order.aggregate([
        { $match: { status: { $in: ['Delivered', 'Out for Delivery', 'Preparing', 'Placed'] } } },
        { $group: { _id: null, totalSales: { $sum: { $divide: ['$totalAmountPaise', 100] } }, count: { $sum: 1 } } }
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
              $dateToString: { format: '%Y-%m-%d', date: '$createdAt' }
            },
            revenue: { $sum: { $divide: ['$totalAmountPaise', 100] } },
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
      VendorKyc.countDocuments({ status: 'pending' })
    ]);

    // Map role counts
    const rolesMap = { customer: 0, shopkeeper: 0, delivery: 0, market_owner: 0, developer: 0 };
    roleCounts.forEach((r) => {
      if (r._id && rolesMap[r._id] !== undefined) {
        rolesMap[r._id] = r.count;
      }
    });

    // Today's metrics
    const todayRevenue = todayOrders
      .filter((o) => o.status !== 'Cancelled')
      .reduce((sum, o) => sum + ((o.totalAmountPaise || 0) / 100), 0);
    const todayOrdersCount = todayOrders.length;

    // Platform commission (10% standard estimate)
    const allTimeSales = allTimeDeliveredOrders[0]?.totalSales || 0;
    const platformCommission = Math.round(allTimeSales * 0.1);
    const todayCommission = Math.round(todayRevenue * 0.1);

    // Format 7/30 days trends for Recharts
    const trendMap = new Map();
    sevenDayTrends.forEach((t) => {
      trendMap.set(t._id, { date: t._id, revenue: t.revenue, orders: t.orders });
    });

    // Generate last 7 days continuity
    const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dateStr = d.toISOString().slice(0, 10);
      const dayName = dayLabels[d.getDay()];
      const entry = trendMap.get(dateStr) || { revenue: 0, orders: 0 };
      last7Days.push({
        name: dayName,
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
            revenue: t.revenue,
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
          environment: process.env.NODE_ENV || 'development'
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
            date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
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

    const series = Array.from(dateMap.values()).map((entry) => {
      const d = new Date(entry.date);
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      return {
        ...entry,
        name: dayNames[d.getDay()] || entry.date.slice(5)
      };
    });

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
    const pendingKyc = await VendorKyc.find({ status: 'pending' })
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
      .populate('shopkeeper', 'name phone')
      .populate('market', 'name address')
      .limit(10)
      .lean();
    pendingStalls.forEach((stall) => {
      alerts.push({
        id: `stall-${stall._id}`,
        type: 'stall',
        severity: 'medium',
        title: 'New Stall Application Pending',
        description: `${stall.stallName || stall.shopkeeper?.name || 'Shopkeeper'} applied for a stall in ${stall.market?.name || 'Market'}.`,
        actionLabel: 'Review Stall',
        actionTab: 'shopkeepers',
        timestamp: stall.createdAt
      });
    });

    // Check out-of-stock products
    const outOfStockProducts = await Product.find({ stock: 0 })
      .limit(10)
      .lean();
    if (outOfStockProducts.length > 0) {
      alerts.push({
        id: 'out-of-stock-summary',
        type: 'inventory',
        severity: 'warning',
        title: `${outOfStockProducts.length} Products Out of Stock`,
        description: `Items like ${outOfStockProducts.slice(0, 3).map((p) => p.name).join(', ')} are currently depleted.`,
        actionLabel: 'View Products',
        actionTab: 'overview',
        timestamp: new Date()
      });
    }

    // Check active unassigned orders
    const unassignedOrders = await Order.find({
      status: { $in: ['Placed', 'Preparing'] },
      deliveryAgent: { $exists: false }
    })
      .limit(10)
      .lean();
    if (unassignedOrders.length > 0) {
      alerts.push({
        id: 'unassigned-orders',
        type: 'orders',
        severity: 'high',
        title: `${unassignedOrders.length} Unassigned Active Orders`,
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
      Stall.find({ shopkeeper: { $in: shopkeeperIds } }).populate('market', 'name').lean(),
      VendorKyc.find({ user: { $in: shopkeeperIds } }).lean(),
      Product.aggregate([
        { $match: { owner: { $in: shopkeeperIds } } },
        { $group: { _id: '$owner', count: { $sum: 1 } } }
      ])
    ]);

    const stallsByShopkeeper = new Map();
    stalls.forEach((st) => stallsByShopkeeper.set(st.shopkeeper.toString(), st));

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
        stallName: stall?.stallName || '—',
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
        { $match: { deliveryAgent: { $in: riderIds } } },
        {
          $group: {
            _id: '$deliveryAgent',
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
        dutyStatus: r.onDuty ? 'On Duty' : 'Off Duty',
        hasLocation: Boolean(r.location?.coordinates?.length),
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
            totalAmount: { $sum: { $divide: ['$amountPaise', 100] } },
            count: { $sum: 1 }
          }
        }
      ])
    ]);

    let totalCredits = 0;
    let totalDebits = 0;
    stats.forEach((s) => {
      if (s._id === 'credit') totalCredits = s.totalAmount;
      if (s._id === 'debit') totalDebits = s.totalAmount;
    });

    return res.json({
      success: true,
      data: {
        summary: {
          totalTransactions: transactions.length,
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
        counts: {
          users: users.length,
          products: products.length,
          markets: markets.length,
          stalls: stalls.length,
          orders: orders.length,
          walletTransactions: transactions.length
        },
        snapshot: {
          users: users.map((u) => ({ id: u._id, name: u.name, phone: u.phone, role: u.role, status: u.status })),
          products: products.map((p) => ({ id: p._id, name: p.name, price: p.price, stock: p.stock, category: p.category })),
          markets: markets.map((m) => ({ id: m._id, name: m.name, address: m.address })),
          stalls: stalls.map((s) => ({ id: s._id, stallName: s.stallName, status: s.status })),
          orders: orders.map((o) => ({ id: o.orderNumber || o._id, total: o.total, status: o.status, createdAt: o.createdAt }))
        }
      }
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
