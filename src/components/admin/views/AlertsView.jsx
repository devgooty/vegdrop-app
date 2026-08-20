import React, { useState, useEffect } from 'react';
import { 
  Bell, ShieldAlert, AlertTriangle, CheckCircle2, Clock, 
  Store, ShoppingCart, RefreshCw, ArrowRight, PackageX
} from 'lucide-react';
import { fetchSystemAlerts } from '../../../services/developer';

export default function AlertsView({ setActiveTab }) {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadAlerts = async () => {
    try {
      setLoading(true);
      setError('');
      const res = await fetchSystemAlerts();
      setAlerts(res?.alerts || []);
    } catch (err) {
      setError(err?.message || 'Failed to load system alerts.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAlerts();
  }, []);

  const getAlertIcon = (type) => {
    switch (type) {
      case 'kyc':
        return <ShieldAlert className="w-5 h-5 text-amber-600" />;
      case 'stall':
        return <Store className="w-5 h-5 text-indigo-600" />;
      case 'inventory':
        return <PackageX className="w-5 h-5 text-rose-600" />;
      case 'orders':
        return <ShoppingCart className="w-5 h-5 text-blue-600" />;
      default:
        return <AlertTriangle className="w-5 h-5 text-amber-600" />;
    }
  };

  const getSeverityBadge = (severity) => {
    switch (severity) {
      case 'high':
        return 'bg-rose-50 text-rose-700 border-rose-200';
      case 'warning':
      case 'medium':
        return 'bg-amber-50 text-amber-700 border-amber-200';
      default:
        return 'bg-blue-50 text-blue-700 border-blue-200';
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-extrabold text-slate-800 tracking-tight">System Alerts & Diagnostics</h2>
          <p className="text-sm text-slate-500 mt-1 font-medium">Action items dynamically identified across database collections.</p>
        </div>
        <button 
          onClick={loadAlerts}
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

      {loading && alerts.length === 0 ? (
        <div className="py-16 text-center text-xs text-slate-400">
          <RefreshCw className="w-8 h-8 animate-spin mx-auto text-emerald-500 mb-2" />
          Checking database conditions for alerts…
        </div>
      ) : alerts.length === 0 ? (
        <div className="bg-emerald-50/60 border border-emerald-200/60 rounded-2xl p-12 text-center space-y-3">
          <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center mx-auto">
            <CheckCircle2 className="w-6 h-6" />
          </div>
          <h3 className="text-base font-extrabold text-emerald-900">All Systems Operational</h3>
          <p className="text-xs text-emerald-700 max-w-md mx-auto">
            No pending KYC submissions, stall bottlenecks, unassigned orders, or depleted inventories detected.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {alerts.map((alert) => (
            <div 
              key={alert.id}
              className="bg-white border border-slate-100 rounded-2xl p-5 shadow-sm hover:shadow-md transition-shadow flex flex-col sm:flex-row sm:items-center justify-between gap-4"
            >
              <div className="flex items-start gap-4">
                <div className="p-3 bg-slate-50 rounded-2xl shrink-0">
                  {getAlertIcon(alert.type)}
                </div>
                <div className="space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h4 className="text-sm font-black text-slate-800">{alert.title}</h4>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border uppercase ${getSeverityBadge(alert.severity)}`}>
                      {alert.severity}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500">{alert.description}</p>
                  {alert.timestamp && (
                    <p className="text-[10px] text-slate-400 font-medium">
                      {new Date(alert.timestamp).toLocaleString()}
                    </p>
                  )}
                </div>
              </div>

              {alert.actionTab && (
                <button
                  onClick={() => setActiveTab && setActiveTab(alert.actionTab)}
                  className="flex items-center justify-center gap-1.5 px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold cursor-pointer transition-colors shrink-0"
                >
                  <span>{alert.actionLabel || 'Take Action'}</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

    </div>
  );
}
