import React, { useState, useEffect } from 'react';
import {
  Store, Package, ShoppingBag, CheckCircle2, Clock, Truck,
  MapPin, LogOut, User, LayoutDashboard, Plus, Edit, Trash2,
  AlertTriangle, Navigation, Check, Camera, MessageSquare, TrendingUp, BarChart3, Star, Settings, ArrowLeft, Wallet, RefreshCw, X, Lock, ShieldAlert
} from 'lucide-react';
import { startPhoneChange, verifyPhoneChange, describePhoneProblem } from '../services/auth';
import { ApiRequestError } from '../services/apiClient';
import OTPBoxGroup from './OTPBoxGroup';

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

  // Navigation & State
  const [activeTab, setActiveTab] = useState('dashboard');
  const [isStoreOnline, setIsStoreOnline] = useState(true);
  const [activeScreen, setActiveScreen] = useState('list'); // 'list', 'add-product', 'edit-product', 'inventory', 'reviews', 'settings', 'delivery-assign'
  
  // Modals & deep dive
  const [selectedOrder, setSelectedOrder] = useState(null);
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

  const [bankSearch, setBankSearch] = useState('');
  const [bankDropdownOpen, setBankDropdownOpen] = useState(false);

  const ALL_INDIAN_BANKS = [
    { group: 'Public Sector Banks', banks: ['State Bank of India (SBI)', 'Bank of Baroda (BOB)', 'Bank of India (BOI)', 'Bank of Maharashtra (BOM)', 'Canara Bank', 'Central Bank of India', 'Indian Bank', 'Indian Overseas Bank (IOB)', 'Punjab & Sind Bank', 'Punjab National Bank (PNB)', 'UCO Bank', 'Union Bank of India'] },
    { group: 'Private Sector Banks', banks: ['Axis Bank', 'Bandhan Bank', 'City Union Bank', 'CSB Bank (Catholic Syrian Bank)', 'DCB Bank', 'Dhanlaxmi Bank', 'Federal Bank', 'HDFC Bank', 'ICICI Bank', 'IDBI Bank', 'IDFC FIRST Bank', 'IndusInd Bank', 'Jammu & Kashmir Bank (JKB)', 'Karnataka Bank', 'Karur Vysya Bank (KVB)', 'Kotak Mahindra Bank', 'Lakshmi Vilas Bank', 'Nainital Bank', 'RBL Bank', 'South Indian Bank', 'Tamilnad Mercantile Bank (TMB)', 'Yes Bank'] },
    { group: 'Small Finance Banks', banks: ['AU Small Finance Bank', 'Capital Small Finance Bank', 'Equitas Small Finance Bank', 'ESAF Small Finance Bank', 'Fincare Small Finance Bank', 'Jana Small Finance Bank', 'North East Small Finance Bank', 'Shivalik Small Finance Bank', 'Suryoday Small Finance Bank', 'Ujjivan Small Finance Bank', 'Unity Small Finance Bank', 'Utkarsh Small Finance Bank'] },
    { group: 'Payment Banks', banks: ['Airtel Payments Bank', 'India Post Payments Bank (IPPB)', 'Fino Payments Bank', 'NSDL Payments Bank', 'Jio Payments Bank', 'Paytm Payments Bank'] },
    { group: 'Foreign Banks', banks: ['Citibank India', 'Deutsche Bank India', 'DBS Bank India', 'HSBC India', 'Standard Chartered Bank India'] },
    { group: 'Co-operative / Regional', banks: ['Saraswat Bank', 'Abhyudaya Bank', 'TJSB Sahakari Bank', 'Cosmos Bank', 'Other Co-operative Bank'] },
  ];

  const bankDetails_allBanks = ALL_INDIAN_BANKS.flatMap(g => g.banks);
  const filteredBankGroups = bankSearch.trim()
    ? [{ group: 'Search Results', banks: bankDetails_allBanks.filter(b => b.toLowerCase().includes(bankSearch.toLowerCase())) }]
    : ALL_INDIAN_BANKS;

  const [bankDetails, setBankDetails] = useState(() => {
    try {
      const saved = localStorage.getItem('vegdrop_shopkeeper_bank');
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return {
      bankName: 'State Bank of India (SBI)',
      accountHolder: user?.name || 'Saibhargav Gooty',
      accountNumber: '38291048592',
      confirmAccountNumber: '38291048592',
      accountType: 'Current',
      ifscCode: 'SBIN0021482',
      upiId: 'vegdrop.vendor@okicici',
      panNumber: '',
      gstin: '',
      settlementCycle: 'Weekly (Every Monday)',
      pendingAmount: '₹4,850.00',
      isVerified: true,
      verificationStatus: 'verified', // 'unverified' | 'pending' | 'verified'
    };
  });

  const [bankFormError, setBankFormError] = useState('');
  const [pennyDropStatus, setPennyDropStatus] = useState('idle'); // 'idle' | 'loading' | 'success' | 'failed'
  const [showSecurityHold, setShowSecurityHold] = useState(false);

  const validateIFSC = (code) => /^[A-Z]{4}0[A-Z0-9]{6}$/.test(code);
  const validatePAN = (pan) => pan === '' || /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(pan);
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
  const revenueToday = deliveredOrders.reduce((sum, o) => sum + o.totalAmount, 0);
  const lowStockItems = products ? products.filter((p) => p.isOutofStock) : [];

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

  const handleAssignDelivery = (orderId) => {
    const order = orders.find(o => o.id === orderId);
    onUpdateOrderStatus(orderId, 'Preparing'); // Transition to preparing (which driver sees as 'ready for pickup')
    if (order && onOrderAccepted) {
      onOrderAccepted(order); // 🔔 Push notification to Delivery Panel
    }
    setSelectedOrder(null);
    setActiveScreen('list');
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
                onClick={() => {
                  setSelectedProduct(product);
                  setImagePreviewError(false);
                  setProductFormError('');
                  setProductForm({
                    name: product.name,
                    categoryId: product.categoryId,
                    price: product.price,
                    weight: product.weight || '',
                    stock: product.stock || 0,
                    image: product.image || ''
                  });
                  setActiveScreen('edit-product');
                }}
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
    if (activeScreen === 'delivery-assign') {
      return (
        <div className="space-y-6 pb-20 animate-fade-in">
          <div className="flex items-center gap-3 mb-4">
            <button onClick={() => setActiveScreen('list')} className="p-2 rounded-full bg-gray-100"><ArrowLeft className="w-5 h-5" /></button>
            <h2 className="font-black text-xl text-gray-900">Assign Delivery</h2>
          </div>
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100 space-y-4">
            <h3 className="font-bold text-gray-700">Available Delivery Partners</h3>
            <div className="border border-green-200 bg-green-50 rounded-xl p-4 flex items-center justify-between cursor-pointer active:scale-95 transition-transform" onClick={() => handleAssignDelivery(selectedOrder?.id)}>
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 bg-gray-200 rounded-full bg-[url('https://images.unsplash.com/photo-1599566150163-29194dcaad36?auto=format&fit=crop&q=80&w=150')] bg-cover" />
                <div>
                  <h4 className="font-black text-gray-900 text-sm">Rahul K.</h4>
                  <p className="text-xs text-gray-500 font-bold">4.9 ⭐ • 0.5 km away</p>
                </div>
              </div>
              <button className="bg-green-600 text-white font-bold px-3 py-1.5 rounded-lg text-xs shadow-sm">Assign</button>
            </div>
            <div className="border border-gray-200 rounded-xl p-4 flex items-center justify-between opacity-60">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 bg-gray-200 rounded-full bg-[url('https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&q=80&w=150')] bg-cover" />
                <div>
                  <h4 className="font-black text-gray-900 text-sm">Suresh M.</h4>
                  <p className="text-xs text-gray-500 font-bold">4.7 ⭐ • 1.2 km away</p>
                </div>
              </div>
              <button className="bg-gray-200 text-gray-600 font-bold px-3 py-1.5 rounded-lg text-xs" disabled>Busy</button>
            </div>
          </div>
        </div>
      );
    }

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
                  <p className="text-xs text-gray-500 mb-1">{order.customerName} • {order.items?.length} items</p>
                  {/* Customer delivery address */}
                  {(order.deliveryAddress || order.address) && (
                    <div className="flex items-start gap-1.5 mb-2 bg-orange-50 border border-orange-100 rounded-lg px-2 py-1.5">
                      <MapPin className="w-3.5 h-3.5 text-orange-500 mt-0.5 shrink-0" />
                      <p className="text-[11px] text-gray-600 leading-tight">{order.deliveryAddress || order.address}</p>
                    </div>
                  )}
                  {/* Item list */}
                  <p className="text-[11px] text-gray-400 mb-3 line-clamp-2">{order.items?.map(i => `${i.quantity}x ${i.name}`).join(', ')}</p>
                  <div className="flex gap-2">
                    <button className="flex-1 py-2 bg-gray-100 text-gray-600 rounded-lg font-bold text-xs">Reject</button>
                    <button onClick={() => { setSelectedOrder(order); setActiveScreen('delivery-assign'); }} className="flex-1 py-2 bg-orange-500 text-white rounded-lg font-bold text-xs shadow-sm active:scale-95 transition-transform">Accept & Assign</button>
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
                  <button className="w-full py-2 bg-gray-100 text-gray-600 rounded-lg font-bold text-xs border border-gray-200 pointer-events-none">Waiting for pickup scan...</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderAnalytics = () => (
    <div className="space-y-6 animate-fade-in pb-20">
      <div className="bg-gradient-to-br from-green-800 to-green-600 p-6 rounded-3xl shadow-xl text-white">
        <span className="block text-green-200 text-sm font-bold uppercase tracking-wider mb-1">Today's Revenue</span>
        <h2 className="text-5xl font-black mb-4">₹{revenueToday}</h2>
        <div className="flex justify-between items-center border-t border-green-700/50 pt-4 mt-2">
          <div>
            <span className="block text-xs text-green-200">This Week</span>
            <span className="font-bold text-lg">₹{revenueToday * 4}</span>
          </div>
          <button className="bg-white text-green-900 px-4 py-2 rounded-xl font-black text-xs shadow-md active:scale-95 transition-transform">
            Withdraw
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100">
          <BarChart3 className="w-6 h-6 text-orange-500 mb-2" />
          <p className="text-xs font-bold text-gray-500 mb-1">Orders</p>
          <p className="font-black text-xl text-gray-900">{orders.length}</p>
        </div>
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100">
          <TrendingUp className="w-6 h-6 text-green-500 mb-2" />
          <p className="text-xs font-bold text-gray-500 mb-1">Conversion</p>
          <p className="font-black text-xl text-gray-900">12.4%</p>
        </div>
      </div>

      <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
        <h3 className="font-black text-gray-900 mb-4 border-b pb-2">Top Selling Items</h3>
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <span className="font-bold text-gray-700 text-sm">Organic Onions</span>
            <span className="text-green-600 font-black text-sm">124 Kg</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="font-bold text-gray-700 text-sm">Fresh Tomatoes</span>
            <span className="text-green-600 font-black text-sm">89 Kg</span>
          </div>
        </div>
      </div>
      
      <button className="w-full bg-gray-100 text-gray-700 font-bold py-4 rounded-2xl active:scale-95 transition-transform border border-gray-200">
        Download Full Report
      </button>
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
        <div className="inline-flex bg-green-50 text-green-700 px-4 py-1.5 rounded-full font-bold text-sm border border-green-200">
          Super Seller 🏆
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <button onClick={() => setActiveScreen('reviews')} className="w-full p-4 flex justify-between items-center border-b border-gray-50 hover:bg-gray-50 active:bg-gray-100 transition-colors text-left cursor-pointer">
          <div className="flex items-center gap-3">
            <Star className="w-5 h-5 text-orange-500" />
            <span className="font-bold text-gray-700">Customer Reviews</span>
          </div>
          <span className="text-gray-400 font-bold">›</span>
        </button>
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
              <p className="text-xs text-gray-500">{p.isOutofStock ? '0' : (p.stock || 50)} {p.unit} remaining</p>
            </div>
            <button className="bg-gray-100 text-gray-600 px-3 py-1.5 rounded-lg text-xs font-bold active:scale-95">Update</button>
          </div>
        ))}
      </div>
    </div>
  );

  const renderReviews = () => (
    <div className="space-y-6 pb-20 animate-fade-in absolute inset-0 bg-gray-50 z-50 p-4 overflow-y-auto">
      <div className="flex items-center gap-3 mb-4 sticky top-0 bg-gray-50 py-2">
        <button onClick={() => setActiveScreen('list')} className="p-2 rounded-full bg-gray-200"><ArrowLeft className="w-5 h-5" /></button>
        <h2 className="font-black text-xl text-gray-900">Customer Reviews</h2>
      </div>

      <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 text-center mb-6">
        <div className="text-5xl font-black text-gray-900 mb-2">4.8</div>
        <div className="flex justify-center gap-1 text-orange-500 mb-2">
          <Star className="w-5 h-5 fill-current" /><Star className="w-5 h-5 fill-current" /><Star className="w-5 h-5 fill-current" /><Star className="w-5 h-5 fill-current" /><Star className="w-5 h-5 fill-current" />
        </div>
        <p className="text-sm text-gray-500 font-bold">Based on 1,204 reviews</p>
      </div>

      <div className="space-y-4">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="bg-white p-4 rounded-xl border border-gray-100 shadow-sm">
            <div className="flex justify-between mb-2">
              <span className="font-bold text-sm text-gray-900">{i === 0 ? 'Rahul Sharma' : i === 1 ? 'Priya Verma' : 'Srinivas Rao'}</span>
              <span className="text-xs text-gray-400">{i === 0 ? '2 days ago' : i === 1 ? '4 days ago' : '1 week ago'}</span>
            </div>
            <div className="flex gap-1 text-orange-500 mb-2">
              <Star className="w-3 h-3 fill-current" /><Star className="w-3 h-3 fill-current" /><Star className="w-3 h-3 fill-current" /><Star className="w-3 h-3 fill-current" /><Star className="w-3 h-3 fill-current" />
            </div>
            <p className="text-sm text-gray-600 mb-3">
              {i === 0 && '"Fresh vegetables and super fast delivery. The tomatoes were excellent!"'}
              {i === 1 && '"Always high quality organic produce. Packaged very cleanly."'}
              {i === 2 && '"Best vegetable shop in Mylavaram area. Highly recommended!"'}
            </p>
            <button className="text-green-600 text-xs font-bold bg-green-50 px-3 py-1.5 rounded-lg active:scale-95 cursor-pointer">Reply to Customer</button>
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

  const renderBankDetails = () => (
    <div className="space-y-4 pb-20 animate-fade-in absolute inset-0 bg-gray-50 z-50 p-4 overflow-y-auto">
      {/* Header */}
      <div className="flex items-center gap-3 sticky top-0 bg-gray-50 py-2 z-10">
        <button onClick={() => { setActiveScreen('list'); setBankFormError(''); setPennyDropStatus('idle'); setShowSecurityHold(false); }} className="p-2 rounded-full bg-gray-200 hover:bg-gray-300 transition-colors">
          <ArrowLeft className="w-5 h-5 text-gray-700" />
        </button>
        <h2 className="font-black text-xl text-gray-900">Bank & Payout Details</h2>
      </div>

      {/* Payout Balance Card */}
      <div className="bg-gradient-to-r from-[#1B4D3E] to-[#276652] p-5 rounded-2xl text-white shadow-md">
        <div className="flex justify-between items-center mb-1">
          <span className="text-[10px] text-emerald-200 font-bold uppercase tracking-wider">Payout Settlement Account</span>
          <span className={`px-2 py-0.5 rounded-full text-[10px] font-black border ${
            bankDetails.verificationStatus === 'verified' ? 'bg-emerald-400/20 text-emerald-300 border-emerald-400/30' :
            bankDetails.verificationStatus === 'pending' ? 'bg-yellow-400/20 text-yellow-300 border-yellow-400/30' :
            'bg-red-400/20 text-red-300 border-red-400/30'
          }`}>
            {bankDetails.verificationStatus === 'verified' ? '✓ Verified' : bankDetails.verificationStatus === 'pending' ? '⏳ Pending' : '✗ Unverified'}
          </span>
        </div>
        <p className="text-2xl font-black font-mono tracking-wider">{bankDetails.pendingAmount}</p>
        <p className="text-[11px] text-emerald-100 mt-1">Next settlement: {bankDetails.settlementCycle}</p>
        {showSecurityHold && (
          <div className="mt-3 bg-yellow-400/20 border border-yellow-300/30 rounded-xl p-2.5">
            <p className="text-[10px] text-yellow-200 font-bold">⚠️ Security Hold Active: Bank details were recently modified. Payouts are on hold for 48 hours for fraud protection.</p>
          </div>
        )}
      </div>

      {/* Security Notice */}
      <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex gap-3">
        <span className="text-lg">🔒</span>
        <div>
          <p className="text-[11px] font-black text-amber-900">Security Policy (Amazon-style)</p>
          <p className="text-[10px] text-amber-700 mt-0.5 leading-relaxed">Whenever you update bank details, a <strong>48–72 hour payout hold</strong> is automatically applied to prevent unauthorized fund hijacking. Your earnings are safe.</p>
        </div>
      </div>

      {/* Error */}
      {bankFormError && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-2.5 text-xs text-red-700 font-bold">{bankFormError}</div>
      )}

      {/* Main Form */}
      <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 space-y-4">
        <div className="flex items-center gap-3 pb-3 border-b border-gray-100">
          <div className="w-10 h-10 rounded-2xl bg-emerald-100 flex items-center justify-center"><Wallet className="w-5 h-5 text-emerald-700" /></div>
          <div>
            <h3 className="font-extrabold text-gray-900 text-sm">Bank Account Details</h3>
            <p className="text-[10px] text-gray-400">Used for weekly payout disbursements</p>
          </div>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            setBankFormError('');
            // Validate
            if (bankDetails.accountNumber !== bankDetails.confirmAccountNumber) {
              setBankFormError('Account numbers do not match. Please re-enter carefully.');
              return;
            }
            if (!validateIFSC(bankDetails.ifscCode)) {
              setBankFormError('Invalid IFSC code format. Must be like: SBIN0021482');
              return;
            }
            if (bankDetails.panNumber && !validatePAN(bankDetails.panNumber)) {
              setBankFormError('Invalid PAN number format. Must be like: ABCDE1234F');
              return;
            }
            const updated = { ...bankDetails, verificationStatus: 'pending', isVerified: false };
            setBankDetails(updated);
            setShowSecurityHold(true);
            try { localStorage.setItem('vegdrop_shopkeeper_bank', JSON.stringify(updated)); } catch (err) {}
            setActiveScreen('list');
          }}
          className="space-y-3 text-xs"
        >
          {/* Bank Name Searchable Picker */}
          <div className="relative">
            <label className="block font-bold text-gray-800 mb-1">Bank Name <span className="text-red-500">*</span></label>
            <div
              className="w-full bg-gray-50 border border-gray-300 rounded-xl px-3 py-2 text-xs font-semibold text-gray-900 cursor-pointer flex justify-between items-center hover:border-emerald-500 transition-colors"
              onClick={() => { setBankDropdownOpen(o => !o); setBankSearch(''); }}
            >
              <span className={bankDetails.bankName ? 'text-gray-900' : 'text-gray-400'}>{bankDetails.bankName || '-- Select Your Bank --'}</span>
              <svg className={`w-4 h-4 text-gray-400 transition-transform ${bankDropdownOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </div>
            {bankDropdownOpen && (
              <div className="absolute z-50 left-0 right-0 mt-1 bg-white border border-gray-200 rounded-2xl shadow-xl overflow-hidden">
                <div className="p-2 border-b border-gray-100 bg-gray-50">
                  <div className="relative">
                    <svg className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                    <input type="text" autoFocus value={bankSearch} onChange={(e) => setBankSearch(e.target.value)} placeholder="Search bank..." className="w-full bg-white border border-gray-200 rounded-lg pl-8 pr-3 py-1.5 text-xs font-semibold text-gray-900 focus:outline-none focus:border-emerald-500" />
                  </div>
                </div>
                <div className="max-h-48 overflow-y-auto">
                  {filteredBankGroups.map(({ group, banks }) => banks.length > 0 && (
                    <div key={group}>
                      <div className="px-3 py-1 text-[10px] font-black text-gray-400 uppercase tracking-wider bg-gray-50 border-b border-gray-100">{group}</div>
                      {banks.map(bank => (
                        <button key={bank} type="button" onClick={() => { setBankDetails({ ...bankDetails, bankName: bank }); setBankDropdownOpen(false); setBankSearch(''); }}
                          className={`w-full text-left px-4 py-2 text-xs font-semibold hover:bg-emerald-50 hover:text-emerald-800 transition-colors cursor-pointer ${bankDetails.bankName === bank ? 'bg-emerald-100 text-emerald-800' : 'text-gray-800'}`}>
                          {bank}
                        </button>
                      ))}
                    </div>
                  ))}
                  {filteredBankGroups[0]?.banks?.length === 0 && <div className="px-4 py-6 text-center text-xs text-gray-400 font-semibold">No bank found</div>}
                </div>
              </div>
            )}
          </div>

          {/* Account Type */}
          <div>
            <label className="block font-bold text-gray-800 mb-1">Account Type <span className="text-red-500">*</span></label>
            <div className="grid grid-cols-2 gap-2">
              {['Savings', 'Current'].map(type => (
                <button key={type} type="button"
                  onClick={() => setBankDetails({ ...bankDetails, accountType: type })}
                  className={`py-2 rounded-xl text-xs font-black border transition-all cursor-pointer ${
                    bankDetails.accountType === type ? 'bg-emerald-600 text-white border-emerald-600 shadow-md' : 'bg-gray-50 text-gray-700 border-gray-200 hover:border-emerald-400'
                  }`}>
                  {type === 'Savings' ? '🏦 Savings' : '🏢 Current'}
                </button>
              ))}
            </div>
          </div>

          {/* Account Holder */}
          <div>
            <label className="block font-bold text-gray-800 mb-1">Account Holder Name <span className="text-red-500">*</span></label>
            <p className="text-[10px] text-gray-400 mb-1">Must match your bank-registered name exactly</p>
            <input type="text" value={bankDetails.accountHolder} onChange={(e) => setBankDetails({ ...bankDetails, accountHolder: e.target.value })}
              className="w-full bg-gray-50 border border-gray-300 rounded-xl px-3 py-2 text-xs font-semibold text-gray-900 focus:outline-none focus:border-emerald-600" required />
          </div>

          {/* Account Number + Confirm */}
          <div>
            <label className="block font-bold text-gray-800 mb-1">Account Number <span className="text-red-500">*</span></label>
            <input type="password" value={bankDetails.accountNumber} onChange={(e) => setBankDetails({ ...bankDetails, accountNumber: e.target.value })}
              className="w-full bg-gray-50 border border-gray-300 rounded-xl px-3 py-2 text-xs font-semibold text-gray-900 focus:outline-none focus:border-emerald-600 font-mono" required />
          </div>
          <div>
            <label className="block font-bold text-gray-800 mb-1">Confirm Account Number <span className="text-red-500">*</span></label>
            <input type="text" value={bankDetails.confirmAccountNumber} onChange={(e) => setBankDetails({ ...bankDetails, confirmAccountNumber: e.target.value })}
              className={`w-full bg-gray-50 border rounded-xl px-3 py-2 text-xs font-semibold text-gray-900 focus:outline-none font-mono ${
                bankDetails.confirmAccountNumber && bankDetails.accountNumber !== bankDetails.confirmAccountNumber
                  ? 'border-red-400 focus:border-red-500' : 'border-gray-300 focus:border-emerald-600'
              }`} required />
            {bankDetails.confirmAccountNumber && bankDetails.accountNumber !== bankDetails.confirmAccountNumber && (
              <p className="text-[10px] text-red-500 font-bold mt-1">⚠ Account numbers do not match</p>
            )}
            {bankDetails.confirmAccountNumber && bankDetails.accountNumber === bankDetails.confirmAccountNumber && bankDetails.confirmAccountNumber.length > 5 && (
              <p className="text-[10px] text-emerald-600 font-bold mt-1">✓ Account numbers match</p>
            )}
          </div>

          {/* IFSC */}
          <div>
            <label className="block font-bold text-gray-800 mb-1">IFSC Code <span className="text-red-500">*</span></label>
            <input type="text" value={bankDetails.ifscCode} onChange={(e) => setBankDetails({ ...bankDetails, ifscCode: e.target.value.toUpperCase() })}
              className={`w-full bg-gray-50 border rounded-xl px-3 py-2 text-xs font-semibold text-gray-900 focus:outline-none font-mono uppercase ${
                bankDetails.ifscCode && !validateIFSC(bankDetails.ifscCode) ? 'border-red-400' : 'border-gray-300 focus:border-emerald-600'
              }`} required />
            {bankDetails.ifscCode && !validateIFSC(bankDetails.ifscCode) && (
              <p className="text-[10px] text-red-500 font-bold mt-1">⚠ Format: 4 letters + 0 + 6 alphanumeric (e.g. SBIN0021482)</p>
            )}
            {bankDetails.ifscCode && validateIFSC(bankDetails.ifscCode) && (
              <p className="text-[10px] text-emerald-600 font-bold mt-1">✓ Valid IFSC format</p>
            )}
          </div>

          {/* UPI */}
          <div>
            <label className="block font-bold text-gray-800 mb-1">UPI ID <span className="text-gray-400">(Optional)</span></label>
            <input type="text" value={bankDetails.upiId} onChange={(e) => setBankDetails({ ...bankDetails, upiId: e.target.value })}
              className="w-full bg-gray-50 border border-gray-300 rounded-xl px-3 py-2 text-xs font-semibold text-gray-900 focus:outline-none focus:border-emerald-600" />
          </div>

          {/* Tax Section */}
          <div className="pt-2 border-t border-gray-100 space-y-3">
            <p className="text-[10px] font-black text-gray-500 uppercase tracking-wider">Tax Compliance (Required for Payouts)</p>
            <div>
              <label className="block font-bold text-gray-800 mb-1">PAN Number <span className="text-red-500">*</span></label>
              <input type="text" value={bankDetails.panNumber} onChange={(e) => setBankDetails({ ...bankDetails, panNumber: e.target.value.toUpperCase() })}
                placeholder="e.g. ABCDE1234F"
                className={`w-full bg-gray-50 border rounded-xl px-3 py-2 text-xs font-semibold text-gray-900 focus:outline-none font-mono uppercase ${
                  bankDetails.panNumber && !validatePAN(bankDetails.panNumber) ? 'border-red-400' : 'border-gray-300 focus:border-emerald-600'
                }`} />
              {bankDetails.panNumber && !validatePAN(bankDetails.panNumber) && (
                <p className="text-[10px] text-red-500 font-bold mt-1">⚠ PAN format: 5 letters + 4 digits + 1 letter (e.g. ABCDE1234F)</p>
              )}
            </div>
            <div>
              <label className="block font-bold text-gray-800 mb-1">GSTIN <span className="text-gray-400">(Optional)</span></label>
              <input type="text" value={bankDetails.gstin} onChange={(e) => setBankDetails({ ...bankDetails, gstin: e.target.value.toUpperCase() })}
                placeholder="e.g. 29ABCDE1234F1Z5"
                className="w-full bg-gray-50 border border-gray-300 rounded-xl px-3 py-2 text-xs font-semibold text-gray-900 focus:outline-none focus:border-emerald-600 font-mono uppercase" />
            </div>
          </div>

          {/* Settlement Cycle */}
          <div>
            <label className="block font-bold text-gray-800 mb-1">Disbursement Schedule</label>
            <select value={bankDetails.settlementCycle} onChange={(e) => setBankDetails({ ...bankDetails, settlementCycle: e.target.value })}
              className="w-full bg-gray-50 border border-gray-300 rounded-xl px-3 py-2 text-xs font-semibold text-gray-900 focus:outline-none focus:border-emerald-600">
              <option>Weekly (Every Monday)</option>
              <option>Bi-Weekly (Every 14 days)</option>
              <option>Monthly (1st of every month)</option>
              <option>On-demand (After delivery confirmation)</option>
            </select>
          </div>

          {/* Penny Drop Verification */}
          <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4 space-y-2">
            <p className="text-[11px] font-black text-blue-900">🔍 Penny Drop Verification</p>
            <p className="text-[10px] text-blue-700 leading-relaxed">We will deposit ₹1 into your account to verify ownership. The credited amount will be automatically deducted from your first payout.</p>
            {pennyDropStatus === 'idle' && (
              <button type="button"
                onClick={() => {
                  if (!bankDetails.accountNumber || !bankDetails.ifscCode || !validateIFSC(bankDetails.ifscCode)) {
                    setBankFormError('Please fill valid Account Number and IFSC before verifying.');
                    return;
                  }
                  setPennyDropStatus('loading');
                  setTimeout(() => { setPennyDropStatus('success'); setBankDetails(d => ({ ...d, verificationStatus: 'verified', isVerified: true })); }, 2500);
                }}
                className="w-full py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-extrabold rounded-xl transition-all cursor-pointer active:scale-95">
                Verify Bank Account (₹1 Drop)
              </button>
            )}
            {pennyDropStatus === 'loading' && (
              <div className="flex items-center gap-2 text-blue-700 text-[11px] font-bold">
                <div className="w-4 h-4 border-2 border-blue-400 border-t-blue-700 rounded-full animate-spin"></div>
                Sending ₹1 to your account...
              </div>
            )}
            {pennyDropStatus === 'success' && (
              <div className="flex items-center gap-2 text-emerald-700 text-[11px] font-black">
                <Check className="w-4 h-4" /> ₹1 credited successfully — Account Verified! ✓
              </div>
            )}
            {pennyDropStatus === 'failed' && (
              <div className="flex items-center gap-2 text-red-600 text-[11px] font-black">
                ✗ Verification failed. Please check your account details.
              </div>
            )}
          </div>

          {/* Submit */}
          <button type="submit"
            className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold py-3.5 rounded-xl transition-all shadow-md text-xs cursor-pointer active:scale-95">
            Save & Apply 48h Security Hold
          </button>
        </form>
      </div>
    </div>
  );

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
        {activeScreen === 'reviews' && renderReviews()}
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
