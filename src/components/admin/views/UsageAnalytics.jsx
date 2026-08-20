import React, { useState, useEffect } from 'react';
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import { RefreshCw, Users, ShieldAlert } from 'lucide-react';
import { fetchUsageAnalytics } from '../../../services/developer';

export default function UsageAnalytics() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [days, setDays] = useState(7);

  const loadData = async (selectedDays = days) => {
    try {
      setLoading(true);
      setError('');
      const res = await fetchUsageAnalytics(selectedDays);
      setData(res);
    } catch (err) {
      setError(err?.message || 'Failed to load usage analytics from database.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData(days);
  }, [days]);

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-extrabold text-slate-800 tracking-tight">App Usage & Growth Analytics</h2>
          <p className="text-sm text-slate-500 mt-1 font-medium">Daily user registrations and active accounts by role.</p>
        </div>
        <div className="flex gap-1.5 bg-slate-100 p-1 rounded-xl">
          {[
            { label: '7 Days', value: 7 },
            { label: '30 Days', value: 30 },
            { label: '90 Days', value: 90 },
          ].map((item) => (
            <button
              key={item.value}
              onClick={() => setDays(item.value)}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-colors cursor-pointer ${
                days === item.value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-900'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="bg-rose-50 border border-rose-200 p-4 rounded-xl text-rose-800 text-xs font-bold">
          {error}
        </div>
      )}

      {/* Main Chart */}
      <div className="bg-white rounded-2xl p-6 border border-slate-100 shadow-[0_4px_20px_rgb(0,0,0,0.03)]">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h3 className="text-base font-bold text-slate-800">User Registrations Over Time</h3>
            <p className="text-xs text-slate-400">Database user creation timeline grouped by role</p>
          </div>
          {loading && <RefreshCw className="w-4 h-4 animate-spin text-emerald-500" />}
        </div>
        
        <div className="h-[360px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data?.series || []} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fill: '#64748b', fontSize: 11}} dy={10} />
              <YAxis axisLine={false} tickLine={false} tick={{fill: '#64748b', fontSize: 11}} />
              <Tooltip 
                contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 4px 20px rgba(0,0,0,0.08)' }}
                labelStyle={{ fontWeight: 'bold', color: '#1e293b', marginBottom: '8px' }}
              />
              <Legend verticalAlign="top" height={36} iconType="circle" />
              
              <Line type="monotone" name="Customers" dataKey="customers" stroke="#3b82f6" strokeWidth={2.5} dot={{r: 3}} activeDot={{r: 6}} />
              <Line type="monotone" name="Shopkeepers" dataKey="shopkeepers" stroke="#10b981" strokeWidth={2.5} dot={{r: 3}} activeDot={{r: 6}} />
              <Line type="monotone" name="Delivery Partners" dataKey="delivery" stroke="#f59e0b" strokeWidth={2.5} dot={{r: 3}} activeDot={{r: 6}} />
              <Line type="monotone" name="Market Owners" dataKey="market_owners" stroke="#6366f1" strokeWidth={2} dot={{r: 3}} activeDot={{r: 6}} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Role Distribution Breakdown */}
      <div className="bg-white rounded-2xl p-6 border border-slate-100 shadow-[0_4px_20px_rgb(0,0,0,0.03)]">
        <h3 className="text-base font-bold text-slate-800 mb-4">Total Ecosystem Account Breakdown</h3>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {(data?.roleDistribution || []).map((r) => (
            <div key={r.role} className="p-4 bg-slate-50 rounded-xl border border-slate-100 text-center">
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">{r.role.replace('_', ' ')}</p>
              <p className="text-2xl font-black text-slate-800 mt-1">{r.count}</p>
            </div>
          ))}
        </div>
      </div>

    </div>
  );
}
