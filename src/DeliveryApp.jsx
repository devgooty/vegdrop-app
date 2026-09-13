import React, { useState, useEffect, useCallback, useRef } from 'react';
import DeliveryPanel from './components/DeliveryPanel';
import LoginPage from './components/LoginPage';
import SplashScreen from './components/SplashScreen';
import { useToast } from './components/Toast';
import { logout } from './services/auth';
import { fetchOrders, verifyPickupCode, verifyDeliveryCode, sameOrdersOrPrevious } from './services/orders';
import { acceptPickup, declinePickup } from './services/rider';
import { ApiRequestError } from './services/apiClient';
import useSessionUser from './hooks/useSessionUser';

const DELIVERY_ROLES = ['delivery'];

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
    /*
      The notification bell's memory goes with the task list. `seenOfferIds`
      records which pickups have already been announced; kept across a change
      of rider it would swallow the first offer to the new one, because the
      previous rider had been told about it.
    */
    onIdentityLost: () => {
      setOrders([]);
      setDeliveryNotifications([]);
      seenOfferIds.current.clear();
    },
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
        // Same list as last tick means no render at all — see
        // sameOrdersOrPrevious. Without it this redrew the whole app every
        // five seconds whether or not anything had moved.
        if (!cancelled) setOrders((prev) => sameOrdersOrPrevious(prev, list));
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

  /**
   * Refetch rather than patch the one order in place.
   *
   * The accept/decline endpoints return the raw order document, not the
   * shaped one `toUiOrder` produces — reusing the existing fetch keeps a
   * single place that does that shaping, instead of a second copy of it here
   * that would drift the first time either changed.
   */
  const refreshOrders = useCallback(async () => {
    try {
      const list = await fetchOrders({ limit: 100 });
      setOrders(list);
    } catch {
      /* The next poll tick recovers. */
    }
  }, []);

  const handleAcceptShopOrder = useCallback(async (orderId) => {
    try {
      await acceptPickup(orderId);
      await refreshOrders();
      toast.success('Pickup accepted — ask the shop for its pickup code 🔑');
    } catch (err) {
      const message = err instanceof ApiRequestError ? err.message : 'Could not accept this pickup.';
      toast.error(message);
      await refreshOrders();
    }
  }, [refreshOrders, toast]);

  const handleDeclineShopOrder = useCallback(async (orderId) => {
    try {
      await declinePickup(orderId);
      await refreshOrders();
      toast.info('Pickup declined.');
    } catch (err) {
      const message = err instanceof ApiRequestError ? err.message : 'Could not decline this pickup.';
      toast.error(message);
      await refreshOrders();
    }
  }, [refreshOrders, toast]);

  /**
   * The rider types a code somebody else is showing: the shop's at the counter,
   * the customer's at the door. These are the rider's only ways to move a
   * direct order - a rider can no longer set `Delivered` by hand.
   *
   * They rethrow on refusal instead of toasting, so the code box itself can say
   * "2 tries left" beside the digits the rider just typed, rather than in a
   * toast that disappears while they are still reading it.
   */
  const handleVerifyPickup = useCallback(async (orderId, code) => {
    await verifyPickupCode(orderId, code);
    await refreshOrders();
    toast.success('Pickup confirmed — on your way to the customer 🚚');
  }, [refreshOrders, toast]);

  const handleVerifyDelivery = useCallback(async (orderId, code) => {
    await verifyDeliveryCode(orderId, code);
    await refreshOrders();
    toast.success('Delivered — thank you ✅');
  }, [refreshOrders, toast]);

  const clearDeliveryNotification = useCallback((orderId) => {
    setDeliveryNotifications(prev => prev.filter(n => n.id !== orderId));
  }, []);

  /**
   * A shop order that just showed up assigned-but-not-yet-accepted is worth a
   * bell notification — it is the one thing on this screen that is actually
   * waiting on the rider to notice it, same reasoning as the emoji toast on
   * every status change below, just surfaced where the bell already is.
   */
  const seenOfferIds = useRef(new Set());
  useEffect(() => {
    const pending = orders.filter((o) => o.assignedTo && !o.riderAccepted && o.status === 'Preparing');
    for (const order of pending) {
      const key = order.serverId || order.id;
      if (seenOfferIds.current.has(key)) continue;
      seenOfferIds.current.add(key);
      setDeliveryNotifications((prev) => [
        ...prev,
        { id: key, message: `New pickup at ${order.shopName || 'a shop'} — accept or decline` },
      ]);
    }
  }, [orders]);

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
    // No `onComplete` while the session check is in flight: there is nothing
    // behind the splash to reveal yet, so it holds rather than fading out on
    // schedule and leaving a blank screen until the restore answers.
    return (
      <SplashScreen
        edition="delivery"
        onComplete={isRestoringSession ? undefined : () => setShowSplash(false)}
      />
    );
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
      onVerifyPickup={handleVerifyPickup}
      onVerifyDelivery={handleVerifyDelivery}
      onAcceptShopOrder={handleAcceptShopOrder}
      onDeclineShopOrder={handleDeclineShopOrder}
      user={user}
      notifications={deliveryNotifications}
      onClearNotification={clearDeliveryNotification}
      onLogout={handleLogout}
    />
  );
}
