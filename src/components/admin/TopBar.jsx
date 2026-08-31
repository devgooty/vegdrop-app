import React, { useState, useEffect } from 'react';
import { Menu, Search, Bell, Database, User, LogOut, RefreshCw, CheckCircle2, AlertTriangle } from 'lucide-react';
import { fetchDatabaseStatus, fetchSystemAlerts } from '../../services/developer';

export default function TopBar({ setIsMobileOpen, activeTabLabel, user, onLogout, setActiveTab }) {
  const [dbStatus, setDbStatus] = useState({ connected: true, state: 'Checking…' });
  const [alertCount, setAlertCount] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const checkStatus = async () => {
    try {
      setIsRefreshing(true);
      const [dbRes, alertRes] = await Promise.allSettled([
        fetchDatabaseStatus(),
        fetchSystemAlerts(),
      ]);

      if (dbRes.status === 'fulfilled' && dbRes.value?.database) {
        setDbStatus({
          connected: dbRes.value.database.connected,
          state: dbRes.value.database.state,
          dbName: dbRes.value.database.dbName,
        });
      } else {
        setDbStatus({ connected: false, state: 'Disconnected' });
      }

      if (alertRes.status === 'fulfilled' && alertRes.value?.totalAlerts !== undefined) {
        setAlertCount(alertRes.value.totalAlerts);
      }
    } catch {
      setDbStatus({ connected: false, state: 'Offline' });
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-4 lg:px-8 z-10 relative shadow-sm">
      
      {/* Left side: Mobile menu toggle + Context */}
      <div className="flex items-center gap-4">
        <button 
          onClick={() => setIsMobileOpen(true)}
          className="p-2 -ml-2 rounded-lg hover:bg-slate-100 lg:hidden cursor-pointer"
          title="Open menu"
        >
          <Menu className="w-5 h-5 text-slate-600" />
        </button>
        <div className="flex items-center gap-3">
          <h1 className="font-extrabold text-xl text-slate-800 hidden sm:block">
            {activeTabLabel}
          </h1>
          {/* Live Database status pill */}
          <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold border ${
            dbStatus.connected 
              ? 'bg-emerald-50 border-emerald-200 text-emerald-700' 
              : 'bg-rose-50 border-rose-200 text-rose-700'
          }`}>
            <span className={`w-2 h-2 rounded-full ${dbStatus.connected ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'}`} />
            <Database className="w-3 h-3" />
            <span className="hidden md:inline">{dbStatus.connected ? 'MongoDB Live' : 'DB Disconnected'}</span>
          </div>
        </div>
      </div>

      {/* Right side tools */}
      <div className="flex items-center gap-3 sm:gap-4">
        
        {/* Refresh button */}
        <button
          onClick={checkStatus}
          disabled={isRefreshing}
          className="p-2 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
          title="Refresh database metrics"
        >
          <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin text-green-600' : ''}`} />
        </button>

        {/* System Alerts */}
        <button 
          onClick={() => setActiveTab && setActiveTab('notifications')}
          className="relative p-2 rounded-lg text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
          title="System Alerts"
        >
          <Bell className="w-5 h-5" />
          {alertCount > 0 && (
            <span className="absolute top-1 right-1 px-1.5 py-0.5 min-w-4 text-[11.5px] font-black bg-rose-500 text-white rounded-full flex items-center justify-center leading-none">
              {alertCount}
            </span>
          )}
        </button>

        {/* Profile info */}
        <div className="flex items-center gap-3 pl-2 sm:pl-4 sm:border-l sm:border-slate-200">
          <div className="w-8 h-8 rounded-full bg-slate-900 text-white flex items-center justify-center font-bold text-xs">
            {user?.name ? user.name.slice(0, 2).toUpperCase() : 'DEV'}
          </div>
          <div className="hidden sm:block text-left">
            <p className="text-xs font-bold text-slate-800 leading-tight truncate max-w-[120px]">
              {user?.name || 'Developer'}
            </p>
            <p className="text-[11.5px] text-emerald-600 font-bold uppercase tracking-wider">
              {user?.role || 'Developer'}
            </p>
          </div>

          {/* Logout button */}
          <button
            onClick={onLogout}
            className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors cursor-pointer"
            title="Sign out of Developer Console"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
