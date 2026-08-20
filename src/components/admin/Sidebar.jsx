import React from 'react';
import { 
  LayoutDashboard, 
  Activity, 
  Users, 
  TrendingUp, 
  CreditCard, 
  PieChart, 
  Store, 
  Bike, 
  UserCircle, 
  ShoppingCart, 
  FileText, 
  Bell, 
  Settings 
} from 'lucide-react';

const navItems = [
  { id: 'overview', label: 'Dashboard Overview', icon: LayoutDashboard },
  { id: 'usage', label: 'Usage Analytics', icon: Activity },
  { id: 'users', label: 'Registered IDs', icon: Users },
  { id: 'sales', label: 'Sales & Revenue', icon: TrendingUp },
  { id: 'payments', label: 'Payment Management', icon: CreditCard },
  { id: 'allocation', label: 'Payment Allocation', icon: PieChart },
  { id: 'shopkeepers', label: 'Shopkeeper Analytics', icon: Store },
  { id: 'delivery', label: 'Delivery Analytics', icon: Bike },
  { id: 'customers', label: 'Customer Analytics', icon: UserCircle },
  { id: 'orders', label: 'Orders Management', icon: ShoppingCart },
  { id: 'reports', label: 'Reports', icon: FileText },
  { id: 'notifications', label: 'Alerts', icon: Bell },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export default function Sidebar({ activeTab, setActiveTab, isMobileOpen, setIsMobileOpen }) {
  return (
    <>
      {/* Mobile Backdrop */}
      {isMobileOpen && (
        <div 
          className="fixed inset-0 bg-slate-900/50 z-40 lg:hidden backdrop-blur-sm"
          onClick={() => setIsMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div className={`fixed top-0 left-0 bottom-0 w-64 bg-white border-r border-slate-200 z-50 flex flex-col transition-transform duration-300 ease-in-out ${isMobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>
        
        {/* Brand */}
        <div className="h-16 flex items-center px-6 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-green-500 flex items-center justify-center text-white font-bold text-xl">
              V
            </div>
            <span className="font-extrabold text-lg text-slate-800 tracking-tight">Veg Bazaar Admin</span>
          </div>
        </div>

        {/* Nav Links */}
        <div className="flex-1 overflow-y-auto py-4 px-3 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  setActiveTab(item.id);
                  setIsMobileOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all cursor-pointer ${
                  isActive 
                    ? 'bg-green-50 text-green-700' 
                    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                }`}
              >
                <Icon className={`w-5 h-5 ${isActive ? 'text-green-600' : 'text-slate-400'}`} />
                {item.label}
              </button>
            );
          })}
        </div>

        {/* Footer info */}
        <div className="p-4 border-t border-slate-100 text-xs text-slate-400 text-center">
          Veg Bazaar v2.0 &copy; 2026
        </div>
      </div>
    </>
  );
}
