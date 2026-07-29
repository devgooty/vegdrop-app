import React from 'react';
import {
  TrendingUp,
  BarChart3,
  Building2,
  DollarSign,
  PieChart,
  Users,
  Award,
  ArrowUpRight
} from 'lucide-react';

export default function MarketOwnerPanel({ products, orders, categories }) {
  const totalGMV = orders.reduce((sum, o) => sum + o.totalAmount, 0);
  const platformCommission = Math.round(totalGMV * 0.15); // 15% marketplace commission
  const activeOrdersCount = orders.filter((o) => o.status !== 'Delivered' && o.status !== 'Cancelled').length;

  return (
    <div className="p-4 space-y-4 pb-20 bg-amber-50/40 min-h-screen">
      {/* Header Banner for Market Owner */}
      <div className="bg-gradient-to-r from-amber-900 via-amber-800 to-yellow-950 text-white p-4 rounded-2xl shadow-xl relative overflow-hidden border border-amber-500/30">
        <div className="flex items-center justify-between relative z-10">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-white/10 backdrop-blur-md rounded-xl border border-white/20">
              <Building2 className="w-6 h-6 text-amber-200" />
            </div>
            <div>
              <h2 className="font-extrabold text-lg tracking-tight">Marketplace Owner Executive Suite</h2>
              <p className="text-xs text-amber-100/90 font-medium">
                Platform Analytics & Revenue Insights
              </p>
            </div>
          </div>
          <span className="px-2.5 py-1 bg-amber-400/20 text-amber-200 rounded-full text-[11px] font-bold border border-amber-300/30 flex items-center gap-1">
            <Award className="w-3.5 h-3.5" />
            Owner Mode
          </span>
        </div>

        {/* Executive Metrics Grid */}
        <div className="grid grid-cols-3 gap-2 mt-4 pt-3 border-t border-white/10 text-center">
          <div className="bg-black/20 p-2 rounded-xl backdrop-blur-xs">
            <div className="text-[10px] text-amber-200 font-semibold uppercase tracking-wider">Gross Sales (GMV)</div>
            <div className="text-lg font-black text-amber-300">₹{totalGMV}</div>
          </div>
          <div className="bg-black/20 p-2 rounded-xl backdrop-blur-xs">
            <div className="text-[10px] text-amber-200 font-semibold uppercase tracking-wider">Net Commission</div>
            <div className="text-lg font-black text-emerald-300">₹{platformCommission}</div>
          </div>
          <div className="bg-black/20 p-2 rounded-xl backdrop-blur-xs">
            <div className="text-[10px] text-amber-200 font-semibold uppercase tracking-wider">Active Pipeline</div>
            <div className="text-lg font-black text-white">{activeOrdersCount} Orders</div>
          </div>
        </div>
      </div>

      {/* Revenue & Commission Analytics Card */}
      <div className="bg-white rounded-2xl p-4 border border-gray-200 shadow-sm space-y-3">
        <div className="flex items-center justify-between border-b border-gray-100 pb-2.5">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-amber-600" />
            <h3 className="font-extrabold text-sm text-gray-900">Financial Growth Breakdown</h3>
          </div>
          <span className="text-[11px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full flex items-center gap-0.5">
            <ArrowUpRight className="w-3.5 h-3.5" />
            +24.5% this week
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="bg-amber-50/70 p-3 rounded-xl border border-amber-100 space-y-1">
            <span className="text-gray-500 font-semibold block text-[11px]">Vendor Payouts</span>
            <span className="font-extrabold text-base text-amber-900">₹{totalGMV - platformCommission}</span>
            <span className="text-[10px] text-gray-500 block">85% total payout to merchants</span>
          </div>

          <div className="bg-emerald-50/70 p-3 rounded-xl border border-emerald-100 space-y-1">
            <span className="text-gray-500 font-semibold block text-[11px]">Platform 15% Cut</span>
            <span className="font-extrabold text-base text-emerald-700">₹{platformCommission}</span>
            <span className="text-[10px] text-emerald-800 block">Direct net profit earned</span>
          </div>
        </div>
      </div>

      {/* Vendors Overview */}
      <div className="bg-white rounded-2xl p-4 border border-gray-200 shadow-sm space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="font-extrabold text-xs text-gray-900 uppercase tracking-wider">
            Artisanal Merchants & Vendors (4 Active)
          </h4>
          <span className="text-[11px] text-amber-700 font-bold">100% Operational</span>
        </div>

        <div className="space-y-2 text-xs">
          {[
            { name: 'Green Valley Organic Farms', location: 'Indiranagar', revenue: '₹4,850', rating: '4.9 ★' },
            { name: 'Shimla Apple Orchards Direct', location: 'Whitefield', revenue: '₹3,200', rating: '4.8 ★' },
            { name: 'Desi Produce Collective', location: 'Bellandur', revenue: '₹2,640', rating: '4.7 ★' },
          ].map((v, i) => (
            <div key={i} className="flex justify-between items-center p-2.5 bg-gray-50 rounded-xl border border-gray-100">
              <div>
                <span className="font-bold text-gray-900 block">{v.name}</span>
                <span className="text-[10px] text-gray-500">{v.location} • Rating: {v.rating}</span>
              </div>
              <div className="text-right">
                <span className="font-extrabold text-[#1B4D3E] block">{v.revenue}</span>
                <span className="text-[10px] text-emerald-600 font-bold">Active</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
