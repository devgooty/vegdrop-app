import React, { useState } from 'react';
import {
  User,
  Mail,
  Phone,
  ArrowRight,
  Lock,
  Eye,
  EyeOff,
  CheckCircle2,
  Zap,
  Star,
  ShieldCheck,
  Store,
  Truck,
  Code,
  Loader2
} from 'lucide-react';
import { startRegistration, verifyRegistration, describePasswordProblem } from '../services/auth';
import { ApiRequestError, NetworkError } from '../services/apiClient';
import OTPBoxGroup from './OTPBoxGroup';

/**
 * Registration.
 *
 * Two steps: submit details, then verify a server-issued code. The account is
 * only created once the code is verified, and it is always a `customer` — this
 * page previously offered a role dropdown whose value was written straight into
 * the session, which let anyone sign up as a developer.
 *
 * `onSignUp` receives the authenticated user returned by the server.
 */
export default function SignUpPage({ onSignUp, onGoToLogin }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [step, setStep] = useState(1);
  const [challenge, setChallenge] = useState(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const describeError = (err, fallback) => {
    if (err instanceof NetworkError) {
      return 'Could not reach the server. Check your connection and try again.';
    }
    if (err instanceof ApiRequestError) return err.message;
    return fallback;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (isSubmitting) return;
    setError('');

    if (!name.trim() || !phone.trim() || !password) {
      setError('Name, mobile number, and password are all required.');
      return;
    }

    // Advisory check for fast feedback; the server enforces the real policy.
    const weak = describePasswordProblem(password);
    if (weak) {
      setError(weak);
      return;
    }

    setIsSubmitting(true);
    try {
      const issued = await startRegistration({
        name: name.trim(),
        phone: phone.trim(),
        email: email.trim() || undefined,
        password,
      });
      setChallenge(issued);
      setCode('');
      setStep(2);
    } catch (err) {
      setError(describeError(err, 'Could not start registration. Please try again.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleVerify = async (e) => {
    e.preventDefault();
    if (isSubmitting) return;
    setError('');

    if (!code || code.trim().length < 6) {
      setError('Enter the 6-digit verification code.');
      return;
    }

    setIsSubmitting(true);
    try {
      const user = await verifyRegistration({ challengeId: challenge.challengeId, code: code.trim() });
      setPassword('');
      onSignUp(user);
    } catch (err) {
      setError(describeError(err, 'Verification failed. Please try again.'));
      if (err instanceof ApiRequestError && ['OTP_EXPIRED', 'OTP_ATTEMPTS_EXCEEDED'].includes(err.code)) {
        setChallenge(null);
        setStep(1);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#FFFDF9] flex flex-col lg:flex-row font-sans text-gray-900">
      
      {/* 🌟 LEFT SHOWCASE HERO SECTION (Visible on LG Screens) */}
      <div className="hidden lg:flex lg:w-5/12 bg-gradient-to-br from-[#1B4D3E] via-[#143B2B] to-[#0D291E] text-white p-12 flex-col justify-between relative overflow-hidden shadow-2xl">
        {/* Background Glow Orbs */}
        <div className="absolute top-0 right-0 w-96 h-96 bg-emerald-400/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 left-0 w-96 h-96 bg-teal-500/10 rounded-full blur-3xl pointer-events-none" />

        {/* Top Branding */}
        <div className="relative z-10 space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-b from-[#3B7A57] to-[#1C4D38] text-white flex items-center justify-center font-bold text-2xl shadow-lg border border-emerald-400/30">
              🌿
            </div>
            <div>
              <span className="font-vintage font-extrabold text-2xl tracking-tight text-emerald-100">
                VegBazzar
              </span>
              <span className="text-[10px] font-mono block text-emerald-400 uppercase tracking-widest -mt-0.5">
                Artisanal Basket
              </span>
            </div>
          </div>

          <div className="pt-6 space-y-2">
            <span className="px-3 py-1 bg-emerald-500/20 text-emerald-300 rounded-full text-xs font-semibold border border-emerald-400/30 inline-flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5 text-emerald-400 fill-emerald-400" />
              Join VegBazzar Marketplace Network
            </span>
            <h1 className="text-3xl font-vintage font-extrabold text-white leading-tight tracking-tight">
              Create Your Account & Access Your Role Portal
            </h1>
            <p className="text-sm text-emerald-100/80 leading-relaxed font-normal">
              Register as a Customer, Shopkeeper merchant, Delivery Agent, Developer, or Marketplace Owner.
            </p>
          </div>
        </div>

        {/* Middle Feature Cards */}
        <div className="relative z-10 space-y-3 my-8">
          <div className="bg-white/10 backdrop-blur-md p-4 rounded-2xl border border-white/15 space-y-1.5 shadow-lg">
            <div className="flex items-center justify-between text-xs font-bold text-emerald-200">
              <span className="flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                Multi-Role Security Architecture
              </span>
              <span className="bg-emerald-400/20 text-emerald-300 px-2 py-0.5 rounded-full text-[10px]">Encrypted</span>
            </div>
            <p className="text-xs text-white/80">
              Privileged role accounts include automatic 2FA dual OTP verification for high-security inventory and financial operations.
            </p>
          </div>
        </div>

        {/* Bottom Rating */}
        <div className="relative z-10 pt-6 border-t border-emerald-800/60 flex items-center justify-between">
          <div className="flex items-center gap-1 text-amber-400">
            {[...Array(5)].map((_, i) => (
              <Star key={i} className="w-4 h-4 fill-amber-400 text-amber-400" />
            ))}
            <span className="text-xs font-bold text-white ml-1.5">4.9/5 Rating</span>
          </div>
          <span className="text-xs text-emerald-300/80 font-mono">Verified Sign Up</span>
        </div>
      </div>

      {/* 🚀 RIGHT FORM CONTAINER SECTION */}
      <div className="flex-1 flex flex-col justify-center items-center p-6 md:p-12 lg:p-16 max-w-2xl mx-auto w-full">
        
        {/* Mobile Branding */}
        <div className="lg:hidden flex items-center gap-2.5 mb-6 text-center">
          <div className="w-10 h-10 rounded-2xl bg-[#1B4D3E] text-white flex items-center justify-center font-bold text-xl shadow-md">
            🌿
          </div>
          <span className="font-vintage font-extrabold text-xl text-[#1B4D3E]">VegBazzar Portal</span>
        </div>

        <div className="w-full max-w-md space-y-5">
          
          {/* Header text */}
          <div className="space-y-1 text-left">
            <h2 className="font-vintage font-extrabold text-3xl text-gray-900 tracking-tight">
              Create New Account
            </h2>
            <p className="text-xs text-gray-500 font-medium">
              {step === 1
                ? 'Enter your details to create a customer account.'
                : `Enter the 6-digit code we sent to ${challenge?.destination || 'you'}.`}
            </p>
          </div>

          {/* STEP 2: verify the server-issued code */}
          {step === 2 && (
            <form onSubmit={handleVerify} className="space-y-4 text-xs">
              <div className="bg-amber-50 p-4 rounded-2xl border border-amber-200 flex items-center gap-2 text-amber-900 font-extrabold text-xs">
                <ShieldCheck className="w-4 h-4 text-amber-700" />
                <span>Verify your contact details</span>
              </div>

              <OTPBoxGroup value={code} onChange={setCode} />

              {error && <p className="text-[11px] font-bold text-rose-600">{error}</p>}

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full bg-gradient-to-r from-[#1B4D3E] to-[#276652] hover:from-[#143B2B] hover:to-[#1B4D3E] disabled:opacity-60 disabled:cursor-not-allowed text-white font-extrabold py-4 rounded-2xl transition-all shadow-md hover:shadow-xl flex items-center justify-center gap-2 text-xs cursor-pointer active:scale-98"
              >
                {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                <span>{isSubmitting ? 'Verifying…' : 'Verify & Create Account'}</span>
              </button>

              <button
                type="button"
                onClick={() => { setStep(1); setChallenge(null); setError(''); }}
                className="w-full text-gray-500 font-bold py-2 text-[11px] cursor-pointer hover:text-gray-700"
              >
                ← Back to details
              </button>
            </form>
          )}

          {step === 1 && (
          <form onSubmit={handleSubmit} className="space-y-3.5 text-xs">
            {/* Full Name */}
            <div>
              <label className="block font-bold text-gray-800 mb-1">Full Name</label>
              <div className="relative">
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Ananya Verma"
                  className="w-full bg-white border border-gray-300 rounded-2xl py-3 pl-11 pr-4 text-xs font-semibold text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]/30 focus:border-[#1B4D3E] shadow-xs"
                  required
                />
                <User className="w-4 h-4 text-gray-400 absolute left-4 top-3.5" />
              </div>
            </div>

            {/* Email Address */}
            <div>
              <label className="block font-bold text-gray-800 mb-1">Email Address</label>
              <div className="relative">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="ananya@example.com"
                  className="w-full bg-white border border-gray-300 rounded-2xl py-3 pl-11 pr-4 text-xs font-semibold text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]/30 focus:border-[#1B4D3E] shadow-xs"
                  required
                />
                <Mail className="w-4 h-4 text-gray-400 absolute left-4 top-3.5" />
              </div>
            </div>

            {/* Mobile Number */}
            <div>
              <label className="block font-bold text-gray-800 mb-1">Mobile Number</label>
              <div className="relative flex items-center">
                <span className="absolute left-4 text-gray-500 font-bold text-xs pointer-events-none">
                  +91
                </span>
                <input
                  type="tel"
                  maxLength={10}
                  value={phone}
                  onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
                  placeholder="9876543210"
                  className="w-full bg-white border border-gray-300 rounded-2xl py-3 pl-14 pr-4 text-xs font-semibold text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]/30 focus:border-[#1B4D3E] shadow-xs"
                  required
                />
                <Phone className="w-4 h-4 text-gray-400 absolute right-4" />
              </div>
            </div>

            {/* Password */}
            <div>
              <label className="block font-bold text-gray-800 mb-1">Set Password</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Set account password"
                  className="w-full bg-white border border-gray-300 rounded-2xl py-3 pl-11 pr-11 text-xs font-semibold text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]/30 focus:border-[#1B4D3E] shadow-xs"
                  required
                />
                <Lock className="w-4 h-4 text-gray-400 absolute left-4 top-3.5" />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-4 top-3.5 text-gray-400 hover:text-gray-600 cursor-pointer"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {error && <p className="text-[11px] font-bold text-rose-600">{error}</p>}

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full bg-gradient-to-r from-[#1B4D3E] to-[#276652] hover:from-[#143B2B] hover:to-[#1B4D3E] disabled:opacity-60 disabled:cursor-not-allowed text-white font-extrabold py-4 rounded-2xl transition-all shadow-md hover:shadow-xl flex items-center justify-center gap-2 text-xs cursor-pointer active:scale-98 mt-2"
            >
              {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              <span>{isSubmitting ? 'Sending code…' : 'Continue'}</span>
            </button>
          </form>
          )}

          {/* Link to Login Page */}
          <div className="pt-4 border-t border-gray-200 text-center text-xs">
            <span className="text-gray-500">Already have an account? </span>
            <button
              onClick={onGoToLogin}
              className="font-extrabold text-[#1B4D3E] hover:underline cursor-pointer ml-1"
            >
              Sign In (Log In)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
