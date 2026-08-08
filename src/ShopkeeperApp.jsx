import React, { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import ShopkeeperPanel from './components/ShopkeeperPanel';
import LoginPage from './components/LoginPage';
import SplashScreen from './components/SplashScreen';
import { useToast } from './components/Toast';
import { restoreSession, logout } from './services/auth';
import { fetchKycStatus } from './services/kyc';
import { initialCategories } from './data/mockData';
import { fetchProducts, updateStock, createProduct, updateProduct } from './services/products';
import { fetchOrders, updateOrderStatus } from './services/orders';
import { fetchMyStall } from './services/stalls';
import { fetchMyJoinRequest } from './services/markets';

/**
 * Only shopkeepers who run a stall in a market load this, so it stays out of
 * the bundle for everyone else.
 */
const StallPanel = lazy(() => import('./components/StallPanel'));

// Onboarding only: seen once, before a shopkeeper has a stall, and never again.
const JoinMarket = lazy(() => import('./components/JoinMarket'));

// Only ever opened by an unverified vendor, so it stays out of the main bundle.
const VendorKycModal = lazy(() => import('./components/VendorKycModal'));

export default function ShopkeeperApp() {
  const toast = useToast();

  /** Static taxonomy — there is no categories endpoint, and these are aisles. */
  const [categories] = useState(initialCategories);

  /**
   * Empty until the server answers, never seeded from fixtures.
   *
   * A shopkeeper seeing invented products in their own catalog is worse than a
   * customer seeing them: the obvious next action is to correct a price or a
   * stock level on a listing that does not exist, and every one of those writes
   * fails against an id the server has never issued. Orders are never read from
   * localStorage either — that key is shared with every app on the origin.
   */
  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [registeredUsers, setRegisteredUsers] = useState([]);

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

  /**
   * Does this shopkeeper run a stall in a market?
   *
   * If they do, they get the stall screen — offers, accept, pack. If they do
   * not, they get the original panel unchanged. That is what makes markets
   * additive: nobody's existing setup changes until a market owner gives them a
   * stall.
   *
   * `undefined` means "still finding out", so the UI can avoid flashing the
   * wrong screen while the answer is in flight.
   */
  const [stall, setStall] = useState(undefined);

  /**
   * Where this shopkeeper's application to a market stands.
   *
   * Separate from `stall` because the interesting states are the ones where
   * there is no stall yet: waiting on a decision, and having been turned down.
   * `null` means they have never applied. `undefined` means still loading, so
   * the join screen does not flash before the answer arrives.
   */
  const [joinRequest, setJoinRequest] = useState(undefined);
  const [showJoin, setShowJoin] = useState(false);

  /**
   * Settlement-account verification.
   *
   * A shopkeeper account can now be created by self-registration (see
   * routes/auth.js's /vendor/register/*), so holding the role no longer implies
   * anyone vetted the person behind it. Catalog writes are gated on this
   * server-side (middleware/vendorVerified.js); showing the modal here is only
   * so the vendor sees *why* those controls would fail, and gets the action
   * that fixes it.
   */
  const [kyc, setKyc] = useState(null);
  const [isKycModalOpen, setIsKycModalOpen] = useState(false);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    fetchMyStall()
      .then((found) => {
        if (!cancelled) setStall(found);
      })
      .catch(() => {
        // 404 NO_STALL is the ordinary answer for a shopkeeper who has not been
        // given one, and 403 STALL_PENDING for one still waiting on a market
        // owner. Neither is an error worth showing — the join screen below
        // reads the request itself and says which of the two it is.
        if (!cancelled) setStall(null);
      });

    return () => {
      cancelled = true;
    };
  }, [user]);

  /** Reloaded after applying or withdrawing, so the screen follows the change. */
  const refreshJoinRequest = useCallback(async () => {
    try {
      const found = await fetchMyJoinRequest();
      setJoinRequest(found);
      setShowJoin(false);
      // An accepted request means there is now a stall to load.
      if (found?.status === 'approved') {
        await fetchMyStall()
          .then(setStall)
          .catch(() => {});
      }
      return found;
    } catch {
      setJoinRequest(null);
      return null;
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    fetchMyJoinRequest()
      .then((found) => !cancelled && setJoinRequest(found))
      .catch(() => !cancelled && setJoinRequest(null));

    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    fetchKycStatus()
      .then((status) => {
        if (cancelled) return;
        setKyc(status);
        // Open unprompted for a vendor who has not finished: the dashboard is
        // useless to them until they do.
        if (!status.canUpdateStock) setIsKycModalOpen(true);
      })
      .catch((err) => console.warn('kyc status unavailable:', err.message));

    return () => {
      cancelled = true;
    };
  }, [user]);

  const handleKycVerified = useCallback((updated) => {
    setKyc(updated);
    toast.success('Account verified! You can now update stock. ✅');
  }, [toast]);
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

  const handleAddProduct = useCallback(async (productData) => {
    try {
      const created = await createProduct(productData);
      setProducts((prev) => [created, ...prev]);
      toast.success(`${created.name} added to your catalog! 🥬`);
      return true;
    } catch (err) {
      toast.error(err.message || 'Could not add the product.');
      return false;
    }
  }, [toast]);

  const handleEditProduct = useCallback(async (productId, productData) => {
    try {
      const updated = await updateProduct(productId, productData);
      setProducts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      toast.success(`${updated.name} updated. ✅`);
      return true;
    } catch (err) {
      toast.error(err.message || 'Could not update the product.');
      return false;
    }
  }, [toast]);

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
        appType="shopkeeper"
        storagePrefix="vegdrop_shopkeeper_"
      />
    );
  }

  // Hold until we know which panel this account should see, so a stall owner
  // never watches the old panel paint and then swap. The join request is part
  // of that answer: a shopkeeper waiting on a market owner gets the waiting
  // screen, not a flash of the panel they cannot use yet.
  if (stall === undefined || joinRequest === undefined) {
    return (
      <div className="min-h-screen bg-[#F6F8F6] flex items-center justify-center">
        <div className="w-10 h-10 border-[3px] border-[#0B7A37] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // A stall in a market: offers, accept, pack.
  if (stall) {
    return (
      <Suspense
        fallback={
          <div className="min-h-screen bg-[#F6F8F6] flex items-center justify-center">
            <div className="w-10 h-10 border-[3px] border-[#0B7A37] border-t-transparent rounded-full animate-spin" />
          </div>
        }
      >
        <StallPanel user={user} stall={stall} onLogout={handleLogout} />
      </Suspense>
    );
  }

  /**
   * No stall, but an application in flight or refused.
   *
   * Shown ahead of the single-shop panel because it is what this account is
   * actually in the middle of. A pending applicant who lands on the ordinary
   * panel has no way to discover their request exists, and the natural thing to
   * do — apply again — is exactly what the server refuses.
   */
  const midOnboarding = joinRequest?.status === 'pending' || joinRequest?.status === 'rejected';

  if (!stall && (midOnboarding || showJoin)) {
    return (
      <Suspense
        fallback={
          <div className="min-h-screen bg-[#F6F8F6] flex items-center justify-center">
            <div className="w-10 h-10 border-[3px] border-[#0B7A37] border-t-transparent rounded-full animate-spin" />
          </div>
        }
      >
        <JoinMarket
          request={joinRequest}
          onChanged={refreshJoinRequest}
          // Only offered when they chose to come here; there is nothing to go
          // back to mid-application.
          onBack={showJoin && !midOnboarding ? () => setShowJoin(false) : undefined}
        />
      </Suspense>
    );
  }

  // No stall and no application: the original single-shop panel, plus a way in.
  return (
    <>
      <div className="bg-[#0B7A37] text-white px-4 py-3 flex items-center justify-between gap-3">
        <p className="text-xs font-medium leading-snug">
          Trading at a vegetable market? Join it to receive orders from customers nearby.
        </p>
        <button
          onClick={() => setShowJoin(true)}
          className="shrink-0 bg-white text-[#0B7A37] text-xs font-bold px-3 py-1.5 rounded-lg"
        >
          Join a market
        </button>
      </div>
      <ShopkeeperPanel
        user={user}
        orders={orders}
        products={products}
        setProducts={setProducts}
        categories={categories}
        onAddProduct={handleAddProduct}
        onEditProduct={handleEditProduct}
        onUpdateOrderStatus={handleUpdateOrderStatus}
        onOrderAccepted={handleOrderAccepted}
        onLogout={handleLogout}
        onSyncOrders={handleSyncOrders}
        kyc={kyc}
        onOpenKyc={() => setIsKycModalOpen(true)}
        // The server, not this component, decides what the phone number
        // becomes — see the comment on the phone-change flow in
        // ShopkeeperPanel. This is how that server response reaches the
        // session state everything else on screen reads from.
        onUserUpdated={setUser}
      />

      {isKycModalOpen && (
        <Suspense fallback={null}>
          <VendorKycModal
            onVerified={handleKycVerified}
            onClose={() => setIsKycModalOpen(false)}
          />
        </Suspense>
      )}
    </>
  );
}
