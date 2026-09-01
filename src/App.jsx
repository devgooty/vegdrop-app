import React, { useState, useEffect, useCallback, useMemo, useRef, Suspense, lazy } from 'react';
import Header from './components/Header';
import HomeHeroBanner, { DEFAULT_HERO_ACCENT } from './components/HomeHeroBanner';
import Categories from './components/Categories';
import ProductList from './components/ProductList';
import BottomNav from './components/BottomNav';
import WalletModal from './components/WalletModal';
import NotepadModal from './components/NotepadModal';
import CartModal from './components/CartModal';
import CategoryDetailView from './components/CategoryDetailView';
import SearchResultsView from './components/SearchResultsView';
import SearchDiscovery from './components/SearchDiscovery';
import ProductDetailView from './components/ProductDetailView';
import CustomerOrders from './components/CustomerOrders';
import LoginPage from './components/LoginPage';
import FlyToCartOverlay from './components/FlyToCartOverlay';
import SplashScreen from './components/SplashScreen';
import PriceHistory from './components/PriceHistory';
import AccountHistory from './components/AccountHistory';
import AccountRewards from './components/AccountRewards';
import AccountAddress from './components/AccountAddress';
import AccountWishlist from './components/AccountWishlist';
import AccountPermissions from './components/AccountPermissions';
import ProfileAvatar from './components/ProfileAvatar';
import AvatarPicker from './components/AvatarPicker';
import PageTransition from './components/PageTransition';
import OTPBoxGroup from './components/OTPBoxGroup';
import ReverseOtpPanel from './components/ReverseOtpPanel';
import MarketPicker from './components/MarketPicker';
import NearbyShops from './components/NearbyShops';
import LocationPrimer from './components/LocationPrimer';
import LanguagePicker from './components/LanguagePicker';
import { useLanguage } from './i18n/LanguageContext';
import { LANGUAGES } from './i18n/translations';
import { productName, dateLocale } from './i18n/catalog';
import { fetchMarketCatalog, savedCustomerCoords } from './services/markets';
import { rememberSearch } from './services/search';
import { fetchShopsForBasket, linesForShop } from './services/shops';
import { savedCustomerAddress } from './services/address';
import { productSkuFromHash } from './services/share';
import { mergeCartLines, cartItemCount } from './services/cart';
import { unitsOf } from './services/packs';
import { createSchedule, fetchSchedules, recurrenceFromDates, describeRecurrence } from './services/schedules';
import { HomeSkeleton } from './components/LoadingSkeleton';
import { useToast } from './components/Toast';
import { ChevronRight, ArrowLeft, User as UserIcon, History as HistoryIcon, Coins as CoinsIcon, Languages as LanguagesIcon, MapPin as MapPinIcon, Heart as HeartIcon, Settings as SettingsIcon, Wallet as WalletIcon, ClipboardList as ClipboardListIcon, Camera as CameraIcon } from 'lucide-react';
import {
  logout,
  logoutEverywhere,
  startPhoneChange,
  verifyPhoneChange,
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
import { fetchUsers, updateUser, updateUserRole, deleteUser, fetchUserAvatar, setUserAvatar, clearUserAvatar } from './services/users';
import { ApiRequestError, NetworkError } from './services/apiClient';
import { RUPEES_PER_BATCH, TOKENS_PER_BATCH } from './services/rewards';

/**
 * Admin panels are code-split: only `developer` and `market_owner` sessions ever
 * render them, so shipping them to every customer is dead weight in the initial
 * download. ShopkeeperPanel and DeliveryPanel were also imported here but never
 * rendered — they live in their own hash-routed apps — so they are gone
 * entirely, which also removes Leaflet from the customer bundle.
 */

const MarketOwnerPanel = lazy(() => import('./components/MarketOwnerPanel'));

/**
 * The tabs that render the header — the delivery-location bar, search box and
 * wallet button.
 *
 * Account and Prices are both deliberately excluded, for the same reason:
 * neither screen is something a shopper searches the catalog, opens the
 * wallet, or picks a delivery address from. Prices carries its own "Search
 * items…" box scoped to the chosen market, so the header's box would have
 * been a second, redundant one above it.
 */
const HEADER_TABS = ['home'];

/**
 * What a cart line IS, independent of who is selling it.
 *
 * Three ids can name the same thing. A shop's listing is its own row and points
 * at the shared catalog item through `catalogItem`; a weight variant's `id` is a
 * synthetic `<catalogId>-500g` key with the real id on `originalId`; a plain
 * catalog row is simply itself. Resolving them here means "the same item" has
 * one definition rather than one per call site — the basket sent for coverage,
 * the line matched when re-pricing, and the line merged when adding all have to
 * agree, and they only do if they ask the same question.
 */
function catalogKeyOf(item) {
  return String(item.catalogItem || item.originalId || item.id);
}

/**
 * What a basket ROW is, which is not the same question.
 *
 * `catalogKeyOf` answers "which item is this", and that is right for coverage
 * and for checkout, where two rows of the same spinach are the same produce.
 * It is wrong for the basket itself: 500g and 1kg of that spinach are two rows,
 * and matching on the catalog id alone folded the second into the first —
 * a shopper picking 1kg after 250g got a second 250g and no warning.
 *
 * Size is therefore part of the row's identity, and the three places that
 * decide whether two lines are the same one — this, `mergeCartLines` and
 * `handleUpdateQuantity` — all key on it.
 */
function cartLineKeyOf(item) {
  const units = unitsOf(item);
  return units > 1 ? `${catalogKeyOf(item)}::x${units}` : catalogKeyOf(item);
}

/**
 * The name each account sub-view carries in the nav bar. A map rather than a
 * ternary that grows a branch per destination — adding one is now a row in the
 * menu and a line here.
 */
const ACCOUNT_VIEW_TITLES = {
  profile: 'account.profileDetails',
  history: 'account.purchaseHistory',
  rewards: 'rewards.title',
  wishlist: 'account.wishlist',
  address: 'account.savedAddress',
  language: 'settings.language',
  permissions: 'permissions.title',
};

/**
 * The heading that marks off one group of account settings.
 *
 * The small-caps treatment is English-only, the same rule and for the same
 * reason as the launch screen's strapline: Telugu and Devanagari have no
 * capital forms, so `uppercase` buys nothing, while wide tracking pulls their
 * conjuncts apart. They also carry vowel marks above and below the line that
 * 10px throws away, hence the extra pixel.
 */
function accountSectionLabel(language) {
  return language === 'en'
    ? 'px-1 mb-2 text-[11.5px] font-black uppercase tracking-wider'
    : 'px-1 mb-2 text-[12.5px] font-black tracking-normal';
}

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
  /**
   * Whether the search field has been tapped but nothing searched yet.
   *
   * A third state alongside the two above, and it earns its place: `searchVal`
   * empty and `searchQuery` empty used to be indistinguishable from "not
   * searching at all", so tapping the box put a keyboard over the home screen
   * and offered nothing. This is the window `SearchDiscovery` fills.
   */
  const [searchDiscoveryOpen, setSearchDiscoveryOpen] = useState(false);
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
  const [isAvatarPickerOpen, setIsAvatarPickerOpen] = useState(false);
  /**
   * The uploaded profile photo, as a data URI.
   *
   * Fetched separately because the session payload carries only a pointer to it
   * — see `toPublicJSON` in server/models/User.js for why the bytes are not on
   * the user record. Null covers both "never uploaded one" and "not fetched
   * yet"; ProfileAvatar falls through to the preset or the initial either way,
   * so there is no loading state to render.
   */
  const [avatarPhoto, setAvatarPhoto] = useState(null);
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
  const [isNotepadOpen, setIsNotepadOpen] = useState(false);

  /**
   * The colour the home hero is currently painting the top of the screen.
   *
   * Held here rather than in the hero because the header is its sibling, not
   * its child — the shell below publishes it as a CSS variable and the frosted
   * header picks it up by inheritance, so neither component has to know the
   * other exists.
   */
  const [heroAccent, setHeroAccent] = useState(DEFAULT_HERO_ACCENT);

  // Delivery Notifications: fired when shopkeeper accepts an order
  const [deliveryNotifications, setDeliveryNotifications] = useState([]);

  /**
   * A session that belongs to another app goes to that app. Any tab, always.
   *
   * Two bugs have lived here, and the second was created by the fix for the
   * first. It originally ran on `[]` — exactly once, while the session was
   * still restoring and `user` was necessarily null — so the body never
   * executed at all. Watching `user` fixed that, but the rewrite kept an
   * `activeTab === 'login' || 'signup'` guard over the whole effect, which
   * quietly narrowed the redirect to "just after signing in".
   *
   * It is reachable from any tab, because the three apps share one origin and
   * therefore one refresh cookie (`path=/api/auth`): a rider signed into
   * `#/delivery` who presses device back is a rider on the customer
   * storefront. `onPopState` below then sets `activeTab` from history — or to
   * `'home'` when there is no state — so by the time the restored `user`
   * arrives, `activeTab` is no longer `'login'` and the guard swallowed the
   * redirect. The rider stayed on the storefront holding a session that cannot
   * shop, and the Account tab helpfully offered them a link back.
   *
   * So the redirect watches only `user`. The tab selection below still needs
   * the guard — it is a post-sign-in choice, and running it on every change of
   * `user` would yank someone off whatever tab they were reading.
   */
  useEffect(() => {
    if (!user) return;

    if (user.role === 'shopkeeper') {
      window.location.hash = '#/shopkeeper';
      return;
    }
    if (user.role === 'delivery') {
      window.location.hash = '#/delivery';
    }
  }, [user]);

  useEffect(() => {
    if (!user || (activeTab !== 'login' && activeTab !== 'signup')) return;
    // Those two are leaving for another app entirely; picking a tab for them
    // here would fight the redirect above for one render.
    if (user.role === 'shopkeeper' || user.role === 'delivery') return;

    setActiveTab(user.role && user.role !== 'customer' ? user.role : 'home');
  }, [user, activeTab, setActiveTab]);

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

    const schedulePacks = new Map();
    for (const item of scheduledCartItems) {
      const productId = item.originalId || item.id;
      schedulePacks.set(productId, (schedulePacks.get(productId) || 0) + item.quantity * unitsOf(item));
    }
    const scheduleLines = [...schedulePacks.entries()].map(([productId, quantity]) => ({
      productId,
      quantity,
    }));

    try {
      const created = await createSchedule({
        /**
         * The SAME translation the one-off checkout does, for the same two
         * reasons — this call site was simply missed when it was written.
         *
         * `item.id` is a pack-variant key (`<catalogId>-x4`) whenever a size
         * above the base pack was picked, and `fields.objectId` refuses it, so
         * the whole request came back 400 and the customer got a bare "The
         * submitted data is not valid." Because zod validates the array as a
         * unit, one sized line also blocked every other line in the basket from
         * being scheduled.
         *
         * And `quantity` alone drops the pack multiplier, so once the id was
         * accepted a "1kg" line of a 250g pack would have recurred, and been
         * billed, as a single 250g pack — every run, forever. See
         * services/packs.mjs.
         *
         * Collapsed onto the catalog product the same way too: two sizes of one
         * product are two basket rows but one order line, and sending both
         * would ask the server to schedule the same product twice.
         */
        items: scheduleLines,
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

  /**
   * Pull the uploaded photo whenever the record says there is a newer one.
   *
   * Keyed on `photoUpdatedAt` rather than just its presence, so replacing a
   * photo re-fetches instead of leaving the previous one on screen. A failure
   * is swallowed: an avatar that will not load is a fallback to initials, not
   * something to interrupt someone with.
   */
  const avatarStamp = user?.avatar?.photoUpdatedAt || null;
  useEffect(() => {
    if (!user?.id || !avatarStamp) {
      setAvatarPhoto(null);
      return undefined;
    }

    let cancelled = false;
    fetchUserAvatar(user.id)
      .then((image) => { if (!cancelled) setAvatarPhoto(image); })
      .catch(() => { if (!cancelled) setAvatarPhoto(null); });

    return () => { cancelled = true; };
  }, [user?.id, avatarStamp]);

  /**
   * The three ways to set a picture, all adopting the user record the server
   * returns rather than assuming the write landed. Each throws on failure so
   * AvatarPicker can report it and stay open.
   */
  const applyAvatarUpdate = useCallback((updated) => {
    setUser(updated);
    setRegisteredUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
    toast.success(t('avatar.updated'));
  }, [setUser, setRegisteredUsers, toast, t]);

  const handleSelectAvatarPreset = useCallback(async (preset) => {
    applyAvatarUpdate(await setUserAvatar(user.id, { preset }));
    setAvatarPhoto(null);
  }, [user, applyAvatarUpdate]);

  const handleUploadAvatarPhoto = useCallback(async (image) => {
    const updated = await setUserAvatar(user.id, { image });
    // Held locally rather than waiting on the fetch the new timestamp triggers —
    // these are the same bytes, and they are already here. Set only after the
    // write succeeds, so a refused upload never appears to have worked.
    setAvatarPhoto(image);
    applyAvatarUpdate(updated);
  }, [user, applyAvatarUpdate]);

  const handleClearAvatar = useCallback(async () => {
    applyAvatarUpdate(await clearUserAvatar(user.id));
    setAvatarPhoto(null);
  }, [user, applyAvatarUpdate]);

  const handleStartEditingProfile = useCallback(() => {
    if (!user) return;
    setEditName(user.name);
    setEditEmail(user.email || '');
    /**
     * Falls back to `pendingPhone`.
     *
     * An account registered while WhatsApp was down has its number there and
     * not in `phone` — unproven, but it is still the number the person typed
     * and expects to see. Reading only `phone` showed them an empty box and no
     * explanation.
     */
    setEditPhone(user.phone || user.pendingPhone || '');
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
   * `email` goes in the PATCH again, alongside `name`. `phone` still does not.
   *
   * The address spent a while behind its own verify flow, because a login code
   * was copied to it: any address a session could set was a way in. Codes no
   * longer go to a mailbox, so an address grants nothing and is an ordinary
   * profile field. The number is still the credential, so it still takes the
   * proved route.
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
    const phoneChanged = phone !== (user.phone || user.pendingPhone || '');

    try {
      /**
       * Name and email in one PATCH, first, so they land even if the number
       * change is abandoned at the code step.
       *
       * An address can be cleared here too — sending an empty one removes it.
       * Nothing depends on an address being present except stall notices, which
       * simply do not get sent.
       */
      const patch = {};
      if (name !== user.name) patch.name = name;
      if (emailChanged) patch.email = email;

      if (Object.keys(patch).length > 0) {
        const updated = await updateUser(user.id, patch);
        setUser(updated);
        setRegisteredUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
      }

      if (phoneChanged) {
        try {
          const issued = await startPhoneChange({ phone });
          setProfileChallenge({ kind: 'phone', rawPhone: phone, ...issued });
          setProfileReverse(false);
        } catch (err) {
          // Reverse OTP is the recovery path when nothing can be delivered.
          // Gating the panel on a successful send made that failure a dead end.
          if (err instanceof ApiRequestError && err.code === 'OTP_DELIVERY_FAILED') {
            setProfileChallenge({ kind: 'phone', rawPhone: phone, destination: phone });
            setProfileReverse(true);
          } else {
            toast.error(err.message || t('toast.profileUpdateFailed'));
            return;
          }
        }
        setPendingPhoneChange(null);
        setProfileMobileOTP('');
        setProfileOtpError('');
        setShowProfileOTP(true);
        return;
      }

      setIsEditingProfile(false);
      if (Object.keys(patch).length > 0) toast.success(t('toast.profileUpdated'));
    } catch (err) {
      // No EMAIL_NOT_CONFIGURED branch: nothing is delivered to an address, so
      // saving one cannot depend on a mail server being reachable.
      toast.error(err.message || t('toast.profileUpdateFailed'));
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

    // Only ever a phone now. The email leg was removed with the flow that
    // delivered codes to an address.
    const code = profileMobileOTP.trim();

    try {
      // The server is the only writer; adopt exactly what it returns rather
      // than optimistically assuming the edit applied.
      const updated = await verifyPhoneChange({ challengeId: profileChallenge.challengeId, code });

      setUser(updated);
      setRegisteredUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
    } catch (err) {
      setProfileOtpError(err.message || 'Could not verify that code.');
      return;
    }

    setIsEditingProfile(false);
    setShowProfileOTP(false);
    setProfileChallenge(null);
    setPendingPhoneChange(null);
    toast.success(t('toast.phoneUpdated'));
  }, [profileChallenge, profileMobileOTP, setUser, setRegisteredUsers, toast, t]);

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

    rememberSearch(trimmed);
    setActiveProductDetail(null);
    setActiveCategoryDetail(null);
    setSearchDiscoveryOpen(false);
    // Results read `searchVal`, not `searchQuery`. A chip used to set only the
    // latter, so the results screen opened on an empty box — "Results for ' '"
    // and zero items.
    setSearchVal(trimmed);
    setSearchQuery(trimmed);
    window.scrollTo({ top: 0 });
  }, []);

  /** Leave the results screen, and take the query out of the box with it. */
  const handleClearSearch = useCallback(() => {
    setSearchQuery('');
    setSearchVal('');
    setSearchDiscoveryOpen(false);
  }, []);

  /**
   * Search used to paint an overlay inside `main`. Home is as tall as the
   * whole catalogue, so that overlay became a cream sheet the height of the
   * page — scrolling (or the keyboard pushing the focused box into view)
   * walked the sticky header and the rails right off the screen, which is the
   * blank page with only the tab bar left.
   *
   * Locking the document and the shell to the viewport while search is open
   * keeps the header pinned and lets only the discovery body scroll.
   */
  /**
   * Only while the discovery overlay itself is on screen. Opening a product
   * (or a category) from a rail used to leave this true, so the shell stayed
   * `h-dvh overflow-hidden` and the detail page could not scroll — the image
   * sat under the header and the rest of the page was trapped.
   */
  const searchScreenOpen =
    searchDiscoveryOpen && !searchQuery && !activeProductDetail && !activeCategoryDetail;

  useEffect(() => {
    if (!searchScreenOpen) return undefined;
    const { body, documentElement } = document;
    const previousBody = body.style.overflow;
    const previousHtml = documentElement.style.overflow;
    body.style.overflow = 'hidden';
    documentElement.style.overflow = 'hidden';
    return () => {
      body.style.overflow = previousBody;
      documentElement.style.overflow = previousHtml;
    };
  }, [searchScreenOpen]);

  /** A suggestion naming a whole section opens that section instead. */
  const handleOpenCategoryFromSearch = useCallback((category) => {
    setSearchQuery('');
    setSearchVal('');
    setSearchDiscoveryOpen(false);
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
      const changed = current?.id !== shop.id || Boolean(market);

      /**
       * A basket this shop can fill MOVES with the customer instead of being
       * thrown away.
       *
       * Emptying it was right while a basket named one seller's product rows and
       * meant nothing at any other. It no longer does: the basket is held as
       * shared-catalog items and translated to the seller's own rows at
       * checkout. Clearing it here would also make the whole point of ranking
       * shops by coverage self-defeating — picking the shop that has everything
       * would discard the basket that ranking was computed from.
       *
       * The price objection in `switchSeller` still stands and is answered
       * rather than ignored: each line is re-priced from what THIS shop charges,
       * so the basket shows the shop's prices from the moment it is chosen and
       * checkout charges the same. Showing one number and charging another is
       * the thing being avoided, not the carrying-over itself.
       */
      const canCarry = Boolean(shop.canFillBasket && shop.lines?.length);
      if (changed && canCarry) {
        const priceByItem = new Map(shop.lines.map((line) => [String(line.catalogItemId), line.price]));
        setCartItems((prev) =>
          prev.map((item) => {
            // Per PACK, so a line holding four of them costs four times it —
            // the same multiplication checkout will do against this shop's own
            // price sheet.
            const packPrice = priceByItem.get(catalogKeyOf(item));
            return packPrice === undefined ? item : { ...item, price: packPrice * unitsOf(item) };
          })
        );
      }

      // Still emptied when the basket genuinely cannot move — a shop that
      // cannot supply every line cannot be given the order at all.
      switchSeller(changed && !canCarry, t('toast.switchedShop', { shop: shop.name }));

      setSelectedShop(shop);
      setSelectedMarket(null);
      setMarketProducts([]);
    },
    [switchSeller, setCartItems, t]
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
    const setTargetCart = isScheduled ? setScheduledCartItems : setCartItems;

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
      /**
       * Matched on what the item IS, not on which row was tapped.
       *
       * A basket now survives being carried to a shop, so the same item can be
       * reached through two different rows in one session: the catalog row it
       * was added from, and that shop's own listing of it. Comparing raw ids put
       * both in the basket as separate lines at two different prices.
       */
      const key = cartLineKeyOf(product);
      const existing = prev.find((item) => cartLineKeyOf(item) === key);

      if (existing) {
        return prev.map((item) =>
          cartLineKeyOf(item) === key ? { ...item, quantity: item.quantity + 1 } : item
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
        /**
         * And the catalog link, for the third time in this object and the same
         * reason as the two above: a fixed field list drops anything not named
         * here.
         *
         * This is what makes the line mean something outside the shop it came
         * from. A shop's listings are its own rows, so asking "which other shop
         * stocks this" needs the shared-catalog item it is an instance of.
         * Null on a platform catalog row, which already IS that item.
         */
        catalogItem: product.catalogItem || null,
        /**
         * And the pack multiplier, for the fourth time in this object and the
         * same reason as the three above.
         *
         * This is what the order is actually placed in. The card prices a size
         * as a whole number of the seller's packs; without carrying that number
         * the basket showed "1kg — ₹140" and checkout ordered one 250g pack at
         * ₹35. See services/packs.js.
         */
        units: unitsOf(product),
        price: product.price,
        quantity: 1,
        image: product.image,
      }];
    });

    /**
     * No confirmation toast here, deliberately.
     *
     * Adding to the basket already announces itself twice — the item flies into
     * the cart and the cart badge bumps — so a banner over the top of the grid
     * only covered the next thing the shopper was reaching for. Removed at the
     * owner's request; the animation and the badge are the feedback.
     */
    /**
     * `cartItems` and `scheduledCartItems` are deliberately NOT dependencies any
     * more. Nothing here reads the basket at render time — the line lookup
     * happens inside the updater against `prev`, which is the only view that
     * reflects taps already queued ahead of this one. `toast`/`t`/`language`
     * stay because the sold-out warning above still uses them.
     */
  }, [shoppingMode, setCartItems, setScheduledCartItems, toast, t, language]);

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

    /**
     * Collapse sizes back onto their catalog product, in PACKS.
     *
     * `units` is the multiplier the card priced the size with, so a "1kg" line
     * of a 250g pack orders four of them. Dropping it — which is what this did
     * — posted one pack, and the server priced one pack: the basket said ₹140
     * and the order was billed ₹35, with the stall told to pack a quarter of
     * what was asked for.
     */
    const quantities = new Map();
    for (const item of cartItems) {
      const productId = item.originalId || item.id;
      const packs = item.quantity * unitsOf(item);
      quantities.set(productId, (quantities.get(productId) || 0) + packs);
    }

    let items = [...quantities.entries()].map(([productId, quantity]) => ({ productId, quantity }));

    // Coordinates let the server hop to the next nearest market if this one's
    // stalls cannot fill the order. Without them it falls back to searching
    // outward from the market itself, which still works.
    const coords = customerCoords || savedCustomerCoords();

    /**
     * Ordering from a shop means ordering THAT SHOP'S rows.
     *
     * Every line of a shop order must belong to the shop, and each shop keeps
     * its own product documents — so the catalog ids collected above name
     * nothing this shop sells. The mapping is re-fetched here rather than reused
     * from the shop card, because the basket can have changed since it was
     * chosen and a stale mapping would post an order missing whatever was added
     * after. It costs one request at the one moment correctness matters most.
     *
     * Failing here is a real answer, not an inconvenience: the alternative is a
     * MIXED_SELLERS rejection from checkout, which tells the customer nothing
     * they can act on.
     */
    if (selectedShop) {
      /**
       * No coordinates means the translation cannot be done at all — the
       * coverage endpoint is the only thing that knows this shop's own product
       * ids, and it is answered from a point.
       *
       * This used to read `if (selectedShop && coords)`, so a missing location
       * skipped the whole block and posted CATALOG ids against a shop id. Every
       * line then belongs to someone else and checkout answers MIXED_SELLERS —
       * a message about mixing sellers, for a basket the customer built from
       * one shop. Refusing here says the true thing instead.
       */
      if (!coords) {
        toast.error(t('toast.shopNeedsLocation'));
        return false;
      }

      try {
        const ranked = await fetchShopsForBasket({
          lat: coords.lat,
          lng: coords.lng,
          radius: 20000,
          items: catalogBasket,
        });
        const shopLines = linesForShop(ranked.find((s) => s.id === selectedShop.id));
        if (!shopLines) {
          toast.warning(t('toast.shopCannotFill', { shop: selectedShop.name }));
          return false;
        }
        items = shopLines;
      } catch {
        toast.error(t('toast.shopCheckFailed'));
        return false;
      }
    }

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

  /**
   * The basket expressed as SHARED-CATALOG items.
   *
   * The only shop-independent way to say what is in it. Every shop keeps its own
   * product rows, so a basket built while browsing one shop names ids that mean
   * nothing at any other, and "which shop stocks most of this" would be
   * unanswerable. Resolved per line: a shop listing carries the catalog item it
   * is an instance of; a platform or market row already IS that item.
   *
   * `originalId` before `id` for the same reason checkout does it — for a
   * weight-based product `id` is a variant key and the catalog id is on
   * `originalId`.
   */
  const catalogBasket = useMemo(() => {
    const lines = new Map();
    for (const item of cartItems) {
      const id = catalogKeyOf(item);
      // In packs, exactly as checkout counts them — a shop that holds one
      // 250g pack does not cover a line asking for four.
      lines.set(id, (lines.get(id) || 0) + item.quantity * unitsOf(item));
    }
    return [...lines.entries()].map(([productId, quantity]) => ({ productId, quantity }));
  }, [cartItems]);

  const sectionLabel = accountSectionLabel(language);

  // Its own native name, never a translated one, for the same reason
  // LanguagePicker lists them that way: it has to be readable by someone who
  // cannot read the language currently active.
  const currentLanguageName = (LANGUAGES.find((lang) => lang.code === language) || LANGUAGES[0]).nativeName;

  if (showSplash) {
    /*
      Which piece of the lockup the launch screen should hand over instead of
      fading out. The login screen carries the same wordmark, so cutting there
      would redraw a mark the user is already looking at.

      The droplet's own handoff (`home`, to the header's logo badge) no longer
      has anywhere to land — the header dropped that badge along with the rest
      of the logo/wordmark, replaced by the delivery-location bar — so only the
      login wordmark handoff is still reachable. A session still being restored
      may yet resolve either way, so it hands over nothing — the splash holds
      long enough that this has almost always settled by the time it is read.
    */
    const landingTab =
      user && (activeTab === 'login' || activeTab === 'signup') ? 'home' : activeTab;

    const handoff = isRestoringSession
      ? undefined
      : !user && (landingTab === 'login' || landingTab === 'signup')
        ? 'login'
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
    <div
      className={`max-w-md mx-auto bg-gray-50 flex flex-col relative shadow-xl border-x border-gray-200/60 ${
        searchScreenOpen
          ? 'h-dvh overflow-hidden justify-start'
          : 'min-h-screen justify-between pb-[calc(4rem+env(safe-area-inset-bottom,0px))]'
      }`}
      style={{ '--vd-hero-accent': heroAccent.header }}
    >
      
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
              onSearchFocus={() => setSearchDiscoveryOpen(true)}
              searchOpen={searchDiscoveryOpen}
              onCloseSearch={handleClearSearch}
              onAddressChange={() => setAddressVersion((v) => v + 1)}
              onOpenNotepad={() => setIsNotepadOpen(true)}
            />
          )}

          {/* MAIN CONTENT AREA */}
          <main className={`flex-1 relative ${searchScreenOpen ? 'min-h-0 overflow-hidden' : ''}`}>

            {/*
              The moment between tapping the search box and searching anything.
              The overlay is sized to THIS main — which is locked to the leftover
              viewport while search is open — so it scrolls under a pinned header
              instead of growing with the home catalogue underneath.
            */}
            {searchScreenOpen && (
              <div className="absolute inset-0 z-40 bg-[#FAF7F2] overflow-y-auto overscroll-contain">
                <SearchDiscovery
                  // The market's own sheet, exactly as the results screen and
                  // the home carousels use — so this cannot offer something the
                  // chosen market does not sell, at a price it does not charge.
                  products={browseProducts}
                  categories={categories}
                  cartItems={activeCartItems}
                  onAddToCart={handleAddToCart}
                  onSelectProduct={handleOpenProductFromSearch}
                  onOpenCategory={handleOpenCategoryFromSearch}
                  onSearchTerm={handleSubmitSearch}
                />
              </div>
            )}
            
            {/* SCHEDULED SHOPPING BANNER */}
            {shoppingMode === 'scheduled' && activeTab === 'home' && (
              <div className="sticky top-0 z-30 bg-[#1B4D3E] text-white p-3 flex flex-col gap-2 shadow-lg border-b border-emerald-900 animate-slide-in-right">
                <div className="flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="text-[11.5px] font-black text-emerald-300 uppercase tracking-wider">Scheduled Delivery Mode</span>
                    <span className="text-sm font-black">{scheduledCartItems.length} items selected</span>
                  </div>
                  <div className="flex gap-2">
                    <button 
                      onClick={() => setIsScheduledCartOpen(true)}
                      className="bg-emerald-700 hover:bg-emerald-600 text-white text-[11.5px] font-black px-3 py-1.5 rounded-full shadow-sm transition-all active:scale-95 flex items-center"
                    >
                      Show Cart
                    </button>
                    <button 
                      onClick={handleScheduleCart}
                      className="bg-yellow-500 hover:bg-yellow-400 text-[#1B4D3E] text-[11.5px] font-black px-3 py-1.5 rounded-full shadow-sm transition-all active:scale-95 flex items-center"
                    >
                      Place Order
                    </button>
                    <button 
                      onClick={() => {
                        setActiveTab('orders');
                        setShoppingMode('regular');
                      }}
                      className="bg-emerald-500 hover:bg-emerald-400 text-white text-[11.5px] font-black px-3 py-1.5 rounded-full shadow-md transition-all active:scale-95 flex items-center"
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
                    {/* 🌟 2. HOME HERO — two store-list cards in the peeking
                        carousel, cut from the market's own sheet, whose
                        colour tints the header above them. */}
                    <HomeHeroBanner
                      products={browseProducts}
                      categories={categories}
                      cartItems={activeCartItems}
                      onAddToCart={handleAddToCart}
                      onUpdateQuantity={handleUpdateQuantity}
                      onSelectProduct={handleOpenProductDetail}
                      onExplore={(category) => setActiveCategoryDetail(category || categories[0])}
                      onAccentChange={setHeroAccent}
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

                    {/* And the shops that are nobody's stall. Given the basket,
                        because once there is one it decides which of them can
                        actually take the order — see NearbyShops. */}
                    <NearbyShops
                      coords={customerCoords}
                      selectedShop={selectedShop}
                      onSelectShop={handleSelectShop}
                      basket={catalogBasket}
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
                /* ACCOUNT & ROLE SWITCHER TAB.

                   pt-safe-6 rather than plain p-2 padding-top: this tab has no header
                   of its own — unlike Orders, which draws a bar carrying its own
                   pt-safe-6 — so nothing was reserving room for the status bar / notch
                   above the menu list, and it opened flush against the top edge. */
                <div className="p-2 sm:p-6 pt-safe-6 text-center space-y-1 sm:space-y-6 animate-fade-in bg-gradient-to-br from-slate-50 to-emerald-50/40 pb-6 flex flex-col min-h-[calc(100dvh-4rem-env(safe-area-inset-bottom,0px))]">
                  {user ? (
                    <div className="max-w-sm mx-auto relative mt-0 sm:mt-4 flex-1 flex flex-col w-full">
                      
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
                            {/* Falls back to the profile title because the
                                view below falls back to the profile body. */}
                            {t(ACCOUNT_VIEW_TITLES[activeAccountView] || ACCOUNT_VIEW_TITLES.profile)}
                          </h2>
                        </div>
                      )}

                      {/* Settings entry point, top-right of the menu screen
                          only — the sub-views already carry the back header
                          above, which would leave two right-aligned controls
                          fighting for the same corner. */}
                      {activeAccountView === 'menu' && (
                        <div className="flex justify-end mb-2">
                          <button
                            onClick={() => setActiveAccountView('permissions')}
                            aria-label={t('permissions.title')}
                            className="p-2 bg-white rounded-xl shadow-sm border border-slate-100 text-slate-600 hover:text-[#1B4D3E] transition-colors cursor-pointer active:scale-95"
                          >
                            <SettingsIcon className="w-5 h-5" />
                          </button>
                        </div>
                      )}

                      {/* Quick actions — shortcuts to destinations that also
                          live in the grouped list below. Real ones only:
                          Wallet and Notepad are actual features of this app
                          (VegWallet, the header clipboard icon), not stand-ins
                          for things it doesn't have. */}
                      {activeAccountView === 'menu' && (
                        <div className="flex gap-2.5 overflow-x-auto pb-1 mb-4 scrollbar-none snap-x snap-mandatory -mx-2 px-2">
                          {[
                            { Icon: MapPinIcon, label: t('account.savedAddress'), onClick: () => setActiveAccountView('address') },
                            { Icon: WalletIcon, label: t('account.quickWallet'), onClick: () => setIsWalletOpen(true) },
                            { Icon: ClipboardListIcon, label: t('header.myList'), onClick: () => setIsNotepadOpen(true) },
                            { Icon: CoinsIcon, label: t('rewards.title'), onClick: () => setActiveAccountView('rewards') },
                          ].map(({ Icon, label, onClick }) => (
                            <button
                              key={label}
                              onClick={onClick}
                              className="shrink-0 snap-start w-[5.5rem] bg-white rounded-2xl shadow-sm border border-slate-100 p-3 flex flex-col items-center gap-2 active:scale-95 transition-all cursor-pointer"
                            >
                              <Icon className="w-5.5 h-5.5 text-slate-700" strokeWidth={1.75} />
                              <span className="text-[11px] font-bold text-slate-600 text-center leading-tight">{label}</span>
                            </button>
                          ))}
                        </div>
                      )}

                      {activeAccountView === 'menu' ? (
                        /* One grouped card with a hairline between rows, rather
                           than six cards each carrying their own shadow and
                           border — six floating slabs read as six unrelated
                           decisions when they are one list of destinations. */
                        <div className="bg-white/90 backdrop-blur-sm rounded-[1.75rem] shadow-sm border border-white/50 divide-y divide-slate-100 overflow-hidden text-left">
                          <button
                            onClick={() => setActiveAccountView('profile')}
                            className="w-full p-4 flex items-center gap-4 active:bg-slate-50 transition-colors cursor-pointer group"
                          >
                            <div className="w-11 h-11 rounded-xl bg-slate-100 text-slate-600 flex items-center justify-center group-hover:scale-110 transition-transform shadow-[inset_1px_1px_2px_rgba(255,255,255,1),2px_2px_4px_rgba(0,0,0,0.06)]">
                              <UserIcon className="w-5 h-5 drop-shadow-sm" />
                            </div>
                            <div className="flex-1">
                              <h3 className="font-extrabold text-slate-600 text-sm tracking-tight">{t('account.profileDetails')}</h3>
                              <p className="text-[11.5px] font-bold text-slate-400 mt-0.5">{t('account.profileDetailsSub')}</p>
                            </div>
                            <div className="w-8 h-8 rounded-full bg-slate-50 flex items-center justify-center group-hover:bg-[#1B4D3E] group-hover:text-white transition-colors">
                              <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-white transition-colors" />
                            </div>
                          </button>

                          <button
                            onClick={() => setActiveAccountView('history')}
                            className="w-full p-4 flex items-center gap-4 active:bg-slate-50 transition-colors cursor-pointer group"
                          >
                            <div className="w-11 h-11 rounded-xl bg-slate-100 text-slate-600 flex items-center justify-center group-hover:scale-110 transition-transform shadow-[inset_1px_1px_2px_rgba(255,255,255,1),2px_2px_4px_rgba(0,0,0,0.06)]">
                              <HistoryIcon className="w-5 h-5 drop-shadow-sm" />
                            </div>
                            <div className="flex-1">
                              <h3 className="font-extrabold text-slate-600 text-sm tracking-tight">{t('account.purchaseHistory')}</h3>
                              <p className="text-[11.5px] font-bold text-slate-400 mt-0.5">{t('account.purchaseHistorySub')}</p>
                            </div>
                            <div className="w-8 h-8 rounded-full bg-slate-50 flex items-center justify-center group-hover:bg-[#1B4D3E] group-hover:text-white transition-colors">
                              <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-white transition-colors" />
                            </div>
                          </button>

                          <button
                            onClick={() => setActiveAccountView('rewards')}
                            className="w-full p-4 flex items-center gap-4 active:bg-slate-50 transition-colors cursor-pointer group"
                          >
                            <div className="w-11 h-11 rounded-xl bg-slate-100 text-slate-600 flex items-center justify-center group-hover:scale-110 transition-transform shadow-[inset_1px_1px_2px_rgba(255,255,255,1),2px_2px_4px_rgba(0,0,0,0.06)]">
                              <CoinsIcon className="w-5 h-5 drop-shadow-sm" />
                            </div>
                            <div className="flex-1">
                              <h3 className="font-extrabold text-slate-600 text-sm tracking-tight">{t('rewards.title')}</h3>
                              <p className="text-[11.5px] font-bold text-slate-400 mt-0.5">
                                {t('account.rewardsSub', { tokens: TOKENS_PER_BATCH, rupees: RUPEES_PER_BATCH })}
                              </p>
                            </div>
                            <div className="w-8 h-8 rounded-full bg-slate-50 flex items-center justify-center group-hover:bg-[#1B4D3E] group-hover:text-white transition-colors">
                              <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-white transition-colors" />
                            </div>
                          </button>

                          <button
                            onClick={() => setActiveAccountView('wishlist')}
                            className="w-full p-4 flex items-center gap-4 active:bg-slate-50 transition-colors cursor-pointer group"
                          >
                            <div className="w-11 h-11 rounded-xl bg-slate-100 text-slate-600 flex items-center justify-center group-hover:scale-110 transition-transform shadow-[inset_1px_1px_2px_rgba(255,255,255,1),2px_2px_4px_rgba(0,0,0,0.06)]">
                              <HeartIcon className="w-5 h-5 drop-shadow-sm" />
                            </div>
                            <div className="flex-1">
                              <h3 className="font-extrabold text-slate-600 text-sm tracking-tight">{t('account.wishlist')}</h3>
                              <p className="text-[11.5px] font-bold text-slate-400 mt-0.5">{t('account.wishlistSub')}</p>
                            </div>
                            <div className="w-8 h-8 rounded-full bg-slate-50 flex items-center justify-center group-hover:bg-[#1B4D3E] group-hover:text-white transition-colors">
                              <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-white transition-colors" />
                            </div>
                          </button>

                          <button
                            onClick={() => setActiveAccountView('address')}
                            className="w-full p-4 flex items-center gap-4 active:bg-slate-50 transition-colors cursor-pointer group"
                          >
                            <div className="w-11 h-11 rounded-xl bg-slate-100 text-slate-600 flex items-center justify-center group-hover:scale-110 transition-transform shadow-[inset_1px_1px_2px_rgba(255,255,255,1),2px_2px_4px_rgba(0,0,0,0.06)]">
                              <MapPinIcon className="w-5 h-5 drop-shadow-sm" />
                            </div>
                            <div className="flex-1">
                              <h3 className="font-extrabold text-slate-600 text-sm tracking-tight">{t('account.savedAddress')}</h3>
                              <p className="text-[11.5px] font-bold text-slate-400 mt-0.5">{t('account.savedAddressSub')}</p>
                            </div>
                            <div className="w-8 h-8 rounded-full bg-slate-50 flex items-center justify-center group-hover:bg-[#1B4D3E] group-hover:text-white transition-colors">
                              <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-white transition-colors" />
                            </div>
                          </button>

                          {/* Language is a destination like the four above it,
                              rather than a card repeated at the foot of every
                              account screen, which is what it was. The subtitle
                              is the setting's current value, so the row answers
                              "which language am I in" without being opened. */}
                          <button
                            onClick={() => setActiveAccountView('language')}
                            className="w-full p-4 flex items-center gap-4 active:bg-slate-50 transition-colors cursor-pointer group"
                          >
                            <div className="w-11 h-11 rounded-xl bg-slate-100 text-slate-600 flex items-center justify-center group-hover:scale-110 transition-transform shadow-[inset_1px_1px_2px_rgba(255,255,255,1),2px_2px_4px_rgba(0,0,0,0.06)]">
                              <LanguagesIcon className="w-5 h-5 drop-shadow-sm" />
                            </div>
                            <div className="flex-1">
                              <h3 className="font-extrabold text-slate-600 text-sm tracking-tight">{t('settings.language')}</h3>
                              <p className="text-[11.5px] font-bold text-slate-400 mt-0.5">{currentLanguageName}</p>
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
                      ) : activeAccountView === 'wishlist' ? (
                        <AccountWishlist
                          cartItems={activeCartItems}
                          onAddToCart={handleAddToCart}
                          onUpdateQuantity={handleUpdateQuantity}
                          onSelectProduct={handleOpenProductDetail}
                        />
                      ) : activeAccountView === 'address' ? (
                        <AccountAddress onAddressChange={() => setAddressVersion((v) => v + 1)} />
                      ) : activeAccountView === 'language' ? (
                        /* Bare: the list is the whole point of this screen, and
                           the nav bar above it already names the setting. */
                        <div className="text-left">
                          <LanguagePicker standalone />
                        </div>
                      ) : activeAccountView === 'permissions' ? (
                        <AccountPermissions />
                      ) : (
                        <>
                          {!isEditingProfile && (
                        <>
                          {/* Premium Skeuomorphic Profile Avatar & Info */}
                          <div className="relative w-16 h-16 sm:w-28 sm:h-28 mx-auto mb-2 sm:mb-5 animate-scale-in drop-shadow-xl shrink-0">
                            <div className="absolute inset-0 bg-gradient-to-br from-white to-emerald-100 rounded-full shadow-[8px_8px_16px_rgba(27,77,62,0.1),-8px_-8px_16px_rgba(255,255,255,0.8)] border border-white"></div>
                            <ProfileAvatar
                              name={user.name}
                              avatar={user.avatar}
                              photo={avatarPhoto}
                              className="absolute inset-1.5 rounded-full text-2xl sm:text-4xl border border-[#0d2a20]"
                              emojiClassName="text-2xl sm:text-5xl"
                            />
                            {/* Replaces the online-glow dot that used to sit here.
                                That corner is the one place on a round avatar the
                                eye already goes, and a pulsing indicator of
                                nothing actionable was spending it. */}
                            <button
                              type="button"
                              onClick={() => setIsAvatarPickerOpen(true)}
                              aria-label={t('avatar.change')}
                              className="absolute -bottom-0.5 -right-0.5 sm:bottom-1 sm:right-1 w-6 h-6 sm:w-9 sm:h-9 bg-white rounded-full border-2 border-white text-[#1B4D3E] flex items-center justify-center shadow-[0_2px_6px_rgba(27,77,62,0.25)] hover:bg-emerald-50 transition-colors cursor-pointer active:scale-95"
                            >
                              <CameraIcon className="w-3 h-3 sm:w-4.5 sm:h-4.5" strokeWidth={2.25} />
                            </button>
                          </div>
                          
                          <div className="text-center mb-3 sm:mb-8">
                            <h3 className="font-extrabold text-lg sm:text-2xl text-slate-800 drop-shadow-sm mb-1 sm:mb-1.5 tracking-tight">{user.name}</h3>
                            <div className="inline-flex items-center gap-1.5 bg-gradient-to-r from-emerald-500 to-teal-600 text-white px-3 sm:px-4 py-1 sm:py-1.5 rounded-full text-[10.5px] sm:text-[11.5px] font-black uppercase tracking-widest shadow-[inset_1px_1px_2px_rgba(255,255,255,0.4),2px_4px_8px_rgba(16,185,129,0.3)] border border-emerald-400/50">
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
                              <label className="block text-slate-500 font-extrabold mb-1.5 text-[11.5px] uppercase tracking-widest pl-1 group-focus-within:text-[#1B4D3E] transition-colors">User Name</label>
                              <input
                                type="text"
                                value={editName}
                                onChange={(e) => setEditName(e.target.value)}
                                className="w-full bg-slate-100/50 border-0 rounded-2xl px-4 py-2.5 font-bold text-slate-800 focus:outline-none focus:ring-0 shadow-[inset_4px_4px_8px_rgba(166,180,200,0.4),inset_-4px_-4px_8px_rgba(255,255,255,0.9)] transition-all"
                                required
                              />
                            </div>
                            <div className="relative group">
                              <label className="block text-slate-500 font-extrabold mb-1.5 text-[11.5px] uppercase tracking-widest pl-1 group-focus-within:text-[#1B4D3E] transition-colors">Email Address</label>
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
                              <label className="block text-slate-500 font-extrabold mb-1.5 text-[11.5px] uppercase tracking-widest pl-1 group-focus-within:text-[#1B4D3E] transition-colors">Mobile Number</label>
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
                            <span className="text-slate-400 font-extrabold text-[11.5px] uppercase tracking-wider group-hover:text-slate-600 transition-colors">User Name</span>
                            <span className="font-black text-slate-800 drop-shadow-sm break-words max-w-full">{user.name}</span>
                          </div>
                          <div className="flex flex-col sm:flex-row sm:justify-between items-start sm:items-center py-1.5 sm:py-2 border-b border-emerald-900/5 group gap-0.5 sm:gap-0">
                            <span className="text-slate-400 font-extrabold text-[11.5px] uppercase tracking-wider group-hover:text-slate-600 transition-colors">Email Address</span>
                            <span className="font-bold text-slate-700 drop-shadow-sm break-all sm:break-words max-w-full">{user.email}</span>
                          </div>
                          <div className="flex flex-col sm:flex-row sm:justify-between items-start sm:items-center py-1.5 sm:py-2 border-b border-emerald-900/5 group gap-0.5 sm:gap-0">
                            <span className="text-slate-400 font-extrabold text-[11.5px] uppercase tracking-wider group-hover:text-slate-600 transition-colors">Mobile Number</span>
                            <span className="font-black text-[#1B4D3E] drop-shadow-sm break-words max-w-full">{user.phone || user.pendingPhone || '—'}</span>
                          </div>
                          <div className="flex flex-col sm:flex-row sm:justify-between items-start sm:items-center py-1.5 sm:py-2 border-b border-emerald-900/5 group bg-emerald-50/50 -mx-2 px-2 rounded-xl gap-0.5 sm:gap-0">
                            <span className="text-emerald-700 font-extrabold text-[11.5px] uppercase tracking-wider">VegWallet Balance</span>
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
                                <p className="text-[11.5px] text-amber-700 font-semibold">
                                  {profileChallenge?.kind === 'email'
                                    ? 'Login codes will be copied here.'
                                    : 'This is your sign-in credential.'}
                                </p>
                              </div>
                            </div>

                            <form onSubmit={handleVerifyProfileOTP} className="space-y-3">
                              {!profileReverse && (
                                <div className="bg-blue-50/80 p-2.5 rounded-xl border border-blue-100 text-[11.5px] text-blue-900 font-semibold leading-relaxed">
                                  We sent a 6-digit code on WhatsApp to{' '}
                                  <span className="font-extrabold">{profileChallenge?.destination || editPhone}</span>.
                                  Enter it to move your account to that number — every other device
                                  will be signed out.
                                </div>
                              )}

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
                                    onUnavailable={() => {
                                      if (profileChallenge?.challengeId) {
                                        setProfileReverse(false);
                                      } else {
                                        setProfileOtpError(
                                          'This option is not available right now. Please use the code we send you instead.'
                                        );
                                      }
                                    }}
                                  />
                                </div>
                              ) : (
                                <div className="space-y-2 border-t border-gray-100 pt-3">
                                  <label className="block font-bold text-gray-700 mb-2 text-[11.5px] uppercase tracking-wider text-center">
                                    {profileChallenge?.kind === 'email' ? 'Email OTP' : 'WhatsApp OTP'}
                                  </label>
                                  <OTPBoxGroup value={profileMobileOTP} onChange={setProfileMobileOTP} />
                                </div>
                              )}

                              {profileOtpError && <p className="text-[11.5px] font-bold text-rose-600">{profileOtpError}</p>}

                              {/* Offered only for the number leg — an email address
                                  has nothing to send a message from. */}
                              {profileChallenge?.kind === 'phone' && profileChallenge?.rawPhone && !(profileReverse && !profileChallenge?.challengeId) && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setProfileOtpError('');
                                    setProfileReverse((on) => !on);
                                  }}
                                  className="w-full text-[11.5px] font-bold text-[#1B4D3E] underline underline-offset-4 hover:text-[#143B2B]"
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
                      
                      {/* End of Profile View */}
                      </>
                    )}

                      {user.role && user.role !== 'customer' && (
                        <div className="mt-4 pt-3 border-t border-gray-200 space-y-2">
                          <span className="text-xs font-bold text-gray-700 block text-left">
                            Open Role Panel (Separate App):
                          </span>
                          {/*
                            Only `developer` gets the cross-app links, and that
                            is not a narrowing of who deserves them — it is the
                            only role that can legitimately be reading this.
                            `APP_ROLE_SCOPE.customer` on the server is
                            ['customer', 'market_owner', 'developer'], so a
                            shopkeeper or rider cannot sign in here at all, and
                            the effect near the top of this file sends one that
                            arrives by any other route back to its own app.

                            Guarding these on `=== 'shopkeeper'` / `=== 'delivery'`
                            meant that when that redirect broke, the storefront
                            did not merely tolerate the wrong session — it
                            advertised it, showing a rider a Delivery App button
                            on a screen no rider should have reached.
                          */}
                          <div className="grid grid-cols-2 gap-1.5 text-xs font-bold">
                            {/* Shopkeeper */}
                            {user.role === 'developer' && (
                              <a
                                href="#/shopkeeper"
                                className="p-2 bg-emerald-50 text-emerald-900 rounded-xl border border-emerald-200 hover:bg-emerald-100 transition-colors text-center flex items-center justify-center gap-1"
                              >
                                🏪 Shopkeeper App
                              </a>
                            )}

                            {/* Delivery */}
                            {user.role === 'developer' && (
                              <a
                                href="#/delivery"
                                className="p-2 bg-purple-50 text-purple-900 rounded-xl border border-purple-200 hover:bg-purple-100 transition-colors text-center flex items-center justify-center gap-1"
                              >
                                🚚 Delivery App
                              </a>
                            )}

                            {/* Developer Console (separate app) */}
                            {user.role === 'developer' && (
                              <>
                                <a
                                  href="#/developer"
                                  className="p-2 bg-slate-900 text-cyan-300 rounded-xl border border-slate-700 hover:bg-slate-800 transition-colors text-center flex items-center justify-center gap-1"
                                >
                                  💻 Developer Console
                                </a>
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

                      {/*
                        Signing out closes the account tab, and belongs to no
                        one screen inside it — so it sits at the foot of the
                        screen, above the nav, rather than immediately under
                        the menu with a gap of empty page below it.

                        It used to render below every account view, on the
                        reasoning that it is the one control someone may want
                        from wherever they are. The language card was repeated
                        with it, so Purchase History and Rewards each ended in
                        two settings that had nothing to do with what was above
                        them, and the picker read as part of whatever it landed
                        under. Each has one home now.
                      */}
                      {activeAccountView === 'menu' && (
                        <div className="max-w-sm mx-auto text-left pt-5 relative z-10 mt-auto w-full">
                          <h4 className={`${sectionLabel} text-slate-400`}>
                            {t('account.sectionSession')}
                          </h4>
                          <button
                            onClick={handleLogout}
                            className="w-full bg-slate-100 hover:bg-slate-200 text-slate-700 text-[11.5px] sm:text-sm font-extrabold px-2 sm:px-4 py-2 sm:py-2.5 rounded-2xl transition-all cursor-pointer text-center shadow-[inset_1px_1px_2px_rgba(255,255,255,0.8),4px_4px_8px_rgba(166,180,200,0.3),-4px_-4px_8px_rgba(255,255,255,0.8)] active:shadow-[inset_4px_4px_8px_rgba(166,180,200,0.4),inset_-4px_-4px_8px_rgba(255,255,255,0.9)]"
                          >
                            {t('common.signOut')}
                          </button>

                          {/* Deliberately quieter than Sign Out and directly
                              below it. With no password this is the only way to
                              end a session someone else is holding, so it has
                              to be findable — but it signs out every device
                              including this one, which is not what most taps
                              here mean. */}
                          <button
                            onClick={handleLogoutEverywhere}
                            className="mt-1.5 w-full text-rose-600/80 hover:text-rose-700 text-[11.5px] sm:text-xs font-bold px-2 py-1.5 rounded-xl transition-colors cursor-pointer text-center hover:bg-rose-50/60"
                          >
                            {t('account.signOutAllDevices')}
                          </button>
                        </div>
                      )}

                      {/* Deleting the account lives on Profile Details and
                          nowhere else — one deliberate step away from the menu,
                          because it is irreversible and it sat one mis-tap from
                          it.

                          Below the profile rather than above it, which is where
                          it used to be. A destructive action above the rest of
                          a screen is passed through by everyone on their way to
                          something ordinary, and nothing that cannot be undone
                          should sit in that path.

                          Hidden while the edit form is open: that form's own
                          Save/Cancel pair is what the eye is on. */}
                      {activeAccountView === 'profile' && !isEditingProfile && (
                        <div className="max-w-sm mx-auto text-left pt-5 relative z-10">
                          <button
                            onClick={handleDeleteAccount}
                            className="w-full text-rose-600/80 hover:text-rose-700 text-xs sm:text-sm font-bold py-2 rounded-xl transition-colors cursor-pointer text-center hover:bg-rose-50/60"
                          >
                            {t('account.deleteAccount')}
                          </button>
                        </div>
                      )}
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
      {activeTab !== 'developer' && activeTab !== 'market_owner' && !searchScreenOpen && (
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

      <NotepadModal
        isOpen={isNotepadOpen}
        onClose={() => setIsNotepadOpen(false)}
      />

      {isAvatarPickerOpen && user && (
        <AvatarPicker
          user={user}
          currentPhoto={avatarPhoto}
          onSelectPreset={handleSelectAvatarPreset}
          onUploadPhoto={handleUploadAvatarPhoto}
          onClear={handleClearAvatar}
          onClose={() => setIsAvatarPickerOpen(false)}
        />
      )}

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
