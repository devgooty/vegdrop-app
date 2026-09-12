import React, { Suspense, lazy } from 'react';
import LoginPage from './components/LoginPage';
import SplashScreen from './components/SplashScreen';
import { HomeSkeleton } from './components/LoadingSkeleton';
import useSessionUser from './hooks/useSessionUser';
import { logout } from './services/auth';

const MarketOwnerPanel = lazy(() => import('./components/MarketOwnerPanel'));

const MARKET_OWNER_ROLES = ['market_owner'];

export default function MarketOwnerApp() {
  const { user, setUser, isRestoringSession } = useSessionUser({
    allowedRoles: MARKET_OWNER_ROLES,
  });

  if (isRestoringSession) {
    return <SplashScreen edition="market_owner" />;
  }

  if (!user || !MARKET_OWNER_ROLES.includes(user.role)) {
    return (
      <div className="min-h-screen bg-[#F8F5EF] flex flex-col justify-center">
        <LoginPage
          onLogin={setUser}
          appType="market_owner"
          storagePrefix="vegdrop_market_"
        />
      </div>
    );
  }

  const handleLogout = async () => {
    try {
      await logout();
    } finally {
      setUser(null);
    }
  };

  return (
    <Suspense fallback={<HomeSkeleton />}>
      <MarketOwnerPanel onExit={handleLogout} />
    </Suspense>
  );
}
