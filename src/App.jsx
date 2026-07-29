import React, { useState, useEffect, useMemo, useCallback, Suspense, lazy } from 'react';
import Header from './components/Header';
import HomeHeroBanner from './components/HomeHeroBanner';
import Categories from './components/Categories';
import ProductList from './components/ProductList';
import BottomNav from './components/BottomNav';
import WalletModal from './components/WalletModal';
import CartModal from './components/CartModal';
import CategoryDetailView from './components/CategoryDetailView';
import ProductDetailView from './components/ProductDetailView';
import CustomerOrders from './components/CustomerOrders';
import LoginPage from './components/LoginPage';
import SignUpPage from './components/SignUpPage';
import FlyToCartOverlay from './components/FlyToCartOverlay';
import SplashScreen from './components/SplashScreen';
import PriceHistory from './components/PriceHistory';
import AccountHistory from './components/AccountHistory';
import PageTransition from './components/PageTransition';
import { HomeSkeleton } from './components/LoadingSkeleton';
import { useToast } from './components/Toast';
import { ChevronRight, ArrowLeft, User as UserIcon, History as HistoryIcon } from 'lucide-react';
import { restoreSession, logout } from './services/auth';
import useLocalStorage from './hooks/useLocalStorage';
import { initialCategories, sampleProducts, initialOrders, initialRegisteredUsers, initialScheduledOrders } from './data/mockData';
import { fetchProducts, updateStock } from './services/products';
import { fetchOrders, createOrder, updateOrderStatus } from './services/orders';
import { fetchWallet } from './services/wallet';
import { fetchUsers, updateUser, deleteUser } from './services/users';
import { ApiRequestError, NetworkError } from './services/apiClient';

/**
 * Admin panels are code-split: only `developer` and `market_owner` sessions ever
 * render them, so shipping them to every customer is dead weight in the initial
 * download. ShopkeeperPanel and DeliveryPanel were also imported here but never
 * rendered — they live in their own hash-routed apps — so they are gone
 * entirely, which also removes Leaflet from the customer bundle.
 */
const DeveloperPanel = lazy(() => import('./components/DeveloperPanel'));
const MarketOwnerPanel = lazy(() => import('./components/MarketOwnerPanel'));

export default function App() {
  // Globally unique ID generator to avoid React key collisions
  const _idCounter = React.useRef(Date.now());
  const uniqueId = () => ++_idCounter.current;

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
  const [scheduledOrders, setScheduledOrders] = useState(initialScheduledOrders);
  const [registeredUsers, setRegisteredUsers] = useState(initialRegisteredUsers);
  const [searchVal, setSearchVal] = useState('');
  const [isAppLoading, setIsAppLoading] = useState(true);
  const [showSplash, setShowSplash] = useState(true);
  
  /**
   * Session state is held in memory and restored from the httpOnly refresh
   * cookie on mount. It is deliberately NOT persisted to localStorage: the user
   * object carries a `role`, and web storage is editable from devtools, so a
   * persisted session would let anyone hand themselves a privileged panel.
   */
  const [user, setUser] = useState(null);
  const [isRestoringSession, setIsRestoringSession] = useState(true);
  const [activeTab, setActiveTab] = useLocalStorage('vegbazzar_tab', 'login');

  useEffect(() => {
    let cancelled = false;
    restoreSession()
      .then((restored) => {
        if (!cancelled && restored) setUser(restored);
      })
      .finally(() => {
        if (!cancelled) setIsRestoringSession(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const [cartItems, setCartItems, clearCart] = useLocalStorage('vegbazzar_cart', [
    {
      id: 101,
      name: 'Organic Spinach (Palak)',
      price: 35,
      quantity: 2,
      image: 'https://images.unsplash.com/photo-1576045057995-568f588f82fb?w=150',
    },
  ]);
  /**
   * Wallet is a read-through cache of the server ledger, never a source of
   * truth. It was previously persisted to localStorage, which meant the balance
   * could simply be typed into devtools.
   */
  const [walletBalance, setWalletBalance] = useState(0);

  // Scheduled Cart State
  const [scheduledCartItems, setScheduledCartItems] = useState([]);
  const [shoppingMode, setShoppingMode] = useState('regular'); // 'regular' | 'scheduled'
  const [scheduleFilter, setScheduleFilter] = useState('All');
  const [selectedDates, setSelectedDates] = useState([]);
  const [isScheduledCartOpen, setIsScheduledCartOpen] = useState(false);

  // Ledger entries as reported by the server.
  const [walletTransactions, setWalletTransactions] = useState([]);


  // Navigation states
  const [activeCategoryDetail, setActiveCategoryDetail] = useState(null);
  const [activeProductDetail, setActiveProductDetail] = useState(null);

  // Profile editing & 2FA verification states
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [activeAccountView, setActiveAccountView] = useState('menu');
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [showProfileOTP, setShowProfileOTP] = useState(false);
  const [profileEmailOTP, setProfileEmailOTP] = useState('');
  const [profileMobileOTP, setProfileMobileOTP] = useState('');
  const [profilePrevEmailOTP, setProfilePrevEmailOTP] = useState('');
  const [profilePrevMobileOTP, setProfilePrevMobileOTP] = useState('');
  const [activeOtpStepIndex, setActiveOtpStepIndex] = useState(0);
  const [profileOtpError, setProfileOtpError] = useState('');

  const [flyingItems, setFlyingItems] = useState([]);
  const [cartBump, setCartBump] = useState(false);

  // Modals state
  const [isWalletOpen, setIsWalletOpen] = useState(false);
  const [isCartOpen, setIsCartOpen] = useState(false);

  // Delivery Notifications: fired when shopkeeper accepts an order
  const [deliveryNotifications, setDeliveryNotifications] = useState([]);

  // Restore session: if user exists but tab is 'login', go to their role
  useEffect(() => {
    if (user && (activeTab === 'login' || activeTab === 'signup')) {
      if (user.role === 'shopkeeper') {
        window.location.hash = '#/shopkeeper';
        return;
      }
      if (user.role === 'delivery') {
        window.location.hash = '#/delivery';
        return;
      }
      const targetTab = user.role && user.role !== 'customer' ? user.role : 'home';
      setActiveTab(targetTab);
    }
  }, []);

  /**
   * Initial load.
   *
   * The catalog is public, so it loads regardless of session. Orders, wallet,
   * and the user list are per-identity and only fetched once a session exists —
   * requesting them signed out would just 401.
   *
   * Each fetch settles independently: one failing (or 401-ing on a role that
   * may not read it) must not blank the rest of the app.
   */
  useEffect(() => {
    if (isRestoringSession) return;

    let cancelled = false;

    async function loadInitialData() {
      const catalog = fetchProducts({ limit: 200 })
        .then((items) => {
          if (!cancelled && items.length > 0) setProducts(items);
        })
        .catch((err) => {
          // Offline degrades to the bundled sample catalog, read-only.
          console.warn('catalog unavailable, using local sample data:', err.message);
        });

      const rest = user
        ? [
            fetchOrders({ limit: 100 })
              .then((list) => {
                if (!cancelled) setOrders(list);
              })
              .catch((err) => console.warn('orders unavailable:', err.message)),

            fetchWallet()
              .then((w) => {
                if (cancelled) return;
                setWalletBalance(w.balance);
                setWalletTransactions(w.transactions);
              })
              .catch((err) => console.warn('wallet unavailable:', err.message)),

            // Admin-only; a 403 here is expected for most roles.
            ...(['developer', 'market_owner'].includes(user.role)
              ? [
                  fetchUsers({ limit: 200 })
                    .then((list) => {
                      if (!cancelled) setRegisteredUsers(list);
                    })
                    .catch(() => {}),
                ]
              : []),
          ]
        : [];

      await Promise.allSettled([catalog, ...rest]);
      if (!cancelled) setIsAppLoading(false);
    }

    loadInitialData();
    return () => {
      cancelled = true;
    };
  }, [isRestoringSession, user]);

  // 🔄 Sync orders to localStorage & BroadcastChannel whenever orders state changes
  useEffect(() => {
    try {
      localStorage.setItem('vegbazzar_orders', JSON.stringify(orders));
      if (window.BroadcastChannel) {
        const bc = new BroadcastChannel('vegbazzar_orders_channel');
        bc.postMessage({ type: 'ORDERS_UPDATED', orders });
        bc.close();
      }
    } catch (e) {}
  }, [orders]);

  // 📡 Real-time Cross-Tab Storage Event & 3-Second Background Order Polling
  useEffect(() => {
    const handleStorage = (e) => {
      if (e.key === 'vegbazzar_orders' && e.newValue) {
        try {
          const fresh = JSON.parse(e.newValue);
          if (Array.isArray(fresh)) setOrders(fresh);
        } catch (err) {}
      }
    };

    window.addEventListener('storage', handleStorage);

    let bc = null;
    if (window.BroadcastChannel) {
      bc = new BroadcastChannel('vegbazzar_orders_channel');
      bc.onmessage = (event) => {
        if (event.data?.type === 'ORDERS_UPDATED' && Array.isArray(event.data.orders)) {
          setOrders(event.data.orders);
        }
      };
    }

    // Background polling every 3 seconds for new orders
    const interval = setInterval(async () => {
      try {
        const saved = localStorage.getItem('vegbazzar_orders');
        if (saved) {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed) && parsed.length > 0) {
            setOrders((prev) => {
              const currentList = Array.isArray(prev) ? prev : [];
              const existingIds = new Set(currentList.map((o) => o?.id));
              const newItems = parsed.filter((o) => o && o.id && !existingIds.has(o.id));
              if (newItems.length > 0) {
                return [...newItems, ...currentList];
              }
              return currentList;
            });
          }
        }

        // Server is authoritative and scopes the result to this caller's role,
        // so replace wholesale rather than merging with locally-cached orders.
        const serverOrders = await fetchOrders({ limit: 100 });
        setOrders(serverOrders);
      } catch (e) {
        /* Transient poll failure; the next tick retries. */
      }
    }, 5000);

    return () => {
      window.removeEventListener('storage', handleStorage);
      if (bc) bc.close();
      clearInterval(interval);
    };
  }, [toast]);

  const handleSyncOrders = useCallback(async () => {
    try {
      const serverOrders = await fetchOrders({ limit: 100 });
      setOrders(serverOrders);
      toast.success(`Orders synced! ${serverOrders.length} orders loaded 🛍️`);
    } catch (e) {
      toast.error('Sync failed: ' + e.message);
    }
  }, [toast]);

  // Accounts are created through the verified registration flow, so there is no
  // client-side user registration path any more.
  const handleRegisterUser = useCallback(() => {}, []);

  const handleScheduleCart = useCallback(() => {
    if (selectedDates.length === 0) {
      toast.warning('Please select a date first!');
      return;
    }
    if (scheduleFilter === 'Weekly' && selectedDates.length < 3) {
      toast.warning('Please select at least 3 days for a weekly schedule!');
      return;
    }
    if (scheduleFilter === 'Monthly' && selectedDates.length < 15) {
      toast.warning('Please select at least 15 days for a monthly schedule!');
      return;
    }
    if (!scheduledCartItems || scheduledCartItems.length === 0) {
      toast.warning('Your cart is empty!');
      return;
    }

    const targetDate = new Date(selectedDates[0]);
    targetDate.setHours(8, 0, 0, 0);

    const baseAmount = scheduledCartItems.reduce((acc, item) => acc + (item.price * item.quantity), 0);
    const totalAmount = (scheduleFilter === 'Weekly' || scheduleFilter === 'Monthly') 
      ? baseAmount * selectedDates.length 
      : baseAmount;

    const newSchedule = {
      id: `SUB${Math.floor(Math.random() * 100000)}`,
      customerName: user ? user.name : 'Guest Customer',
      phone: user ? user.phone : '1234567890',
      address: 'Current Location',
      items: [...scheduledCartItems],
      totalAmount: totalAmount,
      frequency: scheduleFilter,
      selectedDates: selectedDates,
      nextDeliveryDate: targetDate.getTime(),
      status: 'Active'
    };

    setScheduledOrders(prev => [...(prev || []), newSchedule]);
    setScheduledCartItems([]);
    setSelectedDates([]);
    setShoppingMode('regular');
    setActiveTab('orders');
    setIsScheduledCartOpen(false);
    
    if (scheduleFilter === 'Daily') {
      toast.success(`Daily schedule created successfully for ${targetDate.toLocaleDateString()}! 📅`);
    } else {
      toast.success(`${scheduleFilter} schedule created successfully for ${selectedDates.length} days! 📅`);
    }
  }, [selectedDates, scheduleFilter, scheduledCartItems, user, setScheduledOrders, setScheduledCartItems, setSelectedDates, setShoppingMode, setActiveTab, toast]);

  /**
   * Auth handlers.
   *
   * `userData` is always the server's response to a verified sign-in. The role
   * on it was assigned by the server and is never derived here.
   */
  const handleLogin = useCallback((userData) => {
    setUser(userData);
    if (userData.role === 'shopkeeper') {
      window.location.hash = '#/shopkeeper';
      return;
    }
    if (userData.role === 'delivery') {
      window.location.hash = '#/delivery';
      return;
    }
    if (userData.role && userData.role !== 'customer') {
      setActiveTab(userData.role);
    } else {
      setActiveTab('home');
    }
    toast.success(`Welcome back, ${userData.name}! 🌿`);
  }, [setActiveTab, toast]);

  // Registration now completes inside LoginPage (which verifies a server-issued
  // code and returns an authenticated user), so sign-up and sign-in converge on
  // the same handler.
  const handleSignUp = handleLogin;

  const handleLogout = useCallback(async () => {
    const name = user?.name || 'User';
    await logout();
    setUser(null);
    clearCart();
    setActiveTab('login');
    toast.info(`Signed out. See you soon, ${name}! 👋`);
  }, [user, clearCart, setActiveTab, toast]);

  const handleDeleteAccount = useCallback(async () => {
    if (!user) return;
    const confirmDelete = window.confirm(
      "⚠️ WARNING: Are you sure you want to PERMANENTLY delete your account? This will remove all your data from the database and cannot be undone."
    );
    if (!confirmDelete) return;

    try {
      await deleteUser(user.id);
    } catch (err) {
      // Self-service deletion is admin-gated server-side; surface the refusal
      // rather than signing the user out as though it had succeeded.
      toast.error(
        err instanceof ApiRequestError && err.status === 403
          ? 'Account deletion must be performed by an administrator. Contact support.'
          : 'Could not delete your account. Please try again.'
      );
      return;
    }

    await logout();
    setUser(null);
    clearCart();
    setActiveTab('login');
    toast.warning("Your account was permanently deleted. 👋");
  }, [user, clearCart, setActiveTab, setRegisteredUsers, toast]);

  const handleStartEditingProfile = useCallback(() => {
    if (!user) return;
    setEditName(user.name);
    setEditEmail(user.email || '');
    setEditPhone(user.phone || '');
    setIsEditingProfile(true);
    setShowProfileOTP(false);
    setProfileEmailOTP('');
    setProfileMobileOTP('');
    setProfilePrevEmailOTP('');
    setProfilePrevMobileOTP('');
    setActiveOtpStepIndex(0);
    setProfileOtpError('');
  }, [user]);

  const handleSaveProfile = useCallback(async (e) => {
    e.preventDefault();
    if (!editName || !editEmail || !editPhone) {
      alert("All fields are required.");
      return;
    }

    const needsOTP = editEmail.trim().toLowerCase() !== user.email?.toLowerCase() || editPhone.trim() !== user.phone;

    if (needsOTP) {
      setActiveOtpStepIndex(0);
      setShowProfileOTP(true);
      setProfileOtpError('');
    } else {
      try {
        const updated = await updateUser(user.id, { name: editName.trim() });
        setUser(updated);
        setIsEditingProfile(false);
        toast.success('Profile updated successfully!');
      } catch (err) {
        toast.error(err.message || 'Could not update your profile.');
      }
    }
  }, [user, editName, editEmail, editPhone, setUser, toast]);

  const handleVerifyProfileOTP = useCallback(async (e) => {
    e.preventDefault();
    setProfileOtpError('');

    const emailChanged = editEmail.trim().toLowerCase() !== user.email?.toLowerCase();
    const phoneChanged = editPhone.trim() !== user.phone;

    const steps = [];
    if (user.email) {
      steps.push({ type: 'prevEmail', value: profilePrevEmailOTP, correct: '111111' });
    }
    if (user.phone) {
      steps.push({ type: 'prevPhone', value: profilePrevMobileOTP, correct: '222222' });
    }
    if (emailChanged) {
      steps.push({ type: 'newEmail', value: profileEmailOTP, correct: '333333' });
    }
    if (phoneChanged) {
      steps.push({ type: 'newPhone', value: profileMobileOTP, correct: '444444' });
    }

    const currentStep = steps[activeOtpStepIndex];
    if (currentStep.value !== currentStep.correct) {
      setProfileOtpError(`Incorrect OTP code. Use demo code: ${currentStep.correct}`);
      return;
    }

    if (activeOtpStepIndex < steps.length - 1) {
      setActiveOtpStepIndex((prev) => prev + 1);
      return;
    }

    const oldEmailOrPhone = user.email || user.phone;
    const updatedFields = {
      name: editName.trim(),
      email: editEmail.trim().toLowerCase(),
      phone: editPhone.trim()
    };

    try {
      // The server is the only writer; adopt exactly what it returns rather
      // than optimistically assuming the edit applied.
      const updated = await updateUser(user.id, updatedFields);
      setUser(updated);
      setRegisteredUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
    } catch (err) {
      setProfileOtpError(err.message || 'Could not update your profile.');
      return;
    }

    setIsEditingProfile(false);
    setShowProfileOTP(false);
    toast.success("Profile updated successfully after OTP verification! 🔒");
  }, [user, editName, editEmail, editPhone, profilePrevEmailOTP, profilePrevMobileOTP, profileEmailOTP, profileMobileOTP, activeOtpStepIndex, setUser, setRegisteredUsers, toast]);

  /**
   * Stock edits are optimistic, then reconciled against the server's response.
   * On failure the previous value is restored, so a rejected write (wrong role,
   * offline) cannot leave the UI showing a change that never happened.
   */
  const handleUpdateStock = useCallback(async (productId, newStock) => {
    const previous = products.find((p) => p.id === productId)?.stock;
    setProducts((prev) => prev.map((p) => (p.id === productId ? { ...p, stock: newStock } : p)));

    try {
      const updated = await updateStock(productId, newStock);
      setProducts((prev) => prev.map((p) => (p.id === productId ? updated : p)));
      toast.success(`Stock updated to ${updated.stock} units`);
    } catch (err) {
      if (previous !== undefined) {
        setProducts((prev) => prev.map((p) => (p.id === productId ? { ...p, stock: previous } : p)));
      }
      toast.error(err.message || 'Could not update stock.');
    }
  }, [products, toast]);

  const handleUpdateProductDetails = useCallback((productId, updatedDetails) => {
    setProducts((prev) =>
      prev.map((p) => (p.id === productId ? { ...p, ...updatedDetails } : p))
    );
    toast.success('Product details updated');
  }, [toast]);

  const handleAddProduct = useCallback((newProduct) => {
    setProducts((prev) => [newProduct, ...prev]);
    toast.success(`"${newProduct.name}" added to catalog`);
  }, [toast]);

  /**
   * The server validates both the transition graph (no Pending → Delivered) and
   * which roles may drive each move, so a rejection here is expected rather than
   * exceptional — surface it instead of leaving a stale optimistic status.
   */
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

  // Called by ShopkeeperPanel when shopkeeper accepts an order → push notification to Delivery
  const handleOrderAccepted = useCallback((order) => {
    setDeliveryNotifications((prev) => {
      // avoid duplicate notifications for same order
      if (prev.find((n) => n.id === order.id)) return prev;
      return [{ ...order, notifiedAt: Date.now() }, ...prev];
    });
  }, []);

  const clearDeliveryNotification = useCallback((orderId) => {
    setDeliveryNotifications((prev) => prev.filter((n) => n.id !== orderId));
  }, []);

  // Filter products based on search
  const filteredProducts = useMemo(() => {
    return products.filter((p) =>
      p.name.toLowerCase().includes(searchVal.toLowerCase())
    );
  }, [products, searchVal]);

  const handleAddToCart = useCallback((product, event) => {
    if (product.stock === 0) {
      toast.warning(`"${product.name}" is sold out!`);
      return;
    }
    
    const isScheduled = shoppingMode === 'scheduled';
    const targetCart = isScheduled ? scheduledCartItems : cartItems;
    const setTargetCart = isScheduled ? setScheduledCartItems : setCartItems;
    
    const existing = targetCart.find((item) => item.id === product.id);

    // Trigger smooth fly-to-cart animation when item is picked/added
    const clickX = event && event.clientX ? Math.max(10, event.clientX - 45) : window.innerWidth / 2 - 45;
    const clickY = event && event.clientY ? Math.max(10, event.clientY - 45) : window.innerHeight / 2 - 45;

    const newFlyItem = {
      id: crypto.randomUUID(),
      image: product.image,
      name: product.name,
      startPos: { x: clickX, y: clickY },
    };

    setFlyingItems((prev) => [...prev, newFlyItem]);

    setTargetCart((prev) => {
      if (existing) {
        return prev.map((item) =>
          item.id === product.id ? { ...item, quantity: item.quantity + 1 } : item
        );
      }
      return [...prev, { id: product.id, name: product.name, price: product.price, quantity: 1, image: product.image }];
    });

    if (!existing) {
      toast.success(`"${product.name}" added to ${isScheduled ? 'schedule' : 'basket'} 🛒`);
    }
  }, [cartItems, scheduledCartItems, shoppingMode, setCartItems, setScheduledCartItems, toast]);

  const handleFlyingItemEnd = useCallback((id) => {
    setFlyingItems((prev) => prev.filter((item) => item.id !== id));
    setCartBump(true);
    setTimeout(() => setCartBump(false), 450);
  }, []);

  const handleUpdateQuantity = useCallback((id, delta) => {
    const isScheduled = shoppingMode === 'scheduled';
    const setTargetCart = isScheduled ? setScheduledCartItems : setCartItems;
    
    setTargetCart((prev) =>
      prev
        .map((item) => {
          if (item.id === id) {
            const newQty = item.quantity + delta;
            return newQty > 0 ? { ...item, quantity: newQty } : null;
          }
          return item;
        })
        .filter(Boolean)
    );
  }, [shoppingMode, setScheduledCartItems, setCartItems]);

  /**
   * Called after WalletModal has completed a top-up that the SERVER verified
   * and credited. It receives the server's result, not an amount — this
   * component's job is only to re-read the ledger, never to adjust a balance.
   */
  const handleTopUpSettled = useCallback(async (result) => {
    if (result?.balance !== undefined) setWalletBalance(result.balance);

    try {
      const fresh = await fetchWallet();
      setWalletBalance(fresh.balance);
      setWalletTransactions(fresh.transactions);
    } catch {
      /* The credit already succeeded server-side; the next load will reconcile. */
    }

    toast.success(
      result?.credited === false
        ? 'This payment was already credited.'
        : 'Wallet topped up! 💰'
    );
  }, [toast]);

  /**
   * Place an order.
   *
   * Sends only product ids and quantities: the server recomputes every price,
   * the delivery fee, and the total from the live catalog, claims stock
   * atomically, and debits the wallet inside the same transaction. The
   * `totalAmount` argument is used purely to render an optimistic message — it
   * has no bearing on what is charged.
   *
   * @returns {Promise<boolean>} whether the order was placed
   */
  const handleCheckout = useCallback(async (totalAmount, selectedPaymentMethod = 'COD') => {
    if (!user) {
      toast.error('Please sign in to place an order.');
      return false;
    }
    if (cartItems.length === 0) {
      toast.error('Your cart is empty.');
      return false;
    }

    const paymentMethod = selectedPaymentMethod === 'VegWallet' ? 'wallet' : 'cod';
    const address =
      localStorage.getItem('vegbazzar_customer_location') ||
      'Koramangala, Bengaluru, Karnataka - 560034';

    // Collapse variants back onto their catalog product before ordering.
    const quantities = new Map();
    for (const item of cartItems) {
      const productId = item.originalId || item.id;
      quantities.set(productId, (quantities.get(productId) || 0) + item.quantity);
    }

    const items = [...quantities.entries()].map(([productId, quantity]) => ({ productId, quantity }));

    try {
      const order = await createOrder({ items, address, paymentMethod });

      setOrders((prev) => [order, ...prev]);
      setCartItems([]);

      // Re-read both from the server rather than adjusting locally: stock was
      // decremented and the wallet possibly debited by the same transaction.
      fetchProducts({ limit: 200 })
        .then((items2) => items2.length > 0 && setProducts(items2))
        .catch(() => {});
      if (paymentMethod === 'wallet') {
        fetchWallet()
          .then((w) => {
            setWalletBalance(w.balance);
            setWalletTransactions(w.transactions);
          })
          .catch(() => {});
      }

      toast.success(`Order ${order.id} placed! Estimated delivery: 10 mins 🚀`);
      return true;
    } catch (err) {
      if (err instanceof NetworkError) {
        toast.error('Could not reach the server. Your order was not placed.');
      } else if (err instanceof ApiRequestError && err.code === 'INSUFFICIENT_FUNDS') {
        toast.error(err.message);
      } else if (err instanceof ApiRequestError && err.code === 'INSUFFICIENT_STOCK') {
        toast.error(err.message);
        fetchProducts({ limit: 200 })
          .then((items2) => items2.length > 0 && setProducts(items2))
          .catch(() => {});
      } else {
        toast.error(err.message || 'Could not place your order. Please try again.');
      }
      return false;
    }
  }, [cartItems, user, setCartItems, toast]);


  const handleOpenProductDetail = useCallback((product, cat) => {
    const parentCategory = cat || categories.find((c) => c.id === product.categoryId);
    setActiveProductDetail({ product, category: parentCategory });
  }, [categories]);

  const totalCartCount = cartItems.reduce((sum, item) => sum + item.quantity, 0);
  const pendingOrdersCount = orders.filter((o) => o.status === 'Pending').length;

  const activeCartItems = shoppingMode === 'scheduled' ? scheduledCartItems : cartItems;

  if (showSplash) {
    return <SplashScreen onComplete={() => setShowSplash(false)} />;
  }

  // ROUTE TO STANDALONE LOGIN / SIGN UP PAGES WHEN LOGGED OUT OR SELECTING LOGIN / SIGNUP TAB
  if (activeTab === 'login' && !user) {
    return (
      <LoginPage
        onLogin={handleLogin}
        onSignUp={handleSignUp}
        onGoToSignUp={() => setActiveTab('signup')}
      />
    );
  }


  if (activeTab === 'signup' && !user) {
    return (
      <SignUpPage
        onSignUp={handleSignUp}
        onGoToLogin={() => setActiveTab('login')}
      />
    );
  }

  const profileEmailChanged = user && editEmail.trim().toLowerCase() !== user.email?.toLowerCase();
  const profilePhoneChanged = user && editPhone.trim() !== user.phone;



  return (
    <div className="max-w-md mx-auto min-h-screen bg-gray-50 flex flex-col justify-between pb-16 relative shadow-xl border-x border-gray-200/60">
      
      {/* FLY TO CART ITEM ANIMATION OVERLAY */}
      <FlyToCartOverlay
        flyingItems={flyingItems}
        onAnimationEnd={handleFlyingItemEnd}
      />
      
      {/* VIEW ROUTING DECISION */}
      {activeProductDetail ? (
        <ProductDetailView
          product={activeProductDetail.product}
          category={activeProductDetail.category}
          cartItems={activeCartItems}
          onAddToCart={handleAddToCart}
          onUpdateQuantity={handleUpdateQuantity}
          onBack={() => setActiveProductDetail(null)}
        />
      ) : activeCategoryDetail ? (
        <CategoryDetailView
          category={activeCategoryDetail}
          products={products}
          cartItems={activeCartItems}
          onAddToCart={handleAddToCart}
          onUpdateQuantity={handleUpdateQuantity}
          onBack={() => setActiveCategoryDetail(null)}
          onSelectProduct={handleOpenProductDetail}
        />
      ) : (
        <>
          {/* 1. TOP HEADER BAR */}
          {(activeTab === 'home' || activeTab === 'account' || activeTab === 'prices') && (
            <Header
              searchVal={searchVal}
              setSearchVal={setSearchVal}
              walletBalance={walletBalance}
              cartCount={totalCartCount}
              onOpenWallet={() => setIsWalletOpen(true)}
              onOpenAccount={() => setActiveTab('account')}
              user={user}
              onOpenAuthModal={() => setActiveTab('login')}
            />
          )}

          {/* MAIN CONTENT AREA */}
          <main className="flex-1 relative">
            
            {/* SCHEDULED SHOPPING BANNER */}
            {shoppingMode === 'scheduled' && activeTab === 'home' && (
              <div className="sticky top-0 z-30 bg-[#1B4D3E] text-white p-3 flex flex-col gap-2 shadow-lg border-b border-emerald-900 animate-slide-in-right">
                <div className="flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="text-[10px] font-black text-emerald-300 uppercase tracking-wider">Scheduled Delivery Mode</span>
                    <span className="text-sm font-black">{scheduledCartItems.length} items selected</span>
                  </div>
                  <div className="flex gap-2">
                    <button 
                      onClick={() => setIsScheduledCartOpen(true)}
                      className="bg-emerald-700 hover:bg-emerald-600 text-white text-[10px] font-black px-3 py-1.5 rounded-full shadow-sm transition-all active:scale-95 flex items-center"
                    >
                      Show Cart
                    </button>
                    <button 
                      onClick={handleScheduleCart}
                      className="bg-yellow-500 hover:bg-yellow-400 text-[#1B4D3E] text-[10px] font-black px-3 py-1.5 rounded-full shadow-sm transition-all active:scale-95 flex items-center"
                    >
                      Place Order
                    </button>
                    <button 
                      onClick={() => {
                        setActiveTab('orders');
                        setShoppingMode('regular');
                      }}
                      className="bg-emerald-500 hover:bg-emerald-400 text-white text-[10px] font-black px-3 py-1.5 rounded-full shadow-md transition-all active:scale-95 flex items-center"
                    >
                      Return to Calendar
                    </button>
                  </div>
                </div>
              </div>
            )}

            <PageTransition transitionKey={activeTab}>
              {activeTab === 'home' ? (
                isAppLoading ? (
                  <HomeSkeleton />
                ) : (
                  <>
                    {/* 🌟 2. SKEUOMORPHIC HOME HERO BANNER */}
                    <HomeHeroBanner
                      onExplore={() => setActiveCategoryDetail(categories[0])}
                    />

                    {/* 3. DYNAMIC 2-COLUMN CATEGORIES SECTION */}
                    <Categories
                      categories={categories}
                      onSelectCategory={(cat) => setActiveCategoryDetail(cat)}
                    />

                    {/* 4. HORIZONTAL PRODUCT CAROUSELS PER CATEGORY */}
                    <ProductList
                      categories={categories}
                      products={filteredProducts}
                      cartItems={activeCartItems}
                      onAddToCart={handleAddToCart}
                      onUpdateQuantity={handleUpdateQuantity}
                      onOpenCategoryDetail={(cat) => setActiveCategoryDetail(cat)}
                      onSelectProduct={handleOpenProductDetail}
                    />
                  </>
                )
              ) : activeTab === 'prices' ? (
                <PriceHistory products={products} categories={categories} />
              ) : activeTab === 'orders' ? (
                <CustomerOrders 
                  orders={orders.filter(o => o.customerName === user?.name || o.phone === user?.phone)}
                  scheduledOrders={scheduledOrders}
                  setScheduledOrders={setScheduledOrders}
                  cartItems={scheduledCartItems}
                  setCartItems={setScheduledCartItems}
                  selectedDates={selectedDates}
                  setSelectedDates={setSelectedDates}
                  scheduleFilter={scheduleFilter}
                  setScheduleFilter={setScheduleFilter}
                  handleScheduleCart={handleScheduleCart}
                  onStartScheduledShopping={() => {
                    setShoppingMode('scheduled');
                    setActiveTab('home');
                  }}
                  onGoHome={() => setActiveTab('home')}
                />
              ) : activeTab === 'developer' && user?.role === 'developer' ? (
                <Suspense fallback={<HomeSkeleton />}>
                  <DeveloperPanel
                    products={products}
                    orders={orders}
                    categories={categories}
                    registeredUsers={registeredUsers}
                    onRegisterUser={handleRegisterUser}
                    walletTransactions={walletTransactions}
                  />
                </Suspense>
              ) : activeTab === 'market_owner' && (user?.role === 'market_owner' || user?.role === 'developer') ? (
                <Suspense fallback={<HomeSkeleton />}>
                  <MarketOwnerPanel
                    products={products}
                    orders={orders}
                    categories={categories}
                  />
                </Suspense>
              ) : (
                /* ACCOUNT & ROLE SWITCHER TAB */
                <div className="p-2 sm:p-6 text-center space-y-1 sm:space-y-6 animate-fade-in bg-gradient-to-br from-slate-50 to-emerald-50/40 pb-2 sm:pb-20">
                  {user ? (
                    <div className="max-w-sm mx-auto relative mt-0 sm:mt-4">
                      
                      {/* Navigation Header if not in menu */}
                      {activeAccountView !== 'menu' && (
                        <div className="flex items-center mb-4">
                          <button
                            onClick={() => setActiveAccountView('menu')}
                            className="p-2 bg-white rounded-xl shadow-sm border border-slate-100 text-slate-600 hover:text-[#1B4D3E] transition-colors cursor-pointer active:scale-95"
                          >
                            <ArrowLeft className="w-5 h-5" />
                          </button>
                          <h2 className="flex-1 text-center font-black text-lg text-[#1B4D3E] mr-9 drop-shadow-sm">
                            {activeAccountView === 'profile' ? 'Profile Details' : 'Purchase History'}
                          </h2>
                        </div>
                      )}

                      {activeAccountView === 'menu' ? (
                        <div className="flex flex-col gap-3 text-left">
                          <button
                            onClick={() => setActiveAccountView('profile')}
                            className="p-4 bg-white/90 backdrop-blur-sm rounded-2xl flex items-center gap-4 shadow-sm border border-white/50 active:scale-95 transition-all cursor-pointer group"
                          >
                            <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-emerald-50 to-teal-50 text-emerald-600 flex items-center justify-center group-hover:scale-110 transition-transform shadow-[inset_1px_1px_2px_rgba(255,255,255,1),2px_2px_4px_rgba(16,185,129,0.1)]">
                              <UserIcon className="w-5 h-5 drop-shadow-sm" />
                            </div>
                            <div className="flex-1">
                              <h3 className="font-extrabold text-slate-800 text-sm tracking-tight">Profile Details</h3>
                              <p className="text-[10px] font-bold text-slate-400 mt-0.5">View and edit your personal information</p>
                            </div>
                            <div className="w-8 h-8 rounded-full bg-slate-50 flex items-center justify-center group-hover:bg-[#1B4D3E] group-hover:text-white transition-colors">
                              <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-white transition-colors" />
                            </div>
                          </button>
                          
                          <button
                            onClick={() => setActiveAccountView('history')}
                            className="p-4 bg-white/90 backdrop-blur-sm rounded-2xl flex items-center gap-4 shadow-sm border border-white/50 active:scale-95 transition-all cursor-pointer group"
                          >
                            <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-blue-50 to-indigo-50 text-blue-600 flex items-center justify-center group-hover:scale-110 transition-transform shadow-[inset_1px_1px_2px_rgba(255,255,255,1),2px_2px_4px_rgba(59,130,246,0.1)]">
                              <HistoryIcon className="w-5 h-5 drop-shadow-sm" />
                            </div>
                            <div className="flex-1">
                              <h3 className="font-extrabold text-slate-800 text-sm tracking-tight">Purchase History</h3>
                              <p className="text-[10px] font-bold text-slate-400 mt-0.5">Track your past orders and total spending</p>
                            </div>
                            <div className="w-8 h-8 rounded-full bg-slate-50 flex items-center justify-center group-hover:bg-[#1B4D3E] group-hover:text-white transition-colors">
                              <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-white transition-colors" />
                            </div>
                          </button>
                        </div>
                      ) : activeAccountView === 'history' ? (
                        <AccountHistory user={user} orders={orders} />
                      ) : (
                        <>
                          {!isEditingProfile && (
                        <>
                          {/* Premium Skeuomorphic Profile Avatar & Info */}
                          <div className="relative w-16 h-16 sm:w-28 sm:h-28 mx-auto mb-2 sm:mb-5 animate-scale-in drop-shadow-xl shrink-0">
                            <div className="absolute inset-0 bg-gradient-to-br from-white to-emerald-100 rounded-full shadow-[8px_8px_16px_rgba(27,77,62,0.1),-8px_-8px_16px_rgba(255,255,255,0.8)] border border-white"></div>
                            <div className="absolute inset-1.5 bg-gradient-to-br from-[#1B4D3E] to-[#0A2E22] rounded-full flex items-center justify-center font-extrabold text-2xl sm:text-4xl text-white shadow-[inset_4px_4px_8px_rgba(0,0,0,0.6),inset_-4px_-4px_8px_rgba(255,255,255,0.1)] border border-[#0d2a20]">
                              {user.name.charAt(0).toUpperCase()}
                            </div>
                            {/* Glow indicator */}
                            <div className="absolute bottom-0 right-0 sm:bottom-2 sm:right-2 w-4 h-4 sm:w-6 sm:h-6 bg-emerald-400 rounded-full border sm:border-4 border-white shadow-[0_0_12px_rgba(52,211,153,0.9)] animate-pulse"></div>
                          </div>
                          
                          <div className="text-center mb-3 sm:mb-8">
                            <h3 className="font-extrabold text-lg sm:text-2xl text-slate-800 drop-shadow-sm mb-1 sm:mb-1.5 tracking-tight">{user.name}</h3>
                            <div className="inline-flex items-center gap-1.5 bg-gradient-to-r from-emerald-500 to-teal-600 text-white px-3 sm:px-4 py-1 sm:py-1.5 rounded-full text-[9px] sm:text-[10px] font-black uppercase tracking-widest shadow-[inset_1px_1px_2px_rgba(255,255,255,0.4),2px_4px_8px_rgba(16,185,129,0.3)] border border-emerald-400/50">
                              <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse shadow-[0_0_4px_white]"></span>
                              Role: {user.role ? user.role.replace('_', ' ') : 'Customer'}
                            </div>
                          </div>
                        </>
                      )}

                      {isEditingProfile ? (
                        <form onSubmit={handleSaveProfile} className="bg-slate-50/90 backdrop-blur-2xl rounded-[2rem] p-5 border border-white space-y-4 text-left text-sm shadow-[inset_2px_2px_4px_rgba(255,255,255,0.9),12px_12px_24px_rgba(166,180,200,0.4),-12px_-12px_24px_rgba(255,255,255,0.9)] relative z-10 transition-all duration-300">
                          <h4 className="font-black text-[#1B4D3E] border-b-2 border-emerald-900/5 pb-2.5 text-sm flex items-center gap-2 drop-shadow-sm">
                            <span className="bg-white p-1.5 rounded-xl shadow-[inset_1px_1px_2px_rgba(0,0,0,0.1),2px_2px_4px_rgba(255,255,255,1)] flex items-center justify-center">
                              <svg className="w-4 h-4 text-emerald-700" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg>
                            </span> Edit Profile Details
                          </h4>
                          
                          <div className="space-y-3.5">
                            <div className="relative group">
                              <label className="block text-slate-500 font-extrabold mb-1.5 text-[10px] uppercase tracking-widest pl-1 group-focus-within:text-[#1B4D3E] transition-colors">User Name</label>
                              <input
                                type="text"
                                value={editName}
                                onChange={(e) => setEditName(e.target.value)}
                                className="w-full bg-slate-100/50 border-0 rounded-2xl px-4 py-2.5 font-bold text-slate-800 focus:outline-none focus:ring-0 shadow-[inset_4px_4px_8px_rgba(166,180,200,0.4),inset_-4px_-4px_8px_rgba(255,255,255,0.9)] transition-all"
                                required
                              />
                            </div>
                            <div className="relative group">
                              <label className="block text-slate-500 font-extrabold mb-1.5 text-[10px] uppercase tracking-widest pl-1 group-focus-within:text-[#1B4D3E] transition-colors">Email Address</label>
                              <input
                                type="email"
                                value={editEmail}
                                onChange={(e) => setEditEmail(e.target.value)}
                                className="w-full bg-slate-100/50 border-0 rounded-2xl px-4 py-2.5 font-bold text-slate-800 focus:outline-none focus:ring-0 shadow-[inset_4px_4px_8px_rgba(166,180,200,0.4),inset_-4px_-4px_8px_rgba(255,255,255,0.9)] transition-all"
                                required
                              />
                            </div>
                            <div className="relative group">
                              <label className="block text-slate-500 font-extrabold mb-1.5 text-[10px] uppercase tracking-widest pl-1 group-focus-within:text-[#1B4D3E] transition-colors">Mobile Number</label>
                              <input
                                type="text"
                                value={editPhone}
                                onChange={(e) => setEditPhone(e.target.value.replace(/\D/g, ''))}
                                className="w-full bg-slate-100/50 border-0 rounded-2xl px-4 py-2.5 font-bold text-slate-800 focus:outline-none focus:ring-0 shadow-[inset_4px_4px_8px_rgba(166,180,200,0.4),inset_-4px_-4px_8px_rgba(255,255,255,0.9)] transition-all"
                                required
                              />
                            </div>
                          </div>

                          <div className="flex gap-3 pt-3 border-t border-emerald-900/5">
                            <button
                              type="button"
                              onClick={() => setIsEditingProfile(false)}
                              className="flex-1 bg-slate-100 text-slate-600 font-extrabold py-2.5 rounded-2xl text-center cursor-pointer transition-all active:scale-95 shadow-[4px_4px_8px_rgba(166,180,200,0.3),-4px_-4px_8px_rgba(255,255,255,0.8)] hover:shadow-[inset_2px_2px_4px_rgba(166,180,200,0.3),inset_-2px_-2px_4px_rgba(255,255,255,0.8)]"
                            >
                              Cancel
                            </button>
                            <button
                              type="submit"
                              className="flex-1 bg-gradient-to-br from-[#1B4D3E] to-[#0A2E22] text-white font-black py-2.5 rounded-2xl text-center cursor-pointer transition-all active:scale-95 shadow-[4px_4px_10px_rgba(27,77,62,0.4),-4px_-4px_10px_rgba(255,255,255,0.9)] border border-[#143B2B]"
                            >
                              Save Details
                            </button>
                          </div>
                        </form>
                      ) : (
                        <div className="bg-slate-50/90 backdrop-blur-2xl rounded-[2rem] p-3 sm:p-5 border border-white space-y-2 sm:space-y-3 text-left text-sm shadow-[inset_2px_2px_4px_rgba(255,255,255,0.9),12px_12px_24px_rgba(166,180,200,0.4),-12px_-12px_24px_rgba(255,255,255,0.9)] relative z-10 transition-all duration-300">
                          <div className="flex flex-col sm:flex-row sm:justify-between items-start sm:items-center py-1.5 sm:py-2 border-b border-emerald-900/5 group gap-0.5 sm:gap-0">
                            <span className="text-slate-400 font-extrabold text-[10px] uppercase tracking-wider group-hover:text-slate-600 transition-colors">User Name</span>
                            <span className="font-black text-slate-800 drop-shadow-sm break-words max-w-full">{user.name}</span>
                          </div>
                          <div className="flex flex-col sm:flex-row sm:justify-between items-start sm:items-center py-1.5 sm:py-2 border-b border-emerald-900/5 group gap-0.5 sm:gap-0">
                            <span className="text-slate-400 font-extrabold text-[10px] uppercase tracking-wider group-hover:text-slate-600 transition-colors">Email Address</span>
                            <span className="font-bold text-slate-700 drop-shadow-sm break-all sm:break-words max-w-full">{user.email}</span>
                          </div>
                          <div className="flex flex-col sm:flex-row sm:justify-between items-start sm:items-center py-1.5 sm:py-2 border-b border-emerald-900/5 group gap-0.5 sm:gap-0">
                            <span className="text-slate-400 font-extrabold text-[10px] uppercase tracking-wider group-hover:text-slate-600 transition-colors">Mobile Number</span>
                            <span className="font-black text-[#1B4D3E] drop-shadow-sm break-words max-w-full">{user.phone}</span>
                          </div>
                          <div className="flex flex-col sm:flex-row sm:justify-between items-start sm:items-center py-1.5 sm:py-2 border-b border-emerald-900/5 group bg-emerald-50/50 -mx-2 px-2 rounded-xl gap-0.5 sm:gap-0">
                            <span className="text-emerald-700 font-extrabold text-[10px] uppercase tracking-wider">VegWallet Balance</span>
                            <span className="font-black text-emerald-600 text-lg drop-shadow-md">₹{walletBalance.toFixed(0)}</span>
                          </div>

                          <button
                            type="button"
                            onClick={handleStartEditingProfile}
                            className="w-full mt-2 sm:mt-3 py-2 sm:py-2.5 bg-gradient-to-br from-emerald-50 to-white text-[#1B4D3E] font-black rounded-2xl border border-emerald-100 hover:border-emerald-200 transition-all text-center cursor-pointer active:scale-95 shadow-[4px_4px_10px_rgba(166,180,200,0.2),-4px_-4px_10px_rgba(255,255,255,0.9)] hover:shadow-[inset_2px_2px_4px_rgba(166,180,200,0.2),inset_-2px_-2px_4px_rgba(255,255,255,0.9)] animate-fade-in flex items-center justify-center gap-2"
                          >
                            <span className="flex items-center justify-center bg-white/50 p-1.5 rounded-xl shadow-[inset_1px_1px_2px_rgba(0,0,0,0.05),1px_1px_2px_rgba(255,255,255,1)]">
                              <svg className="w-5 h-5 text-[#1B4D3E]" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg>
                            </span> Edit Profile Details
                          </button>
                        </div>
                      )}

                      {showProfileOTP && (
                        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in">
                          <div className="bg-white rounded-3xl w-full max-w-sm p-5 shadow-2xl border border-gray-100 relative overflow-hidden space-y-3.5 text-left text-xs animate-scale-in max-h-[90vh] overflow-y-auto">
                            <div className="flex items-center gap-3">
                              <div className="w-10 h-10 rounded-xl bg-amber-100 text-amber-900 flex items-center justify-center font-bold text-lg border border-amber-200">
                                🔐
                              </div>
                              <div>
                                <h4 className="font-extrabold text-gray-900 text-sm">Verify Profile Update</h4>
                                <p className="text-[10px] text-amber-700 font-semibold">
                                  Two-step verification is required to update credentials.
                                </p>
                              </div>
                            </div>

                            <form onSubmit={handleVerifyProfileOTP} className="space-y-3">
                              {(() => {
                                const steps = [];
                                if (user.email) {
                                  steps.push({ type: 'prevEmail', label: 'Current Email OTP', sub: `sent to ${user.email}`, value: profilePrevEmailOTP, setter: setProfilePrevEmailOTP, correct: '111111' });
                                }
                                if (user.phone) {
                                  steps.push({ type: 'prevPhone', label: 'Current Mobile OTP', sub: `sent to ${user.phone}`, value: profilePrevMobileOTP, setter: setProfilePrevMobileOTP, correct: '222222' });
                                }
                                if (profileEmailChanged) {
                                  steps.push({ type: 'newEmail', label: 'New Email OTP', sub: `sent to ${editEmail}`, value: profileEmailOTP, setter: setProfileEmailOTP, correct: '333333' });
                                }
                                if (profilePhoneChanged) {
                                  steps.push({ type: 'newPhone', label: 'New Mobile OTP', sub: `sent to ${editPhone}`, value: profileMobileOTP, setter: setProfileMobileOTP, correct: '444444' });
                                }

                                if (steps.length === 0) return null;

                                const currentStep = steps[activeOtpStepIndex] || steps[0];
                                const isLastStep = activeOtpStepIndex >= steps.length - 1;

                                return (
                                  <>
                                    <div className="bg-blue-50/80 p-2.5 rounded-xl border border-blue-100 text-[10px] text-blue-900 font-semibold space-y-0.5 animate-fade-in">
                                      <div className="flex justify-between items-center">
                                        <span>Verification Progress:</span>
                                        <span className="font-extrabold bg-blue-200 px-2 py-0.5 rounded-full text-blue-950">Step {activeOtpStepIndex + 1} of {steps.length}</span>
                                      </div>
                                    </div>

                                    <div className="bg-amber-50 p-2.5 rounded-xl border border-amber-200 text-[10px] text-amber-950 font-mono font-semibold space-y-1 animate-fade-in">
                                      <div className="flex justify-between items-center">
                                        <span>Demo Code for this step:</span>
                                        <span className="font-extrabold bg-amber-200 px-1.5 py-0.2 rounded text-amber-950">{currentStep.correct}</span>
                                      </div>
                                    </div>

                                    <div className="space-y-2 border-t border-gray-100 pt-3 animate-fade-in">
                                      <div>
                                        <label className="block font-bold text-gray-700 mb-2 text-[10px] uppercase tracking-wider text-center">{currentStep.label} <span className="normal-case opacity-75">({currentStep.sub})</span></label>
                                        <div className="flex gap-2 justify-center max-w-xs mx-auto">
                                          {[0, 1, 2, 3, 4, 5].map((index) => (
                                            <input
                                              key={`${currentStep.type}-${index}`}
                                              id={`otp-${index}`}
                                              type="text"
                                              inputMode="numeric"
                                              maxLength={6} // Allow paste
                                              value={currentStep.value[index] || ''}
                                              onChange={(e) => {
                                                const val = e.target.value.replace(/\D/g, '');
                                                if (val.length > 1) {
                                                  currentStep.setter(val.slice(0, 6));
                                                  const nextIndex = Math.min(val.length, 5);
                                                  const nextEl = document.getElementById(`otp-${nextIndex}`);
                                                  if(nextEl) nextEl.focus();
                                                  return;
                                                }
                                                let newOtp = (currentStep.value || '').split('');
                                                newOtp[index] = val.slice(-1);
                                                currentStep.setter(newOtp.join(''));
                                                if (val && index < 5) {
                                                  const nextEl = document.getElementById(`otp-${index + 1}`);
                                                  if(nextEl) nextEl.focus();
                                                }
                                              }}
                                              onKeyDown={(e) => {
                                                if (e.key === 'Backspace') {
                                                  if (!currentStep.value[index] && index > 0) {
                                                    const prevEl = document.getElementById(`otp-${index - 1}`);
                                                    if(prevEl) prevEl.focus();
                                                  } else {
                                                    let newOtp = (currentStep.value || '').split('');
                                                    newOtp[index] = '';
                                                    currentStep.setter(newOtp.join(''));
                                                  }
                                                }
                                              }}
                                              onFocus={(e) => e.target.select()}
                                              className="w-10 h-12 text-center bg-white border border-gray-300 rounded-xl text-lg font-mono font-extrabold text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#1B4D3E] focus:border-[#1B4D3E] shadow-sm transition-all"
                                              required
                                              autoFocus={index === 0}
                                            />
                                          ))}
                                        </div>
                                      </div>
                                    </div>

                                    {profileOtpError && <p className="text-[10px] font-bold text-rose-600">{profileOtpError}</p>}

                                    <div className="flex gap-2 pt-3 border-t border-gray-100">
                                      <button
                                        type="button"
                                        onClick={() => setShowProfileOTP(false)}
                                        className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold py-2 rounded-xl text-center cursor-pointer transition-colors active:scale-95"
                                      >
                                        Cancel
                                      </button>
                                      <button
                                        type="submit"
                                        className="flex-[2] bg-[#1B4D3E] hover:bg-[#143B2B] text-white font-extrabold py-2 rounded-xl text-center cursor-pointer transition-colors active:scale-95 shadow-sm"
                                      >
                                        {isLastStep ? 'Verify & Update' : 'Verify & Next'}
                                      </button>
                                    </div>
                                  </>
                                );
                              })()}
                            </form>
                          </div>
                        </div>
                      )}
                      
                      {/* End of Profile View */}
                      </>
                    )}

                      {user.role && user.role !== 'customer' && (
                        <div className="mt-4 pt-3 border-t border-gray-200 space-y-2">
                          <span className="text-xs font-bold text-gray-700 block text-left">
                            Open Role Panel (Separate App):
                          </span>
                          <div className="grid grid-cols-2 gap-1.5 text-xs font-bold">
                            {/* Shopkeeper */}
                            {(user.role === 'shopkeeper' || user.role === 'developer') && (
                              <a
                                href="#/shopkeeper"
                                className="p-2 bg-emerald-50 text-emerald-900 rounded-xl border border-emerald-200 hover:bg-emerald-100 transition-colors text-center flex items-center justify-center gap-1"
                              >
                                🏪 Shopkeeper App
                              </a>
                            )}

                            {/* Delivery */}
                            {(user.role === 'delivery' || user.role === 'developer') && (
                              <a
                                href="#/delivery"
                                className="p-2 bg-purple-50 text-purple-900 rounded-xl border border-purple-200 hover:bg-purple-100 transition-colors text-center flex items-center justify-center gap-1"
                              >
                                🚚 Delivery App
                              </a>
                            )}

                            {/* Developer Console (stays in-app) */}
                            {user.role === 'developer' && (
                              <>
                                <button
                                  onClick={() => setActiveTab('developer')}
                                  className="p-2 bg-slate-900 text-cyan-300 rounded-xl border border-slate-700 hover:bg-slate-800 transition-colors"
                                >
                                  💻 Developer Console
                                </button>
                                <button
                                  onClick={() => setActiveTab('market_owner')}
                                  className="p-2 bg-amber-50 text-amber-900 rounded-xl border border-amber-200 hover:bg-amber-100 transition-colors"
                                >
                                  📊 Market Owner
                                </button>
                              </>
                            )}

                            {/* Market Owner */}
                            {user.role === 'market_owner' && (
                              <button
                                onClick={() => setActiveTab('market_owner')}
                                className="p-2 bg-amber-50 text-amber-900 rounded-xl border border-amber-200 hover:bg-amber-100 transition-colors col-span-2"
                              >
                                📊 Owner Dashboard
                              </button>
                            )}
                          </div>
                        </div>
                      )}

                        <div className="pt-2 sm:pt-3 flex flex-row sm:flex-col gap-2 relative z-10 max-w-sm mx-auto">
                          <button
                            onClick={handleLogout}
                            className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 text-[10px] sm:text-sm font-extrabold px-2 sm:px-4 py-2 sm:py-2.5 rounded-2xl transition-all cursor-pointer shadow-[inset_1px_1px_2px_rgba(255,255,255,0.8),4px_4px_8px_rgba(166,180,200,0.3),-4px_-4px_8px_rgba(255,255,255,0.8)] active:shadow-[inset_4px_4px_8px_rgba(166,180,200,0.4),inset_-4px_-4px_8px_rgba(255,255,255,0.9)]"
                          >
                            Log Out
                          </button>
                          <button
                            onClick={handleDeleteAccount}
                            className="flex-1 bg-gradient-to-br from-rose-50 to-rose-100 hover:from-rose-100 hover:to-rose-200 text-rose-600 text-[10px] sm:text-sm font-black px-2 sm:px-4 py-2 sm:py-2.5 rounded-2xl transition-all border border-rose-200/50 cursor-pointer shadow-[inset_1px_1px_2px_rgba(255,255,255,0.9),4px_4px_8px_rgba(225,29,72,0.15),-4px_-4px_8px_rgba(255,255,255,0.8)] active:shadow-[inset_4px_4px_8px_rgba(225,29,72,0.2),inset_-4px_-4px_8px_rgba(255,255,255,0.9)]"
                          >
                            Delete Account
                          </button>
                        </div>
                      </div>
                  ) : (
                    <div className="py-6 space-y-4">
                      <div className="bg-emerald-100 text-[#1B4D3E] w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-2 font-bold text-2xl">
                        🔒
                      </div>
                      <h3 className="font-extrabold text-lg text-gray-900">Guest User</h3>
                      <p className="text-xs text-gray-500 max-w-xs mx-auto">
                        Log in to access your Customer account or privileged Role Panels (Shopkeeper, Delivery, Developer, Market Owner).
                      </p>

                      <button
                        onClick={() => setActiveTab('login')}
                        className="bg-[#1B4D3E] hover:bg-[#143B2B] text-white text-xs font-extrabold px-6 py-3 rounded-xl shadow-md transition-all active:scale-95 cursor-pointer"
                      >
                        Go to Sign In Page
                      </button>
                    </div>
                  )}
                </div>
              )}
            </PageTransition>
          </main>
        </>
      )}

      {/* 5. FIXED BOTTOM NAVIGATION BAR */}
      {activeTab !== 'developer' && activeTab !== 'market_owner' && (
        <BottomNav
          activeTab={activeTab}
          setActiveTab={(tab) => {
            setActiveProductDetail(null);
            setActiveCategoryDetail(null);
            setActiveTab(tab);
          }}
          cartCount={totalCartCount}
          onOpenCart={() => setIsCartOpen(true)}
          cartBump={cartBump}
          pendingOrdersCount={pendingOrdersCount}
          userRole={user?.role}
        />
      )}

      {/* MODALS */}
      <WalletModal
        isOpen={isWalletOpen}
        onClose={() => setIsWalletOpen(false)}
        balance={walletBalance}
        transactions={walletTransactions}
        user={user}
        onRazorpayPayment={handleTopUpSettled}
      />

      <CartModal
        isOpen={isCartOpen}
        onClose={() => setIsCartOpen(false)}
        cartItems={cartItems}
        onUpdateQuantity={handleUpdateQuantity}
        onCheckout={handleCheckout}
        walletBalance={walletBalance}
      />

      {/* SCHEDULED CART MODAL */}
      <CartModal
        isOpen={isScheduledCartOpen}
        onClose={() => setIsScheduledCartOpen(false)}
        cartItems={scheduledCartItems}
        onUpdateQuantity={handleUpdateQuantity}
        onCheckout={handleScheduleCart}
        walletBalance={walletBalance}
      />

    </div>
  );
}
