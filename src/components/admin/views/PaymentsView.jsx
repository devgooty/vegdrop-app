import React, { useState, useEffect } from 'react';
import { 
  CreditCard, TrendingUp, TrendingDown, RefreshCw, 
  CheckCircle2, ArrowUpRight, ArrowDownLeft, Search
} from 'lucide-react';
import { fetchPaymentLedger } from '../../../services/developer';

export default function PaymentsView() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  const loadData = async () => {
    try {
      setLoading(true);
      setError('');
      const res = await fetchPaymentLedger();
      setData(res);
    } catch (err) {
      setError(err?.message || 'Failed to load payments from database.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const summary = data?.summary || { totalTransactions: 0, totalCredits: 0, totalDebits: 0, netFlow: 0 };
  const transactions = data?.transactions || [];

  const filteredTransactions = transactions.filter((t) => {
    if (filterType !== 'all' && t.type !== filterType) return false;
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      t.userName?.toLowerCase().includes(q) ||
      t.userPhone?.includes(q) ||
      t.reason?.toLowerCase().includes(q) ||
      t.id?.toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-extrabold text-slate-800 tracking-tight">Payment & Ledger Management</h2>
          <p className="text-sm text-slate-500 mt-1 font-medium">Live WalletTransaction documents and Razorpay payment flows from MongoDB.</p>
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

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-2xl p-5 border border-slate-100 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-400 uppercase">Total Inflow (Credits)</span>
            <div className="p-2 bg-emerald-50 text-emerald-600 rounded-xl">
              <ArrowDownLeft className="w-4 h-4" />
            </div>
          </div>
          <p className="text-2xl font-black text-emerald-600 mt-2">
            +₹{Number(summary.totalCredits || 0).toLocaleString('en-IN')}
          </p>
          <p className="text-[11px] text-slate-400 mt-1">Wallet topups & incoming settlements</p>
        </div>

        <div className="bg-white rounded-2xl p-5 border border-slate-100 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-400 uppercase">Total Outflow (Debits)</span>
            <div className="p-2 bg-rose-50 text-rose-600 rounded-xl">
              <ArrowUpRight className="w-4 h-4" />
            </div>
          </div>
          <p className="text-2xl font-black text-rose-600 mt-2">
            −₹{Number(summary.totalDebits || 0).toLocaleString('en-IN')}
          </p>
          <p className="text-[11px] text-slate-400 mt-1">Order checkouts & rider payouts</p>
        </div>

        <div className="bg-white rounded-2xl p-5 border border-slate-100 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-400 uppercase">Net Wallet Float</span>
            <div className="p-2 bg-blue-50 text-blue-600 rounded-xl">
              <CreditCard className="w-4 h-4" />
            </div>
          </div>
          <p className="text-2xl font-black text-slate-900 mt-2">
            ₹{Number(summary.netFlow || 0).toLocaleString('en-IN')}
          </p>
          <p className="text-[11px] text-slate-400 mt-1">Across {summary.totalTransactions} recorded transactions</p>
        </div>
      </div>

      {/* Transactions Table */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-[0_4px_20px_rgb(0,0,0,0.03)] overflow-hidden">
        
        <div className="p-4 border-b border-slate-100 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex gap-1.5 bg-slate-50 p-1 rounded-xl">
            {['all', 'credit', 'debit'].map(type => (
              <button 
                key={type}
                onClick={() => setFilterType(type)}
                className={`px-3 py-1.5 text-xs font-bold rounded-lg uppercase tracking-wider transition-colors cursor-pointer ${
                  filterType === type ? 'bg-white text-emerald-700 shadow-sm border border-slate-200' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {type}
              </button>
            ))}
          </div>

          <div className="relative group w-full md:w-64">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 group-focus-within:text-emerald-500 transition-colors" />
            <input 
              type="text" 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search user, reason, ref..." 
              className="w-full pl-9 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all placeholder:text-slate-400"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50/70">
                <th className="px-5 py-3.5 text-[11px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100">User / Account</th>
                <th className="px-5 py-3.5 text-[11px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100">Reason / Description</th>
                <th className="px-5 py-3.5 text-[11px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100">Amount</th>
                <th className="px-5 py-3.5 text-[11px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100">Balance After</th>
                <th className="px-5 py-3.5 text-[11px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100">Timestamp</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && transactions.length === 0 ? (
                <tr>
                  <td colSpan="5" className="py-12 text-center text-xs text-slate-400">
                    <RefreshCw className="w-6 h-6 animate-spin mx-auto text-emerald-500 mb-2" />
                    Querying transactions from MongoDB…
                  </td>
                </tr>
              ) : filteredTransactions.length === 0 ? (
                <tr>
                  <td colSpan="5" className="py-12 text-center text-xs text-slate-400">
                    No transactions found in wallet ledger.
                  </td>
                </tr>
              ) : (
                filteredTransactions.map((t) => (
                  <tr key={t.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="px-5 py-3.5">
                      <div className="font-bold text-slate-800 text-xs">{t.userName}</div>
                      <div className="text-[11px] text-slate-400">{t.userPhone} ({t.userRole})</div>
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="font-mono text-xs text-slate-700 font-semibold">{t.reason}</div>
                      {t.note && <div className="text-[11px] text-slate-400">{t.note}</div>}
                    </td>
                    <td className="px-5 py-3.5">
                      <span className={`text-xs font-black ${
                        t.type === 'credit' ? 'text-emerald-600' : 'text-rose-600'
                      }`}>
                        {t.type === 'credit' ? '+' : '−'}₹{Number(t.amount || 0).toLocaleString('en-IN')}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 font-mono text-xs text-slate-600">
                      ₹{Number(t.balanceAfter || 0).toLocaleString('en-IN')}
                    </td>
                    <td className="px-5 py-3.5 text-xs text-slate-500">
                      {t.createdAt ? new Date(t.createdAt).toLocaleString() : '—'}
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
