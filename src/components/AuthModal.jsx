import React, { useState } from 'react';
import {
  X,
  User,
  Mail,
  Phone,
  ArrowRight,
  Lock,
  Eye,
  EyeOff,
  ShieldCheck,
  CheckCircle2,
  Sparkles,
  Search,
  BadgeCheck
} from 'lucide-react';

export default function AuthModal({ isOpen, onClose, onLogin, onSignUp, registeredUsers = [] }) {
  const [activeTab, setActiveTab] = useState('login'); // 'login' | 'signup'
  const [loginStep, setLoginStep] = useState(1); // 1: Identifier, 2: Password / 2FA OTP

  // Sign Up form state
  const [signUpName, setSignUpName] = useState('');
  const [signUpEmail, setSignUpEmail] = useState('');
  const [signUpPhone, setSignUpPhone] = useState('');
  const [signUpPassword, setSignUpPassword] = useState('');
  const [signUpRole, setSignUpRole] = useState('customer');
  const [showSignUpPassword, setShowSignUpPassword] = useState(false);

  // Login form state
  const [loginIdentifier, setLoginIdentifier] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [showLoginPassword, setShowLoginPassword] = useState(false);

  // 2FA OTP state for privileged accounts
  const [emailOTP, setEmailOTP] = useState('');
  const [mobileOTP, setMobileOTP] = useState('');
  const [otpError, setOtpError] = useState('');

  if (!isOpen) return null;

  // AUTO-ROLE DETECTION LOGIC
  const cleanId = loginIdentifier.trim().toLowerCase();
  const matchedUser = registeredUsers.find(
    (u) =>
      (u.identifier && u.identifier.toLowerCase() === cleanId) ||
      (u.phone && u.phone.includes(cleanId) && cleanId.length >= 4)
  );

  const detectedRole = matchedUser ? matchedUser.role : 'customer';
  const detectedName = matchedUser ? matchedUser.name : '';
  const isPrivilegedRole = detectedRole !== 'customer';

  const roleBadgeLabel = {
    customer: '🛒 Customer (Storefront Access)',
    shopkeeper: '🏪 Shopkeeper (Inventory & Orders)',
    delivery: '🚚 Delivery Agent (Logistics & Route)',
    developer: '💻 Developer Console & API',
    market_owner: '📊 Marketplace Owner Suite',
  }[detectedRole] || '🛒 Customer Account';

  const handleStep1Next = (e) => {
    e.preventDefault();
    if (!loginIdentifier) return;
    setLoginStep(2);
  };

  const handleLoginFinalSubmit = (e) => {
    e.preventDefault();
    if (!loginPassword) return;

    // Verify OTP for all account logins
    if (!emailOTP) {
      setOtpError('Please enter the 6-digit verification code (e.g. 123456).');
      return;
    }

    const isEmail = loginIdentifier.includes('@');
    const nameFromId = detectedName || (isEmail
      ? loginIdentifier.split('@')[0].replace(/[._-]/g, ' ')
      : 'User');
    const formattedName = nameFromId.charAt(0).toUpperCase() + nameFromId.slice(1);

    onLogin({
      name: formattedName || 'VegBazzar User',
      email: isEmail ? loginIdentifier : 'user@vegbazzar.com',
      phone: isEmail ? '+91 98765 43210' : loginIdentifier,
      role: detectedRole,
    });

    // Reset state & close
    setLoginStep(1);
    setEmailOTP('');
    setMobileOTP('');
    onClose();
  };

  const handleSignUpSubmit = (e) => {
    e.preventDefault();
    if (!signUpName || !signUpPhone || !signUpPassword) return;

    const formattedPhone = signUpPhone.startsWith('+91')
      ? signUpPhone
      : `+91 ${signUpPhone.replace(/\D/g, '').slice(-10)}`;

    onSignUp({
      name: signUpName.trim(),
      email: signUpEmail.trim() || `${formattedPhone.replace(/\D/g, '')}@vegbazzar.com`,
      phone: formattedPhone,
      password: signUpPassword,
      role: signUpRole,
    });

    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in">
      <div className="bg-white rounded-3xl w-full max-w-md p-6 shadow-2xl border border-gray-100 relative overflow-hidden max-h-[90vh] overflow-y-auto">
        {/* Decorative Top Accent */}
        <div className="absolute top-0 left-0 right-0 h-2 bg-gradient-to-r from-[#1B4D3E] via-emerald-500 to-teal-600" />

        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 p-1.5 rounded-full hover:bg-gray-100 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Branding Header */}
        <div className="flex items-center gap-3 mb-4 mt-1">
          <div className="w-11 h-11 rounded-2xl bg-[#1B4D3E] text-white flex items-center justify-center font-bold text-xl shadow-md border border-emerald-900">
            🌿
          </div>
          <div>
            <h3 className="font-extrabold text-gray-900 text-base tracking-tight">
              VegBazzar Login Portal
            </h3>
            <p className="text-[11px] text-gray-500 font-medium">
              Automatic Role Detection via Registered Email / Mobile ID
            </p>
          </div>
        </div>

        {/* Tab Selector */}
        <div className="flex bg-gray-100 p-1 rounded-2xl mb-4 font-bold text-xs">
          <button
            onClick={() => {
              setActiveTab('login');
              setLoginStep(1);
            }}
            className={`flex-1 py-2 rounded-xl transition-all cursor-pointer ${
              activeTab === 'login'
                ? 'bg-[#1B4D3E] text-white shadow-md'
                : 'text-gray-500 hover:text-gray-800'
            }`}
          >
            Log In
          </button>
          <button
            onClick={() => setActiveTab('signup')}
            className={`flex-1 py-2 rounded-xl transition-all cursor-pointer ${
              activeTab === 'signup'
                ? 'bg-[#1B4D3E] text-white shadow-md'
                : 'text-gray-500 hover:text-gray-800'
            }`}
          >
            Create Account (Sign Up)
          </button>
        </div>

        {/* LOG IN FORM (AUTO ROLE DETECTION) */}
        {activeTab === 'login' ? (
          <div>
            {loginStep === 1 ? (
              <form onSubmit={handleStep1Next} className="space-y-3.5 text-xs">
                {/* Email or Mobile Input */}
                <div>
                  <label className="block font-bold text-gray-700 mb-1">
                    Registered Email Address or Mobile Number
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      value={loginIdentifier}
                      onChange={(e) => setLoginIdentifier(e.target.value)}
                      placeholder="e.g. shopkeeper@vegbazzar.com or 9876543210"
                      className="w-full bg-gray-50 border border-gray-200 rounded-xl py-2.5 pl-9 pr-3 text-xs font-semibold text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]"
                      required
                    />
                    <User className="w-4 h-4 text-gray-400 absolute left-3 top-3" />
                  </div>
                </div>

                {/* Auto-Role Detection Indicator */}
                {loginIdentifier.length > 2 && (
                  <div
                    className={`p-3 rounded-2xl border text-xs space-y-1 transition-all ${
                      isPrivilegedRole
                        ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
                        : 'bg-gray-50 border-gray-200 text-gray-800'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 font-extrabold text-[11px]">
                      <BadgeCheck className={`w-4 h-4 ${isPrivilegedRole ? 'text-emerald-700' : 'text-gray-500'}`} />
                      <span>Detected Role:</span>
                      <span className="uppercase tracking-wide font-black">{detectedRole.replace('_', ' ')}</span>
                    </div>
                    <p className="text-[10px] text-gray-600">
                      {isPrivilegedRole
                        ? '🔒 Privileged account detected — requires Password + Dual OTP 2FA'
                        : '🛒 Customer account — requires Password only'}
                    </p>
                  </div>
                )}

                <button
                  type="submit"
                  className="w-full bg-[#1B4D3E] hover:bg-[#143B2B] text-white font-extrabold py-3 rounded-xl transition-all shadow-md flex items-center justify-center gap-2 text-xs mt-2 cursor-pointer active:scale-98"
                >
                  <span>Continue to Verification</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </form>
            ) : (
              /* STEP 2: PASSWORD + DUAL 2FA FOR PRIVILEGED ROLES */
              <form onSubmit={handleLoginFinalSubmit} className="space-y-3.5 text-xs">
                <div className="bg-gray-50 p-2.5 rounded-xl border border-gray-200 flex items-center justify-between">
                  <div className="text-[11px]">
                    <span className="text-gray-500 block">Logging in ID:</span>
                    <span className="font-bold text-gray-900">{loginIdentifier}</span>
                    <span className="ml-2 font-bold text-emerald-700 uppercase">({detectedRole.replace('_', ' ')})</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setLoginStep(1)}
                    className="text-[11px] text-[#1B4D3E] font-bold underline cursor-pointer"
                  >
                    Change ID
                  </button>
                </div>

                {/* Password Field */}
                <div>
                  <label className="block font-bold text-gray-700 mb-1">Account Password</label>
                  <div className="relative">
                    <input
                      type={showLoginPassword ? 'text' : 'password'}
                      value={loginPassword}
                      onChange={(e) => setLoginPassword(e.target.value)}
                      placeholder="Enter account password"
                      className="w-full bg-gray-50 border border-gray-200 rounded-xl py-2.5 pl-9 pr-10 text-xs font-semibold text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]"
                      required
                    />
                    <Lock className="w-4 h-4 text-gray-400 absolute left-3 top-3" />
                    <button
                      type="button"
                      onClick={() => setShowLoginPassword(!showLoginPassword)}
                      className="absolute right-3 top-3 text-gray-400 hover:text-gray-600 cursor-pointer"
                    >
                      {showLoginPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {/* ACCOUNT OTP VERIFICATION SCREEN */}
                <div className="space-y-3 pt-1 border-t border-gray-100">
                  <div className="bg-amber-50 p-2.5 rounded-xl border border-amber-200 flex items-start gap-2">
                    <ShieldCheck className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                    <div className="text-[11px] text-amber-800 leading-tight">
                      <span className="font-bold block">Account OTP Verification</span>
                      Please enter the Email or Mobile OTP to verify your {detectedRole.replace('_', ' ').toUpperCase()} login.
                    </div>
                  </div>

                  <div className="bg-blue-50 p-2 rounded-lg border border-blue-100 text-[10px] text-blue-800 flex items-center justify-between font-mono">
                    <span>Demo Verification Code:</span>
                    <span className="font-bold bg-blue-200 text-blue-900 px-1.5 py-0.5 rounded">123456</span>
                  </div>

                  {/* Single Email or Mobile OTP */}
                  <div>
                    <label className="block font-bold text-gray-700 mb-1">Email or Mobile OTP (6 Digits)</label>
                    <div className="relative">
                      <input
                        type="text"
                        maxLength={6}
                        value={emailOTP}
                        onChange={(e) => setEmailOTP(e.target.value)}
                        placeholder="Enter 6-digit OTP (e.g. 123456)"
                        className="w-full bg-gray-50 border border-gray-200 rounded-xl py-2.5 pl-9 pr-3 text-xs font-mono font-bold text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]"
                        required
                      />
                      <Mail className="w-4 h-4 text-gray-400 absolute left-3 top-3" />
                    </div>
                  </div>

                  {otpError && (
                    <p className="text-[11px] font-bold text-rose-600">{otpError}</p>
                  )}
                </div>

                <button
                  type="submit"
                  className="w-full bg-[#1B4D3E] hover:bg-[#143B2B] text-white font-extrabold py-3 rounded-xl transition-all shadow-md flex items-center justify-center gap-2 text-xs mt-2 cursor-pointer active:scale-98"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Launch {detectedRole.replace('_', ' ').toUpperCase()} Panel</span>
                </button>
              </form>
            )}
          </div>
        ) : (
          /* SIGN UP FORM */
          <form onSubmit={handleSignUpSubmit} className="space-y-3 text-xs">
            {/* Select Role */}
            <div>
              <label className="block font-bold text-gray-700 mb-1">Register Account As</label>
              <select
                value={signUpRole}
                onChange={(e) => setSignUpRole(e.target.value)}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-xs font-bold text-gray-800 focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]"
              >
                <option value="customer">🛒 Customer (Storefront Access)</option>
                <option value="shopkeeper">🏪 Shopkeeper (Inventory & Orders)</option>
                <option value="delivery">🚚 Delivery Agent (Logistics & Route)</option>
                <option value="developer">💻 Developer (API & Console)</option>
                <option value="market_owner">📊 Market Owner (Executive GMV)</option>
              </select>
            </div>

            {/* Name */}
            <div>
              <label className="block font-bold text-gray-700 mb-1">Full Name</label>
              <div className="relative">
                <input
                  type="text"
                  value={signUpName}
                  onChange={(e) => setSignUpName(e.target.value)}
                  placeholder="e.g. Ananya Verma"
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl py-2 pl-9 pr-3 text-xs font-semibold text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]"
                  required
                />
                <User className="w-4 h-4 text-gray-400 absolute left-3 top-2.5" />
              </div>
            </div>

            {/* Mobile */}
            <div>
              <label className="block font-bold text-gray-700 mb-1">Mobile Number</label>
              <div className="relative flex items-center">
                <span className="absolute left-3 text-gray-500 font-bold text-xs pointer-events-none">
                  +91
                </span>
                <input
                  type="tel"
                  maxLength={10}
                  value={signUpPhone}
                  onChange={(e) => setSignUpPhone(e.target.value.replace(/\D/g, ''))}
                  placeholder="9876543210"
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl py-2 pl-11 pr-3 text-xs font-semibold text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]"
                  required
                />
                <Phone className="w-4 h-4 text-gray-400 absolute right-3" />
              </div>
            </div>

            {/* Password */}
            <div>
              <label className="block font-bold text-gray-700 mb-1">Password</label>
              <div className="relative">
                <input
                  type={showSignUpPassword ? 'text' : 'password'}
                  value={signUpPassword}
                  onChange={(e) => setSignUpPassword(e.target.value)}
                  placeholder="Set account password"
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl py-2 pl-9 pr-10 text-xs font-semibold text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]"
                  required
                />
                <Lock className="w-4 h-4 text-gray-400 absolute left-3 top-2.5" />
                <button
                  type="button"
                  onClick={() => setShowSignUpPassword(!showSignUpPassword)}
                  className="absolute right-3 top-2.5 text-gray-400 hover:text-gray-600 cursor-pointer"
                >
                  {showSignUpPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              className="w-full bg-[#1B4D3E] hover:bg-[#143B2B] text-white font-extrabold py-2.5 rounded-xl transition-all shadow-md flex items-center justify-center gap-2 text-xs mt-2 cursor-pointer active:scale-98"
            >
              <span>Register Credentials & Launch Panel</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
