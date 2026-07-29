import React, { useMemo } from 'react';
import { IndianRupee, Package, Clock, CheckCircle2, ChevronRight } from 'lucide-react';

export default function AccountHistory({ user, orders }) {
  // Filter orders for the current user
  const userOrders = useMemo(() => {
    if (!user) return [];
    return orders.filter(o => o.customerName === user.name || o.phone === user.phone).sort((a, b) => b.timestamp - a.timestamp);
  }, [user, orders]);

  // Calculate total spent (only for Delivered orders, or all? Let's say all non-cancelled orders)
  const totalSpent = useMemo(() => {
    return userOrders
      .filter(o => o.status !== 'Cancelled')
      .reduce((total, order) => total + (order.totalAmount || 0), 0);
  }, [userOrders]);

  const totalItemsOrdered = useMemo(() => {
    return userOrders
      .filter(o => o.status !== 'Cancelled')
      .reduce((total, order) => {
        const itemQty = order.items?.reduce((qty, item) => qty + (item.quantity || 1), 0) || 0;
        return total + itemQty;
      }, 0);
  }, [userOrders]);

  return (
    <div className="space-y-4 text-left animate-fade-in w-full max-w-md mx-auto">
      {/* Total Spent Dashboard Card */}
      <div className="bg-gradient-to-br from-[#1B4D3E] to-[#0A2E22] p-5 rounded-[2rem] shadow-[0_8px_16px_rgba(27,77,62,0.2)] text-white relative overflow-hidden">
        <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-full blur-2xl -translate-y-8 translate-x-8" />
        <div className="absolute bottom-0 left-0 w-24 h-24 bg-white/5 rounded-full blur-2xl translate-y-8 -translate-x-4" />
        
        <div className="relative z-10 flex items-center justify-between">
          <div>
            <p className="text-emerald-200/80 text-[10px] font-extrabold uppercase tracking-widest mb-1">Total Lifetime Spent</p>
            <div className="flex items-end gap-1">
              <span className="text-2xl font-bold text-emerald-400">₹</span>
              <span className="text-4xl font-black tracking-tight drop-shadow-sm">{totalSpent.toLocaleString('en-IN')}</span>
            </div>
          </div>
          <div className="w-12 h-12 bg-white/10 rounded-2xl flex items-center justify-center backdrop-blur-md border border-white/10">
            <IndianRupee className="w-6 h-6 text-emerald-300" />
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 border-t border-white/10 pt-4">
          <div>
            <p className="text-emerald-200/60 text-[9px] font-bold uppercase tracking-wider mb-0.5">Total Orders</p>
            <p className="font-black text-lg text-emerald-50">{userOrders.length}</p>
          </div>
          <div>
            <p className="text-emerald-200/60 text-[9px] font-bold uppercase tracking-wider mb-0.5">Items Purchased</p>
            <p className="font-black text-lg text-emerald-50">{totalItemsOrdered}</p>
          </div>
        </div>
      </div>

      {/* Orders List */}
      <div className="space-y-3">
        <h3 className="font-black text-slate-800 text-sm px-2 drop-shadow-sm flex items-center gap-2">
          <Package className="w-4 h-4 text-emerald-600" />
          Recent Order History
        </h3>

        {userOrders.length === 0 ? (
          <div className="bg-slate-50 border border-slate-100 rounded-3xl p-8 text-center text-slate-400">
            <Package className="w-12 h-12 mx-auto mb-3 opacity-20" />
            <p className="font-bold text-sm">No orders yet</p>
            <p className="text-xs font-medium mt-1 opacity-70">Your history will appear here once you buy something.</p>
          </div>
        ) : (
          userOrders.map((order) => (
            <div key={order.id} className="bg-white border border-slate-100 rounded-3xl p-4 shadow-sm relative overflow-hidden group hover:shadow-md transition-shadow">
              {/* Decorative side accent based on status */}
              <div className={`absolute left-0 top-0 bottom-0 w-1 ${
                order.status === 'Delivered' ? 'bg-emerald-400' : 
                order.status === 'Cancelled' ? 'bg-rose-400' : 'bg-amber-400'
              }`} />

              <div className="flex justify-between items-start mb-3">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-black text-slate-800">{order.id}</span>
                    <span className={`text-[9px] font-extrabold px-1.5 py-0.5 rounded-md uppercase tracking-wider ${
                      order.status === 'Delivered' ? 'bg-emerald-50 text-emerald-600 border border-emerald-100' :
                      order.status === 'Cancelled' ? 'bg-rose-50 text-rose-600 border border-rose-100' :
                      'bg-amber-50 text-amber-600 border border-amber-100'
                    }`}>
                      {order.status}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 text-[10px] font-bold text-slate-400">
                    <Clock className="w-3 h-3" />
                    {new Date(order.timestamp).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
                <div className="text-right">
                  <span className="block font-black text-emerald-700 text-base">₹{order.totalAmount}</span>
                  <span className="text-[9px] font-bold text-slate-400 uppercase">{order.paymentMethod || 'Cash'}</span>
                </div>
              </div>

              {/* Items List */}
              <div className="bg-slate-50/50 rounded-2xl p-3 border border-slate-50 space-y-2">
                {order.items?.map((item, idx) => (
                  <div key={idx} className="flex justify-between items-center text-xs">
                    <div className="flex items-center gap-2 overflow-hidden pr-2">
                      <span className="w-5 h-5 rounded-md bg-white border border-slate-100 flex items-center justify-center font-bold text-[9px] text-slate-600 shrink-0">
                        {item.quantity}x
                      </span>
                      <span className="font-semibold text-slate-700 truncate">{item.name}</span>
                    </div>
                    <span className="font-bold text-slate-900 shrink-0">₹{item.price * item.quantity}</span>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
