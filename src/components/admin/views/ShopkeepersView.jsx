import React, { useState, useEffect } from 'react';
import { Store, ShieldCheck, ShieldAlert, RefreshCw, Search, Package } from 'lucide-react';
import { fetchShopkeeperAnalytics } from '../../../services/developer';

export default function ShopkeepersView() {
  const [shopkeepers, setShopkeepers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const loadData = async () => {
    try {
      setLoading(true);
      setError('');
      const res = await fetchShopkeeperAnalytics();
      setShopkeepers(res || []);
    } catch (err) {
      setError(err?.message || 'Failed to load shopkeeper analytics.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const filtered = shopkeepers.filter((s) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      s.name?.toLowerCase().includes(q) ||
      s.phone?.includes(q) ||
      s.stallName?.toLowerCase().includes(q) ||
      s.marketName?.toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-extrabold text-slate-800 tracking-tight">Shopkeeper & Vendor Directory</h2>
          <p className="text-sm text-slate-500 mt-1 font-medium">Stalls, KYC verification status, and catalog counts from MongoDB.</p>
        </div>
        <button 
          onClick={loadData}
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

      <div className="bg-white rounded-2xl border border-slate-100 shadow-[0_4px_20px_rgb(0,0,0,0.03)] overflow-hidden">
        
        <div className="p-4 border-b border-slate-100 flex items-center justify-between">
          <div className="relative group w-full md:w-64">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 group-focus-within:text-emerald-500 transition-colors" />
            <input 
              type="text" 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search vendor, stall, market..." 
              className="w-full pl-9 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all placeholder:text-slate-400"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50/70">
                <th className="px-5 py-3.5 text-[11px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100">Shopkeeper</th>
                <th className="px-5 py-3.5 text-[11px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100">Stall / Market</th>
                <th className="px-5 py-3.5 text-[11px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100">Stall Status</th>
                <th className="px-5 py-3.5 text-[11px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100">KYC Status</th>
                <th className="px-5 py-3.5 text-[11px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100">Listed Products</th>
                <th className="px-5 py-3.5 text-[11px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100">Joined</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && shopkeepers.length === 0 ? (
                <tr>
                  <td colSpan="6" className="py-12 text-center text-xs text-slate-400">
                    <RefreshCw className="w-6 h-6 animate-spin mx-auto text-emerald-500 mb-2" />
                    Querying shopkeepers from MongoDB…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan="6" className="py-12 text-center text-xs text-slate-400">
                    No shopkeepers found.
                  </td>
                </tr>
              ) : (
                filtered.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="px-5 py-3.5">
                      <div className="font-bold text-slate-800 text-xs">{s.name || 'Vendor'}</div>
                      <div className="text-[11px] text-slate-400">{s.phone}</div>
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="font-bold text-slate-800 text-xs">{s.stallName}</div>
                      <div className="text-[11px] text-slate-400">{s.marketName}</div>
                    </td>
                    <td className="px-5 py-3.5">
                      <span className={`text-[10px] font-extrabold px-2.5 py-0.5 rounded-full border uppercase ${
                        s.stallStatus === 'approved' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                        s.stallStatus === 'pending' ? 'bg-amber-50 text-amber-700 border-amber-200' :
                        'bg-slate-100 text-slate-600 border-slate-200'
                      }`}>
                        {s.stallStatus}
                      </span>
                    </td>
                    <td className="px-5 py-3.5">
                      <span className={`text-[10px] font-extrabold px-2.5 py-0.5 rounded-full border uppercase ${
                        s.kycStatus === 'verified' || s.kycStatus === 'approved' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                        s.kycStatus === 'pending' ? 'bg-amber-50 text-amber-700 border-amber-200' :
                        'bg-rose-50 text-rose-700 border-rose-200'
                      }`}>
                        {s.kycStatus}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 font-bold text-xs text-slate-800">
                      {s.productsListed} items
                    </td>
                    <td className="px-5 py-3.5 text-xs text-slate-500">
                      {s.joinedAt ? new Date(s.joinedAt).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

      </div>

    </div>
  );
}
