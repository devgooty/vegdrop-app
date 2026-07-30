import React, { useState } from 'react';
import {
  User,
  Phone,
  ArrowRight,
  ShieldCheck,
  CheckCircle2,
  Zap,
  ArrowLeft,
  Loader2,
  MessageCircle,
} from 'lucide-react';
import { startPhoneAuth, verifyPhoneAuth, describePhoneProblem } from '../services/auth';
import { ApiRequestError, NetworkError } from '../services/apiClient';

import OTPBoxGroup from './OTPBoxGroup';

/**
 * Sign in — passwordless.
 *
 * Two steps: enter a mobile number, then enter the code WhatsApp delivers to it.
 * There is no password field and no separate sign-up screen, because the server
 * treats both as one flow: a number with no account gets one created when the
 * code checks out.
 *
 * `onLogin` receives the user object returned by the server after successful
 * verification. This component never determines a role and never validates a
 * code — both are server decisions.
 */
export default function LoginPage({ onLogin, appType = 'customer', storagePrefix = 'vegbazzar_' }) {
  const [step, setStep] = useState(1);

  const [phone, setPhone] = useState(() => {
    return window.localStorage.getItem(`${storagePrefix}remembered_id`) || '';
  });
  const [name, setName] = useState('');
  const [rememberMe, setRememberMe] = useState(() => {
    return window.localStorage.getItem(`${storagePrefix}remember_me`) === 'true';
  });

  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Server-issued challenge. Holding the id is not enough to authenticate — the
  // code itself is verified on the server.
  const [challenge, setChallenge] = useState(null);

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

  /** Step 1: ask the server to send a code to this number. */
  const handleRequestCode = async (e) => {
    e.preventDefault();
    if (isSubmitting) return;

    const badPhone = describePhoneProblem(phone);
    if (badPhone) {
      setError(badPhone);
      return;
    }

    setError('');
    setIsSubmitting(true);

    if (rememberMe) {
      window.localStorage.setItem(`${storagePrefix}remembered_id`, phone);
      window.localStorage.setItem(`${storagePrefix}remember_me`, 'true');
    } else {
      window.localStorage.removeItem(`${storagePrefix}remembered_id`);
      window.localStorage.removeItem(`${storagePrefix}remember_me`);
    }

    try {
      const issued = await startPhoneAuth({ phone: phone.trim(), name: name.trim() || undefined });
      setChallenge(issued);
      setCode('');
      setStep(2);
    } catch (err) {
      setError(describeError(err, 'Could not send a code. Please try again.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  /** Step 2: the server verifies the code and establishes the session. */
  const handleVerify = async (e) => {
    e.preventDefault();
    if (isSubmitting) return;

    if (!code || code.trim().length < 6) {
      setError('Enter the 6-digit verification code.');
      return;
    }
    if (!challenge) {
      setError('This sign-in attempt has expired. Please start again.');
      return;
    }

    setError('');
    setIsSubmitting(true);

    try {
      // The authenticated user comes back from the server, including their role.
      // Nothing about the session is constructed here.
      const user = await verifyPhoneAuth({ challengeId: challenge.challengeId, code: code.trim() });
      onLogin(user);
    } catch (err) {
      setError(describeError(err, 'Verification failed. Please try again.'));

      // An expired or exhausted challenge cannot be retried; send them back.
      if (err instanceof ApiRequestError && ['OTP_EXPIRED', 'OTP_ATTEMPTS_EXCEEDED'].includes(err.code)) {
        setChallenge(null);
        setCode('');
        setStep(1);
      }
    } finally {
      setIsSubmitting(false);
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
                No password needed
              </span>
              <h2 className="text-lg font-vintage font-extrabold text-white leading-snug">
                Farm-to-Table Fresh Produce
              </h2>
              <p className="text-xs text-emerald-100/80 leading-relaxed font-normal">
                Sign in with your mobile number — we'll send a code on WhatsApp.
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
              {step === 1 ? 'Sign In' : 'Enter Code'}
            </h2>
            <p className="text-xs text-gray-500 font-medium">
              {step === 1 && 'Enter your mobile number to continue.'}
              {step === 2 && 'Check WhatsApp for your 6-digit code.'}
            </p>
          </div>

          {/* STEP 1: MOBILE NUMBER */}
          {step === 1 && (
            <div className="animate-fade-in">
              <form onSubmit={handleRequestCode} className="space-y-4 text-xs">
                <div>
                  <label className="block font-bold text-gray-800 mb-1.5 text-xs">
                    Mobile Number
                  </label>
                  <div className="relative flex items-center">
                    <span className="absolute left-4 text-gray-500 font-bold text-xs pointer-events-none">
                      +91
                    </span>
                    <input
                      type="tel"
                      inputMode="numeric"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                      placeholder="9876543210"
                      maxLength={10}
                      className="w-full bg-white border border-gray-300 rounded-2xl py-3.5 pl-14 pr-11 text-xs font-semibold text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]/30 focus:border-[#1B4D3E] shadow-xs"
                      required
                      disabled={isSubmitting}
                    />
                    <Phone className="w-4 h-4 text-gray-400 absolute right-4" />
                  </div>
                </div>

                {/* Only used when this number is new to us — the server ignores it
                    for an existing account, so it cannot rename someone else. */}
                <div>
                  <label className="block font-bold text-gray-800 mb-1.5 text-xs">
                    Your Name
                    <span className="font-medium text-gray-400 ml-1">— first time only</span>
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. Ramesh Kumar"
                      maxLength={120}
                      className="w-full bg-white border border-gray-300 rounded-2xl py-3.5 pl-11 pr-4 text-xs font-semibold text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]/30 focus:border-[#1B4D3E] shadow-xs"
                      disabled={isSubmitting}
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
                    Remember my number on this machine
                  </label>
                </div>

                {error && <p className="text-[11px] font-bold text-rose-600">{error}</p>}

                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full bg-gradient-to-r from-[#1B4D3E] to-[#276652] hover:from-[#143B2B] hover:to-[#1B4D3E] text-white font-extrabold py-4 rounded-2xl transition-all shadow-md hover:shadow-xl flex items-center justify-center gap-2 text-xs cursor-pointer active:scale-98 disabled:opacity-70 disabled:cursor-not-allowed"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Sending code…</span>
                    </>
                  ) : (
                    <>
                      <MessageCircle className="w-4 h-4" />
                      <span>Send code on WhatsApp</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>

                <p className="text-[10px] text-gray-400 text-center leading-relaxed">
                  New here? Signing in with a new number creates your account.
                </p>
              </form>
            </div>
          )}

          {/* STEP 2: VERIFICATION CODE */}
          {step === 2 && (
            <div className="animate-fade-in">
              <form onSubmit={handleVerify} className="space-y-4 text-xs">
                <div className="bg-gray-50 p-3 rounded-2xl border border-gray-200 flex items-center justify-between">
                  <div>
                    <span className="text-[10px] text-gray-500 block uppercase font-semibold">Sending to:</span>
                    <span className="font-bold text-gray-900">+91 {phone}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => { setError(''); setChallenge(null); setStep(1); }}
                    className="text-xs text-[#1B4D3E] font-bold underline cursor-pointer hover:text-emerald-900 flex items-center gap-1"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    <span>Change</span>
                  </button>
                </div>

                <div className="bg-amber-50 p-4 rounded-2xl border border-amber-200 space-y-1">
                  <div className="flex items-center gap-2 text-amber-900 font-extrabold text-xs">
                    <ShieldCheck className="w-4 h-4 text-amber-700" />
                    <span>WhatsApp Verification</span>
                  </div>
                  <p className="text-[11px] text-amber-800 leading-relaxed">
                    {challenge
                      ? `We sent a 6-digit code to ${challenge.destination} on WhatsApp. Enter it below to finish signing in.`
                      : 'Enter the 6-digit code we sent you to finish signing in.'}
                  </p>
                </div>

                <div>
                  <label className="block font-bold text-gray-800 mb-1 flex items-center gap-2">
                    <MessageCircle className="w-4 h-4 text-gray-500" />
                    <span>WhatsApp OTP (6 Digits)</span>
                  </label>
                  <OTPBoxGroup value={code} onChange={setCode} />
                </div>

                {error && <p className="text-[11px] font-bold text-rose-600">{error}</p>}

                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full bg-gradient-to-r from-[#1B4D3E] to-[#276652] hover:from-[#143B2B] hover:to-[#1B4D3E] disabled:opacity-60 disabled:cursor-not-allowed text-white font-extrabold py-4 rounded-2xl transition-all shadow-md hover:shadow-xl flex items-center justify-center gap-2 text-xs cursor-pointer active:scale-98"
                >
                  {isSubmitting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="w-4 h-4" />
                  )}
                  <span>{isSubmitting ? 'Verifying…' : 'Verify & Sign In'}</span>
                </button>
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
