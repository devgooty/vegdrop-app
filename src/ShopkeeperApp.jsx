import React, { useState, useEffect, useCallback } from 'react';
import ShopkeeperPanel from './components/ShopkeeperPanel';
import LoginPage from './components/LoginPage';
import SplashScreen from './components/SplashScreen';
import { useToast } from './components/Toast';
import { restoreSession, logout } from './services/auth';
import { initialCategories, sampleProducts, initialOrders, initialRegisteredUsers } from './data/mockData';
import { fetchProducts, updateStock } from './services/products';
import { fetchOrders, updateOrderStatus } from './services/orders';

export default function ShopkeeperApp() {
  const toast = useToast();

  const [categories] = useState(initialCategories);
  const [products, setProducts] = useState(sampleProducts);
  const [orders, setOrders] = useState(() => {
    try {
      const saved = localStorage.getItem('vegbazzar_orders');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch (e) {}
    return initialOrders;
  });
  const [registeredUsers, setRegisteredUsers] = useState(initialRegisteredUsers);

  /**
   * Session state lives in memory and is restored from the httpOnly refresh
   * cookie on mount. It is deliberately NOT persisted to localStorage: a stored
   * user object carries a `role`, and anything in web storage is attacker-
   * editable, so restoring from it would let a customer grant themselves this
   * panel by typing into devtools.
   */
  const [user, setUser] = useState(null);
  const [isRestoringSession, setIsRestoringSession] = useState(true);
  const [showSplash, setShowSplash] = useState(true);
  const [isAppLoading, setIsAppLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    restoreSession()
      .then((restored) => {
        if (cancelled) return;
        // The role is whatever the server says it is, checked again below.
        if (restored && ['shopkeeper', 'developer'].includes(restored.role)) {
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

  /** Load catalog and orders once a shopkeeper session exists. */
  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    async function loadInitialData() {
      await Promise.allSettled([
        fetchProducts({ limit: 200 })
          .then((items) => {
            if (!cancelled && items.length > 0) setProducts(items);
          })
          .catch((err) => console.warn('catalog unavailable:', err.message)),

        fetchOrders({ limit: 100 })
          .then((list) => {
            if (!cancelled) setOrders(list);
          })
          .catch((err) => console.warn('orders unavailable:', err.message)),
      ]);

      if (!cancelled) setIsAppLoading(false);
    }

    loadInitialData();
    return () => {
      cancelled = true;
    };
  }, [user]);

  /**
   * Poll the server for order changes.
   *
   * This replaces a localStorage + BroadcastChannel scheme that mirrored the
   * order list across every app in the browser. That was not just redundant now
   * that the server scopes orders by role — it actively leaked one role's view
   * into another's, because any app on the origin could read the shared key.
   *
   * Polling pauses while the tab is hidden: a background tab hammering the API
   * every few seconds is pure waste, and a stale list behind a hidden tab has no
   * one looking at it.
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
    // Refresh immediately when the tab regains focus, rather than waiting.
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

  const handleSyncOrders = useCallback(async () => {
    try {
      const list = await fetchOrders({ limit: 100 });
      setOrders(list);
      toast.success(`Orders synced! ${list.length} orders loaded 🛍️`);
    } catch (e) {
      toast.error('Sync failed: ' + e.message);
    }
  }, [toast]);

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

  const handleOrderAccepted = useCallback((order) => {
    setDeliveryNotifications(prev => {
      if (prev.find(n => n.id === order.id)) return prev;
      return [{ ...order, notifiedAt: Date.now() }, ...prev];
    });
  }, []);

  /**
   * Gate this panel on the server-verified role. This is a UX guard only — the
   * API independently authorizes every request, so bypassing it in the browser
   * grants nothing.
   */
  const handleLogin = useCallback(async (userData) => {
    if (userData.role !== 'shopkeeper' && userData.role !== 'developer') {
      toast.error('Access denied. This app is for Shopkeepers only.');
      await logout();
      return;
    }
    setUser(userData);
    toast.success(`Welcome back, ${userData.name}! 🏪`);
  }, [toast]);

  const handleLogout = useCallback(async () => {
    const name = user?.name || 'Shopkeeper';
    await logout();
    setUser(null);
    toast.info(`Signed out. See you soon, ${name}! 👋`);
  }, [user, toast]);

  // Hold the splash until the session check resolves, so an already-signed-in
  // shopkeeper never sees the login screen flash before being restored.
  if (showSplash || isRestoringSession) {
    return <SplashScreen onComplete={() => setShowSplash(false)} />;
  }

  // Login Screen
  if (!user) {
    return (
      <LoginPage
        onLogin={handleLogin}
        onSignUp={() => toast.warning('Shopkeeper accounts are provisioned by an administrator.')}
        appType="shopkeeper"
        storagePrefix="vegbazzar_shopkeeper_"
      />
    );
  }

  // Main Shopkeeper Panel
  return (
    <ShopkeeperPanel
      user={user}
      orders={orders}
      products={products}
      setProducts={setProducts}
      onUpdateOrderStatus={handleUpdateOrderStatus}
      onOrderAccepted={handleOrderAccepted}
      onLogout={handleLogout}
      onSyncOrders={handleSyncOrders}
    />
  );
}
