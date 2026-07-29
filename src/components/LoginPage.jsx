import React, { useState, useEffect, useRef } from 'react';
import {
  User,
  Mail,
  Phone,
  ArrowRight,
  Lock,
  Eye,
  EyeOff,
  ShieldCheck,
  CheckCircle2,
  Zap,
  Star,
  ArrowLeft,
  X,
  UserPlus,
  Loader2
} from 'lucide-react';
import {
  startLogin,
  verifyLogin,
  startRegistration,
  verifyRegistration,
  describePasswordProblem,
} from '../services/auth';
import { ApiRequestError, NetworkError } from '../services/apiClient';

// Extracted so registration and sign-in share one implementation.
import OTPBoxGroup from './OTPBoxGroup';

/**
 * Sign-in and registration.
 *
 * `onLogin` receives the user object returned by the server after successful
 * verification. This component never determines a role, never compares a
 * password, and never validates a code — all three are server decisions.
 */
export default function LoginPage({ onLogin, onSignUp, appType = 'customer', storagePrefix = 'vegbazzar_' }) {
  const [step, setStep] = useState(1);
  const [identifier, setIdentifier] = useState(() => {
    return window.localStorage.getItem(`${storagePrefix}remembered_id`) || '';
  });
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(() => {
    return window.localStorage.getItem(`${storagePrefix}remember_me`) === 'true';
  });

  const [passwordError, setPasswordError] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);

  const [emailOTP, setEmailOTP] = useState('');
  const [mobileOTP, setMobileOTP] = useState('');
  const [otpError, setOtpError] = useState('');

  // Server-issued challenge for the second factor. Holding the id is not enough
  // to authenticate — the code itself is verified on the server.
  const [challenge, setChallenge] = useState(null);

  const [isSignUpModalOpen, setIsSignUpModalOpen] = useState(false);
  const [signUpName, setSignUpName] = useState('');
  const [signUpPassword, setSignUpPassword] = useState('');
  // Self-registration always creates a customer. There is deliberately no role
  // selector: the API rejects any request that tries to choose one.
  const [showSignUpPassword, setShowSignUpPassword] = useState(false);

  // New multi-step SignUp state
  const [signUpStep, setSignUpStep] = useState(1);
  const [signUpEmail, setSignUpEmail] = useState('');
  const [signUpPhone, setSignUpPhone] = useState('');
  const [signUpShopName, setSignUpShopName] = useState('');
  const [signUpShopNo, setSignUpShopNo] = useState('');
  const [signUpAddress, setSignUpAddress] = useState('');
  const [signUpEmailOTP, setSignUpEmailOTP] = useState('');
  const [signUpMobileOTP, setSignUpMobileOTP] = useState('');
  const [signUpOtpError, setSignUpOtpError] = useState('');
  const [signUpChallenge, setSignUpChallenge] = useState(null);

  useEffect(() => {
    if (isSignUpModalOpen && identifier) {
      const clean = identifier.trim();
      if (clean.includes('@')) {
        setSignUpEmail(clean);
        setSignUpPhone('');
      } else {
        setSignUpPhone(clean);
        setSignUpEmail('');
      }
      setSignUpStep(1);
      setSignUpEmailOTP('');
      setSignUpMobileOTP('');
      setSignUpOtpError('');
    }
  }, [isSignUpModalOpen, identifier]);

  /**
   * Turn any thrown error into something worth showing the user.
   * A network failure is reported as a failure — never as a reason to fall back
   * to local checking, which is what made the old flow bypassable offline.
   */
  const describeError = (err, fallback) => {
    if (err instanceof NetworkError) {
      return 'Could not reach the server. Check your connection and try again.';
    }
    if (err instanceof ApiRequestError) return err.message;
    return fallback;
  };

  const handleStep1Next = (e) => {
    e.preventDefault();
    if (!identifier) return;

    if (rememberMe) {
      window.localStorage.setItem(`${storagePrefix}remembered_id`, identifier);
      window.localStorage.setItem(`${storagePrefix}remember_me`, 'true');
    } else {
      window.localStorage.removeItem(`${storagePrefix}remembered_id`);
      window.localStorage.removeItem(`${storagePrefix}remember_me`);
    }

    // Whether the account exists is not disclosed before authentication, so the
    // client simply advances to the password step and lets the server decide.
    setPasswordError('');
    setStep(2);
  };

  /** Step 2: the server verifies the password and issues a challenge. */
  const handlePasswordVerification = async (e) => {
    e.preventDefault();
    if (!password || isVerifying) return;

    setPasswordError('');
    setIsVerifying(true);

    try {
      const issued = await startLogin({ identifier, password });
      setChallenge(issued);
      setEmailOTP('');
      setOtpError('');
      setStep(3);
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'INVALID_CREDENTIALS' && appType === 'customer') {
        // The server does not reveal whether the account exists, so offer
        // sign-up as a next step rather than asserting either way.
        setPasswordError('Incorrect credentials. If you have not registered yet, create an account below.');
      } else {
        setPasswordError(describeError(err, 'Unable to sign in. Please try again.'));
      }
    } finally {
      setIsVerifying(false);
    }
  };

  /** Step 3: the server verifies the code and establishes the session. */
  const handleOTPVerification = async (e) => {
    e.preventDefault();
    if (isVerifying) return;

    if (!emailOTP || emailOTP.trim().length < 6) {
      setOtpError('Enter the 6-digit verification code.');
      return;
    }
    if (!challenge) {
      setOtpError('This sign-in attempt has expired. Please start again.');
      return;
    }

    setOtpError('');
    setIsVerifying(true);

    try {
      // The authenticated user comes back from the server, including their role.
      // Nothing about the session is constructed here.
      const user = await verifyLogin({ challengeId: challenge.challengeId, code: emailOTP.trim() });
      onLogin(user);
    } catch (err) {
      setOtpError(describeError(err, 'Verification failed. Please try again.'));

      // An expired or exhausted challenge cannot be retried; send them back.
      if (err instanceof ApiRequestError && ['OTP_EXPIRED', 'OTP_ATTEMPTS_EXCEEDED'].includes(err.code)) {
        setChallenge(null);
        setPassword('');
        setStep(2);
      }
    } finally {
      setIsVerifying(false);
    }
  };

  const handleSignUpStep1Next = async (e) => {
    e.preventDefault();
    if (isVerifying) return;

    setSignUpOtpError('');

    if (!signUpName.trim() || !signUpPassword || !signUpPhone.trim()) {
      setSignUpOtpError('Name, mobile number, and password are all required.');
      return;
    }

    // Advisory only — the server enforces the authoritative policy.
    const weak = describePasswordProblem(signUpPassword);
    if (weak) {
      setSignUpOtpError(weak);
      return;
    }

    setIsVerifying(true);
    try {
      const issued = await startRegistration({
        name: signUpName.trim(),
        phone: signUpPhone.trim(),
        email: signUpEmail.trim() || undefined,
        password: signUpPassword,
      });
      setSignUpChallenge(issued);
      setSignUpEmailOTP('');
      setSignUpStep(2);
    } catch (err) {
      setSignUpOtpError(describeError(err, 'Could not start registration. Please try again.'));
    } finally {
      setIsVerifying(false);
    }
  };

  const handleSignUpStep2Submit = async (e) => {
    e.preventDefault();
    if (isVerifying) return;

    setSignUpOtpError('');

    if (!signUpEmailOTP || signUpEmailOTP.trim().length < 6) {
      setSignUpOtpError('Enter the 6-digit verification code.');
      return;
    }
    if (!signUpChallenge) {
      setSignUpOtpError('This registration has expired. Please start again.');
      return;
    }

    setIsVerifying(true);
    try {
      // The account is created server-side only once the code checks out, and
      // is always a customer regardless of anything supplied here.
      const user = await verifyRegistration({
        challengeId: signUpChallenge.challengeId,
        code: signUpEmailOTP.trim(),
      });
      setIsSignUpModalOpen(false);
      setSignUpChallenge(null);
      setSignUpPassword('');
      onLogin(user);
    } catch (err) {
      setSignUpOtpError(describeError(err, 'Verification failed. Please try again.'));
      if (err instanceof ApiRequestError && ['OTP_EXPIRED', 'OTP_ATTEMPTS_EXCEEDED'].includes(err.code)) {
        setSignUpChallenge(null);
        setSignUpStep(1);
      }
    } finally {
      setIsVerifying(false);
    }
  };

  return (
    <div className="min-h-[100dvh] bg-gray-100 flex items-center justify-center p-0 sm:p-4 font-sans text-gray-900">
      
      {/* 📱 MOBILE APP CONTAINER FRAME */}
      <div className="w-full max-w-md bg-[#FFFDF9] min-h-[100dvh] sm:min-h-[850px] sm:max-h-[900px] sm:rounded-3xl shadow-2xl border-x sm:border border-gray-200 overflow-y-auto flex flex-col justify-between p-6 relative">
        
        {/* 🌟 APP TOP BRANDING HEADER */}
        {appType === 'customer' && (
          <div className="bg-gradient-to-br from-[#1B4D3E] via-[#143B2B] to-[#0D291E] text-white rounded-3xl p-6 shadow-xl relative overflow-hidden mb-6 shrink-0 text-left">
            <div className="absolute top-0 right-0 w-40 h-40 bg-emerald-400/10 rounded-full blur-2xl pointer-events-none" />
            <div className="absolute bottom-0 left-0 w-32 h-32 bg-teal-500/10 rounded-full blur-2xl pointer-events-none" />
            
            <div className="flex items-center gap-3 mb-4 relative z-10">
              <div className="w-11 h-11 rounded-2xl bg-gradient-to-b from-[#3B7A57] to-[#1C4D38] text-white flex items-center justify-center font-bold text-2xl shadow-lg border border-emerald-400/30 shrink-0">
                🌿
              </div>
              <div>
                <span className="font-vintage font-extrabold text-2xl tracking-tight text-emerald-100 block leading-tight">
                  VegBazzar
                </span>
                <span className="text-[10px] font-mono text-emerald-400 uppercase tracking-widest block">
                  Artisanal Basket
                </span>
              </div>
            </div>

            <div className="relative z-10 space-y-1.5">
              <span className="px-2.5 py-0.5 bg-emerald-500/20 text-emerald-300 rounded-full text-[10px] font-bold border border-emerald-400/30 inline-flex items-center gap-1">
                <Zap className="w-3 h-3 text-emerald-400 fill-emerald-400" />
                Smart Auto Account Detect
              </span>
              <h2 className="text-lg font-vintage font-extrabold text-white leading-snug">
                Farm-to-Table Fresh Produce
              </h2>
              <p className="text-xs text-emerald-100/80 leading-relaxed font-normal">
                Enter email or mobile to log in to your account.
              </p>
            </div>
          </div>
        )}

        {/* 🏪 SHOPKEEPER BRANDING HEADER */}
        {appType === 'shopkeeper' && (
          <div className="bg-gradient-to-br from-[#1B4D3E] to-[#0A2E22] p-6 text-center text-white rounded-3xl shadow-xl relative overflow-hidden mb-6 shrink-0">
            <div className="w-16 h-16 bg-white/10 rounded-2xl flex items-center justify-center mx-auto mb-3 backdrop-blur-sm border border-white/10">
              <span className="text-3xl">🏪</span>
            </div>
            <h1 className="text-xl font-black tracking-tight">Shopkeeper Panel</h1>
            <p className="text-emerald-200/80 text-xs font-medium mt-1">VegBazzar Store Management</p>
          </div>
        )}

        {/* 🚚 DELIVERY BRANDING HEADER */}
        {appType === 'delivery' && (
          <div className="bg-gradient-to-br from-[#1B4D3E] to-[#0A2E22] p-6 text-center text-white rounded-3xl shadow-xl relative overflow-hidden mb-6 shrink-0">
            <div className="w-16 h-16 bg-white/10 rounded-2xl flex items-center justify-center mx-auto mb-3 backdrop-blur-sm border border-white/10">
              <span className="text-3xl">🚚</span>
            </div>
            <h1 className="text-xl font-black tracking-tight">Delivery Agent</h1>
            <p className="text-emerald-200/80 text-xs font-medium mt-1">VegBazzar Delivery Management</p>
          </div>
        )}

        {/* 🚀 FORM CONTAINER */}
        <div className="flex-1 flex flex-col justify-center w-full space-y-5">
          
          {/* Header Title */}
          <div className="space-y-1.5 text-left">
            <h2 className="font-vintage font-extrabold text-3xl text-gray-900 tracking-tight">
              Sign In
            </h2>
            <p className="text-xs text-gray-500 font-medium">
              {step === 1 && 'Enter your Email Address or Mobile Number to begin.'}
              {step === 2 && 'Enter your account password to verify identity.'}
              {step === 3 && 'Non-Customer account detected — Enter 2FA OTP codes.'}
            </p>
          </div>

          {/* STEP 1: ENTER EMAIL OR MOBILE NUMBER */}
          {step === 1 && (
            <div className="animate-fade-in">
              <form onSubmit={handleStep1Next} className="space-y-4 text-xs">
                <div>
                  <label className="block font-bold text-gray-800 mb-1.5 text-xs">
                    Email Address or Mobile Number
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      value={identifier}
                      onChange={(e) => {
                        let val = e.target.value;
                        if (/^\d+$/.test(val) && val.length > 10) {
                          val = val.slice(0, 10);
                        }
                        setIdentifier(val);
                      }}
                      placeholder="Enter email or mobile number"
                      maxLength={254}
                      pattern="^(\d{10}|[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,4})$"
                      title="Please enter a valid 10-digit mobile number or email address (e.g. user@domain.com)"
                      className="w-full bg-white border border-gray-300 rounded-2xl py-3.5 pl-11 pr-4 text-xs font-semibold text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]/30 focus:border-[#1B4D3E] shadow-xs"
                      required
                    />
                    <User className="w-4 h-4 text-gray-400 absolute left-4 top-4" />
                  </div>
                </div>

                <div className="flex items-center gap-2 py-1">
                  <input
                    type="checkbox"
                    id="remember_me"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="w-4 h-4 rounded border-gray-300 text-[#1B4D3E] focus:ring-[#1B4D3E]"
                  />
                  <label htmlFor="remember_me" className="text-xs font-semibold text-gray-600 cursor-pointer">
                    Remember my ID on this machine
                  </label>
                </div>

                <button
                  type="submit"
                  className="w-full bg-gradient-to-r from-[#1B4D3E] to-[#276652] hover:from-[#143B2B] hover:to-[#1B4D3E] text-white font-extrabold py-4 rounded-2xl transition-all shadow-md hover:shadow-xl flex items-center justify-center gap-2 text-xs cursor-pointer active:scale-98"
                >
                  <span>Continue to Password</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </form>
            </div>
          )}

          {/* STEP 2: ENTER PASSWORD */}
          {step === 2 && (
            <div className="animate-fade-in">
              <form onSubmit={handlePasswordVerification} className="space-y-4 text-xs">
                <div className="bg-gray-50 p-3 rounded-2xl border border-gray-200 flex items-center justify-between">
                  <div>
                    <span className="text-[10px] text-gray-500 block uppercase font-semibold">Account ID:</span>
                    <span className="font-bold text-gray-900">{identifier}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => { setPasswordError(''); setStep(1); }}
                    className="text-xs text-[#1B4D3E] font-bold underline cursor-pointer hover:text-emerald-900 flex items-center gap-1"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    <span>Change ID</span>
                  </button>
                </div>

                <div>
                  <label className="block font-bold text-gray-800 mb-1.5">Account Password</label>
                  <div className="relative">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Enter account password"
                      className="w-full bg-white border border-gray-300 rounded-2xl py-3.5 pl-11 pr-11 text-xs font-semibold text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]/30 focus:border-[#1B4D3E] shadow-xs"
                      required
                      disabled={isVerifying}
                    />
                    <Lock className="w-4 h-4 text-gray-400 absolute left-4 top-4" />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-4 top-4 text-gray-400 hover:text-gray-600 cursor-pointer"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {passwordError && <p className="text-[11px] font-bold text-rose-600">{passwordError}</p>}

                <button
                  type="submit"
                  disabled={isVerifying}
                  className="w-full bg-gradient-to-r from-[#1B4D3E] to-[#276652] hover:from-[#143B2B] hover:to-[#1B4D3E] text-white font-extrabold py-4 rounded-2xl transition-all shadow-md hover:shadow-xl flex items-center justify-center gap-2 text-xs cursor-pointer active:scale-98 disabled:opacity-70 disabled:cursor-not-allowed"
                >
                  {isVerifying ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Verifying Credentials...</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="w-4 h-4" />
                      <span>Verify Password & Open App</span>
                    </>
                  )}
                </button>
              </form>
            </div>
          )}

          {/* STEP 3: DUAL OTP VERIFICATION (ONLY FOR NON-CUSTOMER ACCOUNTS AFTER PASSWORD VERIFIED) */}
          {step === 3 && (
            <div className="animate-fade-in">
              <form onSubmit={handleOTPVerification} className="space-y-4 text-xs">
                <div className="bg-amber-50 p-4 rounded-2xl border border-amber-200 space-y-1">
                  <div className="flex items-center gap-2 text-amber-900 font-extrabold text-xs">
                    <ShieldCheck className="w-4 h-4 text-amber-700" />
                    <span>Two-Step Verification</span>
                  </div>
                  <p className="text-[11px] text-amber-800 leading-relaxed">
                    {challenge
                      ? `We sent a 6-digit code to ${challenge.destination}. Enter it below to finish signing in.`
                      : 'Enter the 6-digit code we sent you to finish signing in.'}
                  </p>
                </div>

                {/* Single Email or Phone OTP */}
                <div>
                  <label className="block font-bold text-gray-800 mb-1 flex items-center gap-2">
                    <Mail className="w-4 h-4 text-gray-500" />
                    <Phone className="w-4 h-4 text-gray-500 -ml-1" />
                    <span>Email or Phone OTP (6 Digits)</span>
                  </label>
                  <OTPBoxGroup value={emailOTP} onChange={setEmailOTP} />
                </div>

                {otpError && <p className="text-[11px] font-bold text-rose-600">{otpError}</p>}

                <button
                  type="submit"
                  disabled={isVerifying}
                  className="w-full bg-gradient-to-r from-[#1B4D3E] to-[#276652] hover:from-[#143B2B] hover:to-[#1B4D3E] disabled:opacity-60 disabled:cursor-not-allowed text-white font-extrabold py-4 rounded-2xl transition-all shadow-md hover:shadow-xl flex items-center justify-center gap-2 text-xs cursor-pointer active:scale-98"
                >
                  {isVerifying ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="w-4 h-4" />
                  )}
                  <span>{isVerifying ? 'Verifying…' : 'Verify & Sign In'}</span>
                </button>
              </form>
            </div>
          )}
        </div>
      </div>

      {/* 🌟 AUTOMATIC SIGN UP MODAL POPUP (Triggered when user does NOT exist) */}
      {isSignUpModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in">
          <div className="bg-white rounded-3xl w-full max-w-md p-6 shadow-2xl border border-gray-100 relative overflow-hidden space-y-4 animate-scale-in">
            <button
              onClick={() => setIsSignUpModalOpen(false)}
              className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 p-1.5 rounded-full hover:bg-gray-100 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>

            {/* Popup Header */}
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-2xl bg-emerald-100 text-[#1B4D3E] flex items-center justify-center font-bold text-xl shadow-xs border border-emerald-200">
                <UserPlus className="w-6 h-6" />
              </div>
              <div>
                <h3 className="font-extrabold text-gray-900 text-base tracking-tight">
                  {signUpStep === 1 ? 'New User Profile' : 'Verify Registration'}
                </h3>
                <p className="text-[11px] text-emerald-700 font-bold">
                  {signUpStep === 1 ? 'Create your profile to join VegBazzar' : 'Confirm your credentials via OTP'}
                </p>
              </div>
            </div>

            {signUpStep === 1 ? (
              <form onSubmit={handleSignUpStep1Next} className="space-y-3.5 text-xs">
                {/* Full Name */}
                <div>
                  <label className="block font-bold text-gray-800 mb-1">Full Name</label>
                  <div className="relative">
                    <input
                      type="text"
                      value={signUpName}
                      onChange={(e) => setSignUpName(e.target.value)}
                      placeholder="e.g. Ramesh Kumar"
                      className="w-full bg-white border border-gray-300 rounded-2xl py-2.5 pl-10 pr-3 text-xs font-semibold text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]"
                      required
                    />
                    <User className="w-4 h-4 text-gray-400 absolute left-3.5 top-3" />
                  </div>
                </div>

                {/* Mobile Number */}
                <div>
                  <label className="block font-bold text-gray-800 mb-1">Mobile Number</label>
                  <div className="relative">
                    <input
                      type="text"
                      value={signUpPhone}
                      onChange={(e) => {
                        const val = e.target.value.replace(/\D/g, '');
                        if (val.length <= 10) setSignUpPhone(val);
                      }}
                      placeholder="e.g. 9876543210"
                      maxLength={10}
                      className="w-full bg-white border border-gray-300 rounded-2xl py-2.5 pl-10 pr-3 text-xs font-semibold text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]"
                      required
                    />
                    <Phone className="w-4 h-4 text-gray-400 absolute left-3.5 top-3" />
                  </div>
                </div>



                {/* Set Password */}
                <div>
                  <label className="block font-bold text-gray-800 mb-1">Set Password</label>
                  <div className="relative">
                    <input
                      type={showSignUpPassword ? 'text' : 'password'}
                      value={signUpPassword}
                      onChange={(e) => setSignUpPassword(e.target.value)}
                      placeholder="Set account password"
                      className="w-full bg-white border border-gray-300 rounded-2xl py-2.5 pl-10 pr-10 text-xs font-semibold text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]"
                      required
                    />
                    <Lock className="w-4 h-4 text-gray-400 absolute left-3.5 top-3" />
                    <button
                      type="button"
                      onClick={() => setShowSignUpPassword(!showSignUpPassword)}
                      className="absolute right-3.5 top-3 text-gray-400 hover:text-gray-600 cursor-pointer"
                    >
                      {showSignUpPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  className="w-full bg-[#1B4D3E] hover:bg-[#143B2B] text-white font-extrabold py-3.5 rounded-2xl transition-all shadow-md flex items-center justify-center gap-2 text-xs cursor-pointer active:scale-98"
                >
                  <span>Continue to Verification</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </form>
            ) : (
              <form onSubmit={handleSignUpStep2Submit} className="space-y-4 text-xs">
                <div className="bg-blue-50/80 p-3 rounded-2xl border border-blue-100 space-y-1">
                  <div className="flex items-center gap-2 text-blue-900 font-extrabold text-xs">
                    <ShieldCheck className="w-4.5 h-4.5 text-blue-700" />
                    <span>Enter Registration OTP Codes</span>
                  </div>
                  <p className="text-[10px] text-blue-800 leading-relaxed font-semibold">
                    We sent a 6-digit code to {signUpChallenge?.destination || signUpEmail || signUpPhone}.
                  </p>
                </div>

                {/* Single Email or Phone OTP */}
                <div>
                  <label className="block font-bold text-gray-800 mb-1 flex items-center gap-2">
                    <Mail className="w-4 h-4 text-gray-500" />
                    <Phone className="w-4 h-4 text-gray-500 -ml-1" />
                    <span>Email or Phone OTP (6 Digits)</span>
                  </label>
                  <OTPBoxGroup value={signUpEmailOTP} onChange={setSignUpEmailOTP} />
                </div>

                {signUpOtpError && <p className="text-[11px] font-bold text-rose-600">{signUpOtpError}</p>}

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setSignUpStep(1)}
                    className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold py-3 rounded-2xl text-xs transition-colors cursor-pointer active:scale-95 text-center"
                  >
                    Back to Edit
                  </button>

                  <button
                    type="submit"
                    className="flex-[2] bg-[#1B4D3E] hover:bg-[#143B2B] text-white font-extrabold py-3.5 rounded-2xl transition-all shadow-md flex items-center justify-center gap-2 text-xs cursor-pointer active:scale-98"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Verify & Create Account</span>
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
