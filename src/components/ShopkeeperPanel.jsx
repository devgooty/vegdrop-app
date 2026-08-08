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

  /**
   * There is deliberately no bank state here any more.
   *
   * This component used to hold a full settlement-account form — bank name,
   * account number, IFSC, PAN, GSTIN — seeded from `localStorage` and written
   * back to it on save. Two things made that worse than merely redundant:
   *
   *  - It defaulted to `verificationStatus: 'verified'` with a hardcoded
   *    account number, so an untouched account displayed "✓ Verified" to a
   *    vendor who had submitted nothing.
   *  - Its penny drop was a 2.5s `setTimeout` that called no endpoint, then set
   *    the same flag. A vendor could reach "verified" without a rupee moving.
   *
   * None of it was ever sent to the server, so it competed with the real KYC
   * record rather than feeding it. Settlement details now live only in
   * VendorKycModal and GET /api/kyc/me, where the PAN and account number are
   * encrypted at rest, returned masked, and the amount a vendor must confirm is
   * randomised and held as an HMAC. `renderBankDetails` below just reports that
   * status and opens the real flow.
   */
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

  /**
   * Bank and payout details.
   *
   * This screen used to be a self-contained imitation of vendor onboarding: it
   * collected an account number, IFSC and PAN, wrote all three to localStorage
   * in the clear, and 'verified' the account with a 2.5s setTimeout that
   * reached no server at all. Nothing it produced was ever sent anywhere, so a
   * vendor who filled it in was told they were verified while remaining
   * unverified everywhere that matters.
   *
   * Two things were wrong beyond the theatre. Financial identifiers in web
   * storage are readable by any script that achieves XSS — the same reason the
   * access token lives in a module variable and the wallet balance is no longer
   * mirrored client-side. And a second, softer 'verified' state competing with
   * the real one is how a vendor ends up trusting the wrong answer.
   *
   * The genuine flow already exists and is wired into this component: KYC
   * status comes from GET /api/kyc/me, and VendorKycModal drives the real
   * penny drop, whose amount is randomised, stored only as an HMAC, and must
   * be read off an actual bank statement. This defers to it.
   */
  const renderBankDetails = () => {
    const status = kyc?.status || 'missing';
    const isVerified = Boolean(kyc?.canUpdateStock);
    const inProgress = status === 'penny_sent';

    const tone = isVerified
      ? 'bg-emerald-400/20 text-emerald-300 border-emerald-400/30'
      : inProgress
        ? 'bg-yellow-400/20 text-yellow-300 border-yellow-400/30'
        : 'bg-red-400/20 text-red-300 border-red-400/30';

    const label = isVerified
      ? '✓ Verified'
      : inProgress
        ? '⏳ Awaiting confirmation'
        : '✗ Not verified';

    return (
      <div className="space-y-4 pb-20 animate-fade-in absolute inset-0 bg-gray-50 z-50 p-4 overflow-y-auto">
        <div className="flex items-center gap-3 sticky top-0 bg-gray-50 py-2 z-10">
          <button onClick={() => setActiveScreen('list')} className="p-2 rounded-full bg-gray-200 hover:bg-gray-300 transition-colors">
            <ArrowLeft className="w-5 h-5 text-gray-700" />
          </button>
          <h2 className="font-black text-xl text-gray-900">Bank & Payout Details</h2>
        </div>

        <div className="bg-gradient-to-r from-[#1B4D3E] to-[#276652] p-5 rounded-2xl text-white shadow-md">
          <div className="flex justify-between items-center mb-1">
            <span className="text-[10px] text-emerald-200 font-bold uppercase tracking-wider">Settlement account</span>
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-black border ${tone}`}>{label}</span>
          </div>
          {kyc?.upiVpa ? (
            <p className="text-lg font-black font-mono tracking-wider">{kyc.upiVpa}</p>
          ) : (
            <p className="text-sm font-bold text-emerald-100">No settlement account on file yet.</p>
          )}
          {kyc?.bankAccountLast4 && (
            <p className="text-[11px] text-emerald-100 mt-1">Account ending {kyc.bankAccountLast4}</p>
          )}
        </div>

        <div className="bg-white rounded-2xl p-4 border border-gray-100 shadow-sm space-y-3">
          <p className="text-[11px] font-black text-gray-900">How verification works</p>
          <p className="text-[10px] text-gray-600 leading-relaxed">
            We send a small, random amount — somewhere between 1 and 100 paise — to your UPI ID.
            You then tell us exactly what arrived. Only someone who can see that account can read
            the amount, which is what proves the account is yours.
          </p>
          <p className="text-[10px] text-gray-600 leading-relaxed">
            Your PAN and account number are encrypted before they are stored and are only ever
            shown back to you masked. They are never kept on this device.
          </p>

          <button
            type="button"
            onClick={onOpenKyc}
            className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold rounded-xl transition-all shadow-md cursor-pointer active:scale-95"
          >
            {isVerified
              ? 'View verification details'
              : inProgress
                ? 'Enter the amount you received'
                : 'Set up your settlement account'}
          </button>

          {!isVerified && (
            <p className="text-[10px] text-amber-700 font-semibold">
              Until this is verified you cannot list stock or change prices.
            </p>
          )}
        </div>
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
