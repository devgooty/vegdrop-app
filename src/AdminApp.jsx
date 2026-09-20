import React from 'react';
import AdminAppLayout from './components/adminApp/AdminAppLayout';
import LoginPage from './components/LoginPage';
import SplashScreen from './components/SplashScreen';
import useSessionUser from './hooks/useSessionUser';
import { logout } from './services/auth';

const ADMIN_ROLES = ['admin', 'developer'];

export default function AdminApp() {
  const { user, setUser, isRestoringSession } = useSessionUser({
    allowedRoles: ADMIN_ROLES,
  });

  if (isRestoringSession) {
    return <SplashScreen edition="admin" />;
  }

  if (!user || !ADMIN_ROLES.includes(user.role)) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col justify-center">
        <LoginPage
          onLogin={setUser}
          appType="admin"
          storagePrefix="vegdrop_admin_"
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

  return <AdminAppLayout user={user} onLogout={handleLogout} />;
}
