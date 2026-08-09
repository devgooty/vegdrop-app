import React, { useState, useEffect, useCallback } from 'react';
import DeliveryPanel from './components/DeliveryPanel';
import LoginPage from './components/LoginPage';
import SplashScreen from './components/SplashScreen';
import { useToast } from './components/Toast';
import { logout } from './services/auth';
import { fetchOrders, updateOrderStatus } from './services/orders';
import useSessionUser from './hooks/useSessionUser';

const DELIVERY_ROLES = ['delivery', 'developer'];

export default function DeliveryApp() {
  const toast = useToast();

  /**
   * Empty until the server answers. Never read from localStorage either: that
   * key is shared with every app on the origin.
   *
   * This used to be seeded from `initialOrders`, a fixture of invented customers
   * and addresses. Those rendered as real work before the first fetch landed,
   * and stayed on screen if it failed — so an agent's task list could be
   * entirely fictional and never say so. An empty list is the honest state while
   * we do not yet know.
   */
  const [orders, setOrders] = useState([]);

  /**
   * Session state lives in memory and is restored from the httpOnly refresh
   * cookie — never from localStorage, where an attacker-editable `role` field
   * would let anyone grant themselves this panel.
   *
   * Watched rather than read once: the refresh cookie is shared with the other
   * two apps on this origin, so signing in as a customer in another tab can
   * hand this one a session it must not render. `useSessionUser` drops back to
   * the login screen instead, and clears the task list on the way out so one
   * account's deliveries never appear under another's name.
   */
  const { user, setUser, isRestoringSession } = useSessionUser({
    allowedRoles: DELIVERY_ROLES,
    onIdentityLost: () => setOrders([]),
  });
  const [showSplash, setShowSplash] = useState(true);

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
        appType="delivery"
        storagePrefix="vegdrop_delivery_"
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
