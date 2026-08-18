import React, { useState, useEffect, useCallback, useMemo, useRef, Suspense, lazy } from 'react';
import Header from './components/Header';
import HomeHeroBanner from './components/HomeHeroBanner';
import Categories from './components/Categories';
import ProductList from './components/ProductList';
import BottomNav from './components/BottomNav';
import WalletModal from './components/WalletModal';
import CartModal from './components/CartModal';
import CategoryDetailView from './components/CategoryDetailView';
import SearchResultsView from './components/SearchResultsView';
import ProductDetailView from './components/ProductDetailView';
import CustomerOrders from './components/CustomerOrders';
import LoginPage from './components/LoginPage';
import FlyToCartOverlay from './components/FlyToCartOverlay';
import SplashScreen from './components/SplashScreen';
import PriceHistory from './components/PriceHistory';
import AccountHistory from './components/AccountHistory';
import AccountRewards from './components/AccountRewards';
import PageTransition from './components/PageTransition';
import OTPBoxGroup from './components/OTPBoxGroup';
import ReverseOtpPanel from './components/ReverseOtpPanel';
import MarketPicker from './components/MarketPicker';
import NearbyShops from './components/NearbyShops';
import LocationPrimer from './components/LocationPrimer';
import LanguagePicker from './components/LanguagePicker';
import { useLanguage } from './i18n/LanguageContext';
import { productName, dateLocale } from './i18n/catalog';
import { fetchMarketCatalog, savedCustomerCoords } from './services/markets';
import { savedCustomerAddress } from './services/address';
import { productSkuFromHash } from './services/share';
import { mergeCartLines, cartItemCount } from './services/cart';
import { createSchedule, fetchSchedules, recurrenceFromDates, describeRecurrence } from './services/schedules';
import { HomeSkeleton } from './components/LoadingSkeleton';
import { useToast } from './components/Toast';
import { ChevronRight, ArrowLeft, User as UserIcon, History as HistoryIcon, Coins as CoinsIcon } from 'lucide-react';
import {
  logout,
  logoutEverywhere,
  startPhoneChange,
  verifyPhoneChange,
  startEmailChange,
  verifyEmailChange,
} from './services/auth';
import useLocalStorage from './hooks/useLocalStorage';
import useSessionUser from './hooks/useSessionUser';
import { initialCategories } from './data/mockData';
import { fetchProducts, updateStock } from './services/products';
import {
  fetchOrders, createOrder, updateOrderStatus, cancelOrder,
  acceptPartialOrder, retryPartialOrder,
} from './services/orders';
import { fetchWallet, topUpWallet } from './services/wallet';
import { fetchUsers, updateUser, updateUserRole, deleteUser } from './services/users';
import { ApiRequestError, NetworkError } from './services/apiClient';
import { RUPEES_PER_BATCH, TOKENS_PER_BATCH } from './services/rewards';

/**
 * Admin panels are code-split: only `developer` and `market_owner` sessions ever
 * render them, so shipping them to every customer is dead weight in the initial
 * download. ShopkeeperPanel and DeliveryPanel were also imported here but never
 * rendered — they live in their own hash-routed apps — so they are gone
 * entirely, which also removes Leaflet from the customer bundle.
 */
const DeveloperPanel = lazy(() => import('./components/DeveloperPanel'));
const MarketOwnerPanel = lazy(() => import('./components/MarketOwnerPanel'));

/**
 * The tabs that render the header, and so the only ones with a logo badge for
 * the launch screen to hand its droplet to. Named once because two places have
 * to agree on it: the header's own render condition, and the decision about how
 * the splash should leave.
 */
const HEADER_TABS = ['home', 'account', 'prices'];

export default function App() {
  // Globally unique ID generator to avoid React key collisions
  const _idCounter = React.useRef(Date.now());
  const uniqueId = () => ++_idCounter.current;

  const toast = useToast();
  const { t, language } = useLanguage();

  /**
   * The category taxonomy is genuinely static — there is no categories endpoint
   * and these are the aisles of a vegetable market, not records. It is the one
   * thing still read from the fixtures.
   */
  const [categories] = useState(initialCategories);

  /**
   * The home page's own "Categories" grid shows only the four aisle-level
   * tiles, not the individual vegetable ids appended after them — those exist
   * for a shopkeeper's own category picker (ShopkeeperPanel), not as a second,
   * non-purchasable browsing path now that every one of those vegetables is a
   * real Product under categoryId 2 and already shows up, addable to cart, in
   * both the "Fresh Vegetables" tile's detail view and ProductList's carousel
   * below. Every other read of `categories` keeps the full list.
   */
  const homeGridCategories = categories.filter((c) => c.id <= 4);

  /**
   * Everything below starts EMPTY, and waits for the server.
   *
   * These used to be seeded from `sampleProducts`, `initialOrders` and
   * `initialRegisteredUsers`. Invented produce at invented prices rendered as
   * the real catalog on first paint — and stayed if the fetch failed, so an
   * offline shopper could fill a basket with items that do not exist and place
   * an order the server had never heard of. `isAppLoading` already drives a
   * skeleton, which is the honest version of that moment.
   *
   * Orders are also deliberately NOT seeded from localStorage: that key is
   * readable by every app on the origin, so the shopkeeper and delivery apps
   * were picking up the customer's list (and vice versa).
   */
  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [scheduledOrders, setScheduledOrders] = useState([]);
  const [registeredUsers, setRegisteredUsers] = useState([]);
  const [searchVal, setSearchVal] = useState('');
  /**
   * The *submitted* search, which is a different thing from `searchVal`, the
   * text currently in the box. Typing only opens suggestions; a search is not
   * run until one is picked. Keeping them apart is what stopped the home
   * carousels emptying out underneath the open suggestion panel — they used to
   * be filtered live by every keystroke, so the page rearranged itself while
   * the shopper was still deciding what to search for.
   */
  const [searchQuery, setSearchQuery] = useState('');
  const [isAppLoading, setIsAppLoading] = useState(true);
  const [showSplash, setShowSplash] = useState(true);
  
  const [activeTab, setActiveTab] = useLocalStorage('vegdrop_tab', 'login');

  /**
   * Session state is held in memory and restored from the httpOnly refresh
   * cookie. It is deliberately NOT persisted to localStorage: the user object
   * carries a `role`, and web storage is editable from devtools, so a persisted
   * session would let anyone hand themselves a privileged panel.
   *
   * Every role may render this app — `developer` and `market_owner` get their
   * panels as tabs here — so nothing is gated on role. What IS handled is the
   * identity changing underneath: the refresh cookie is shared with the
   * shopkeeper and delivery apps, so signing into one of those in another tab
   * silently replaced the session here. This screen then went on showing one
   * person's cart, orders and wallet while authenticated as somebody else.
   */
  const { user, setUser, isRestoringSession } = useSessionUser({
    onIdentityLost: (next) => {
      // Everything below is per-account. Leaving any of it on screen after the
      // session moved to another person is exactly the leak to avoid.
      clearCart();
      setOrders([]);
      setScheduledOrders([]);
      setRegisteredUsers([]);
      setWalletBalance(0);
      setWalletTransactions([]);
      // Gone entirely: 'login' renders the sign-in screen, because `activeTab`
      // only reaches it while there is no user. Replaced by someone else: they
      // ARE signed in, so drop them on a clean home rather than a login screen
      // they would fall straight through.
      setActiveTab(next ? 'home' : 'login');
    },
  });

  /**
   * The cart starts empty. It previously shipped a demo line item whose `id` was
   * a mock catalog number (101), not a real product id — so the first thing a new
   * user saw in their basket was the one thing checkout could not accept: the
   * server validates every productId as a 24-character ObjectId and rejected the
   * whole order with a 400.
   */
  const [cartItems, setCartItems, clearCart] = useLocalStorage('vegdrop_cart', []);
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

  /**
   * The market being shopped from, and its catalog.
   *
   * Held here rather than inside MarketPicker because three other things need
   * it: what the browse screens list, what the cards say underneath each
   * product name, and which market the order is sent to at checkout.
   */
  const [selectedMarket, setSelectedMarket] = useState(null);
  const [marketProducts, setMarketProducts] = useState([]);

  /**
   * Bumped whenever the delivery address is saved.
   *
   * The address lives in localStorage, which React cannot observe, so anything
   * derived from it needs a signal to recompute — otherwise the basket keeps
   * showing "no delivery address" after the customer has just entered one.
   */
  const [addressVersion, setAddressVersion] = useState(0);

  /**
   * The independent shop being bought from instead, and its own catalog.
   *
   * Mutually exclusive with `selectedMarket` — an order has one seller, and the
   * server refuses a request naming both. Resolved here rather than inside
   * either picker so neither has to know the other exists.
   */
  const [selectedShop, setSelectedShop] = useState(null);
  const [shopProducts, setShopProducts] = useState([]);

  /**
   * Where the customer is, once known. Seeded from whatever the address picker
   * saved earlier so a returning visitor is never asked again, and updated when
   * the primer resolves so both nearby lists can load without a reload.
   */
  const [customerCoords, setCustomerCoords] = useState(() => savedCustomerCoords());

  /**
   * Why an order cannot be placed right now, or null when it can.
   *
   * AN ORDER WITH NO SELLER IS AN ORDER NOBODY CAN EVER FILL. `marketId` and
   * `shopId` are both optional on the wire, and omitting both still creates a
   * "legacy marketless" order — but `GET /stalls/me/orders` selects on
   * `market: <the stall's market>` AND `fulfillment.status: 'sourcing'`, and a
   * marketless order has neither. No stall sees it, no rider is ever dispatched
   * for it, and it sits at Pending until someone reads the database.
   *
   * That used to be reachable in one very ordinary way: decline the location
   * prompt. MarketPicker then has no coordinates, selects no market, and
   * checkout quietly posted without one. So the basket refuses instead, and
   * says which of the two things is missing.
   */
  const checkoutBlockedReason = useMemo(() => {
    if (!selectedMarket && !selectedShop) {
      return t('checkout.needMarket');
    }
    if (!savedCustomerAddress()) {
      return t('checkout.needStreetAddress');
    }
    return null;
    // `addressVersion` is the only signal that localStorage changed. `t` is a
    // dependency because it closes over the chosen language — without it the
    // blocked-reason banner keeps whichever language was active when the basket
    // first refused, and never restates itself after a language switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMarket, selectedShop, addressVersion, t, language]);

  // Profile editing, plus the verified phone-change flow
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [activeAccountView, setActiveAccountView] = useState('menu');
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [showProfileOTP, setShowProfileOTP] = useState(false);
  const [profileMobileOTP, setProfileMobileOTP] = useState('');
  const [profileOtpError, setProfileOtpError] = useState('');
  /**
   * Whether the number leg is being proved in reverse — the user messaging us
   * from the new number instead of reading back a code we sent to it.
   *
   * Only ever offered for `kind: 'phone'`. An email address has nothing to send
   * from, so the address leg has no reverse equivalent.
   */
  const [profileReverse, setProfileReverse] = useState(false);
  /**
   * The challenge currently being answered, as `{ kind: 'email'|'phone', ... }`.
   *
   * Both contact changes are OTP-verified against the NEW destination, so one
   * piece of state drives one modal. `kind` decides which verify call to make
   * and what the modal says — the two outcomes differ enough to be worth saying
   * plainly (a phone change signs every other device out; an email change does
   * not).
   */
  const [profileChallenge, setProfileChallenge] = useState(null);
  /**
   * A phone change queued behind an email change, when the user edited both.
   *
   * They run in sequence rather than together because each proves a different
   * destination. Email goes first deliberately: it is the harmless one, so a
   * user who abandons the flow at the phone step keeps the address they just
   * proved instead of losing both.
   */
  const [pendingPhoneChange, setPendingPhoneChange] = useState(null);

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
   * Wire the phone/browser back button to the bottom-nav tabs.
   *
   * Prices (and every other tab) had no way back at all: they are top-level
   * screens with no on-screen back arrow, so the only route to them was
   * tapping another icon in BottomNav. Nothing here ever touched browser
   * history, so pressing device back from Prices didn't return to Home — it
   * left the app entirely, landing on whatever page opened it (or closing a
   * installed PWA outright).
   *
   * Every tab change now pushes a history entry, and popping it lands back on
   * the previous tab instead. `isPoppingRef` stops that landing from pushing
   * a second entry, which would otherwise turn one back press into a no-op.
   */
  const isPoppingRef = useRef(false);

  useEffect(() => {
    window.history.replaceState({ vegdropTab: activeTab }, '');
  }, []); // seed once, so the very first back press has a defined entry to land on

  useEffect(() => {
    const onPopState = (event) => {
      isPoppingRef.current = true;
      setActiveTab(event.state?.vegdropTab || 'home');
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [setActiveTab]);

  useEffect(() => {
    if (isPoppingRef.current) {
      isPoppingRef.current = false;
      return;
    }
    // Pre-auth screens aren't tabs to navigate back through.
    if (activeTab === 'login' || activeTab === 'signup') return;
    window.history.pushState({ vegdropTab: activeTab }, '');
  }, [activeTab]);

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

            // Standing orders now live on the server, so they survive a reload
            // and actually place deliveries. Previously this list was React
            // state seeded from a fixture and cleared on every refresh.
            fetchSchedules()
              .then((list) => {
                if (!cancelled) setScheduledOrders(list);
              })
              .catch((err) => console.warn('schedules unavailable:', err.message)),

            fetchWallet()
              .then((w) => {
                if (cancelled) return;
                setWalletBalance(w.balance);
                setWalletTransactions(w.transactions);
              })
              .catch((err) => console.warn('wallet unavailable:', err.message)),

            // Developer-only, and only DeveloperPanel renders it. A market owner
            // used to be asked for this too, which was a request for the whole
            // user table — phone numbers included — on behalf of a panel they
            // never see. The server refuses them now; do not ask.
            ...(['developer'].includes(user.role)
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

  /**
   * Poll the server for order changes.
   *
   * This replaces a localStorage + BroadcastChannel mirror that wrote this
   * customer's order list to a key every app on the origin could read, and
   * merged whatever it found back into state. The server already scopes orders
   * to the caller, so the mirror added nothing but a cross-role leak.
   *
   * Polling pauses while the tab is hidden, and does not run at all until there
   * is a session — an unauthenticated poll just 401s every five seconds.
   */
  useEffect(() => {
    if (!user) return;

    let cancelled = false;

    const poll = async () => {
      if (document.hidden) return;
      try {
        const serverOrders = await fetchOrders({ limit: 100 });
        if (!cancelled) setOrders(serverOrders);
      } catch (e) {
        /* Transient poll failure; the next tick retries. */
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

  /**
   * A toast for the transitions that happen on somebody else's phone.
   *
   * Everything else that changes an order in this app already toasts at the
   * call site — placing one, cancelling one. These four do not: a shopkeeper
   * confirming, a rider accepting, a pickup code being verified, and a
   * delivery landing all happen outside this tab, and the poll above is the
   * only way this screen ever finds out. Compared against the previous poll
   * rather than fired from `setOrders` itself, so the very first load (every
   * order "changing" from nothing) does not toast the customer's entire
   * order history at once.
   */
  const previousOrderState = useRef(new Map());
  useEffect(() => {
    const previous = previousOrderState.current;
    const next = new Map();

    for (const order of orders) {
      const id = order.serverId || order.id;
      const prior = previous.get(id);
      next.set(id, { status: order.status, riderAccepted: order.riderAccepted });

      if (!prior) continue; // First time this order has been seen; nothing to compare.

      if (order.riderAccepted && !prior.riderAccepted) {
        toast.info(`${order.riderName ? order.riderName : 'A rider'} is on the way to collect order ${order.id} 🛵`);
      }
      if (order.status !== prior.status) {
        const message = {
          Preparing: `Order ${order.id} is being prepared 👨‍🍳`,
          'Out for Delivery': `Order ${order.id} is out for delivery 🚚`,
          Delivered: `Order ${order.id} delivered ✅`,
        }[order.status];
        if (message) toast.info(message);
      }
    }

    previousOrderState.current = next;
  }, [orders, toast]);

  const handleSyncOrders = useCallback(async () => {
    try {
      const serverOrders = await fetchOrders({ limit: 100 });
      setOrders(serverOrders);
      toast.success(`Orders synced! ${serverOrders.length} orders loaded 🛍️`);
    } catch (e) {
      toast.error('Sync failed: ' + e.message);
    }
  }, [toast]);

  /**
   * Grant an EXISTING account a role. There is no client-side account
   * creation any more — accounts only come from the verified sign-up flow —
   * so this looks the person up by the phone or email they already signed up
   * with, rather than minting a new record the way the old stub's name/UI
   * implied.
   *
   * `registeredUsers` is the admin-only user list already fetched into this
   * component; searching it locally avoids a lookup endpoint that would let
   * an admin panel enumerate accounts by guessing phone numbers.
   */
  const handleRegisterUser = useCallback(async ({ identifier, role }) => {
    const needle = identifier.trim().toLowerCase();
    const digits = needle.replace(/\D/g, '');

    const target = registeredUsers.find((u) => {
      if (u.email && u.email.toLowerCase() === needle) return true;
      if (digits.length >= 10 && u.phone && u.phone.replace(/\D/g, '').endsWith(digits.slice(-10))) return true;
      return false;
    });

    if (!target) {
      toast.error('No account found with that phone or email. They need to sign up in the app first.');
      return false;
    }

    try {
      const updated = await updateUserRole(target.id, role);
      setRegisteredUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
      toast.success(`${updated.name} is now ${role.replace('_', ' ')}. They must sign in again.`);
      return true;
    } catch (err) {
      const message =
        err instanceof NetworkError
          ? 'Could not reach the server. Check your connection and try again.'
          : err instanceof ApiRequestError
          ? err.message
          : 'Could not update that role. Please try again.';
      toast.error(message);
      return false;
    }
  }, [registeredUsers, toast]);

  /**
   * Create a standing order on the server.
   *
   * This used to build an object with a `SUB${Math.random()}` id, push it into
   * React state, and toast "schedule created successfully". Nothing was sent
   * anywhere and a reload cleared it, so a customer expecting vegetables every
   * Tuesday got none and no explanation.
   *
   * The total this used to compute is gone with it. A schedule stores intent,
   * never a price: each run is priced from the market's sheet on the morning it
   * ships, because a basket ordered three weeks ahead cannot honestly quote
   * today's number.
   */
  const handleScheduleCart = useCallback(async () => {
    if (!user) {
      toast.warning(t('toast.signInToSchedule'));
      return;
    }
    if (!scheduledCartItems || scheduledCartItems.length === 0) {
      toast.warning(t('toast.basketEmpty'));
      return;
    }
    // A standing order inherits the same requirement as a one-off: without a
    // market it would mint an unfillable order every single run.
    if (checkoutBlockedReason) {
      toast.error(checkoutBlockedReason);
      return;
    }

    const frequency = String(scheduleFilter || 'Daily').toLowerCase();

    // Daily needs no dates at all; the others need at least one to recur on.
    if (frequency !== 'daily' && selectedDates.length === 0) {
      toast.warning(
        t(frequency === 'weekly' ? 'toast.pickWeekday' : 'toast.pickMonthDay')
      );
      return;
    }

    const coords = savedCustomerCoords();

    try {
      const created = await createSchedule({
        items: scheduledCartItems.map((item) => ({
          productId: item.id,
          quantity: item.quantity,
        })),
        // The same address and coordinates a manual checkout uses. Guaranteed
        // non-null by the checkoutBlockedReason gate below.
        address: savedCustomerAddress(),
        // COD keeps a standing order working without a funded wallet. The
        // server refuses razorpay outright — nobody is present to pay.
        paymentMethod: 'cod',
        marketId: selectedMarket?.id,
        lat: coords?.lat,
        lng: coords?.lng,
        frequency,
        ...recurrenceFromDates(frequency, selectedDates),
      });

      setScheduledOrders((prev) => [...(prev || []), created]);
      setScheduledCartItems([]);
      setSelectedDates([]);
      setShoppingMode('regular');
      setActiveTab('orders');
      setIsScheduledCartOpen(false);

      toast.success(
        t('toast.scheduleCreated', {
          recurrence: describeRecurrence(created, t, dateLocale(language)),
          date: new Date(created.nextRunAt).toLocaleDateString(dateLocale(language)),
        })
      );
    } catch (err) {
      toast.error(err.message || t('toast.scheduleFailed'));
    }
  }, [
    selectedDates,
    scheduleFilter,
    scheduledCartItems,
    user,
    selectedMarket,
    checkoutBlockedReason,
    toast,
    t,
    language,
  ]);

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
    toast.success(t('toast.welcomeBack', { name: userData.name }));
  }, [setActiveTab, toast, t]);

  const handleLogout = useCallback(async () => {
    const name = user?.name || 'User';
    await logout();
    setUser(null);
    clearCart();
    setActiveTab('login');
    toast.info(t('toast.signedOut', { name }));
  }, [user, clearCart, setActiveTab, toast, t]);

  /**
   * Sign out every device, not just this one.
   *
   * In a system with no password this is the whole of account recovery. There
   * is nothing to rotate when a session goes bad — no credential to change —
   * so revoking the refresh-token family and bumping `tokenVersion` is the only
   * lever, and `POST /auth/logout-all` was reachable by nothing.
   *
   * It matters more now that a verified email receives copies of login codes:
   * account security becomes the weaker of the two channels, so "someone has
   * been in my mailbox" needs an answer that does not depend on reaching the
   * mailbox again.
   *
   * Confirmed first because it is disruptive rather than dangerous — every
   * other phone and tab is signed out, including ones the user may not be
   * holding.
   */
  const handleLogoutEverywhere = useCallback(async () => {
    const confirmed = window.confirm(t('toast.confirmLogoutEverywhere'));
    if (!confirmed) return;

    const name = user?.name || 'User';
    try {
      await logoutEverywhere();
    } catch {
      // The service clears local state regardless; a failed call must not
      // leave the user looking signed in when they asked not to be.
    }
    setUser(null);
    clearCart();
    setActiveTab('login');
    toast.success(t('toast.loggedOutEverywhere', { name }));
  }, [user, clearCart, setActiveTab, toast, t]);

  const handleDeleteAccount = useCallback(async () => {
    if (!user) return;
    const confirmDelete = window.confirm(t('toast.confirmDeleteAccount'));
    if (!confirmDelete) return;

    try {
      await deleteUser(user.id);
    } catch (err) {
      // Self-service deletion is admin-gated server-side; surface the refusal
      // rather than signing the user out as though it had succeeded.
      toast.error(
        t(
          err instanceof ApiRequestError && err.status === 403
            ? 'toast.deleteNeedsAdmin'
            : 'toast.deleteFailed'
        )
      );
      return;
    }

    await logout();
    setUser(null);
    clearCart();
    setActiveTab('login');
    toast.warning(t('toast.accountDeleted'));
  }, [user, clearCart, setActiveTab, setRegisteredUsers, toast, t]);

  const handleStartEditingProfile = useCallback(() => {
    if (!user) return;
    setEditName(user.name);
    setEditEmail(user.email || '');
    setEditPhone(user.phone || '');
    setIsEditingProfile(true);
    setShowProfileOTP(false);
    /**
     * Four more setters used to be called here — `setProfileEmailOTP`,
     * `setProfilePrevEmailOTP`, `setProfilePrevMobileOTP` and
     * `setActiveOtpStepIndex` — left behind when the multi-step profile OTP flow
     * was removed. None of them existed any more, so every click on "Edit
     * Profile Details" threw a ReferenceError partway through and the two resets
     * below never ran: a stale code and, worse, a stale error message survived
     * into the next edit.
     */
    setProfileMobileOTP('');
    setProfileReverse(false);
    setProfileOtpError('');
  }, [user]);

  /**
   * The name is an ordinary profile field and saves directly. Neither contact
   * is.
   *
   * This used to send `email` alongside `name` in the profile PATCH. That
   * stopped working when login codes began being copied to a verified address:
   * the server dropped `email` from the schema for the same reason it never
   * accepted `phone`, and because the schema is `.strict()` an unknown key
   * fails the WHOLE request — so a user with an address on file (the field is
   * pre-filled from it, so that is everyone) got a 400 and could not even
   * rename themselves. Both contacts now take the verified route they always
   * should have.
   */
  const handleSaveProfile = useCallback(async (e) => {
    e.preventDefault();

    const name = editName.trim();
    const email = editEmail.trim().toLowerCase();
    const phone = editPhone.trim();

    if (!name || !phone) {
      toast.error(t('toast.nameAndPhoneRequired'));
      return;
    }

    const emailChanged = email !== (user.email || '').toLowerCase();
    const phoneChanged = phone !== (user.phone || '');

    try {
      // The name first, so it lands even if a contact change is abandoned at
      // the code step.
      if (name !== user.name) {
        const updated = await updateUser(user.id, { name });
        setUser(updated);
        setRegisteredUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
      }

      // An address can be added or replaced, but not removed — there is no
      // endpoint for dropping one, so say that rather than silently ignoring it.
      if (emailChanged && !email) {
        toast.warning(t('toast.emailRemovalUnsupported'));
      }

      if (emailChanged && email) {
        const issued = await startEmailChange({ email });
        setProfileChallenge({ kind: 'email', ...issued });
        // Queued, not run in parallel: each code proves a different destination.
        setPendingPhoneChange(phoneChanged ? phone : null);
        setProfileMobileOTP('');
        setProfileOtpError('');
        setShowProfileOTP(true);
        return;
      }

      if (phoneChanged) {
        const issued = await startPhoneChange({ phone });
        // `issued.destination` is masked, so the raw number is kept alongside —
        // the reverse-OTP panel needs a real number to raise a challenge for.
        setProfileChallenge({ kind: 'phone', rawPhone: phone, ...issued });
        setPendingPhoneChange(null);
        setProfileMobileOTP('');
        setProfileOtpError('');
        setShowProfileOTP(true);
        return;
      }

      setIsEditingProfile(false);
      if (name !== user.name) toast.success(t('toast.profileUpdated'));
    } catch (err) {
      toast.error(
        err.code === 'EMAIL_NOT_CONFIGURED'
          ? t('toast.emailNotConfigured')
          : err.message || t('toast.profileUpdateFailed')
      );
    }
  }, [user, editName, editEmail, editPhone, setUser, setRegisteredUsers, toast, t]);

  const handleVerifyProfileOTP = useCallback(async (e) => {
    e.preventDefault();
    setProfileOtpError('');

    if (!profileMobileOTP || profileMobileOTP.trim().length < 6) {
      setProfileOtpError('Enter the 6-digit verification code.');
      return;
    }
    if (!profileChallenge) {
      setProfileOtpError('This request expired. Please start again.');
      return;
    }

    const isEmail = profileChallenge.kind === 'email';
    const code = profileMobileOTP.trim();

    try {
      // The server is the only writer; adopt exactly what it returns rather
      // than optimistically assuming the edit applied.
      const updated = isEmail
        ? await verifyEmailChange({ challengeId: profileChallenge.challengeId, code })
        : await verifyPhoneChange({ challengeId: profileChallenge.challengeId, code });

      setUser(updated);
      setRegisteredUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));

      /**
       * The address is proved; now do the number, without closing the modal.
       * Started only after the email leg succeeded, so abandoning here costs
       * the user the number change and not the address they just confirmed.
       */
      if (isEmail && pendingPhoneChange) {
        const issued = await startPhoneChange({ phone: pendingPhoneChange });
        setProfileChallenge({ kind: 'phone', rawPhone: pendingPhoneChange, ...issued });
        setPendingPhoneChange(null);
        setProfileMobileOTP('');
        toast.success(t('toast.emailVerifiedNowPhone'));
        return;
      }
    } catch (err) {
      setProfileOtpError(err.message || 'Could not verify that code.');
      return;
    }

    setIsEditingProfile(false);
    setShowProfileOTP(false);
    setProfileChallenge(null);
    setPendingPhoneChange(null);
    toast.success(t(isEmail ? 'toast.emailVerified' : 'toast.phoneUpdated'));
  }, [profileChallenge, pendingPhoneChange, profileMobileOTP, setUser, setRegisteredUsers, toast, t]);

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

  /** Run a search: leave the box showing it and open the results screen. */
  const handleSubmitSearch = useCallback((query) => {
    const trimmed = query.trim();
    if (!trimmed) return;

    setActiveProductDetail(null);
    setActiveCategoryDetail(null);
    setSearchQuery(trimmed);
    window.scrollTo({ top: 0 });
  }, []);

  /** Leave the results screen, and take the query out of the box with it. */
  const handleClearSearch = useCallback(() => {
    setSearchQuery('');
    setSearchVal('');
  }, []);

  /** A suggestion naming a whole section opens that section instead. */
  const handleOpenCategoryFromSearch = useCallback((category) => {
    setSearchQuery('');
    setSearchVal('');
    setActiveProductDetail(null);
    setActiveCategoryDetail(category);
  }, []);

  /**
   * Load the chosen market's catalog.
   *
   * A cart built at one market cannot be carried to another: the prices differ,
   * and a market that does not stock one of the lines would refuse the whole
   * order at checkout. Clearing it on switch is blunt but honest — far better
   * than a confusing rejection three taps later.
   */
  useEffect(() => {
    if (!selectedMarket) return;
    let cancelled = false;

    fetchMarketCatalog(selectedMarket.id)
      .then((items) => {
        if (!cancelled) setMarketProducts(items);
      })
      .catch((err) => {
        if (!cancelled) {
          setMarketProducts([]);
          console.warn('market catalog unavailable:', err.message);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedMarket]);

  /**
   * Current seller and basket size, for the selection handlers below.
   *
   * Held in a ref so those handlers can keep a STABLE identity. MarketPicker
   * runs its load-and-auto-select effect whenever its `onSelectMarket` prop
   * changes; if the handler were rebuilt every time the selection changed, then
   * picking a shop (which clears the market) would hand MarketPicker a fresh
   * callback, it would re-run, find no market selected, and auto-select the
   * nearest one straight back — silently undoing the customer's choice.
   */
  const sellerRef = useRef({ market: null, shop: null, cartCount: 0 });
  useEffect(() => {
    sellerRef.current = { market: selectedMarket, shop: selectedShop, cartCount: cartItems.length };
  });

  /**
   * Switching seller empties the basket.
   *
   * The decision is made out here rather than inside a setState updater. An
   * updater runs during React's render phase, so calling `setCartItems` and
   * `toast` from within one updates another component mid-render — React warns
   * about exactly this ("Cannot update a component while rendering a different
   * component"), and the toast can be dropped.
   */
  const switchSeller = useCallback(
    (changed, message) => {
      if (!changed || sellerRef.current.cartCount === 0) return;
      setCartItems([]);
      toast.info(message);
    },
    [setCartItems, toast]
  );

  const handleSelectMarket = useCallback(
    (market) => {
      const { market: current, shop } = sellerRef.current;
      switchSeller(
        (current && current.id !== market.id) || Boolean(shop),
        t('toast.switchedMarket', { market: market.name })
      );
      setSelectedMarket(market);
      // One seller at a time.
      setSelectedShop(null);
    },
    [switchSeller, t]
  );

  /**
   * Switch to buying from one independent shop.
   *
   * Clears the market for the same reason switching market clears the cart: the
   * basket is priced against whoever is selling, and a shop's own listings are
   * not the market's price sheet. Carrying items across would show one price and
   * charge another — and the server rejects a basket that mixes sellers outright.
   */
  const handleSelectShop = useCallback(
    (shop) => {
      const { market, shop: current } = sellerRef.current;
      switchSeller(
        current?.id !== shop.id || Boolean(market),
        t('toast.switchedShop', { shop: shop.name })
      );
      setSelectedShop(shop);
      setSelectedMarket(null);
      setMarketProducts([]);
    },
    [switchSeller, t]
  );

  /** One shop's own listings. Empty until a shop is chosen. */
  useEffect(() => {
    if (!selectedShop) {
      setShopProducts([]);
      return;
    }
    let cancelled = false;

    fetchProducts({ shopId: selectedShop.id, limit: 200 })
      .then((items) => !cancelled && setShopProducts(items))
      .catch((err) => {
        if (cancelled) return;
        setShopProducts([]);
        console.warn('shop catalog unavailable:', err.message);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedShop]);

  /**
   * What the customer is actually browsing.
   *
   * When a market is chosen, its own price sheet replaces the platform catalog
   * — that is what "one price per market" means, and the same tomato can cost
   * differently two streets apart. The shapes are identical, so every browse
   * component below works unchanged either way.
   *
   * With no market (none nearby, or the list is still loading) this falls back
   * to the platform catalog, so the app is never empty.
   *
   * There is no separate live-filtered list alongside this one: search is
   * submit-based (services/search.js) and reads straight from browseProducts,
   * so a market's own catalog is what suggestions and results are drawn from
   * too — see the Header, SearchResultsView and RelatedProducts call sites
   * below.
   */
  const browseProducts = selectedShop
    ? /**
       * A shop's own listings, and NO fallback when it has none.
       *
       * Falling through to the platform catalog here would fill the screen with
       * items this shop does not stock; the server rejects a basket that mixes
       * sellers, so the customer would only find out at checkout. An empty shop
       * reads as empty.
       */
      shopProducts
    : selectedMarket && marketProducts.length > 0
      ? marketProducts
      : products;

  /**
   * Repair a basket saved while Add could append duplicate lines.
   *
   * The basket outlives the deploy that fixed the writer, so without this an
   * affected shopper keeps seeing their three separate "Broccoli x1" rows for
   * good. `mergeCartLines` returns the same reference when there is nothing to
   * merge, so the overwhelming majority of loads neither re-render nor rewrite
   * storage.
   */
  useEffect(() => {
    setCartItems((prev) => mergeCartLines(prev));
  }, [setCartItems]);

  const handleAddToCart = useCallback((product, event) => {
    if (product.stock === 0) {
      toast.warning(t('toast.soldOut', { name: productName(product, language) }));
      return;
    }
    
    const isScheduled = shoppingMode === 'scheduled';
    const targetCart = isScheduled ? scheduledCartItems : cartItems;
    const setTargetCart = isScheduled ? setScheduledCartItems : setCartItems;
    
    /**
     * Only for the toast, never for the cart itself.
     *
     * This is a render-time snapshot, so it is stale the moment two taps land
     * in one batch. Getting it wrong costs a duplicate "added" toast; getting
     * the *cart* wrong from the same read used to cost a duplicate line, which
     * is why the real lookup moved inside the updater below.
     */
    const existingAtRender = targetCart.find((item) => item.id === product.id);

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
      /**
       * Resolved from `prev`, not from the enclosing render.
       *
       * Tapping Add three times quickly puts all three updates in one React
       * batch, and every one of them saw the same pre-batch `cartItems` — so
       * each concluded the product was absent and appended its own line. The
       * basket came back with three "Broccoli (500g)" rows at quantity 1
       * instead of one row at 3, and removing one left the others behind.
       * `prev` is the only view that reflects the updates already queued ahead
       * of this one.
       */
      const existing = prev.find((item) => item.id === product.id);

      if (existing) {
        return prev.map((item) =>
          item.id === product.id ? { ...item, quantity: item.quantity + 1 } : item
        );
      }
      /**
       * `originalId` has to survive into the cart line.
       *
       * For a weight-based product `id` is a variant key — `<catalogId>-500g`
       * — and the catalog id lives only on `originalId`. This rebuilt the line
       * from a fixed set of fields and dropped it, so checkout fell back to
       * `id` and posted the variant key as `productId`.
       */
      return [...prev, {
        id: product.id,
        originalId: product.originalId ?? product.id,
        name: product.name,
        /**
         * The translated names travel into the line too.
         *
         * The line is rebuilt from a fixed field list rather than spread, which
         * is the same trap `originalId` fell into above: without these the
         * basket would resolve every product back to its English name while the
         * card the shopper tapped it from showed Telugu.
         */
        nameTe: product.nameTe || '',
        nameHi: product.nameHi || '',
        price: product.price,
        quantity: 1,
        image: product.image,
      }];
    });

    if (!existingAtRender) {
      toast.success(
        t(isScheduled ? 'toast.addedToSchedule' : 'toast.addedToBasket', {
          name: productName(product, language),
        })
      );
    }
  }, [cartItems, scheduledCartItems, shoppingMode, setCartItems, setScheduledCartItems, toast, t, language]);

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
      t(result?.credited === false ? 'toast.alreadyCredited' : 'toast.walletToppedUp')
    );
  }, [toast, t]);

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
      toast.error(t('toast.signInToOrder'));
      return false;
    }
    // Authoritative: the modal disables its button on the same condition, but a
    // stale render must not be the only thing standing between a customer and
    // an order no stall can see.
    if (checkoutBlockedReason) {
      toast.error(checkoutBlockedReason);
      return false;
    }
    if (cartItems.length === 0) {
      toast.error(t('toast.cartEmpty'));
      return false;
    }

    /**
     * Online payment tops the wallet up, then the order is paid from it.
     *
     * Charging the order directly would leave the customer paid-but-orderless
     * whenever the stock check fails after capture, and unwinding that needs a
     * refund. Money landing in the wallet first has no such window: if the order
     * is then rejected, the balance simply stays theirs and the next attempt
     * spends it.
     *
     * Only the shortfall is charged, so an existing balance is spent before the
     * card is.
     */
    const isOnlinePayment = selectedPaymentMethod !== 'COD' && selectedPaymentMethod !== 'VegWallet';

    if (isOnlinePayment) {
      const shortfallRupees = Math.max(0, totalAmount - walletBalance);

      if (shortfallRupees > 0) {
        // The server's floor for a single top-up. Below it, the smallest
        // allowed payment is collected and the remainder stays in the wallet.
        const MIN_TOPUP = 10;
        const chargeRupees = Math.max(MIN_TOPUP, Math.ceil(shortfallRupees));

        try {
          // The method the customer picked in the basket, so choosing PhonePe
          // there opens PhonePe rather than the generic sheet.
          const result = await topUpWallet(chargeRupees, user, { method: selectedPaymentMethod });
          setWalletBalance(result.balance);
          if (chargeRupees > shortfallRupees) {
            toast.success(
              t('toast.paidChangeToWallet', {
                paid: chargeRupees,
                change: (chargeRupees - shortfallRupees).toFixed(0),
              })
            );
          }
        } catch (err) {
          // A dismissed checkout sheet is a decision, not a fault.
          if (/cancel/i.test(err?.message || '')) return false;
          toast.error(err?.message || t('toast.paymentFailed'));
          return false;
        }

        // The balance the order will be charged against is now the server's,
        // so re-read it rather than trusting the number we just computed.
        fetchWallet()
          .then((w) => {
            setWalletBalance(w.balance);
            setWalletTransactions(w.transactions);
          })
          .catch(() => {});
      }
    }

    const paymentMethod =
      selectedPaymentMethod === 'VegWallet' || isOnlinePayment ? 'wallet' : 'cod';
    // Non-null: checkoutBlockedReason above refuses when it isn't set.
    const address = savedCustomerAddress();

    // Collapse variants back onto their catalog product before ordering.
    const quantities = new Map();
    for (const item of cartItems) {
      const productId = item.originalId || item.id;
      quantities.set(productId, (quantities.get(productId) || 0) + item.quantity);
    }

    const items = [...quantities.entries()].map(([productId, quantity]) => ({ productId, quantity }));

    // Coordinates let the server hop to the next nearest market if this one's
    // stalls cannot fill the order. Without them it falls back to searching
    // outward from the market itself, which still works.
    const coords = customerCoords || savedCustomerCoords();

    try {
      const order = await createOrder({
        items,
        address,
        paymentMethod,
        // Mutually exclusive, and already kept that way by the selection
        // handlers — passed through as-is so the server sees at most one.
        marketId: selectedMarket?.id,
        shopId: selectedShop?.id,
        lat: coords?.lat,
        lng: coords?.lng,
      });

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

      /**
       * A market order that comes back already locked was taken by stalls with
       * auto-accept the moment it was placed — worth saying, because it is the
       * difference between "someone is on it" and "we are still asking around".
       */
      if (order.fulfillmentStatus === 'sourcing') {
        toast.success(t('toast.orderSourcing', { id: order.id, market: order.marketName }));
      } else if (order.fulfillmentStatus) {
        toast.success(t('toast.orderAccepted', { id: order.id }));
      } else {
        toast.success(t('toast.orderPlaced', { id: order.id }));
      }
      return true;
    } catch (err) {
      if (err instanceof NetworkError) {
        toast.error(t('toast.noServer'));
      } else if (err instanceof ApiRequestError && err.code === 'INSUFFICIENT_FUNDS') {
        toast.error(err.message);
      } else if (err instanceof ApiRequestError && err.code === 'INSUFFICIENT_STOCK') {
        toast.error(err.message);
        fetchProducts({ limit: 200 })
          .then((items2) => items2.length > 0 && setProducts(items2))
          .catch(() => {});
      } else if (err instanceof ApiRequestError && err.code === 'MARKET_CANNOT_FILL') {
        toast.error(
          t('toast.marketCannotFill', {
            market: selectedMarket?.name || t('toast.thisMarket'),
          })
        );
      } else if (err instanceof ApiRequestError && err.code === 'MARKET_UNAVAILABLE') {
        toast.error(
          t('toast.marketClosed', { market: selectedMarket?.name || t('toast.thatMarket') })
        );
      } else if (err instanceof ApiRequestError && err.code === 'SHOP_UNAVAILABLE') {
        toast.error(
          t('toast.shopClosed', { shop: selectedShop?.name || t('toast.thatShop') })
        );
        setSelectedShop(null);
      } else if (err instanceof ApiRequestError && err.code === 'SHOP_JOINED_MARKET') {
        // They now trade at a market, so they are reached through it instead.
        toast.info(
          t('toast.shopJoinedMarket', { shop: selectedShop?.name || t('toast.thatShop') })
        );
        setSelectedShop(null);
      } else if (err instanceof ApiRequestError && err.code === 'MIXED_SELLERS') {
        toast.error(err.message);
      } else {
        toast.error(err.message || t('toast.orderFailed'));
      }

      /**
       * The payment already went through when this is an online method, so say
       * where the money is. Without this the failure reads as "charged and lost
       * it" — the balance is the thing that answers that.
       */
      if (isOnlinePayment) {
        toast.info(t('toast.paymentSafe'));
      }
      return false;
    }
  }, [
    cartItems,
    user,
    setCartItems,
    toast,
    selectedMarket,
    selectedShop,
    checkoutBlockedReason,
    customerCoords,
    walletBalance,
    setWalletBalance,
    setWalletTransactions,
    t,
  ]);


  /**
   * Cancel an order that is still looking for a stall.
   *
   * The button is only shown while that is true, but a stall can accept in the
   * gap between the screen painting and the tap landing. The server answers
   * ORDER_LOCKED in that case, which is not a failure to apologise for — it is
   * the good news that someone took the order.
   */
  const handleCancelOrder = useCallback(async (order) => {
    try {
      const updated = await cancelOrder(order.serverId || order.id);
      setOrders((prev) => prev.map((o) => (o.serverId === updated.serverId ? updated : o)));
      toast.success(t('toast.orderCancelled'));
      fetchWallet()
        .then((w) => {
          setWalletBalance(w.balance);
          setWalletTransactions(w.transactions);
        })
        .catch(() => {});
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'ORDER_LOCKED') {
        toast.info(t('toast.orderLocked'));
        fetchOrders({ limit: 100 }).then(setOrders).catch(() => {});
      } else {
        toast.error(err.message || t('toast.cancelFailed'));
      }
    }
  }, [toast, t]);

  /**
   * "Send the 3 that are available."
   *
   * The refund lands in the wallet whatever they paid with, so the balance is
   * pulled again — otherwise the money appears only after a reload and looks
   * like it went missing.
   *
   * A 409 here means the decision window lapsed and the server already did this
   * on their behalf. That is the same outcome they just asked for, so it is
   * reported as progress rather than an error.
   */
  const handleAcceptPartial = useCallback(async (order) => {
    try {
      const updated = await acceptPartialOrder(order.serverId || order.id);
      setOrders((prev) => prev.map((o) => (o.serverId === updated.serverId ? updated : o)));
      // `refund` is what the server actually credited — zero for COD, which has
      // paid nothing yet and simply owes less at the door.
      toast.success(
        updated.refund > 0
          ? t('toast.partialRefunded', { amount: updated.refund })
          : t('toast.partialCod')
      );
      fetchWallet()
        .then((w) => {
          setWalletBalance(w.balance);
          setWalletTransactions(w.transactions);
        })
        .catch(() => {});
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'NOT_PARTIAL') {
        toast.info(t('toast.alreadySorted'));
        fetchOrders({ limit: 100 }).then(setOrders).catch(() => {});
      } else {
        toast.error(err.message || t('toast.updateOrderFailed'));
      }
    }
  }, [toast, t]);

  /** "Try another market for everything." */
  const handleRetryPartial = useCallback(async (order) => {
    try {
      const updated = await retryPartialOrder(order.serverId || order.id);
      setOrders((prev) => prev.map((o) => (o.serverId === updated.serverId ? updated : o)));
      toast.info(
        t('toast.lookingElsewhere', {
          market: updated.marketName || t('toast.anotherMarket'),
        })
      );
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'NO_MARKET') {
        toast.warning(t('toast.noOtherMarket'));
      } else if (err instanceof ApiRequestError && err.code === 'NOT_PARTIAL') {
        toast.info(t('toast.orderMovedOn'));
        fetchOrders({ limit: 100 }).then(setOrders).catch(() => {});
      } else {
        toast.error(err.message || t('toast.retryFailed'));
      }
    }
  }, [toast, t]);

  const handleOpenProductDetail = useCallback((product, cat) => {
    const parentCategory = cat || categories.find((c) => c.id === product.categoryId);
    setActiveProductDetail({ product, category: parentCategory });
    // Related items sit at the bottom of the page, so opening one from there
    // would otherwise drop the shopper straight into the *next* product's
    // related rail, having never seen the item they just tapped.
    window.scrollTo({ top: 0 });
  }, [categories]);

  /**
   * A suggestion naming one specific item opens that item's page directly.
   * The search is cleared rather than left behind, so backing out of the
   * product returns to where the shopper was, not to a results screen they
   * never asked for.
   *
   * Declared after handleOpenProductDetail on purpose — these are const
   * bindings, so calling it from above its declaration is a dead-zone error at
   * render, not a hoisted function.
   */
  const handleOpenProductFromSearch = useCallback((product) => {
    setSearchQuery('');
    setSearchVal('');
    setActiveCategoryDetail(null);
    handleOpenProductDetail(product);
  }, [handleOpenProductDetail]);

  /**
   * Open the product named by a `#/p/<sku>` share link.
   *
   * Resolution is by `sku` rather than `id` because the link may have been
   * written by someone browsing a different market, whose copy of the item is a
   * separate document with a different `_id`. The market sheet is searched
   * first so a shared item is priced the way the *recipient* would buy it, and
   * the platform catalog is the fallback for a market that does not stock it.
   *
   * `handledShareHash` is what stops this from fighting the shopper: without it
   * the effect would reopen the product every time an unrelated re-render
   * happened, making the back button appear broken. The hash is left in the URL
   * on purpose — clearing it would break a reload of the same link.
   */
  const handledShareHash = useRef(null);

  useEffect(() => {
    const apply = () => {
      const sku = productSkuFromHash();
      if (!sku || handledShareHash.current === sku) return;

      // Nothing has loaded yet; stay unhandled so the next render retries.
      if (browseProducts.length === 0 && products.length === 0) return;

      const match =
        browseProducts.find((p) => p.sku === sku) || products.find((p) => p.sku === sku);

      handledShareHash.current = sku;

      if (!match) {
        toast.warning(t('toast.itemGone'));
        return;
      }
      handleOpenProductDetail(match);
    };

    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, [browseProducts, products, handleOpenProductDetail, toast, t]);

  const totalCartCount = cartItemCount(cartItems);
  const pendingOrdersCount = orders.filter((o) => o.status === 'Pending').length;

  const activeCartItems = shoppingMode === 'scheduled' ? scheduledCartItems : cartItems;

  if (showSplash) {
    /*
      Which piece of the lockup the launch screen should hand over instead of
      fading out. The login screen carries the same wordmark and the shop's
      header badge carries the same droplet, so in both cases cutting would
      redraw a mark the user is already looking at.

      It has to name the screen that is actually next, because each of those
      exits ends on one bare element and only the screen expecting it has
      anywhere to put it. Three things decide that. A session still being
      restored may yet resolve either way, so it hands over nothing — the splash
      holds long enough that this has almost always settled by the time it is
      read. A signed-in user on the login tab is about to be moved to the shop
      (see the effect above), so the tab that matters is where they will land,
      not where they are. And the header only renders on three of the tabs; the
      others have no badge to catch anything.
    */
    const landingTab =
      user && (activeTab === 'login' || activeTab === 'signup') ? 'home' : activeTab;

    const handoff = isRestoringSession
      ? undefined
      : !user && (landingTab === 'login' || landingTab === 'signup')
        ? 'login'
        : HEADER_TABS.includes(landingTab)
          ? 'home'
          : undefined;

    return <SplashScreen onComplete={() => setShowSplash(false)} handoff={handoff} />;
  }

  // One screen for both. Signing in with a number that has no account creates
  // one, so there is no separate sign-up page to route to.
  if ((activeTab === 'login' || activeTab === 'signup') && !user) {
    return <LoginPage onLogin={handleLogin} />;
  }

  return (
    /* pb reserves room for the fixed bottom nav, so it has to grow by the same
       home-indicator inset the nav itself now adds — otherwise the last row of
       content sits behind it on a gesture-bar phone. */
    <div className="max-w-md mx-auto min-h-screen bg-gray-50 flex flex-col justify-between pb-[calc(4rem+env(safe-area-inset-bottom,0px))] relative shadow-xl border-x border-gray-200/60">
      
      {/* FLY TO CART ITEM ANIMATION OVERLAY */}
      <FlyToCartOverlay
        flyingItems={flyingItems}
        onAnimationEnd={handleFlyingItemEnd}
      />
      
      {/* VIEW ROUTING DECISION */}
      {activeProductDetail ? (
        <ProductDetailView
          /* Remount on a different product. Tapping a related item swaps the
             prop without unmounting, and the weight variant and liked flag are
             component state — without this they carry over from the product
             that was just left. */
          key={activeProductDetail.product.originalId ?? activeProductDetail.product.id}
          product={activeProductDetail.product}
          category={activeProductDetail.category}
          cartItems={activeCartItems}
          onAddToCart={handleAddToCart}
          onUpdateQuantity={handleUpdateQuantity}
          onBack={() => setActiveProductDetail(null)}
          products={products}
          categories={categories}
          onSelectProduct={handleOpenProductDetail}
          onOpenCategory={handleOpenCategoryFromSearch}
          onShared={(result) =>
            result === 'copied'
              ? toast.success(t('toast.linkCopied'))
              : toast.error(t('toast.shareFailed'))
          }
        />
      ) : activeCategoryDetail ? (
        <CategoryDetailView
          category={activeCategoryDetail}
          // The chosen market's sheet, so drilling into a category shows the
          // same prices the home carousels just showed.
          products={browseProducts}
          cartItems={activeCartItems}
          onAddToCart={handleAddToCart}
          onUpdateQuantity={handleUpdateQuantity}
          onBack={() => setActiveCategoryDetail(null)}
          onSelectProduct={handleOpenProductDetail}
        />
      ) : searchQuery ? (
        /* Sits above the tab switch, so a search is reachable from any tab and
           backing out of it returns to the tab that was open underneath. */
        <SearchResultsView
          query={searchVal}
          onQueryChange={(value) => {
            setSearchVal(value);
            setSearchQuery(value);
          }}
          // The chosen market's sheet, not the platform catalog: otherwise a
          // search would quote one price and the home screen another for the
          // same tomato, and could offer something this market does not sell.
          products={browseProducts}
          categories={categories}
          cartItems={activeCartItems}
          onAddToCart={handleAddToCart}
          onUpdateQuantity={handleUpdateQuantity}
          onSelectProduct={handleOpenProductDetail}
          onBack={handleClearSearch}
        />
      ) : (
        <>
          {/* 1. TOP HEADER BAR */}
          {HEADER_TABS.includes(activeTab) && (
            <Header
              searchVal={searchVal}
              setSearchVal={setSearchVal}
              walletBalance={walletBalance}
              cartCount={totalCartCount}
              onOpenWallet={() => setIsWalletOpen(true)}
              onOpenAccount={() => setActiveTab('account')}
              user={user}
              onOpenAuthModal={() => setActiveTab('login')}
              // Suggestions come from what this market actually sells, for the
              // same reason as the results screen above.
              products={browseProducts}
              categories={categories}
              onSubmitSearch={handleSubmitSearch}
              onOpenCategory={handleOpenCategoryFromSearch}
              onSelectProduct={handleOpenProductFromSearch}
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
                      onAddressChange={() => setAddressVersion((v) => v + 1)}
                    />

                    {/*
                      Why we want location, before the browser asks. Renders
                      nothing once answered, or if permission is already settled
                      either way.
                    */}
                    <LocationPrimer onLocated={setCustomerCoords} />

                    {/*
                      Which market am I buying from — above the categories,
                      because it decides what every price below it says.

                      Keyed on the coordinates so it reloads once the primer
                      resolves; without that a first-time visitor who has just
                      granted location keeps the "set your address" card until
                      they reload.
                    */}
                    <MarketPicker
                      key={customerCoords ? `${customerCoords.lat},${customerCoords.lng}` : 'no-coords'}
                      selectedMarket={selectedMarket}
                      onSelectMarket={handleSelectMarket}
                    />

                    {/* And the shops that are nobody's stall. */}
                    <NearbyShops
                      coords={customerCoords}
                      selectedShop={selectedShop}
                      onSelectShop={handleSelectShop}
                    />

                    {/* 3. DYNAMIC 2-COLUMN CATEGORIES SECTION */}
                    <Categories
                      categories={homeGridCategories}
                      onSelectCategory={(cat) => setActiveCategoryDetail(cat)}
                    />

                    {/*
                      4. HORIZONTAL PRODUCT CAROUSELS PER CATEGORY

                      `browseProducts`, not `products` — this is a browse
                      surface, so it has to show whoever is being bought from.
                      Left on the raw catalog it offered items the selected
                      seller does not stock, which for a shop is not merely
                      cosmetic: the server rejects a basket that mixes sellers,
                      so the customer would only find out at checkout.
                    */}
                    <ProductList
                      categories={categories}
                      products={browseProducts}
                      cartItems={activeCartItems}
                      onAddToCart={handleAddToCart}
                      onUpdateQuantity={handleUpdateQuantity}
                      onOpenCategoryDetail={(cat) => setActiveCategoryDetail(cat)}
                      onSelectProduct={handleOpenProductDetail}
                    />
                  </>
                )
              ) : activeTab === 'prices' ? (
                /* Scoped to the chosen market: prices are set per market, so a
                   trend drawn across the platform catalog would not correspond
                   to anything a shopper can actually buy at. `browseProducts`
                   is that market's sheet when one is chosen. */
                <PriceHistory
                  products={browseProducts}
                  categories={categories}
                  market={selectedMarket}
                />
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
                  onCancelOrder={handleCancelOrder}
                  onAcceptPartial={handleAcceptPartial}
                  onRetryPartial={handleRetryPartial}
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
                  {/* Reads its own data now, scoped to the markets this account
                      owns. The products/orders/categories it used to take were
                      the whole customer-side state, which is a different market
                      entirely once there is more than one.

                      `onExit` is not decoration: this tab hides the header AND
                      the bottom navigation, so until the panel offered its own
                      way out, opening it left no route back to the app short of
                      reloading the page. */}
                  <MarketOwnerPanel onExit={() => setActiveTab('account')} />
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
                            {activeAccountView === 'profile'
                              ? t('account.profileDetails')
                              : activeAccountView === 'rewards'
                                ? t('rewards.title')
                                : t('account.purchaseHistory')}
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
                              <h3 className="font-extrabold text-slate-800 text-sm tracking-tight">{t('account.profileDetails')}</h3>
                              <p className="text-[10px] font-bold text-slate-400 mt-0.5">{t('account.profileDetailsSub')}</p>
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
                              <h3 className="font-extrabold text-slate-800 text-sm tracking-tight">{t('account.purchaseHistory')}</h3>
                              <p className="text-[10px] font-bold text-slate-400 mt-0.5">{t('account.purchaseHistorySub')}</p>
                            </div>
                            <div className="w-8 h-8 rounded-full bg-slate-50 flex items-center justify-center group-hover:bg-[#1B4D3E] group-hover:text-white transition-colors">
                              <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-white transition-colors" />
                            </div>
                          </button>

                          <button
                            onClick={() => setActiveAccountView('rewards')}
                            className="p-4 bg-white/90 backdrop-blur-sm rounded-2xl flex items-center gap-4 shadow-sm border border-white/50 active:scale-95 transition-all cursor-pointer group"
                          >
                            <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-amber-50 to-orange-50 text-amber-600 flex items-center justify-center group-hover:scale-110 transition-transform shadow-[inset_1px_1px_2px_rgba(255,255,255,1),2px_2px_4px_rgba(217,119,6,0.12)]">
                              <CoinsIcon className="w-5 h-5 drop-shadow-sm" />
                            </div>
                            <div className="flex-1">
                              <h3 className="font-extrabold text-slate-800 text-sm tracking-tight">{t('rewards.title')}</h3>
                              <p className="text-[10px] font-bold text-slate-400 mt-0.5">
                                {t('account.rewardsSub', { tokens: TOKENS_PER_BATCH, rupees: RUPEES_PER_BATCH })}
                              </p>
                            </div>
                            <div className="w-8 h-8 rounded-full bg-slate-50 flex items-center justify-center group-hover:bg-[#1B4D3E] group-hover:text-white transition-colors">
                              <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-white transition-colors" />
                            </div>
                          </button>
                        </div>
                      ) : activeAccountView === 'history' ? (
                        <AccountHistory user={user} orders={orders} />
                      ) : activeAccountView === 'rewards' ? (
                        <AccountRewards user={user} orders={orders} />
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
                            </span> {t('account.editProfile')}
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
                              {/* Optional: signing up needs only a phone number,
                                  so most accounts have no email at all. Marking
                                  this required made the form unsubmittable for
                                  every one of them. */}
                              <input
                                type="email"
                                value={editEmail}
                                onChange={(e) => setEditEmail(e.target.value)}
                                placeholder="Optional"
                                className="w-full bg-slate-100/50 border-0 rounded-2xl px-4 py-2.5 font-bold text-slate-800 focus:outline-none focus:ring-0 shadow-[inset_4px_4px_8px_rgba(166,180,200,0.4),inset_-4px_-4px_8px_rgba(255,255,255,0.9)] transition-all"
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
                            </span> {t('account.editProfile')}
                          </button>
                        </div>
                      )}

                      {/* Moving the account to a new number. The code goes to the
                          NEW number, because that is what has to be proven. */}
                      {showProfileOTP && (
                        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in">
                          <div className="bg-white rounded-3xl w-full max-w-sm p-5 shadow-2xl border border-gray-100 relative overflow-hidden space-y-3.5 text-left text-xs animate-scale-in max-h-[90vh] overflow-y-auto">
                            <div className="flex items-center gap-3">
                              <div className="w-10 h-10 rounded-xl bg-amber-100 text-amber-900 flex items-center justify-center font-bold text-lg border border-amber-200">
                                {profileChallenge?.kind === 'email' ? '✉️' : '🔐'}
                              </div>
                              <div>
                                <h4 className="font-extrabold text-gray-900 text-sm">
                                  {profileChallenge?.kind === 'email' ? 'Verify New Email' : 'Verify New Number'}
                                </h4>
                                <p className="text-[10px] text-amber-700 font-semibold">
                                  {profileChallenge?.kind === 'email'
                                    ? 'Login codes will be copied here.'
                                    : 'This is your sign-in credential.'}
                                </p>
                              </div>
                            </div>

                            <form onSubmit={handleVerifyProfileOTP} className="space-y-3">
                              <div className="bg-blue-50/80 p-2.5 rounded-xl border border-blue-100 text-[10px] text-blue-900 font-semibold leading-relaxed">
                                {profileChallenge?.kind === 'email' ? (
                                  <>
                                    We sent a 6-digit code to{' '}
                                    <span className="font-extrabold">{profileChallenge?.destination || editEmail}</span>.
                                    Enter it to attach that address. Sign-in codes will then arrive
                                    there as well as on WhatsApp, so keep the mailbox secure.
                                    {pendingPhoneChange && ' Your new number is confirmed after this.'}
                                  </>
                                ) : (
                                  <>
                                    We sent a 6-digit code on WhatsApp to{' '}
                                    <span className="font-extrabold">{profileChallenge?.destination || editPhone}</span>.
                                    Enter it to move your account to that number — every other
                                    device will be signed out.
                                  </>
                                )}
                              </div>

                              {profileReverse && profileChallenge?.kind === 'phone' ? (
                                <div className="border-t border-gray-100 pt-3">
                                  <ReverseOtpPanel
                                    phone={profileChallenge.rawPhone}
                                    purpose="phone_change"
                                    onVerified={({ user: updated }) => {
                                      setUser(updated);
                                      setRegisteredUsers((prev) =>
                                        prev.map((u) => (u.id === updated.id ? updated : u))
                                      );
                                      setIsEditingProfile(false);
                                      setShowProfileOTP(false);
                                      setProfileChallenge(null);
                                      setProfileReverse(false);
                                      toast.success(t('toast.phoneUpdated'));
                                    }}
                                  />
                                </div>
                              ) : (
                                <div className="space-y-2 border-t border-gray-100 pt-3">
                                  <label className="block font-bold text-gray-700 mb-2 text-[10px] uppercase tracking-wider text-center">
                                    {profileChallenge?.kind === 'email' ? 'Email OTP' : 'WhatsApp OTP'}
                                  </label>
                                  <OTPBoxGroup value={profileMobileOTP} onChange={setProfileMobileOTP} />
                                </div>
                              )}

                              {profileOtpError && <p className="text-[10px] font-bold text-rose-600">{profileOtpError}</p>}

                              {/* Offered only for the number leg — an email address
                                  has nothing to send a message from. */}
                              {profileChallenge?.kind === 'phone' && profileChallenge?.rawPhone && (
                                <button
                                  type="button"
                                  onClick={() => { setProfileOtpError(''); setProfileReverse((on) => !on); }}
                                  className="w-full text-[10px] font-bold text-[#1B4D3E] underline underline-offset-4 hover:text-[#143B2B]"
                                >
                                  {profileReverse
                                    ? 'Type a code instead'
                                    : "Didn't get a code? Send us one instead"}
                                </button>
                              )}

                              <div className="flex gap-2 pt-3 border-t border-gray-100">
                                <button
                                  type="button"
                                  onClick={() => { setShowProfileOTP(false); setProfileChallenge(null); setPendingPhoneChange(null); setProfileReverse(false); }}
                                  className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold py-2 rounded-xl text-center cursor-pointer transition-colors active:scale-95"
                                >
                                  Cancel
                                </button>
                                {!profileReverse && (
                                  <button
                                    type="submit"
                                    className="flex-[2] bg-[#1B4D3E] hover:bg-[#143B2B] text-white font-extrabold py-2 rounded-xl text-center cursor-pointer transition-colors active:scale-95 shadow-sm"
                                  >
                                    Verify &amp; Update
                                  </button>
                                )}
                              </div>
                            </form>
                          </div>
                        </div>
                      )}
                      
                      {/* Deleting the account lives here and nowhere else.
                          Hidden while the edit form is open: that form's own
                          Save/Cancel pair is what the eye is on, and a
                          destructive button directly beneath it is the one
                          most likely to be hit by mistake. */}
                      {!isEditingProfile && (
                        <div className="mt-4 sm:mt-6 pt-4 border-t border-rose-200/60 text-left relative z-10">
                          <h4 className="font-black text-rose-700 text-[11px] uppercase tracking-wider mb-1.5">
                            Danger Zone
                          </h4>
                          <p className="text-[10px] font-bold text-slate-400 mb-2.5 leading-relaxed">
                            Deleting your account is permanent. Your orders, wallet balance and
                            reward tokens go with it.
                          </p>
                          <button
                            onClick={handleDeleteAccount}
                            className="w-full bg-gradient-to-br from-rose-50 to-rose-100 hover:from-rose-100 hover:to-rose-200 text-rose-600 text-xs sm:text-sm font-black px-4 py-2.5 rounded-2xl transition-all border border-rose-200/50 cursor-pointer active:scale-95 shadow-[inset_1px_1px_2px_rgba(255,255,255,0.9),4px_4px_8px_rgba(225,29,72,0.15),-4px_-4px_8px_rgba(255,255,255,0.8)] active:shadow-[inset_4px_4px_8px_rgba(225,29,72,0.2),inset_-4px_-4px_8px_rgba(255,255,255,0.9)]"
                          >
                            Delete Account
                          </button>
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

                        {/* Same reasoning as Log Out below: a setting someone
                            may want from wherever they are on this tab, not
                            just from the plain profile view. */}
                        <div className="pt-2 sm:pt-3 relative z-10 max-w-sm mx-auto">
                          <LanguagePicker />
                        </div>

                        {/* Log Out stays on every account view — it is the one
                            control someone may want from wherever they are.
                            Deleting the account does NOT: it lives inside
                            Profile Details, one deliberate step away, because
                            it is irreversible and sat one mis-tap from the menu. */}
                        <div className="pt-2 sm:pt-3 flex relative z-10 max-w-sm mx-auto">
                          <button
                            onClick={handleLogout}
                            className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 text-[10px] sm:text-sm font-extrabold px-2 sm:px-4 py-2 sm:py-2.5 rounded-2xl transition-all cursor-pointer shadow-[inset_1px_1px_2px_rgba(255,255,255,0.8),4px_4px_8px_rgba(166,180,200,0.3),-4px_-4px_8px_rgba(255,255,255,0.8)] active:shadow-[inset_4px_4px_8px_rgba(166,180,200,0.4),inset_-4px_-4px_8px_rgba(255,255,255,0.9)]"
                          >
                            {t('common.signOut')}
                          </button>
                        </div>

                        {/* Deliberately quieter than Log Out and directly below
                            it. With no password this is the only way to end a
                            session someone else is holding, so it has to be
                            findable — but it signs out every device including
                            this one, which is not what most taps here mean. */}
                        <div className="pt-1.5 flex relative z-10 max-w-sm mx-auto">
                          <button
                            onClick={handleLogoutEverywhere}
                            className="flex-1 text-rose-600/80 hover:text-rose-700 text-[10px] sm:text-xs font-bold px-2 py-1.5 rounded-xl transition-colors cursor-pointer hover:bg-rose-50/60"
                          >
                            {t('account.signOutAllDevices')}
                          </button>
                        </div>
                      </div>
                  ) : (
                    <div className="py-6 space-y-4">
                      <div className="bg-emerald-100 text-[#1B4D3E] w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-2 font-bold text-2xl">
                        🔒
                      </div>
                      <h3 className="font-extrabold text-lg text-gray-900">{t('account.guestTitle')}</h3>
                      <p className="text-xs text-gray-500 max-w-xs mx-auto">{t('account.guestBody')}</p>

                      <button
                        onClick={() => setActiveTab('login')}
                        className="bg-[#1B4D3E] hover:bg-[#143B2B] text-white text-xs font-extrabold px-6 py-3 rounded-xl shadow-md transition-all active:scale-95 cursor-pointer"
                      >
                        {t('account.goToSignIn')}
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
            handleClearSearch();
            /**
             * The basket closes with the tab change.
             *
             * It sits at z-25, deliberately below this nav, so the tabs stay
             * reachable while it is open — but nothing was dismissing it, so
             * tapping Account switched the tab *underneath* and left the basket
             * covering the whole screen. Every other route reset on this line
             * exists for the same reason.
             */
            setIsCartOpen(false);
            setIsScheduledCartOpen(false);
            setActiveTab(tab);
          }}
          cartCount={totalCartCount}
          // Tapping Cart with the basket already open closes it. It is the same
          // control in the same place, and leaving it inert made it read as
          // broken now that the nav is reachable from inside the basket.
          onOpenCart={() => setIsCartOpen((open) => !open)}
          cartOpen={isCartOpen}
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
        blockedReason={checkoutBlockedReason}
      />

      {/* SCHEDULED CART MODAL */}
      <CartModal
        isOpen={isScheduledCartOpen}
        onClose={() => setIsScheduledCartOpen(false)}
        cartItems={scheduledCartItems}
        onUpdateQuantity={handleUpdateQuantity}
        onCheckout={handleScheduleCart}
        walletBalance={walletBalance}
        blockedReason={checkoutBlockedReason}
      />

    </div>
  );
}
