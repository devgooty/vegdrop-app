import React, { useState, useEffect } from 'react';
import { 
  Users, Store, Bike, ShoppingCart, 
  IndianRupee, TrendingUp, TrendingDown,
  Activity, ArrowUpRight, RefreshCw, ShieldAlert,
  Clock, CheckCircle, PackageCheck
} from 'lucide-react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';
import { fetchDeveloperOverview } from '../../../services/developer';

const KPICard = ({ title, value, subtext, icon: Icon, color, bg, isCurrency = false }) => {
  return (
    <div className="bg-white rounded-2xl p-5 border border-slate-100 shadow-[0_2px_10px_rgb(0,0,0,0.02)] flex flex-col justify-between hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between">
        <div className={`p-3 rounded-2xl ${bg}`}>
          <Icon className={`w-5 h-5 ${color}`} />
        </div>
      </div>
      <div className="mt-4">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">{title}</h3>
        <p className="text-2xl font-black text-slate-800 mt-1">
          {isCurrency ? `₹${Number(value || 0).toLocaleString('en-IN')}` : Number(value || 0).toLocaleString('en-IN')}
        </p>
        {subtext && <p className="text-[12.5px] font-medium text-slate-500 mt-1">{subtext}</p>}
      </div>
    </div>
  );
};

export default function DashboardOverview({ setActiveTab }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [timeRange, setTimeRange] = useState('7d');

  const loadData = async () => {
    try {
      setLoading(true);
      setError('');
      const res = await fetchDeveloperOverview();
      setData(res);
    } catch (err) {
      setError(err?.message || 'Failed to load overview data from database.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  if (loading && !data) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] text-slate-400 gap-3">
        <RefreshCw className="w-8 h-8 animate-spin text-green-500" />
        <p className="text-sm font-semibold">Querying live MongoDB metrics…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-rose-50 border border-rose-200 p-6 rounded-2xl text-center space-y-3">
        <ShieldAlert className="w-8 h-8 text-rose-500 mx-auto" />
        <p className="text-rose-700 font-bold text-sm">{error}</p>
        <button
          onClick={loadData}
          className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-xs font-bold cursor-pointer"
        >
          Retry Connection
        </button>
      </div>
    );
  }

  const kpis = data?.kpis || {};
  const chartData = timeRange === '7d' ? (data?.charts?.last7Days || []) : (data?.charts?.trends30Days || []);

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      
      {/* Header Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-extrabold text-slate-800 tracking-tight">Database Overview & KPIs</h2>
          <p className="text-sm text-slate-500 mt-1 font-medium">Real-time statistics queried directly from MongoDB collections.</p>
        </div>
        <div className="flex items-center gap-2">
          <button 
            onClick={loadData}
            className="flex items-center gap-2 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 px-3 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer shadow-sm"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
        </div>
      </div>

      {/* Main KPI Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3.5">
        <KPICard
          title="Total Customers"
          value={kpis.customers}
          subtext="Active buyer accounts"
          icon={Users}
          color="text-blue-600"
          bg="bg-blue-50"
        />
        <KPICard
          title="Shopkeepers"
          value={kpis.shopkeepers}
          subtext={`${kpis.activeStalls || 0} active stalls`}
          icon={Store}
          color="text-emerald-600"
          bg="bg-emerald-50"
        />
        <KPICard
          title="Delivery Partners"
          value={kpis.deliveryPartners}
          subtext="Riders in fleet"
          icon={Bike}
          color="text-amber-600"
          bg="bg-amber-50"
        />
        <KPICard
          title="Today's Orders"
          value={kpis.todayOrders}
          subtext={`${kpis.totalOrders || 0} total all-time`}
          icon={ShoppingCart}
          color="text-purple-600"
          bg="bg-purple-50"
        />
        <KPICard
          title="Today's Sales"
          value={kpis.todaySales}
          subtext="From active orders"
          icon={IndianRupee}
          color="text-teal-600"
          bg="bg-teal-50"
          isCurrency={true}
        />
        <KPICard
          title="Est. Commission"
          value={kpis.todayCommission}
          subtext="Platform revenue"
          icon={Activity}
          color="text-rose-600"
          bg="bg-rose-50"
          isCurrency={true}
        />
      </div>

      {/* Pending Action Banners */}
      {(kpis.pendingKycs > 0 || kpis.pendingStallRequests > 0) && (
        <div className="grid sm:grid-cols-2 gap-3">
          {kpis.pendingKycs > 0 && (
            <div className="bg-amber-50 border border-amber-200 p-4 rounded-2xl flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center text-amber-700 font-bold">
                  <ShieldAlert className="w-5 h-5" />
                </div>
                <div>
                  <p className="text-sm font-bold text-amber-900">{kpis.pendingKycs} Pending Vendor KYC(s)</p>
                  <p className="text-xs text-amber-700">Bank accounts awaiting verification before payouts.</p>
                </div>
              </div>
              <button
                onClick={() => setActiveTab && setActiveTab('shopkeepers')}
                className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-bold cursor-pointer"
              >
                Review
              </button>
            </div>
          )}

          {kpis.pendingStallRequests > 0 && (
            <div className="bg-indigo-50 border border-indigo-200 p-4 rounded-2xl flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold">
                  <Store className="w-5 h-5" />
                </div>
                <div>
                  <p className="text-sm font-bold text-indigo-900">{kpis.pendingStallRequests} Stall Request(s)</p>
                  <p className="text-xs text-indigo-700">Vendors waiting for market stall approval.</p>
                </div>
              </div>
              <button
                onClick={() => setActiveTab && setActiveTab('shopkeepers')}
                className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold cursor-pointer"
              >
                Inspect
              </button>
            </div>
          )}
        </div>
      )}

      {/* Revenue & Orders Chart */}
      <div className="bg-white rounded-2xl p-6 border border-slate-100 shadow-[0_4px_20px_rgb(0,0,0,0.03)]">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
          <div>
            <h3 className="text-lg font-bold text-slate-800">Revenue & Order Volume (MongoDB Live)</h3>
            <p className="text-xs text-slate-400">Aggregated order total value over time</p>
          </div>
          <div className="flex bg-slate-100 p-1 rounded-xl">
            <button
              onClick={() => setTimeRange('7d')}
              className={`px-3 py-1 text-xs font-bold rounded-lg cursor-pointer transition-colors ${
                timeRange === '7d' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-900'
              }`}
            >
              7 Days
            </button>
            <button
              onClick={() => setTimeRange('30d')}
              className={`px-3 py-1 text-xs font-bold rounded-lg cursor-pointer transition-colors ${
                timeRange === '30d' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-900'
              }`}
            >
              30 Days
            </button>
          </div>
        </div>

        <div className="h-[280px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
              <defs>
                <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.3}/>
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fill: '#64748b', fontSize: 11}} dy={10} />
              <YAxis axisLine={false} tickLine={false} tick={{fill: '#64748b', fontSize: 11}} />
              <Tooltip 
                formatter={(val, name) => [
                  name === 'revenue' ? `₹${val.toLocaleString('en-IN')}` : val, 
                  name === 'revenue' ? 'Sales Revenue' : 'Orders Count'
                ]}
                contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 4px 20px rgba(0,0,0,0.08)' }}
              />
              <Area type="monotone" dataKey="revenue" stroke="#10b981" strokeWidth={2.5} fillOpacity={1} fill="url(#colorRevenue)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Recent Orders & Recent Users Grid */}
      <div className="grid lg:grid-cols-2 gap-6">
        
        {/* Recent Orders */}
        <div className="bg-white rounded-2xl p-5 border border-slate-100 shadow-[0_4px_20px_rgb(0,0,0,0.03)]">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-bold text-slate-800 flex items-center gap-2">
              <ShoppingCart className="w-4 h-4 text-emerald-600" />
              Recent Orders from Database
            </h3>
            <button
              onClick={() => setActiveTab && setActiveTab('orders')}
              className="text-xs font-bold text-emerald-600 hover:text-emerald-700 cursor-pointer"
            >
              View All &rarr;
            </button>
          </div>

          <div className="divide-y divide-slate-100">
            {(!data?.recentOrders || data.recentOrders.length === 0) ? (
              <p className="text-xs text-slate-400 text-center py-6">No orders in database yet.</p>
            ) : (
              data.recentOrders.map((order) => (
                <div key={order._id} className="py-3 flex items-center justify-between gap-3 text-xs">
                  <div>
                    <p className="font-bold text-slate-800">{order.customerName}</p>
                    <p className="text-[12.5px] text-slate-400">
                      ID: {order.id.slice(-6).toUpperCase()} • {new Date(order.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-extrabold text-slate-900">₹{order.total?.toLocaleString('en-IN')}</p>
                    <span className={`inline-block px-2 py-0.5 rounded-md text-[11.5px] font-bold ${
                      order.status === 'Delivered' ? 'bg-emerald-50 text-emerald-700' :
                      order.status === 'Cancelled' ? 'bg-rose-50 text-rose-700' :
                      'bg-blue-50 text-blue-700'
                    }`}>
                      {order.status}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Recent Registered Users */}
        <div className="bg-white rounded-2xl p-5 border border-slate-100 shadow-[0_4px_20px_rgb(0,0,0,0.03)]">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-bold text-slate-800 flex items-center gap-2">
              <Users className="w-4 h-4 text-blue-600" />
              Recent User Registrations
            </h3>
            <button
              onClick={() => setActiveTab && setActiveTab('users')}
              className="text-xs font-bold text-blue-600 hover:text-blue-700 cursor-pointer"
            >
              Manage Users &rarr;
            </button>
          </div>

          <div className="divide-y divide-slate-100">
            {(!data?.recentUsers || data.recentUsers.length === 0) ? (
              <p className="text-xs text-slate-400 text-center py-6">No users found.</p>
            ) : (
              data.recentUsers.map((u) => (
                <div key={u.id} className="py-2.5 flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <p className="font-bold text-slate-800 truncate">{u.name || 'User'}</p>
                    <p className="text-[12.5px] text-slate-400 truncate">{u.phone || u.email || '—'}</p>
                  </div>
                  <span className={`px-2.5 py-1 rounded-full text-[11.5px] font-extrabold uppercase shrink-0 ${
                    u.role === 'shopkeeper' ? 'bg-emerald-50 text-emerald-700' :
                    u.role === 'delivery' ? 'bg-amber-50 text-amber-700' :
                    u.role === 'developer' ? 'bg-purple-50 text-purple-700' :
                    u.role === 'market_owner' ? 'bg-indigo-50 text-indigo-700' :
                    'bg-slate-100 text-slate-700'
                  }`}>
                    {u.role}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

      </div>

    </div>
  );
}
