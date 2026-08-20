import React, { useState, useEffect } from 'react';
import { Bike, RefreshCw, Search, CheckCircle2, Clock } from 'lucide-react';
import { fetchDeliveryAnalytics } from '../../../services/developer';

export default function DeliveryPartnersView() {
  const [riders, setRiders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const loadData = async () => {
    try {
      setLoading(true);
      setError('');
      const res = await fetchDeliveryAnalytics();
      setRiders(res || []);
    } catch (err) {
      setError(err?.message || 'Failed to load delivery rider analytics.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const filtered = riders.filter((r) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      r.name?.toLowerCase().includes(q) ||
      r.phone?.includes(q) ||
      r.id?.includes(q)
    );
  });

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-extrabold text-slate-800 tracking-tight">Delivery Fleet Directory</h2>
          <p className="text-sm text-slate-500 mt-1 font-medium">Active delivery partners, on-duty status, and fulfilled orders from MongoDB.</p>
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
              placeholder="Search rider name or phone..." 
              className="w-full pl-9 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all placeholder:text-slate-400"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50/70">
                <th className="px-5 py-3.5 text-[11px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100">Rider</th>
                <th className="px-5 py-3.5 text-[11px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100">Duty Status</th>
                <th className="px-5 py-3.5 text-[11px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100">Account Status</th>
                <th className="px-5 py-3.5 text-[11px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100">Bank Setup</th>
                <th className="px-5 py-3.5 text-[11px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100">Completed Orders</th>
                <th className="px-5 py-3.5 text-[11px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100">Joined</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && riders.length === 0 ? (
                <tr>
                  <td colSpan="6" className="py-12 text-center text-xs text-slate-400">
                    <RefreshCw className="w-6 h-6 animate-spin mx-auto text-emerald-500 mb-2" />
                    Loading delivery fleet from MongoDB…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan="6" className="py-12 text-center text-xs text-slate-400">
                    No delivery riders found.
                  </td>
                </tr>
              ) : (
                filtered.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="px-5 py-3.5">
                      <div className="font-bold text-slate-800 text-xs">{r.name || 'Rider'}</div>
                      <div className="text-[11px] text-slate-400">{r.phone}</div>
                    </td>
                    <td className="px-5 py-3.5">
                      <span className={`text-[10px] font-extrabold px-2.5 py-0.5 rounded-full border uppercase ${
                        r.dutyStatus === 'On Duty' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                        'bg-slate-100 text-slate-600 border-slate-200'
                      }`}>
                        {r.dutyStatus}
                      </span>
                    </td>
                    <td className="px-5 py-3.5">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md ${
                        r.status === 'suspended' ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700'
                      }`}>
                        {r.status || 'active'}
                      </span>
                    </td>
                    <td className="px-5 py-3.5">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md ${
                        r.bankStatus === 'Configured' ? 'bg-blue-50 text-blue-700' : 'bg-amber-50 text-amber-700'
                      }`}>
                        {r.bankStatus}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 font-bold text-xs text-slate-800">
                      {r.completedDeliveries} / {r.totalAssigned}
                    </td>
                    <td className="px-5 py-3.5 text-xs text-slate-500">
                      {r.joinedAt ? new Date(r.joinedAt).toLocaleDateString() : '—'}
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
