import React, { useState, useEffect } from 'react';
import {
  Store, Package, ShoppingBag, CheckCircle2, Clock, Truck,
  MapPin, LogOut, User, LayoutDashboard, Plus, Edit, Trash2,
  AlertTriangle, Navigation, Check, Camera, TrendingUp, BarChart3, Settings, ArrowLeft, Wallet, RefreshCw, X, Lock, ShieldAlert
} from 'lucide-react';
import { startPhoneChange, verifyPhoneChange, describePhoneProblem } from '../services/auth';
import { fetchShopEarnings, withdrawShopEarnings } from '../services/shops';
import { resetHandover } from '../services/orders';
import { ApiRequestError } from '../services/apiClient';
import OTPBoxGroup from './OTPBoxGroup';

/** Server amounts are integer paise; ₹1,250.00 is what a shopkeeper reads. */
const formatPaise = (paise) =>
  `₹${((paise ?? 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "in about 4 hours" for the next automatic payout. */
function timeUntilRelease(when) {
  const ms = new Date(when).getTime() - Date.now();
  if (ms <= 0) return 'any moment now';

  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in about ${hours} hour${hours === 1 ? '' : 's'}`;

  const days = Math.round(hours / 24);
  return `in about ${days} day${days === 1 ? '' : 's'}`;
}

/**
 * Prompt shown while the vendor's settlement account is unverified.
 *
 * The server refuses catalog writes in this state regardless of what the UI
 * shows (middleware/vendorVerified.js), so this exists to explain why the
 * controls are inert and to offer the action that fixes it — not as a check.
 */
function KycGateBanner({ kyc, onOpenKyc }) {
  if (!kyc || kyc.canUpdateStock) return null;

  const isPending = kyc.status === 'penny_sent';

  return (
    <button
      type="button"
      onClick={onOpenKyc}
      className="w-full text-left bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-start gap-3 active:scale-98 transition-transform mb-4"
    >
      <ShieldAlert className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
      <div className="flex-1">
        <p className="font-black text-sm text-amber-900">
          {isPending ? 'Confirm your verification amount' : 'Verify your account to update stock'}
        </p>
        <p className="text-xs text-amber-800 mt-0.5 leading-relaxed">
          {isPending
            ? 'We sent a small amount to your UPI ID. Enter the exact figure to unlock stock updates.'
            : 'Add your PAN and bank details, then confirm a ₹1 UPI transfer, before listing or updating stock.'}
        </p>
      </div>
    </button>
  );
}

export default function ShopkeeperPanel({ user, orders, products, setProducts, categories = [], onAddProduct, onEditProduct, onUpdateOrderStatus, onOrderAccepted, onLogout, onSyncOrders, kyc = null, onOpenKyc, onUserUpdated }) {
  // UX gate only. Every catalog write is authorized again by the API.
  const canUpdateStock = kyc ? kyc.canUpdateStock : true;

  /** Which order's handover reset is in flight, so only that button spins. */
  const [busyHandover, setBusyHandover] = useState(null);

  // Navigation & State
  const [activeTab, setActiveTab] = useState('dashboard');
  const [isStoreOnline, setIsStoreOnline] = useState(true);
  const [activeScreen, setActiveScreen] = useState('list'); // 'list' | 'add-product' | 'edit-product' | 'inventory' | 'hours' | 'bank'
  
  // Modals & deep dive
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [isEditProfileOpen, setIsEditProfileOpen] = useState(false);
  
  // Business Hours & Bank Details State
  const [businessHours, setBusinessHours] = useState(() => {
    try {
      const saved = localStorage.getItem('vegdrop_shopkeeper_hours');
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return {
      openTime: '06:00 AM',
      closeTime: '10:00 PM',
      autoAccept: true,
      days: { Monday: true, Tuesday: true, Wednesday: true, Thursday: true, Friday: true, Saturday: true, Sunday: true }
    };
  });

  /**
   * Real money owed to this shop, read from the server.
   *
   * WHAT THIS REPLACED
   *
   * A `bankDetails` object seeded with a hardcoded "₹4,850.00 pending", a fake
   * SBI account number, a fake account-holder name, and `verificationStatus:
   * 'verified'` — none of which the server had ever heard of. Its form saved a
   * bank account number into localStorage, readable by any script on the
   * origin, and its "penny drop" flipped itself to verified on a 2.5-second
   * setTimeout. That last one inverted the entire point of a penny drop: the
   * real one lands a RANDOM sub-rupee amount that the vendor has to read off
   * their own statement, precisely so that clicking a button proves nothing.
   *
   * Identity and bank verification live in VendorKycModal, against
   * /api/kyc — `onOpenKyc` is how this screen hands over to it.
   */
  const [earnings, setEarnings] = useState(null);
  const [earningsError, setEarningsError] = useState('');
  const [withdrawing, setWithdrawing] = useState(false);

  /**
   * Purge the bank account number the old screen persisted.
   *
   * Removing the code that wrote it does not remove it from the browsers of
   * everyone who already opened that screen — an account number and IFSC are
   * sitting in localStorage on those devices, readable by any script that
   * achieves XSS on this origin. Same reasoning as keeping the access token out
   * of web storage.
   */
  useEffect(() => {
    try {
      localStorage.removeItem('vegdrop_shopkeeper_bank');
    } catch {
      /* Private mode or a full quota — nothing was readable there anyway. */
    }
  }, []);

  /**
   * Loaded when a screen that shows money opens, rather than on mount: money
   * owed does not change on the timescale of a dashboard poll.
   */
  const needsEarnings = activeScreen === 'bank' || activeTab === 'analytics';

  useEffect(() => {
    if (!needsEarnings) return undefined;

    let cancelled = false;
    fetchShopEarnings()
      .then((data) => {
        if (!cancelled) setEarnings(data);
      })
      .catch((err) => {
        if (!cancelled) setEarningsError(err?.message || 'Could not load your earnings.');
      });

    return () => { cancelled = true; };
  }, [needsEarnings]);

  const handleWithdraw = async () => {
    setWithdrawing(true);
    setEarningsError('');
    try {
      // Returns the fresh summary alongside what it moved, so there is no
      // second round trip and no moment where the screen shows a stale total.
      const result = await withdrawShopEarnings();
      setEarnings((prev) => ({ ...prev, ...result }));
    } catch (err) {
      setEarningsError(err?.message || 'Could not withdraw right now.');
    } finally {
      setWithdrawing(false);
    }
  };
  const [profileData, setProfileData] = useState(() => {
    try {
      const savedKey = `vegdrop_shopkeeper_profile_${user?.phone || 'default'}`;
      const saved = localStorage.getItem(savedKey) || localStorage.getItem('vegdrop_shopkeeper_profile');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed) return parsed;
      }
    } catch (e) {}
    
    const userShopNo = user?.shopNo || '';
    const hasShopNo = Boolean(userShopNo && userShopNo.trim().length > 0);
    return {
      shopName: user?.shopName || user?.name || '',
      shopNo: userShopNo,
      isShopNoLocked: hasShopNo,
      phone: user?.phone || '',
      address: user?.address || ''
    };
  });

  // Automatically prompt for Shop Name, Shop No, and Address if missing (e.g. login with new phone number)
  useEffect(() => {
    if (!profileData.shopNo || !profileData.shopName || profileData.shopName === 'Shopkeeper User' || profileData.shopName === '') {
      setIsEditProfileOpen(true);
    }
  }, []);

  /**
   * Changing the phone number, unlike the rest of this modal, is not a plain
   * local edit. The number is the sign-in credential (see routes/auth.js's
   * comment on POST /phone/start), so it goes through the same OTP-verified
   * flow the login screen uses for a NEW account: prove control of the number
   * before the server will accept it, never a free-text field trusted at face
   * value the way Shop Name or Address are.
   *
   * 'idle' -> 'enter' (typing the new number) -> 'code' (typed, code sent) -> 'idle'.
   */
  const [phoneChangeStep, setPhoneChangeStep] = useState('idle');
  const [newPhone, setNewPhone] = useState('');
  const [phoneChallengeId, setPhoneChallengeId] = useState(null);
  const [phoneCode, setPhoneCode] = useState('');
  const [phoneChangeError, setPhoneChangeError] = useState('');
  const [phoneChangeBusy, setPhoneChangeBusy] = useState(false);

  function resetPhoneChange() {
    setPhoneChangeStep('idle');
    setNewPhone('');
    setPhoneChallengeId(null);
    setPhoneCode('');
    setPhoneChangeError('');
    setPhoneChangeBusy(false);
  }

  async function handleSendPhoneCode(e) {
    e.preventDefault();
    const problem = describePhoneProblem(newPhone);
    if (problem) {
      setPhoneChangeError(problem);
      return;
    }

    setPhoneChangeBusy(true);
    setPhoneChangeError('');
    try {
      const result = await startPhoneChange({ phone: newPhone });
      setPhoneChallengeId(result.challengeId);
      setPhoneChangeStep('code');
    } catch (err) {
      setPhoneChangeError(err instanceof ApiRequestError ? err.message : 'Could not send a code. Try again.');
    } finally {
      setPhoneChangeBusy(false);
    }
  }

  async function handleVerifyPhoneCode(e) {
    e.preventDefault();
    if (phoneCode.length !== 6) return;

    setPhoneChangeBusy(true);
    setPhoneChangeError('');
    try {
      const updatedUser = await verifyPhoneChange({ challengeId: phoneChallengeId, code: phoneCode });
      // The server is the source of truth for what the number actually became
      // — never the value typed into the form, in case it was normalised.
      setProfileData((prev) => ({ ...prev, phone: updatedUser.phone }));
      onUserUpdated?.(updatedUser);
      resetPhoneChange();
    } catch (err) {
      setPhoneChangeError(err instanceof ApiRequestError ? err.message : 'That code did not work. Try again.');
      setPhoneChangeBusy(false);
    }
  }

  // Form State
  const initialProductState = {
    name: '',
    categoryId: categories[0]?.id ?? 1,
    price: '',
    weight: '1 Kg',
    stock: '',
    image: ''
  };
  const [productForm, setProductForm] = useState(initialProductState);
  const [productFormError, setProductFormError] = useState('');
  const [isSavingProduct, setIsSavingProduct] = useState(false);
  const [imagePreviewError, setImagePreviewError] = useState(false);

  /** sku is globally unique (this catalog has no per-vendor scoping), so a
   * pure name-slug would let two vendors' identical product names collide.
   * The random suffix keeps that from blocking an honest second listing. */
  const generateSku = (name) => {
    const slug = name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'ITEM';
    const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
    return `${slug}-${suffix}`;
  };

  /** Compact relative time for "added" timestamps; null when there's nothing to show. */
  const formatAddedAt = (iso) => {
    if (!iso) return null;
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return null;
    const diffMs = Date.now() - then;
    const minute = 60_000, hour = 60 * minute, day = 24 * hour;
    if (diffMs < minute) return 'Added just now';
    if (diffMs < hour) return `Added ${Math.floor(diffMs / minute)}m ago`;
    if (diffMs < day) return `Added ${Math.floor(diffMs / hour)}h ago`;
    if (diffMs < 7 * day) return `Added ${Math.floor(diffMs / day)}d ago`;
    return `Added ${new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`;
  };

  // Derived Stats
  const pendingOrders = orders.filter((o) => o.status === 'Pending');
  const preparingOrders = orders.filter((o) => o.status === 'Preparing');
  const deliveredOrders = orders.filter((o) => o.status === 'Delivered');
  const lowStockItems = products ? products.filter((p) => p.isOutofStock) : [];

  /**
   * Takings for the calendar day, which is what "Today's Revenue" claimed to be.
   *
   * It summed every delivered order the panel had ever loaded, so the figure
   * only ever climbed and a quiet day still showed a month of trading.
   */
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const todaysDelivered = deliveredOrders.filter((o) => (o.timestamp ?? 0) >= startOfToday);
  const revenueToday = todaysDelivered.reduce((sum, o) => sum + o.totalAmount, 0);

  /**
   * What actually sold, counted from delivered orders rather than asserted.
   *
   * The list this replaces was two fixed rows — "Organic Onions 124 Kg" and
   * "Fresh Tomatoes 89 Kg" — printed identically for every shop in the system,
   * including one that had never sold either.
   */
  const topSellers = Object.entries(
    deliveredOrders.reduce((tally, order) => {
      for (const item of order.items || []) {
        tally[item.name] = (tally[item.name] || 0) + item.quantity;
      }
      return tally;
    }, {})
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  // Handlers
  const handleAddProduct = async () => {
    if (!productForm.name || !productForm.price) {
      setProductFormError('Name and price are required.');
      return;
    }
    if (!onAddProduct) return;
    setProductFormError('');
    setIsSavingProduct(true);
    const ok = await onAddProduct({
      sku: generateSku(productForm.name),
      categoryId: Number(productForm.categoryId),
      name: productForm.name,
      weight: productForm.weight,
      price: parseFloat(productForm.price),
      stock: parseInt(productForm.stock, 10) || 0,
      ...(productForm.image ? { image: productForm.image } : {}),
    });
    setIsSavingProduct(false);
    if (ok) {
      setProductForm(initialProductState);
      setActiveScreen('list');
    }
  };

  const handleEditProduct = async () => {
    if (!productForm.name || !productForm.price) {
      setProductFormError('Name and price are required.');
      return;
    }
    if (!onEditProduct) return;
    setProductFormError('');
    setIsSavingProduct(true);
    // categoryId and sku are immutable after creation — the server's PATCH
    // schema doesn't accept them, so only the editable fields are sent.
    const ok = await onEditProduct(selectedProduct.id, {
      name: productForm.name,
      weight: productForm.weight,
      price: parseFloat(productForm.price),
      stock: parseInt(productForm.stock, 10) || 0,
      image: productForm.image || undefined,
    });
    setIsSavingProduct(false);
    if (ok) {
      setProductForm(initialProductState);
      setSelectedProduct(null);
      setActiveScreen('list');
    }
  };

  const handleDeleteProduct = (id) => {
    if (window.confirm("Are you sure you want to delete this product?")) {
      if (setProducts) {
        setProducts(prev => prev.filter(p => p.id !== id));
      }
    }
  };

  /**
   * Take the order on. A rider picks it up from the open pool afterwards.
   *
   * This replaces an "Assign Delivery" screen that offered a choice between two
   * hardcoded couriers — "Rahul K., 4.9 stars, 0.5 km away" and a permanently
   * busy "Suresh M." — neither of whom existed. Whichever you tapped, the same
   * thing happened: the order moved to Preparing. There is no endpoint for
   * listing riders, and a shopkeeper does not pick one in this system; riders
   * claim marketless orders themselves.
   */
  const handleAcceptOrder = (order) => {
    onUpdateOrderStatus(order.id, 'Preparing');
    if (onOrderAccepted) onOrderAccepted(order);
  };

  const handleRejectOrder = (orderId) => {
    // The server refunds a wallet-paid order and restocks it on cancellation.
    onUpdateOrderStatus(orderId, 'Cancelled');
  };

  /**
   * The rider mistyped their way into a lock and is standing at the counter.
   *
   * The cap on the pickup endpoint is what stops a four-digit code being
   * brute-forced by somebody who never came to the shop, so it has to be low —
   * low enough to occasionally catch a rider who misheard a number. Clearing it
   * belongs to the shopkeeper rather than the rider for the obvious reason: if
   * the person being checked could reset their own failures, the cap would be
   * unlimited guesses with extra steps.
   */
  const handleResetHandover = async (order) => {
    const id = order.serverId || order.id;
    setBusyHandover(id);
    try {
      await resetHandover(id);
      if (onSyncOrders) await onSyncOrders();
    } catch (err) {
      console.warn('[shopkeeper] handover reset failed:', err.message);
    } finally {
      setBusyHandover(null);
    }
  };

  /**
   * Open the edit form for one product.
   *
   * Shared so the inventory list's "Update" button lands somewhere — it had no
   * handler at all, and was the only way that screen offered to fix a stock
   * count it had just flagged as low.
   */
  const openProductEditor = (product) => {
    setSelectedProduct(product);
    setImagePreviewError(false);
    setProductFormError('');
    setProductForm({
      name: product.name,
      categoryId: product.categoryId,
      price: product.price,
      weight: product.weight || '',
      stock: product.stock || 0,
      image: product.image || '',
    });
    setActiveScreen('edit-product');
  };

  // Render Screens
  const renderDashboard = () => (
    <div className="space-y-6 animate-fade-in pb-20">
      {/* Top Profile & Store Toggle */}
      <div className="flex items-center justify-between bg-white p-5 rounded-2xl shadow-sm border border-gray-100">
        <div className="flex items-center gap-3">
          <div className="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center border-2 border-green-500 overflow-hidden">
            <Store className="w-8 h-8 text-green-600" />
          </div>
          <div>
            <h2 className="text-lg font-black text-gray-900">{user ? user.name : 'Vendor Shop'}</h2>
            <div className="flex items-center gap-1 text-sm font-bold text-gray-500">
              <MapPin className="w-3.5 h-3.5 text-orange-500" /> MG Road Market
            </div>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <button
            onClick={() => setIsStoreOnline(!isStoreOnline)}
            className={`relative w-14 h-8 rounded-full transition-colors duration-300 ease-in-out ${isStoreOnline ? 'bg-green-500' : 'bg-gray-300'}`}
          >
            <div className={`absolute top-1 w-6 h-6 bg-white rounded-full transition-transform duration-300 ease-in-out ${isStoreOnline ? 'translate-x-7' : 'translate-x-1'}`} />
          </button>
          <span className={`text-[10px] font-black uppercase tracking-wider ${isStoreOnline ? 'text-green-600' : 'text-gray-400'}`}>
            {isStoreOnline ? 'Shop Online' : 'Shop Offline'}
          </span>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 flex flex-col items-center justify-center text-center">
          <ShoppingBag className="w-6 h-6 text-orange-500 mb-2" />
          <span className="text-2xl font-black text-gray-900">{pendingOrders.length}</span>
          <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">Pending Orders</span>
        </div>
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 flex flex-col items-center justify-center text-center">
          <TrendingUp className="w-6 h-6 text-green-500 mb-2" />
          <span className="text-2xl font-black text-green-600">₹{revenueToday}</span>
          <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">Today's Revenue</span>
        </div>
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 flex flex-col items-center justify-center text-center">
          <CheckCircle2 className="w-6 h-6 text-blue-500 mb-2" />
          <span className="text-2xl font-black text-gray-900">{deliveredOrders.length}</span>
          <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">Today's Deliveries</span>
        </div>
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 flex flex-col items-center justify-center text-center">
          <AlertTriangle className="w-6 h-6 text-red-500 mb-2" />
          <span className="text-2xl font-black text-red-600">{lowStockItems.length}</span>
          <span className="text-xs font-bold text-red-400 uppercase tracking-wider">Low Stock</span>
        </div>
      </div>

      {/* Quick Actions */}
      <div>
        <h3 className="font-black text-gray-900 text-sm mb-3 px-1">Quick Actions</h3>
        <div className="grid grid-cols-2 gap-3">
          <button 
            onClick={() => { setActiveTab('products'); setActiveScreen('add-product'); }}
            className="bg-green-50 border border-green-200 text-green-800 p-4 rounded-2xl shadow-sm flex items-center gap-3 active:scale-95 transition-transform"
          >
            <Plus className="w-6 h-6 text-green-600" />
            <span className="font-bold text-sm leading-tight text-left">Add<br/>Product</span>
          </button>
          <button 
            onClick={() => setActiveScreen('inventory')}
            className="bg-orange-50 border border-orange-200 text-orange-800 p-4 rounded-2xl shadow-sm flex items-center gap-3 active:scale-95 transition-transform"
          >
            <Package className="w-6 h-6 text-orange-600" />
            <span className="font-bold text-sm leading-tight text-left">Check<br/>Inventory</span>
          </button>
        </div>
      </div>
    </div>
  );

  const renderProducts = () => {
    if (activeScreen === 'add-product' || activeScreen === 'edit-product') {
      return (
        <div className="space-y-6 pb-20 animate-fade-in">
          <div className="flex items-center gap-3 mb-4">
            <button onClick={() => { setActiveScreen('list'); setProductForm(initialProductState); setProductFormError(''); setImagePreviewError(false); }} className="p-2 rounded-full bg-gray-100"><ArrowLeft className="w-5 h-5" /></button>
            <h2 className="font-black text-xl text-gray-900">{activeScreen === 'add-product' ? 'Add New Product' : 'Edit Product'}</h2>
          </div>

          <KycGateBanner kyc={kyc} onOpenKyc={onOpenKyc} />

          <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100 space-y-4">
            {productFormError && (
              <p className="text-xs font-bold text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{productFormError}</p>
            )}
            <div>
              <label className="block text-xs font-bold text-gray-500 mb-1">Product Image</label>
              <div className="flex items-center gap-3">
                {productForm.image && !imagePreviewError ? (
                  <img
                    src={productForm.image}
                    alt=""
                    className="w-14 h-14 rounded-xl object-cover border border-gray-200 shrink-0"
                    onError={() => setImagePreviewError(true)}
                  />
                ) : (
                  <div className="w-14 h-14 rounded-xl bg-gray-100 border border-dashed border-gray-300 flex items-center justify-center shrink-0">
                    <Camera className="w-5 h-5 text-gray-300" />
                  </div>
                )}
                <input
                  type="url"
                  value={productForm.image}
                  onChange={e => { setProductForm({...productForm, image: e.target.value}); setImagePreviewError(false); }}
                  className="flex-1 bg-gray-50 border border-gray-200 rounded-xl p-3 focus:border-green-500 outline-none font-bold text-sm"
                  placeholder="https://example.com/tomato.jpg"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-bold text-gray-500 mb-1">Product Name</label>
              <input type="text" value={productForm.name} onChange={e => setProductForm({...productForm, name: e.target.value})} className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 focus:border-green-500 outline-none font-bold" placeholder="e.g. Fresh Tomatoes" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold text-gray-500 mb-1">Price (₹)</label>
                <input type="number" value={productForm.price} onChange={e => setProductForm({...productForm, price: e.target.value})} className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 focus:border-green-500 outline-none font-bold" placeholder="e.g. 40" />
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-500 mb-1">Unit</label>
                <select value={productForm.weight} onChange={e => setProductForm({...productForm, weight: e.target.value})} className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 focus:border-green-500 outline-none font-bold">
                  <option>1 Kg</option>
                  <option>500 g</option>
                  <option>1 Piece</option>
                  <option>1 Dozen</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold text-gray-500 mb-1">Category</label>
                <select
                  value={productForm.categoryId}
                  onChange={e => setProductForm({...productForm, categoryId: Number(e.target.value)})}
                  disabled={activeScreen === 'edit-product'}
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 focus:border-green-500 outline-none font-bold disabled:opacity-60"
                >
                  {categories.map(c => (
                    <option key={c.id} value={c.id}>{c.title}</option>
                  ))}
                </select>
                {activeScreen === 'edit-product' && (
                  <p className="text-[11px] text-gray-400 mt-1">Category can't be changed after a product is created.</p>
                )}
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-500 mb-1">Stock Qty</label>
                <input type="number" value={productForm.stock} onChange={e => setProductForm({...productForm, stock: e.target.value})} className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 focus:border-green-500 outline-none font-bold" placeholder="e.g. 100" />
              </div>
            </div>
            <button
              onClick={activeScreen === 'add-product' ? handleAddProduct : handleEditProduct}
              disabled={!canUpdateStock || isSavingProduct}
              className="w-full py-4 bg-green-600 text-white rounded-xl font-black shadow-lg active:scale-95 transition-transform mt-4 disabled:bg-gray-300 disabled:active:scale-100 disabled:shadow-none"
            >
              {isSavingProduct ? 'Saving…' : (activeScreen === 'add-product' ? 'Save Product' : 'Update Product')}
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-4 pb-24 animate-fade-in">
        <KycGateBanner kyc={kyc} onOpenKyc={onOpenKyc} />

        {products?.map(product => (
          <div key={product.id} className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 flex gap-4 items-center">
            {product.image ? (
              <img
                src={product.image}
                alt={product.name}
                className="w-20 h-20 object-cover rounded-xl border border-gray-200 shrink-0"
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
              />
            ) : (
              <div className="w-20 h-20 rounded-xl bg-gray-100 border border-gray-200 flex items-center justify-center shrink-0">
                <Camera className="w-6 h-6 text-gray-300" />
              </div>
            )}
            <div className="flex-1">
              <h3 className="font-black text-gray-900">{product.name}</h3>
              <p className="text-xs text-gray-500 font-bold mb-1">₹{product.price} / {product.weight}</p>
              {(product.stock ?? 0) <= 0 ? (
                <span className="text-[10px] font-black bg-red-100 text-red-600 px-2 py-0.5 rounded-md">OUT OF STOCK</span>
              ) : (
                <span className="text-[10px] font-black bg-green-100 text-green-700 px-2 py-0.5 rounded-md">IN STOCK ({product.stock})</span>
              )}
              {formatAddedAt(product.createdAt) && (
                <p className="text-[10px] text-gray-400 font-semibold mt-1">{formatAddedAt(product.createdAt)}</p>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => openProductEditor(product)}
                className="p-2 bg-gray-100 text-gray-600 rounded-lg active:scale-90 transition-transform"
              >
                <Edit className="w-4 h-4" />
              </button>
              <button onClick={() => handleDeleteProduct(product.id)} className="p-2 bg-red-50 text-red-600 rounded-lg active:scale-90 transition-transform">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
        {/* Floating Add Button */}
        <button 
          onClick={() => { setProductForm(initialProductState); setProductFormError(''); setImagePreviewError(false); setActiveScreen('add-product'); }}
          className="fixed bottom-24 right-4 w-14 h-14 bg-green-600 text-white rounded-full shadow-[0_10px_20px_rgba(34,197,94,0.3)] flex items-center justify-center active:scale-90 transition-transform z-50"
        >
          <Plus className="w-6 h-6" />
        </button>
      </div>
    );
  };

  const renderOrders = () => {
    return (
      <div className="space-y-6 pb-20 animate-fade-in">
        <div>
          <h3 className="font-black text-gray-900 text-sm mb-3 px-1 flex justify-between">
            <span>New Orders</span>
            <span className="bg-orange-100 text-orange-700 px-2 rounded-full text-xs">{pendingOrders.length}</span>
          </h3>
          {pendingOrders.length === 0 ? <p className="text-xs text-gray-400 italic px-1">No new orders.</p> : (
            <div className="space-y-3">
              {pendingOrders.map(order => (
                <div key={order.id} className="bg-white border-l-4 border-orange-500 rounded-xl p-4 shadow-sm">
                  <div className="flex justify-between items-start mb-1">
                    <span className="font-bold text-gray-900">Order #{order.id}</span>
                    <span className="text-green-600 font-black">₹{order.totalAmount}</span>
                  </div>
                  {/*
                    The customer's name and delivery address used to sit here.
                    The server no longer sends either to a shopkeeper: you pack
                    the order, a rider carries it, and the address is the
                    rider's business — the same rule the market stall screen has
                    always followed.
                  */}
                  <p className="text-xs text-gray-500 mb-1">
                    {order.items?.length} item{order.items?.length === 1 ? '' : 's'}
                  </p>
                  <p className="text-[11px] text-gray-400 mb-3 line-clamp-2">{order.items?.map(i => `${i.quantity}x ${i.name}`).join(', ')}</p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleRejectOrder(order.id)}
                      className="flex-1 py-2 bg-gray-100 text-gray-600 rounded-lg font-bold text-xs active:scale-95 transition-transform"
                    >
                      Reject
                    </button>
                    <button
                      onClick={() => handleAcceptOrder(order)}
                      className="flex-1 py-2 bg-orange-500 text-white rounded-lg font-bold text-xs shadow-sm active:scale-95 transition-transform"
                    >
                      Accept order
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <h3 className="font-black text-gray-900 text-sm mb-3 px-1 flex justify-between">
            <span>Preparing for Pickup</span>
            <span className="bg-blue-100 text-blue-700 px-2 rounded-full text-xs">{preparingOrders.length}</span>
          </h3>
          {preparingOrders.length === 0 ? <p className="text-xs text-gray-400 italic px-1">No orders being prepared.</p> : (
            <div className="space-y-3">
              {preparingOrders.map(order => (
                <div key={order.id} className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
                  <div className="flex justify-between items-start mb-2">
                    <span className="font-bold text-gray-900">Order #{order.id}</span>
                    <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded-md text-[10px] font-bold">Waiting for Agent</span>
                  </div>
                  <p className="text-xs text-gray-500 mb-3 line-clamp-1">{order.items.map(i => `${i.quantity}x ${i.name}`).join(', ')}</p>

                  {/*
                    The handover code, to be read aloud to the rider.

                    Sized to be read across a counter rather than glanced at, and
                    tabular so 6 and 8 are not confusable at arm's length. It is
                    the rider's proof they collected these bags, and until they
                    enter it they cannot see the customer's address — so give it
                    to nobody else.

                    Absent once the pickup is done, and absent entirely on market
                    orders, whose codes are per stall and live on the stall
                    screen instead.
                  */}
                  {order.pickupCode ? (
                    <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2.5">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-[10px] font-black text-emerald-700 uppercase tracking-wide">
                            Handover code
                          </p>
                          <p className="text-[11px] text-gray-600 mt-0.5">
                            Read this to the rider when they collect.
                          </p>
                        </div>
                        <p className="text-[24px] leading-none font-black text-gray-900 tabular-nums tracking-[0.2em] shrink-0">
                          {order.pickupCode}
                        </p>
                      </div>

                      {order.pickupAttemptsRemaining === 0 ? (
                        <div className="mt-2.5 flex items-center gap-2 flex-wrap">
                          <p className="flex-1 min-w-[9rem] text-[11.5px] font-bold text-amber-800">
                            Locked — too many wrong codes.
                          </p>
                          <button
                            type="button"
                            onClick={() => handleResetHandover(order)}
                            disabled={busyHandover === (order.serverId || order.id)}
                            className="text-[12px] font-bold text-white bg-emerald-600 px-3 py-1.5 rounded-lg disabled:opacity-50"
                          >
                            {busyHandover === (order.serverId || order.id) ? 'Unlocking…' : 'Unlock'}
                          </button>
                        </div>
                      ) : (
                        order.pickupAttemptsRemaining != null &&
                        order.pickupAttemptsRemaining < 3 && (
                          <p className="mt-1.5 text-[11px] text-amber-700">
                            {order.pickupAttemptsRemaining} attempt
                            {order.pickupAttemptsRemaining === 1 ? '' : 's'} left before it locks.
                          </p>
                        )
                      )}
                    </div>
                  ) : (
                    /* A status line, not a control — it was marked up as a
                       button with pointer-events disabled, so assistive tech
                       announced a button that could never be pressed. */
                    <p className="w-full py-2 bg-gray-100 text-gray-500 rounded-lg font-bold text-xs border border-gray-200 text-center">
                      Waiting for a rider to collect it
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  /**
   * Trading, on figures that come from somewhere.
   *
   * What this replaced: a "This Week" that was literally today's number times
   * four, a "Conversion 12.4%" that was a string in the markup, and a top-seller
   * list of two fixed rows shown to every shop regardless of what it sold. The
   * only honest number on the screen was the order count.
   *
   * Money owed is the real settlement summary — the same data the payout screen
   * reads — so "Withdraw" now moves actual money instead of doing nothing.
   */
  const renderAnalytics = () => (
    <div className="space-y-6 animate-fade-in pb-20">
      <div className="bg-gradient-to-br from-green-800 to-green-600 p-6 rounded-3xl shadow-xl text-white">
        <span className="block text-green-200 text-sm font-bold uppercase tracking-wider mb-1">Delivered today</span>
        <h2 className="text-5xl font-black mb-1">₹{revenueToday.toLocaleString('en-IN')}</h2>
        <p className="text-green-200 text-xs mb-4">
          {todaysDelivered.length} order{todaysDelivered.length === 1 ? '' : 's'} · what customers paid, before our commission
        </p>

        <div className="flex justify-between items-center border-t border-green-700/50 pt-4 mt-2 gap-3">
          <div className="min-w-0">
            <span className="block text-xs text-green-200">Yours to withdraw</span>
            <span className="font-bold text-lg">
              {earnings ? formatPaise(earnings.pendingPaise) : '—'}
            </span>
          </div>
          <button
            onClick={handleWithdraw}
            disabled={!earnings || withdrawing || !earnings.canWithdrawNow}
            className="bg-white disabled:bg-white/40 disabled:text-green-900/50 text-green-900 px-4 py-2 rounded-xl font-black text-xs shadow-md active:scale-95 transition-transform shrink-0"
          >
            {withdrawing ? 'Moving…' : 'Withdraw'}
          </button>
        </div>
        {earnings && !earnings.canWithdrawNow && earnings.pendingPaise > 0 && (
          <p className="text-[10px] text-green-200/80 mt-2">
            Reaches your wallet on its own within {earnings.holdHours} hours, or withdraw early from{' '}
            {formatPaise(earnings.minEarlyPayoutPaise)}.
          </p>
        )}
      </div>

      {earningsError && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-2.5 text-xs text-red-700 font-bold">{earningsError}</div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100">
          <BarChart3 className="w-6 h-6 text-orange-500 mb-2" />
          <p className="text-xs font-bold text-gray-500 mb-1">Orders</p>
          <p className="font-black text-xl text-gray-900">{orders.length}</p>
        </div>
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100">
          {/* Replaces a hardcoded "Conversion 12.4%". Nothing in this system
              tracks how many people looked without buying, so a conversion rate
              cannot be computed — this counts what actually completed. */}
          <TrendingUp className="w-6 h-6 text-green-500 mb-2" />
          <p className="text-xs font-bold text-gray-500 mb-1">Delivered</p>
          <p className="font-black text-xl text-gray-900">{deliveredOrders.length}</p>
        </div>
      </div>

      <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
        <h3 className="font-black text-gray-900 mb-4 border-b pb-2">Top Selling Items</h3>
        {topSellers.length === 0 ? (
          <p className="text-xs text-gray-400 italic">Nothing delivered yet — this fills in as orders complete.</p>
        ) : (
          <div className="space-y-4">
            {topSellers.map(([name, quantity]) => (
              <div key={name} className="flex justify-between items-center gap-3">
                <span className="font-bold text-gray-700 text-sm truncate">{name}</span>
                <span className="text-green-600 font-black text-sm shrink-0">{quantity} sold</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const renderProfile = () => (
    <div className="space-y-6 animate-fade-in pb-20">
      <div className="bg-white p-6 rounded-3xl shadow-sm border border-gray-100 text-center relative">
        <button 
          onClick={() => setIsEditProfileOpen(true)}
          className="absolute top-4 right-4 flex items-center gap-1.5 px-3 py-1.5 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 text-emerald-700 rounded-xl text-xs font-black transition-all active:scale-95 shadow-xs cursor-pointer"
          title="Edit Profile"
        >
          <Edit className="w-3.5 h-3.5" />
          <span>Edit</span>
        </button>
        
        <div className="w-24 h-24 bg-green-100 rounded-full flex items-center justify-center border-4 border-white shadow-lg mx-auto mb-4">
          <Store className="w-10 h-10 text-green-600" />
        </div>
        <h2 className="text-2xl font-black text-gray-900">{profileData.shopName}</h2>
        <p className="text-emerald-700 font-bold mb-1 text-sm">Shop No: {profileData.shopNo || 'Not Set'}</p>
        <p className="text-xs text-gray-400 mb-4 font-mono">{profileData.phone}</p>
        {/* "Super Seller 🏆" stood here for every account unconditionally —
            there is no seller tier or rating in this system, so the badge
            awarded nothing and meant nothing. Delivered count is the standing
            this shop actually has. */}
        <div className="inline-flex bg-green-50 text-green-700 px-4 py-1.5 rounded-full font-bold text-sm border border-green-200">
          {deliveredOrders.length} order{deliveredOrders.length === 1 ? '' : 's'} delivered
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <button onClick={() => setActiveScreen('hours')} className="w-full p-4 flex justify-between items-center border-b border-gray-50 hover:bg-gray-50 active:bg-gray-100 transition-colors text-left cursor-pointer">
          <div className="flex items-center gap-3">
            <Clock className="w-5 h-5 text-blue-500" />
            <span className="font-bold text-gray-700">Business Hours</span>
          </div>
          <span className="text-gray-400 font-bold">›</span>
        </button>
        <button onClick={() => setActiveScreen('bank')} className="w-full p-4 flex justify-between items-center hover:bg-gray-50 active:bg-gray-100 transition-colors text-left cursor-pointer">
          <div className="flex items-center gap-3">
            <Wallet className="w-5 h-5 text-green-500" />
            <span className="font-bold text-gray-700">Bank Details</span>
          </div>
          <span className="text-gray-400 font-bold">›</span>
        </button>
      </div>

      {onLogout && (
        <button 
          onClick={onLogout}
          className="w-full bg-red-50 text-red-600 font-black py-4 rounded-2xl border border-red-100 active:scale-95 transition-transform flex items-center justify-center gap-2"
        >
          <LogOut className="w-5 h-5" /> LOG OUT
        </button>
      )}
    </div>
  );

  const renderInventory = () => (
    <div className="space-y-6 pb-20 animate-fade-in absolute inset-0 bg-gray-50 z-50 p-4 overflow-y-auto">
      <div className="flex items-center gap-3 mb-4 sticky top-0 bg-gray-50 py-2">
        <button onClick={() => setActiveScreen('list')} className="p-2 rounded-full bg-gray-200"><ArrowLeft className="w-5 h-5" /></button>
        <h2 className="font-black text-xl text-gray-900">Inventory Status</h2>
      </div>
      
      {lowStockItems.length > 0 && (
        <div className="bg-red-50 border border-red-200 p-4 rounded-xl flex gap-3 shadow-sm">
          <AlertTriangle className="w-6 h-6 text-red-500 shrink-0" />
          <div>
            <h3 className="font-black text-red-900 text-sm">Low Stock Alert</h3>
            <p className="text-xs text-red-700 mt-1">{lowStockItems.length} items need immediate restocking.</p>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {products?.map(p => (
          <div key={p.id} className="bg-white p-4 rounded-xl border border-gray-100 shadow-sm flex justify-between items-center">
            <div>
              <h4 className="font-bold text-gray-900 text-sm">{p.name}</h4>
              {/* `p.stock || 50` invented a stock count whenever the real one
                  was zero or absent, on the one screen whose job is to report
                  stock. */}
              <p className="text-xs text-gray-500">{p.stock ?? 0} {p.unit || 'units'} remaining</p>
            </div>
            <button
              onClick={() => openProductEditor(p)}
              className="bg-gray-100 text-gray-600 px-3 py-1.5 rounded-lg text-xs font-bold active:scale-95"
            >
              Update
            </button>
          </div>
        ))}
      </div>
    </div>
  );


  const renderBusinessHours = () => (
    <div className="space-y-6 pb-20 animate-fade-in absolute inset-0 bg-gray-50 z-50 p-4 overflow-y-auto">
      <div className="flex items-center justify-between mb-4 sticky top-0 bg-gray-50 py-2 z-10">
        <div className="flex items-center gap-3">
          <button onClick={() => setActiveScreen('list')} className="p-2 rounded-full bg-gray-200 hover:bg-gray-300 transition-colors">
            <ArrowLeft className="w-5 h-5 text-gray-700" />
          </button>
          <h2 className="font-black text-xl text-gray-900">Business Hours</h2>
        </div>
      </div>

      <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 space-y-4">
        <div className="flex items-center gap-3 pb-3 border-b border-gray-100">
          <div className="w-10 h-10 rounded-2xl bg-blue-100 text-blue-600 flex items-center justify-center font-bold">
            <Clock className="w-5 h-5" />
          </div>
          <div>
            <h3 className="font-extrabold text-gray-900 text-sm">Store Operational Hours</h3>
            <p className="text-xs text-gray-500">Set daily opening & closing schedule</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 pt-1">
          <div>
            <label className="block text-xs font-bold text-gray-700 mb-1">Opening Time</label>
            <input
              type="text"
              value={businessHours.openTime}
              onChange={(e) => setBusinessHours({ ...businessHours, openTime: e.target.value })}
              className="w-full bg-gray-50 border border-gray-300 rounded-xl px-3 py-2 text-xs font-bold text-gray-900 focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-gray-700 mb-1">Closing Time</label>
            <input
              type="text"
              value={businessHours.closeTime}
              onChange={(e) => setBusinessHours({ ...businessHours, closeTime: e.target.value })}
              className="w-full bg-gray-50 border border-gray-300 rounded-xl px-3 py-2 text-xs font-bold text-gray-900 focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>

        <div className="pt-2 border-t border-gray-100 space-y-2">
          <label className="block text-xs font-bold text-gray-800 mb-2">Operational Days</label>
          {Object.keys(businessHours.days).map((day) => (
            <div key={day} className="flex justify-between items-center bg-gray-50 p-2.5 rounded-xl border border-gray-200">
              <span className="font-bold text-xs text-gray-800">{day}</span>
              <button
                onClick={() => {
                  const updatedDays = { ...businessHours.days, [day]: !businessHours.days[day] };
                  setBusinessHours({ ...businessHours, days: updatedDays });
                }}
                className={`px-3 py-1 rounded-full text-[10px] font-black transition-all cursor-pointer ${
                  businessHours.days[day] ? 'bg-emerald-100 text-emerald-800 border border-emerald-300' : 'bg-gray-200 text-gray-500'
                }`}
              >
                {businessHours.days[day] ? 'OPEN' : 'CLOSED'}
              </button>
            </div>
          ))}
        </div>

        <button
          onClick={() => {
            try {
              localStorage.setItem('vegdrop_shopkeeper_hours', JSON.stringify(businessHours));
            } catch (e) {}
            setActiveScreen('list');
          }}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white font-extrabold py-3.5 rounded-xl transition-all shadow-md text-xs cursor-pointer active:scale-95"
        >
          Save Business Hours
        </button>
      </div>
    </div>
  );

  /**
   * Bank & payouts, on real data.
   *
   * Three things, in the order a shopkeeper cares about them: what is owed,
   * where it will be sent, and how to change that. Everything here comes from
   * the server — the screen this replaced invented all three.
   */
  const renderBankDetails = () => {
    const kycStatus = kyc?.status || 'missing';
    const verified = Boolean(kyc?.isVerified);
    const pendingPaise = earnings?.pendingPaise ?? 0;
    const releasedPaise = earnings?.releasedPaise ?? 0;

    const STATUS_CHIP = {
      verified: { text: '✓ Verified', cls: 'bg-emerald-400/20 text-emerald-300 border-emerald-400/30' },
      penny_sent: { text: '⏳ Awaiting confirmation', cls: 'bg-yellow-400/20 text-yellow-300 border-yellow-400/30' },
      pending: { text: '⏳ In review', cls: 'bg-yellow-400/20 text-yellow-300 border-yellow-400/30' },
      rejected: { text: '✗ Rejected', cls: 'bg-red-400/20 text-red-300 border-red-400/30' },
      missing: { text: '✗ Not set up', cls: 'bg-red-400/20 text-red-300 border-red-400/30' },
    };
    const chip = STATUS_CHIP[kycStatus] || STATUS_CHIP.missing;

    return (
      <div className="space-y-4 pb-20 animate-fade-in absolute inset-0 bg-gray-50 z-50 p-4 overflow-y-auto">
        {/* Header */}
        <div className="flex items-center gap-3 sticky top-0 bg-gray-50 py-2 z-10">
          <button onClick={() => { setActiveScreen('list'); setEarningsError(''); }} className="p-2 rounded-full bg-gray-200 hover:bg-gray-300 transition-colors">
            <ArrowLeft className="w-5 h-5 text-gray-700" />
          </button>
          <h2 className="font-black text-xl text-gray-900">Bank & Payouts</h2>
        </div>

        {/* What is actually owed */}
        <div className="bg-gradient-to-r from-[#1B4D3E] to-[#276652] p-5 rounded-2xl text-white shadow-md">
          <div className="flex justify-between items-center mb-1">
            <span className="text-[10px] text-emerald-200 font-bold uppercase tracking-wider">Settlement account</span>
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-black border ${chip.cls}`}>{chip.text}</span>
          </div>

          {earnings === null ? (
            <p className="text-2xl font-black font-mono tracking-wider opacity-40">₹—</p>
          ) : (
            <>
              <p className="text-2xl font-black font-mono tracking-wider">{formatPaise(pendingPaise)}</p>
              <p className="text-[11px] text-emerald-100 mt-1">
                {pendingPaise === 0
                  ? 'Nothing waiting. Earnings appear here once an order is delivered.'
                  : earnings.nextReleaseAt
                    ? `Reaches your wallet ${timeUntilRelease(earnings.nextReleaseAt)}, on its own.`
                    : 'Reaching your wallet shortly.'}
              </p>
              {releasedPaise > 0 && (
                <p className="text-[10px] text-emerald-200/80 mt-1">
                  {formatPaise(releasedPaise)} already paid out
                </p>
              )}
            </>
          )}
        </div>

        {earningsError && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-2.5 text-xs text-red-700 font-bold">{earningsError}</div>
        )}

        {/* Take it early */}
        {earnings && pendingPaise > 0 && (
          <button
            type="button"
            onClick={handleWithdraw}
            disabled={withdrawing || !earnings.canWithdrawNow}
            className="w-full py-3 rounded-2xl font-black text-xs bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-200 disabled:text-gray-500 text-white transition-all active:scale-95"
          >
            {withdrawing
              ? 'Moving money…'
              : earnings.canWithdrawNow
                ? `Withdraw ${formatPaise(pendingPaise)} now`
                : `${formatPaise(earnings.minEarlyPayoutPaise - pendingPaise)} more to withdraw early`}
          </button>
        )}

        {/* How the money actually moves. Replaces a "48-72 hour security hold"
            and a weekly disbursement schedule, neither of which existed. */}
        <div className="bg-white border border-gray-100 rounded-2xl p-4 flex gap-3 shadow-sm">
          <Wallet className="w-5 h-5 text-emerald-700 shrink-0 mt-0.5" />
          <div>
            <p className="text-[11px] font-black text-gray-900">How you get paid</p>
            <p className="text-[10px] text-gray-500 mt-0.5 leading-relaxed">
              An order earns you money the moment the customer takes delivery — not when it
              is accepted, and not when it is packed. It is then held for{' '}
              {earnings?.holdHours ?? 24} hours and moves into your VegDrop wallet by itself.
              You can take it sooner once there is at least{' '}
              {formatPaise(earnings?.minEarlyPayoutPaise ?? 20000)} waiting.
            </p>
          </div>
        </div>

        {/* Where it goes */}
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 space-y-4">
          <div className="flex items-center gap-3 pb-3 border-b border-gray-100">
            <div className="w-10 h-10 rounded-2xl bg-emerald-100 flex items-center justify-center">
              <Lock className="w-5 h-5 text-emerald-700" />
            </div>
            <div>
              <h3 className="font-extrabold text-gray-900 text-sm">Your bank details</h3>
              <p className="text-[10px] text-gray-400">Verified once, then never shown in full</p>
            </div>
          </div>

          {verified ? (
            <dl className="space-y-2 text-xs">
              <div className="flex justify-between gap-3">
                <dt className="text-gray-500 font-semibold">Account holder</dt>
                <dd className="font-bold text-gray-900 text-right">{kyc.legalName}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-gray-500 font-semibold">Account</dt>
                <dd className="font-bold text-gray-900 font-mono">{kyc.bankAccount}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-gray-500 font-semibold">IFSC</dt>
                <dd className="font-bold text-gray-900 font-mono">{kyc.ifsc}</dd>
              </div>
              {kyc.upiVpa && (
                <div className="flex justify-between gap-3">
                  <dt className="text-gray-500 font-semibold">UPI</dt>
                  <dd className="font-bold text-gray-900 font-mono truncate">{kyc.upiVpa}</dd>
                </div>
              )}
              <div className="flex justify-between gap-3">
                <dt className="text-gray-500 font-semibold">PAN</dt>
                <dd className="font-bold text-gray-900 font-mono">{kyc.pan}</dd>
              </div>
            </dl>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-gray-600 leading-relaxed">
                {kycStatus === 'penny_sent'
                  ? 'We have sent a small amount to your UPI ID. Enter the exact figure you received to finish verifying — we deliberately do not tell you what it was.'
                  : kycStatus === 'rejected'
                    ? kyc?.rejectionReason || 'Your last submission was rejected. You can submit again.'
                    : 'Add your PAN and settlement account so we have somewhere to send your earnings.'}
              </p>
              <button
                type="button"
                onClick={onOpenKyc}
                className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold py-3 rounded-xl transition-all shadow-md text-xs active:scale-95"
              >
                {kycStatus === 'penny_sent' ? 'Confirm the amount you received' : 'Set up payouts'}
              </button>
            </div>
          )}

          {verified && (
            <button
              type="button"
              onClick={onOpenKyc}
              className="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 font-extrabold py-2.5 rounded-xl transition-all text-xs active:scale-95"
            >
              Change bank details
            </button>
          )}
        </div>

        {/* Recent payouts */}
        {earnings?.recent?.length > 0 && (
          <div className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100">
            <h3 className="font-extrabold text-gray-900 text-sm mb-3">Recent orders</h3>
            <div className="space-y-2">
              {earnings.recent.slice(0, 10).map((row) => (
                <div key={row.id} className="flex items-center justify-between gap-3 py-1.5 border-b border-gray-50 last:border-0">
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-gray-900 font-mono truncate">{row.orderNumber}</p>
                    <p className="text-[10px] text-gray-400">
                      {row.itemCount} item{row.itemCount === 1 ? '' : 's'} · {new Date(row.earnedAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs font-black text-emerald-700">{formatPaise(row.netPaise)}</p>
                    <p className={`text-[9px] font-bold ${row.status === 'released' ? 'text-gray-400' : 'text-amber-600'}`}>
                      {row.status === 'released' ? 'Paid' : 'Held'}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="min-h-[100dvh] bg-gray-50 flex flex-col font-sans relative max-w-md mx-auto shadow-2xl overflow-hidden border-x border-gray-200">
      {/* Header */}
      <header className="bg-white px-5 py-3 border-b border-gray-100 shadow-sm sticky top-0 z-40 flex items-center justify-between">
        <div>
          <h1 className="font-black text-lg text-gray-900 tracking-tight">
            {activeTab === 'dashboard' && 'Vendor Dashboard'}
            {activeTab === 'orders' && 'Order Management'}
            {activeTab === 'products' && 'Product Catalog'}
            {activeTab === 'analytics' && 'Analytics & Earnings'}
            {activeTab === 'profile' && 'Shop Settings'}
          </h1>
          <p className="text-[10px] text-emerald-600 font-bold flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping"></span>
            <span>Live Auto-Sync Active</span>
          </p>
        </div>

        <button
          onClick={onSyncOrders}
          className="flex items-center gap-1.5 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 text-emerald-700 px-3 py-1.5 rounded-xl text-xs font-black transition-all active:scale-95 shadow-xs shrink-0 cursor-pointer"
          title="Sync latest customer orders"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Sync Orders</span>
        </button>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 p-4 overflow-y-auto relative">
        {activeTab === 'dashboard' && renderDashboard()}
        {activeTab === 'orders' && renderOrders()}
        {activeTab === 'products' && renderProducts()}
        {activeTab === 'analytics' && renderAnalytics()}
        {activeTab === 'profile' && renderProfile()}

        {activeScreen === 'inventory' && renderInventory()}
        {activeScreen === 'hours' && renderBusinessHours()}
        {activeScreen === 'bank' && renderBankDetails()}
      </main>

      {/* ✏️ EDIT PROFILE MODAL */}
      {isEditProfileOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 z-[100] animate-fade-in">
          <div className="bg-white rounded-3xl w-full max-w-sm p-6 shadow-2xl border border-gray-100 relative space-y-4 animate-scale-in">
            <button
              onClick={() => setIsEditProfileOpen(false)}
              className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 p-1.5 rounded-full hover:bg-gray-100 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-emerald-100 text-[#1B4D3E] flex items-center justify-center font-bold text-xl shadow-xs">
                <Edit className="w-5 h-5 text-emerald-700" />
              </div>
              <div>
                <h3 className="font-extrabold text-gray-900 text-base">Edit Shopkeeper Profile</h3>
                <p className="text-[11px] text-emerald-700 font-bold">Update store & license details</p>
              </div>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                const updated = {
                  ...profileData,
                  isShopNoLocked: Boolean(profileData.shopNo && profileData.shopNo.trim().length > 0)
                };
                setProfileData(updated);
                try {
                  const savedKey = `vegdrop_shopkeeper_profile_${profileData.phone || user?.phone || 'default'}`;
                  localStorage.setItem(savedKey, JSON.stringify(updated));
                  localStorage.setItem('vegdrop_shopkeeper_profile', JSON.stringify(updated));
                } catch(err) {}
                setIsEditProfileOpen(false);
              }}
              className="space-y-3 text-xs"
            >
              <div>
                <label className="block font-bold text-gray-800 mb-1">Shop / Vendor Name</label>
                <input
                  type="text"
                  value={profileData.shopName}
                  onChange={(e) => setProfileData({ ...profileData, shopName: e.target.value })}
                  className="w-full bg-gray-50 border border-gray-300 rounded-xl px-3 py-2 text-xs font-semibold text-gray-900 focus:outline-none focus:border-emerald-600"
                  required
                />
              </div>

              {/* Shop No (Once set, locked permanently) */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="font-bold text-gray-800">Shop No / ID</label>
                  {profileData.isShopNoLocked && (
                    <span className="text-[10px] text-amber-700 font-black flex items-center gap-1 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200">
                      <Lock className="w-3 h-3" /> Locked
                    </span>
                  )}
                </div>
                <div className="relative">
                  <input
                    type="text"
                    value={profileData.shopNo}
                    onChange={(e) => !profileData.isShopNoLocked && setProfileData({ ...profileData, shopNo: e.target.value })}
                    disabled={profileData.isShopNoLocked}
                    placeholder="Enter Shop Number"
                    className={`w-full border rounded-xl px-3 py-2 text-xs font-semibold ${
                      profileData.isShopNoLocked 
                        ? 'bg-gray-100 border-gray-200 text-gray-500 cursor-not-allowed pr-9 font-mono' 
                        : 'bg-gray-50 border-gray-300 text-gray-900 focus:outline-none focus:border-emerald-600'
                    }`}
                    required
                  />
                  {profileData.isShopNoLocked && (
                    <Lock className="w-4 h-4 text-gray-400 absolute right-3 top-2.5 pointer-events-none" />
                  )}
                </div>
                <p className="text-[10px] text-gray-400 mt-1">
                  {profileData.isShopNoLocked 
                    ? '🔒 Shop No is permanently locked and cannot be edited.' 
                    : '⚡ Once you save your Shop No, it cannot be changed.'}
                </p>
              </div>

              {/* Phone Number — locked to editing here, but changeable through
                  its own OTP-verified flow rather than as a plain text field. */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="font-bold text-gray-800">Phone Number</label>
                  {phoneChangeStep === 'idle' && (
                    <span className="text-[10px] text-amber-700 font-black flex items-center gap-1 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200">
                      <Lock className="w-3 h-3" /> Locked
                    </span>
                  )}
                </div>

                {phoneChangeStep === 'idle' && (
                  <>
                    <div className="relative">
                      <input
                        type="text"
                        value={profileData.phone}
                        disabled={true}
                        readOnly={true}
                        className="w-full bg-gray-100 border border-gray-200 rounded-xl px-3 py-2 text-xs font-semibold text-gray-500 cursor-not-allowed pr-9 font-mono"
                      />
                      <Lock className="w-4 h-4 text-gray-400 absolute right-3 top-2.5 pointer-events-none" />
                    </div>
                    <div className="flex items-center justify-between mt-1">
                      <p className="text-[10px] text-gray-400">🔒 Verified. Changing it needs a new code.</p>
                      <button
                        type="button"
                        onClick={() => setPhoneChangeStep('enter')}
                        className="text-[10px] font-bold text-emerald-700 underline underline-offset-2 shrink-0 ml-2"
                      >
                        Change
                      </button>
                    </div>
                  </>
                )}

                {phoneChangeStep === 'enter' && (
                  <div className="bg-emerald-50/60 border border-emerald-100 rounded-xl p-3 space-y-2">
                    <div className="relative flex items-center">
                      <span className="absolute left-3 text-xs font-semibold text-gray-500 pointer-events-none">+91</span>
                      <input
                        type="tel"
                        inputMode="numeric"
                        autoFocus
                        value={newPhone}
                        onChange={(e) => setNewPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                        maxLength={10}
                        placeholder="New 10-digit number"
                        className="w-full bg-white border border-gray-300 rounded-xl pl-10 pr-3 py-2 text-xs font-semibold text-gray-900 font-mono focus:outline-none focus:border-emerald-600"
                      />
                    </div>
                    {phoneChangeError && <p className="text-[10px] text-red-600 font-semibold">{phoneChangeError}</p>}
                    <p className="text-[10px] text-gray-500">
                      We'll text a code to this number. Every other device you're signed in on will be signed out once it's confirmed.
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={handleSendPhoneCode}
                        disabled={phoneChangeBusy}
                        className="flex-1 bg-emerald-600 text-white font-bold py-2 rounded-lg text-[11px] disabled:opacity-50"
                      >
                        {phoneChangeBusy ? 'Sending…' : 'Send code'}
                      </button>
                      <button
                        type="button"
                        onClick={resetPhoneChange}
                        disabled={phoneChangeBusy}
                        className="px-3 bg-white border border-gray-300 text-gray-600 font-bold py-2 rounded-lg text-[11px]"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {phoneChangeStep === 'code' && (
                  <div className="bg-emerald-50/60 border border-emerald-100 rounded-xl p-3 space-y-2">
                    <p className="text-[10px] text-gray-600 font-semibold">
                      Code sent to +91 {newPhone}
                    </p>
                    <OTPBoxGroup value={phoneCode} onChange={setPhoneCode} />
                    {phoneChangeError && <p className="text-[10px] text-red-600 font-semibold">{phoneChangeError}</p>}
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={handleVerifyPhoneCode}
                        disabled={phoneChangeBusy || phoneCode.length !== 6}
                        className="flex-1 bg-emerald-600 text-white font-bold py-2 rounded-lg text-[11px] disabled:opacity-50"
                      >
                        {phoneChangeBusy ? 'Verifying…' : 'Verify and update'}
                      </button>
                      <button
                        type="button"
                        onClick={resetPhoneChange}
                        disabled={phoneChangeBusy}
                        className="px-3 bg-white border border-gray-300 text-gray-600 font-bold py-2 rounded-lg text-[11px]"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div>
                <label className="block font-bold text-gray-800 mb-1">Shop Address</label>
                <textarea
                  rows={2}
                  value={profileData.address}
                  onChange={(e) => setProfileData({ ...profileData, address: e.target.value })}
                  className="w-full bg-gray-50 border border-gray-300 rounded-xl px-3 py-2 text-xs font-semibold text-gray-900 focus:outline-none focus:border-emerald-600"
                />
              </div>

              <button
                type="submit"
                className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold py-3 rounded-xl transition-all shadow-md text-xs cursor-pointer active:scale-95 mt-2"
              >
                Save Changes
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Bottom Navigation */}
      <nav className="fixed bottom-0 left-0 right-0 mx-auto w-full max-w-md bg-white border-t border-gray-200 pb-safe pt-2 px-6 flex justify-between items-center shadow-[0_-10px_20px_rgba(0,0,0,0.03)] z-40 rounded-t-3xl">
        <NavButton icon={LayoutDashboard} label="Home" isActive={activeTab === 'dashboard'} onClick={() => { setActiveTab('dashboard'); setActiveScreen('list'); }} />
        <NavButton icon={Package} label="Orders" isActive={activeTab === 'orders'} onClick={() => { setActiveTab('orders'); setActiveScreen('list'); }} />
        <NavButton icon={Store} label="Products" isActive={activeTab === 'products'} onClick={() => { setActiveTab('products'); setActiveScreen('list'); }} />
        <NavButton icon={BarChart3} label="Analytics" isActive={activeTab === 'analytics'} onClick={() => { setActiveTab('analytics'); setActiveScreen('list'); }} />
        <NavButton icon={User} label="Profile" isActive={activeTab === 'profile'} onClick={() => { setActiveTab('profile'); setActiveScreen('list'); }} />
      </nav>
    </div>
  );
}

const NavButton = ({ icon: Icon, label, isActive, onClick }) => (
  <button 
    onClick={onClick} 
    className="flex flex-col items-center gap-1 p-2 active:scale-90 transition-transform"
  >
    <div className={`p-1.5 rounded-xl transition-colors ${isActive ? 'bg-green-100 text-green-700' : 'text-gray-400'}`}>
      <Icon className="w-5 h-5" strokeWidth={isActive ? 2.5 : 2} />
    </div>
    <span className={`text-[10px] font-bold ${isActive ? 'text-green-700' : 'text-gray-400'}`}>{label}</span>
  </button>
);
