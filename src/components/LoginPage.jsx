import React, { useState } from 'react';
import {
  User,
  Phone,
  Mail,
  ArrowRight,
  ShieldCheck,
  CheckCircle2,
  Zap,
  ArrowLeft,
  Loader2,
  MessageCircle,
  Info,
} from 'lucide-react';
import {
  lookupIdentifier,
  startIdentifierAuth,
  verifyPhoneAuth,
  startRegistration,
  verifyRegistration,
  describeIdentifierProblem,
  describePhoneProblem,
  describeEmailProblem,
} from '../services/auth';
import { ApiRequestError, NetworkError } from '../services/apiClient';

import OTPBoxGroup from './OTPBoxGroup';

/**
 * Sign in and sign up — passwordless.
 *
 * One box first: a mobile number OR an email address. The server is asked
 * whether that identifier has an account, and the flow forks:
 *
 *   existing → one code, delivered to every verified contact at once
 *   new      → both contacts collected, each proved by its OWN code
 *
 * Two things about that fork are worth knowing before changing it.
 *
 * The lookup call reveals whether an identifier is registered, which the rest of
 * this flow is otherwise careful never to disclose. It is a deliberate trade for
 * this UX, priced by the tightest rate limit on the server. Do not call it while
 * the user is typing.
 *
 * At registration the two codes DIFFER, and must. Sharing one would mean holding
 * either channel proves both. At sign-in they are the same code by design — it is
 * one challenge delivered twice, so whichever arrives first works.
 *
 * `onLogin` receives the user object the server returns. This component never
 * determines a role and never validates a code — both are server decisions.
 */
const STEP = {
  IDENTIFIER: 'identifier',
  LOGIN_CODE: 'login-code',
  REGISTER: 'register',
  REGISTER_CODES: 'register-codes',
};

export default function LoginPage({ onLogin, appType = 'customer', storagePrefix = 'vegbazzar_' }) {
  const [step, setStep] = useState(STEP.IDENTIFIER);

  const [identifier, setIdentifier] = useState(() => {
    return window.localStorage.getItem(`${storagePrefix}remembered_id`) || '';
  });
  const [rememberMe, setRememberMe] = useState(() => {
    return window.localStorage.getItem(`${storagePrefix}remember_me`) === 'true';
  });

  // Registration inputs, pre-filled from whatever was typed in the first box.
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');

  const [code, setCode] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [phoneCode, setPhoneCode] = useState('');

  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Server-issued challenges. Holding an id is not enough to authenticate — the
  // code itself is verified on the server.
  const [challenge, setChallenge] = useState(null);
  const [registration, setRegistration] = useState(null);

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

  const resetToStart = () => {
    setError('');
    setChallenge(null);
    setRegistration(null);
    setCode('');
    setEmailCode('');
    setPhoneCode('');
    setStep(STEP.IDENTIFIER);
  };

  /** Step 1: does this identifier have an account? Fork accordingly. */
  const handleContinue = async (e) => {
    e.preventDefault();
    if (isSubmitting) return;

    const problem = describeIdentifierProblem(identifier);
    if (problem) {
      setError(problem);
      return;
    }

    setError('');
    setIsSubmitting(true);

    const typed = identifier.trim();
    if (rememberMe) {
      window.localStorage.setItem(`${storagePrefix}remembered_id`, typed);
      window.localStorage.setItem(`${storagePrefix}remember_me`, 'true');
    } else {
      window.localStorage.removeItem(`${storagePrefix}remembered_id`);
      window.localStorage.removeItem(`${storagePrefix}remember_me`);
    }

    try {
      const { exists, type } = await lookupIdentifier({ identifier: typed });

      if (exists) {
        const issued = await startIdentifierAuth({ identifier: typed });
        setChallenge(issued);
        setCode('');
        setStep(STEP.LOGIN_CODE);
        return;
      }

      // New here. Carry across whichever contact they already gave us so they
      // only have to fill in the other one.
      if (type === 'email') {
        setEmail(typed);
        setPhone('');
      } else {
        setPhone(typed.replace(/\D/g, '').slice(-10));
        setEmail('');
      }
      setStep(STEP.REGISTER);
    } catch (err) {
      setError(describeError(err, 'Could not continue. Please try again.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  /** Existing account: one code, whichever channel it arrived on. */
  const handleVerifyLogin = async (e) => {
    e.preventDefault();
    if (isSubmitting) return;

    if (!code || code.trim().length < 6) {
      setError('Enter the 6-digit verification code.');
      return;
    }
    if (!challenge?.challengeId) {
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
        resetToStart();
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  /** New account: ask the server to send one code to each contact. */
  const handleStartRegistration = async (e) => {
    e.preventDefault();
    if (isSubmitting) return;

    const problem = describePhoneProblem(phone) || describeEmailProblem(email);
    if (problem) {
      setError(problem);
      return;
    }

    setError('');
    setIsSubmitting(true);

    try {
      const issued = await startRegistration({
        phone: phone.trim(),
        email: email.trim(),
        name: name.trim() || undefined,
      });
      setRegistration(issued);
      setEmailCode('');
      setPhoneCode('');
      setStep(STEP.REGISTER_CODES);
    } catch (err) {
      setError(describeError(err, 'Could not start registration. Please try again.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  /** New account: prove each contact that actually received a code. */
  const handleVerifyRegistration = async (e) => {
    e.preventDefault();
    if (isSubmitting) return;

    const phoneWasDelivered = Boolean(registration?.phone?.delivered);

    if (!emailCode || emailCode.trim().length < 6) {
      setError('Enter the 6-digit code sent to your email.');
      return;
    }
    if (phoneWasDelivered && (!phoneCode || phoneCode.trim().length < 6)) {
      setError('Enter the 6-digit code sent on WhatsApp.');
      return;
    }

    setError('');
    setIsSubmitting(true);

    try {
      const user = await verifyRegistration({
        emailChallengeId: registration.email.challengeId,
        emailCode: emailCode.trim(),
        // Omitted entirely when WhatsApp could not be reached; the server then
        // keeps the number unverified rather than treating it as proved.
        phoneChallengeId: phoneWasDelivered ? registration.phone.challengeId : undefined,
        phoneCode: phoneWasDelivered ? phoneCode.trim() : undefined,
      });
      onLogin(user);
    } catch (err) {
      setError(describeError(err, 'Verification failed. Please try again.'));

      if (err instanceof ApiRequestError && ['OTP_EXPIRED', 'OTP_ATTEMPTS_EXCEEDED'].includes(err.code)) {
        resetToStart();
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const headings = {
    [STEP.IDENTIFIER]: ['Sign In', 'Enter your mobile number or email to continue.'],
    [STEP.LOGIN_CODE]: ['Enter Code', 'We sent one code to your WhatsApp and email.'],
    [STEP.REGISTER]: ['Create Account', "You're new here — we need both contacts."],
    [STEP.REGISTER_CODES]: ['Verify Contacts', 'Enter the code sent to each one.'],
  };
  const [heading, subheading] = headings[step];

  const inputClass =
    'w-full bg-white border border-gray-300 rounded-2xl py-3.5 pl-11 pr-4 text-xs font-semibold text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]/30 focus:border-[#1B4D3E] shadow-xs';
  const buttonClass =
    'w-full bg-gradient-to-r from-[#1B4D3E] to-[#276652] hover:from-[#143B2B] hover:to-[#1B4D3E] text-white font-extrabold py-4 rounded-2xl transition-all shadow-md hover:shadow-xl flex items-center justify-center gap-2 text-xs cursor-pointer active:scale-98 disabled:opacity-70 disabled:cursor-not-allowed';

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
                Sign in with your mobile number or email — we'll send you a code.
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

          <div className="space-y-1.5 text-left">
            <h2 className="font-vintage font-extrabold text-3xl text-gray-900 tracking-tight">{heading}</h2>
            <p className="text-xs text-gray-500 font-medium">{subheading}</p>
          </div>

          {/* STEP 1: ONE BOX — NUMBER OR EMAIL */}
          {step === STEP.IDENTIFIER && (
            <div className="animate-fade-in">
              <form onSubmit={handleContinue} className="space-y-4 text-xs">
                <div>
                  <label className="block font-bold text-gray-800 mb-1.5 text-xs">
                    Mobile Number or Email
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      inputMode="email"
                      autoComplete="username"
                      value={identifier}
                      onChange={(e) => setIdentifier(e.target.value)}
                      placeholder="9876543210 or you@example.com"
                      maxLength={254}
                      className={inputClass}
                      required
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
                    Remember me on this machine
                  </label>
                </div>

                {error && <p className="text-[11px] font-bold text-rose-600">{error}</p>}

                <button type="submit" disabled={isSubmitting} className={buttonClass}>
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Checking…</span>
                    </>
                  ) : (
                    <>
                      <span>Next</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>

                <p className="text-[10px] text-gray-400 text-center leading-relaxed">
                  New here? We'll set up your account on the next screen.
                </p>
              </form>
            </div>
          )}

          {/* STEP 2A: SIGN IN — ONE CODE, BOTH CHANNELS */}
          {step === STEP.LOGIN_CODE && (
            <div className="animate-fade-in">
              <form onSubmit={handleVerifyLogin} className="space-y-4 text-xs">
                <div className="bg-gray-50 p-3 rounded-2xl border border-gray-200 flex items-center justify-between">
                  <div>
                    <span className="text-[10px] text-gray-500 block uppercase font-semibold">Signing in as:</span>
                    <span className="font-bold text-gray-900">{identifier}</span>
                  </div>
                  <button
                    type="button"
                    onClick={resetToStart}
                    className="text-xs text-[#1B4D3E] font-bold underline cursor-pointer hover:text-emerald-900 flex items-center gap-1"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    <span>Change</span>
                  </button>
                </div>

                <div className="bg-amber-50 p-4 rounded-2xl border border-amber-200 space-y-1">
                  <div className="flex items-center gap-2 text-amber-900 font-extrabold text-xs">
                    <ShieldCheck className="w-4 h-4 text-amber-700" />
                    <span>Verification</span>
                  </div>
                  <p className="text-[11px] text-amber-800 leading-relaxed">
                    {/* One challenge, delivered to every verified contact — so the
                        same code works whichever one arrives first. */}
                    We sent a 6-digit code to {challenge?.destination || 'your contacts'}. If your
                    account has both a number and an email, the same code goes to both.
                  </p>
                </div>

                <div>
                  <label className="font-bold text-gray-800 mb-1 flex items-center gap-2">
                    <MessageCircle className="w-4 h-4 text-gray-500" />
                    <span>Verification Code (6 Digits)</span>
                  </label>
                  <OTPBoxGroup value={code} onChange={setCode} />
                </div>

                {error && <p className="text-[11px] font-bold text-rose-600">{error}</p>}

                <button type="submit" disabled={isSubmitting} className={buttonClass}>
                  {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                  <span>{isSubmitting ? 'Verifying…' : 'Verify & Sign In'}</span>
                </button>
              </form>
            </div>
          )}

          {/* STEP 2B: REGISTER — BOTH CONTACTS */}
          {step === STEP.REGISTER && (
            <div className="animate-fade-in">
              <form onSubmit={handleStartRegistration} className="space-y-4 text-xs">
                <div className="bg-emerald-50 p-3 rounded-2xl border border-emerald-200 flex items-start gap-2">
                  <Info className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
                  <p className="text-[11px] text-emerald-900 leading-relaxed">
                    We need both so you can always get in — if WhatsApp is unavailable, your email
                    still works.
                  </p>
                </div>

                <div>
                  <label className="block font-bold text-gray-800 mb-1.5 text-xs">WhatsApp Number</label>
                  <div className="relative flex items-center">
                    <span className="absolute left-4 text-gray-500 font-bold text-xs pointer-events-none">+91</span>
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

                <div>
                  <label className="block font-bold text-gray-800 mb-1.5 text-xs">Email Address</label>
                  <div className="relative">
                    <input
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@example.com"
                      maxLength={254}
                      className={inputClass}
                      required
                      disabled={isSubmitting}
                    />
                    <Mail className="w-4 h-4 text-gray-400 absolute left-4 top-4" />
                  </div>
                </div>

                <div>
                  <label className="block font-bold text-gray-800 mb-1.5 text-xs">
                    Your Name
                    <span className="font-medium text-gray-400 ml-1">— optional</span>
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. Ramesh Kumar"
                      maxLength={120}
                      className={inputClass}
                      disabled={isSubmitting}
                    />
                    <User className="w-4 h-4 text-gray-400 absolute left-4 top-4" />
                  </div>
                </div>

                {error && <p className="text-[11px] font-bold text-rose-600">{error}</p>}

                <button type="submit" disabled={isSubmitting} className={buttonClass}>
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Sending codes…</span>
                    </>
                  ) : (
                    <>
                      <span>Send verification codes</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={resetToStart}
                  className="w-full text-[11px] text-gray-500 font-bold underline cursor-pointer hover:text-gray-800"
                >
                  Back
                </button>
              </form>
            </div>
          )}

          {/* STEP 3: REGISTER — ONE CODE PER CONTACT */}
          {step === STEP.REGISTER_CODES && (
            <div className="animate-fade-in">
              <form onSubmit={handleVerifyRegistration} className="space-y-4 text-xs">

                {/* WhatsApp code — hidden entirely when delivery failed. The
                    number is still kept against the account, unverified, so it
                    can be confirmed later. */}
                {registration?.phone?.delivered ? (
                  <div>
                    <label className="font-bold text-gray-800 mb-1 flex items-center gap-2">
                      <MessageCircle className="w-4 h-4 text-gray-500" />
                      <span>WhatsApp Code — {registration.phone.destination}</span>
                    </label>
                    <OTPBoxGroup value={phoneCode} onChange={setPhoneCode} />
                  </div>
                ) : (
                  <div className="bg-amber-50 p-3 rounded-2xl border border-amber-200 flex items-start gap-2">
                    <Info className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                    <p className="text-[11px] text-amber-900 leading-relaxed">
                      We couldn't reach WhatsApp right now, so we've saved your number and skipped
                      that code. Verify your email below to finish — you can confirm the number
                      later from your profile.
                    </p>
                  </div>
                )}

                <div>
                  <label className="font-bold text-gray-800 mb-1 flex items-center gap-2">
                    <Mail className="w-4 h-4 text-gray-500" />
                    <span>Email Code — {registration?.email?.destination}</span>
                  </label>
                  <OTPBoxGroup value={emailCode} onChange={setEmailCode} />
                </div>

                {error && <p className="text-[11px] font-bold text-rose-600">{error}</p>}

                <button type="submit" disabled={isSubmitting} className={buttonClass}>
                  {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                  <span>{isSubmitting ? 'Verifying…' : 'Create Account'}</span>
                </button>

                <button
                  type="button"
                  onClick={resetToStart}
                  className="w-full text-[11px] text-gray-500 font-bold underline cursor-pointer hover:text-gray-800"
                >
                  Start over
                </button>
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
