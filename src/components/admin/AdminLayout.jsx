import React, { useState } from 'react';
import Sidebar from './Sidebar';
import TopBar from './TopBar';

// Views
import DashboardOverview from './views/DashboardOverview';
import UsageAnalytics from './views/UsageAnalytics';
import UsersManagement from './views/UsersManagement';
import OrdersManagement from './views/OrdersManagement';
import PaymentsView from './views/PaymentsView';
import ShopkeepersView from './views/ShopkeepersView';
import DeliveryPartnersView from './views/DeliveryPartnersView';
import AlertsView from './views/AlertsView';
import SettingsDbView from './views/SettingsDbView';

export default function AdminLayout({ user, onLogout }) {
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');

  // Map tabs to labels for the TopBar title
  const tabLabels = {
    overview: 'Dashboard Overview',
    usage: 'Usage Analytics',
    users: 'Registered IDs',
    sales: 'Sales & Revenue',
    payments: 'Payment Management',
    allocation: 'Payment Allocation',
    shopkeepers: 'Shopkeeper Analytics',
    delivery: 'Delivery Analytics',
    customers: 'Customer Analytics',
    orders: 'Orders Management',
    reports: 'Reports & DB Dump',
    notifications: 'Alerts',
    settings: 'Database & Settings',
  };

  const renderActiveView = () => {
    switch (activeTab) {
      case 'overview':
      case 'sales':
        return <DashboardOverview setActiveTab={setActiveTab} />;
      case 'usage':
      case 'customers':
        return <UsageAnalytics />;
      case 'users':
        return <UsersManagement />;
      case 'orders':
        return <OrdersManagement />;
      case 'payments':
      case 'allocation':
        return <PaymentsView />;
      case 'shopkeepers':
        return <ShopkeepersView />;
      case 'delivery':
        return <DeliveryPartnersView />;
      case 'notifications':
        return <AlertsView setActiveTab={setActiveTab} />;
      case 'settings':
      case 'reports':
        return <SettingsDbView />;
      default:
        return <DashboardOverview setActiveTab={setActiveTab} />;
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex">
      <Sidebar 
        activeTab={activeTab} 
        setActiveTab={setActiveTab} 
        isMobileOpen={isMobileOpen} 
        setIsMobileOpen={setIsMobileOpen} 
      />
      
      <div className="flex-1 flex flex-col lg:pl-64 transition-all duration-300">
        <TopBar 
          setIsMobileOpen={setIsMobileOpen} 
          activeTabLabel={tabLabels[activeTab] || 'Developer Console'} 
          user={user}
          onLogout={onLogout}
          setActiveTab={setActiveTab}
        />
        
        {/* Main Content Area */}
        <main className="flex-1 p-4 md:p-6 lg:p-8 overflow-y-auto">
          <div className="max-w-7xl mx-auto">
            {renderActiveView()}
          </div>
        </main>
      </div>
    </div>
  );
}
