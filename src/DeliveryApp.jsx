import React, { useState, useEffect, useCallback } from 'react';
import DeliveryPanel from './components/DeliveryPanel';
import LoginPage from './components/LoginPage';
import SplashScreen from './components/SplashScreen';
import { useToast } from './components/Toast';
import { restoreSession, logout } from './services/auth';
import { initialOrders, initialRegisteredUsers } from './data/mockData';
import { fetchOrders, updateOrderStatus } from './services/orders';

export default function DeliveryApp() {
  const toast = useToast();

  // Seeded from fixtures, then replaced by the server's role-scoped list. Never
  // read from localStorage: that key is shared with every app on the origin.
  const [orders, setOrders] = useState(initialOrders);
  const [registeredUsers, setRegisteredUsers] = useState(initialRegisteredUsers);

  /**
   * Session state lives in memory and is restored from the httpOnly refresh
   * cookie on mount — never from localStorage, where an attacker-editable
   * `role` field would let anyone grant themselves this panel.
   */
  const [user, setUser] = useState(null);
  const [isRestoringSession, setIsRestoringSession] = useState(true);
  const [showSplash, setShowSplash] = useState(true);

  useEffect(() => {
    let cancelled = false;
    restoreSession()
      .then((restored) => {
        if (cancelled) return;
        if (restored && ['delivery', 'developer'].includes(restored.role)) {
          setUser(restored);
        }
      })
      .finally(() => {
        if (!cancelled) setIsRestoringSession(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Delivery Notifications
  const [deliveryNotifications, setDeliveryNotifications] = useState([]);

  /** Load assigned and available orders once a delivery session exists. */
  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    fetchOrders({ limit: 100 })
      .then((list) => {
        if (!cancelled) setOrders(list);
      })
      .catch((err) => console.warn('orders unavailable:', err.message));

    return () => {
      cancelled = true;
    };
  }, [user]);

  /**
   * Poll the server for order changes.
   *
   * Replaces a localStorage + BroadcastChannel mirror that shared the order list
   * with every app on the origin. The server already scopes orders by role, so
   * that scheme leaked one role's view into another's.
   *
   * Polling pauses while the tab is hidden — a background tab hitting the API
   * every few seconds is wasted work no one is looking at.
   */
  useEffect(() => {
    if (!user) return;

    let cancelled = false;

    const poll = async () => {
      if (document.hidden) return;
      try {
        const list = await fetchOrders({ limit: 100 });
        if (!cancelled) setOrders(list);
      } catch (e) {
        /* Transient failure; the next tick retries. */
      }
    };

    const interval = setInterval(poll, 5000);
    const onVisible = () => {
      if (!document.hidden) poll();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [user]);

  const handleUpdateOrderStatus = useCallback(async (orderId, newStatus) => {
    const target = orders.find((o) => o.id === orderId || o.serverId === orderId);
    if (!target?.serverId) {
      toast.error('This order is not available on the server yet.');
      return;
    }

    try {
      const updated = await updateOrderStatus(target.serverId, newStatus);
      setOrders((prev) => prev.map((o) => (o.serverId === updated.serverId ? updated : o)));
      const emoji = { Preparing: '👨‍🍳', 'Out for Delivery': '🚚', Delivered: '✅', Cancelled: '❌' }[newStatus] || '📦';
      toast.success(`Order ${updated.id} → ${newStatus} ${emoji}`);
    } catch (err) {
      toast.error(err.message || 'Could not update the order.');
    }
  }, [orders, toast]);

  const clearDeliveryNotification = useCallback((orderId) => {
    setDeliveryNotifications(prev => prev.filter(n => n.id !== orderId));
  }, []);

  /**
   * UX gate on the server-verified role. The API authorizes every request
   * independently, so bypassing this in the browser grants no access.
   */
  const handleLogin = useCallback(async (userData) => {
    if (userData.role !== 'delivery' && userData.role !== 'developer') {
      toast.error('Access denied. This app is for Delivery Agents only.');
      await logout();
      return;
    }
    setUser(userData);
    toast.success(`Welcome back, ${userData.name}! 🚚`);
  }, [toast]);

  const handleLogout = useCallback(async () => {
    const name = user?.name || 'Agent';
    await logout();
    setUser(null);
    toast.info(`Signed out. See you soon, ${name}! 👋`);
  }, [user, toast]);

  if (showSplash || isRestoringSession) {
    return <SplashScreen onComplete={() => setShowSplash(false)} />;
  }

  // Login Screen
  if (!user) {
    return (
      <LoginPage
        onLogin={handleLogin}
        onSignUp={() => toast.warning('Delivery accounts are provisioned by an administrator.')}
        appType="delivery"
        storagePrefix="vegbazzar_delivery_"
      />
    );
  }

  // Main Delivery Panel
  return (
    <DeliveryPanel
      orders={orders}
      onUpdateOrderStatus={handleUpdateOrderStatus}
      user={user}
      notifications={deliveryNotifications}
      onClearNotification={clearDeliveryNotification}
      onLogout={handleLogout}
    />
  );
}
