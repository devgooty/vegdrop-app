import React, { lazy, Suspense, useState } from 'react';
import Sidebar from './Sidebar';
import TopBar from './TopBar';

/**
 * The two charting views are lazy; the other eight are not.
 *
 * Not a micro-optimisation — recharts and its d3 tree are 99 kB gzip, and a
 * static import here put them in a chunk the entry HTML modulepreloads, so
 * every CUSTOMER downloaded the whole charting library before first paint to
 * render a shop front that has no chart on it. `MapLocationPicker` is loaded
 * this way for the same reason — Leaflet is the other large library that only
 * some screens need — and `vite.config.js` deliberately leaves recharts
 * unassigned by `manualChunks` so that this laziness is what decides where it
 * lands.
 *
 * `overview` is the default tab, so its fallback is visible on entry. That is
 * the cost, and it is paid by the handful of people who open the Developer
 * Console rather than by everyone who opens the shop.
 */
const DashboardOverview = lazy(() => import('./views/DashboardOverview'));
const UsageAnalytics = lazy(() => import('./views/UsageAnalytics'));

// Views
import UsersManagement from './views/UsersManagement';
import OrdersManagement from './views/OrdersManagement';
import PaymentsView from './views/PaymentsView';
import ShopkeepersView from './views/ShopkeepersView';
import DeliveryPartnersView from './views/DeliveryPartnersView';
import AlertsView from './views/AlertsView';
import SettingsDbView from './views/SettingsDbView';
import CatalogSuggestionsView from './views/CatalogSuggestionsView';

export default function AdminLayout({ user, onLogout }) {
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');

  // Map tabs to labels for the TopBar title
  const tabLabels = {
    overview: 'Dashboard Overview',
    usage: 'Usage Analytics',
    users: 'Registered IDs',
    payments: 'Payment Management',
    shopkeepers: 'Shopkeeper Analytics',
    'catalog-suggestions': 'Catalog suggestions',
    delivery: 'Delivery Analytics',
    orders: 'Orders Management',
    notifications: 'Alerts',
    settings: 'Database, Settings & DB Dump',
  };

  const renderActiveView = () => {
    switch (activeTab) {
      case 'overview':
        return <DashboardOverview setActiveTab={setActiveTab} />;
      case 'usage':
        return <UsageAnalytics />;
      case 'users':
        return <UsersManagement />;
      case 'orders':
        return <OrdersManagement />;
      case 'payments':
        return <PaymentsView />;
      case 'shopkeepers':
        return <ShopkeepersView />;
      case 'catalog-suggestions':
        return <CatalogSuggestionsView />;
      case 'delivery':
        return <DeliveryPartnersView />;
      case 'notifications':
        return <AlertsView setActiveTab={setActiveTab} />;
      case 'settings':
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
            <Suspense
              fallback={
                <p className="text-sm text-slate-500 font-medium py-12 text-center">
                  Loading…
                </p>
              }
            >
              {renderActiveView()}
            </Suspense>
          </div>
        </main>
      </div>
    </div>
  );
}
