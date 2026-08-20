import React from 'react';
import AdminLayout from './components/admin/AdminLayout';
import LoginPage from './components/LoginPage';
import SplashScreen from './components/SplashScreen';
import useSessionUser from './hooks/useSessionUser';
import { logout } from './services/auth';

const DEVELOPER_ROLES = ['developer'];

export default function DeveloperApp() {
  const { user, setUser, isRestoringSession } = useSessionUser({
    allowedRoles: DEVELOPER_ROLES,
  });

  if (isRestoringSession) {
    return <SplashScreen edition="developer" />;
  }

  if (!user || !DEVELOPER_ROLES.includes(user.role)) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col justify-center">
        <LoginPage
          onLogin={setUser}
          appType="developer"
          storagePrefix="vegdrop_developer_"
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

  return <AdminLayout user={user} onLogout={handleLogout} />;
}
