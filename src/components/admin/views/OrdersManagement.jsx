import React, { useState, useEffect } from 'react';
import { 
  ShoppingCart, Search, Filter, RefreshCw, Eye, 
  MapPin, Phone, User, Package, Calendar, IndianRupee
} from 'lucide-react';
import { fetchOrders } from '../../../services/orders';

export default function OrdersManagement() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedOrder, setSelectedOrder] = useState(null);

  const loadOrders = async () => {
    try {
      setLoading(true);
      setError('');
      const res = await fetchOrders();
      setOrders(res || []);
    } catch (err) {
      setError(err?.message || 'Failed to load orders from database.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadOrders();
  }, []);

  const filteredOrders = orders.filter((o) => {
    const matchesStatus = statusFilter === 'All' || o.status === statusFilter;
    if (!matchesStatus) return false;

    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    const orderNum = (o.orderNumber || o.id || o._id || '').toLowerCase();
    const customer = (o.deliveryAddress?.name || o.customer?.name || '').toLowerCase();
    const phone = (o.deliveryAddress?.phone || o.customer?.phone || '');
    return orderNum.includes(q) || customer.includes(q) || phone.includes(q);
  });

  const getStatusBadge = (status) => {
    switch (status) {
      case 'Delivered':
        return 'bg-emerald-50 text-emerald-700 border-emerald-200';
      case 'Out for Delivery':
        return 'bg-indigo-50 text-indigo-700 border-indigo-200';
      case 'Preparing':
        return 'bg-amber-50 text-amber-700 border-amber-200';
      case 'Placed':
        return 'bg-blue-50 text-blue-700 border-blue-200';
      case 'Cancelled':
        return 'bg-rose-50 text-rose-700 border-rose-200';
      default:
        return 'bg-slate-100 text-slate-700 border-slate-200';
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-extrabold text-slate-800 tracking-tight">Orders Management</h2>
          <p className="text-sm text-slate-500 mt-1 font-medium">All platform transactions and fulfillment statuses from MongoDB.</p>
        </div>
        <button 
          onClick={loadOrders}
          className="flex items-center gap-2 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 px-3 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer shadow-sm"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="bg-rose-50 border border-rose-200 p-4 rounded-xl text-rose-800 text-xs font-bold">
          {error}
        </div>
      )}

      {/* Main Table Card */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-[0_4px_20px_rgb(0,0,0,0.03)] overflow-hidden">
        
        {/* Filter and Search Bar */}
        <div className="p-4 border-b border-slate-100 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex gap-1.5 bg-slate-50 p-1 rounded-xl overflow-x-auto">
            {['All', 'Placed', 'Preparing', 'Out for Delivery', 'Delivered', 'Cancelled'].map(status => (
              <button 
                key={status}
                onClick={() => setStatusFilter(status)}
                className={`px-3 py-1.5 text-xs font-bold rounded-lg whitespace-nowrap transition-colors cursor-pointer ${
                  statusFilter === status ? 'bg-white text-emerald-700 shadow-sm border border-slate-200' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {status}
              </button>
            ))}
          </div>

          <div className="relative group w-full md:w-64">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 group-focus-within:text-emerald-500 transition-colors" />
            <input 
              type="text" 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by Order #, customer..." 
              className="w-full pl-9 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all placeholder:text-slate-400"
            />
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50/70">
                <th className="px-5 py-3.5 text-[11px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100">Order ID</th>
                <th className="px-5 py-3.5 text-[11px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100">Customer</th>
                <th className="px-5 py-3.5 text-[11px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100">Items / Stall</th>
                <th className="px-5 py-3.5 text-[11px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100">Total</th>
                <th className="px-5 py-3.5 text-[11px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100">Status</th>
                <th className="px-5 py-3.5 text-[11px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100">Created At</th>
                <th className="px-5 py-3.5 text-[11px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100 text-right">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && orders.length === 0 ? (
                <tr>
                  <td colSpan="7" className="py-12 text-center text-xs text-slate-400">
                    <RefreshCw className="w-6 h-6 animate-spin mx-auto text-emerald-500 mb-2" />
                    Loading live orders from MongoDB…
                  </td>
                </tr>
              ) : filteredOrders.length === 0 ? (
                <tr>
                  <td colSpan="7" className="py-12 text-center text-xs text-slate-400">
                    No orders matching criteria.
                  </td>
                </tr>
              ) : (
                filteredOrders.map((o) => {
                  const orderIdStr = o.orderNumber || o.id || o._id;
                  return (
                    <tr key={o.id || o._id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="px-5 py-3.5">
                        <span className="font-mono text-xs font-bold text-slate-800 bg-slate-100 px-2 py-1 rounded-md">
                          #{String(orderIdStr).slice(-6).toUpperCase()}
                        </span>
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="font-bold text-slate-800 text-xs">{o.deliveryAddress?.name || o.customer?.name || 'Customer'}</div>
                        <div className="text-[11px] text-slate-400">{o.deliveryAddress?.phone || o.customer?.phone || '—'}</div>
                      </td>
                      <td className="px-5 py-3.5 text-xs text-slate-600">
                        {o.items?.length || 0} item(s)
                      </td>
                      <td className="px-5 py-3.5 font-black text-slate-900 text-xs">
                        ₹{Number(o.total || 0).toLocaleString('en-IN')}
                      </td>
                      <td className="px-5 py-3.5">
                        <span className={`text-[10px] font-extrabold px-2.5 py-1 rounded-full border uppercase ${getStatusBadge(o.status)}`}>
                          {o.status}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-xs text-slate-500">
                        {o.createdAt ? new Date(o.createdAt).toLocaleString() : '—'}
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        <button
                          onClick={() => setSelectedOrder(o)}
                          className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-bold cursor-pointer transition-colors"
                        >
                          View
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Order Detail Modal */}
      {selectedOrder && (
        <div className="fixed inset-0 bg-slate-900/60 z-50 flex items-center justify-center p-4 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 space-y-4 shadow-2xl animate-in zoom-in-95 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-base font-extrabold text-slate-800">
                  Order Details #{String(selectedOrder.orderNumber || selectedOrder.id || selectedOrder._id).slice(-8).toUpperCase()}
                </h3>
                <p className="text-xs text-slate-400">
                  {selectedOrder.createdAt ? new Date(selectedOrder.createdAt).toLocaleString() : '—'}
                </p>
              </div>
              <span className={`text-xs font-extrabold px-3 py-1 rounded-full border uppercase ${getStatusBadge(selectedOrder.status)}`}>
                {selectedOrder.status}
              </span>
            </div>

            {/* Delivery address */}
            <div className="bg-slate-50 p-3.5 rounded-xl space-y-1 text-xs">
              <p className="font-bold text-slate-700 flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5 text-slate-400" />
                Delivery Address
              </p>
              <p className="text-slate-900 font-semibold">{selectedOrder.deliveryAddress?.name} ({selectedOrder.deliveryAddress?.phone})</p>
              <p className="text-slate-600">{selectedOrder.deliveryAddress?.addressLine || selectedOrder.deliveryAddress?.fullAddress || '—'}</p>
            </div>

            {/* Order Items */}
            <div className="space-y-2">
              <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Ordered Items</h4>
              <div className="divide-y divide-slate-100 border border-slate-100 rounded-xl overflow-hidden">
                {(selectedOrder.items || []).map((item, idx) => (
                  <div key={idx} className="p-3 flex items-center justify-between text-xs">
                    <div>
                      <p className="font-bold text-slate-800">{item.name || item.product?.name || 'Item'}</p>
                      <p className="text-[11px] text-slate-400">Qty: {item.quantity} × ₹{item.price}</p>
                    </div>
                    <p className="font-bold text-slate-900">₹{(item.quantity * item.price).toLocaleString('en-IN')}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Total Summary */}
            <div className="bg-slate-900 text-white p-4 rounded-xl flex items-center justify-between">
              <span className="text-xs font-bold text-slate-300">Total Order Amount</span>
              <span className="text-lg font-black text-emerald-400">₹{selectedOrder.total?.toLocaleString('en-IN')}</span>
            </div>

            <div className="pt-2">
              <button
                onClick={() => setSelectedOrder(null)}
                className="w-full py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-xl text-xs font-bold cursor-pointer transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
