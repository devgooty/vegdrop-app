import React, { useState } from 'react';
import { ArrowRight, ArrowLeft, Loader2, Check, Info } from 'lucide-react';
import {
  lookupIdentifier,
  startIdentifierAuth,
  verifyPhoneAuth,
  startRegistration,
  verifyRegistration,
  startVendorRegistration,
  verifyVendorRegistration,
  describeIdentifierProblem,
  describePhoneProblem,
  describeEmailProblem,
} from '../services/auth';
import { ApiRequestError, NetworkError } from '../services/apiClient';

import OTPBoxGroup from './OTPBoxGroup';

/**
 * Sign in and sign up — passwordless.
 *
 * FLOW
 *
 * One box first: a mobile number OR an email address. The server is asked
 * whether that identifier has an account, and the flow forks:
 *
 *   existing → one code, delivered to every verified contact
 *   new      → both contacts collected, each proved by its OWN code
 *
 * Two things about that fork matter if you change it. The lookup call reveals
 * whether an identifier is registered, which the rest of this flow is careful
 * never to disclose — a deliberate trade for this UX, priced by the tightest
 * rate limit on the server, so never call it while the user is typing. And at
 * registration the two codes DIFFER by design; sharing one would mean holding
 * either channel proves both.
 *
 * DESIGN
 *
 * Quick-commerce grocery — the register Blinkit, Zepto and Instamart set, which
 * is what this app's customers already recognise as "the app that brings me
 * food": a saturated green hero carrying the delivery promise and real produce,
 * with a white sheet lifted over it holding the form. Tokens live in index.css
 * under `.si-scope`.
 *
 * The screen is meant to read as stocked, not airy — an empty login for a
 * grocery shop looks shut. Density comes from produce and proof, never from
 * decorating the form, which stays plain and high-contrast because it is the
 * part someone has to read at six in the morning.
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

/**
 * The page's own heading, above the card. It tracks the flow rather than
 * staying fixed — "Login" sitting over a card that reads "Create account"
 * contradicts itself.
 */
const PAGE_TITLE = {
  [STEP.IDENTIFIER]: 'Login',
  [STEP.LOGIN_CODE]: 'Login',
  [STEP.REGISTER]: 'Sign up',
  [STEP.REGISTER_CODES]: 'Sign up',
};

/**
 * Subtitles are kept to a single line at phone width on purpose. Each one that
 * wraps costs 18px, and the whole screen has to clear the viewport without
 * scrolling — the field's own label already says what to type.
 */
const COPY = {
  [STEP.IDENTIFIER]: {
    title: 'Sign in',
    sub: "We'll send you a one-time code.",
  },
  [STEP.LOGIN_CODE]: {
    title: 'Enter your code',
    sub: 'Six digits, sent to WhatsApp and email.',
  },
  [STEP.REGISTER]: {
    title: 'Create account',
    sub: "You're new here. We need both contacts.",
  },
  [STEP.REGISTER_CODES]: {
    title: 'Check your messages',
    sub: 'Type the code from each one below.',
  },
};

/**
 * Served from `public/`, so it is a same-origin file rather than a remote
 * fetch — this is the first paint of the first screen, and it carries the
 * wordmark, so it must not wait on a third party.
 *
 * Shared by every app. A separate shopkeeper photo was tried and reverted —
 * the brand is one photo, and the shopkeeper screen tells itself apart through
 * its heading instead (see the `isVendor` check on the h1 below), not through
 * a second asset to keep in sync with the first.
 */
const HERO_SRC = '/hero.webp';

export default function LoginPage({ onLogin, appType = 'customer', storagePrefix = 'vegdrop_' }) {
  // Shopkeepers register through the SAME dual-OTP flow as customers — this app
  // has no passwords, so there is no extra step to insert — but the account
  // that comes out the other end holds the `shopkeeper` role. That is a server
  // decision made by which endpoint is called (routes/auth.js), never by
  // anything chosen here.
  const isVendor = appType === 'shopkeeper';

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
   * Turn any thrown error into something worth showing.
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
      setError('Enter all six digits.');
      return;
    }
    if (!challenge?.challengeId) {
      setError('This sign-in expired. Start again.');
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
      setError(describeError(err, 'That code did not work. Try again.'));

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
      const startFn = isVendor ? startVendorRegistration : startRegistration;
      const issued = await startFn({
        phone: phone.trim(),
        email: email.trim(),
        name: name.trim() || undefined,
      });
      setRegistration(issued);
      setEmailCode('');
      setPhoneCode('');
      setStep(STEP.REGISTER_CODES);
    } catch (err) {
      setError(describeError(err, 'Could not send the codes. Please try again.'));
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
      setError('Enter all six digits from your email.');
      return;
    }
    if (phoneWasDelivered && (!phoneCode || phoneCode.trim().length < 6)) {
      setError('Enter all six digits from WhatsApp.');
      return;
    }

    setError('');
    setIsSubmitting(true);

    try {
      const payload = {
        emailChallengeId: registration.email.challengeId,
        emailCode: emailCode.trim(),
        // Omitted entirely when WhatsApp could not be reached; the server then
        // keeps the number unverified rather than treating it as proved.
        phoneChallengeId: phoneWasDelivered ? registration.phone.challengeId : undefined,
        phoneCode: phoneWasDelivered ? phoneCode.trim() : undefined,
      };
      // verifyVendorRegistration also returns `nextStep: 'kyc'`, but the
      // shopkeeper app already checks KYC status on mount for every sign-in
      // (not just a fresh signup), so there is nothing extra to thread through
      // here — `user` is all onLogin needs.
      const user = isVendor ? (await verifyVendorRegistration(payload)).user : await verifyRegistration(payload);
      onLogin(user);
    } catch (err) {
      setError(describeError(err, 'That did not work. Check the codes and try again.'));

      if (err instanceof ApiRequestError && ['OTP_EXPIRED', 'OTP_ATTEMPTS_EXCEEDED'].includes(err.code)) {
        resetToStart();
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  let { title, sub } = COPY[step];
  if (isVendor && step === STEP.REGISTER) {
    title = 'Register your stall';
    sub = "You're new here. We need both contacts, then a quick account check.";
  } else if (isVendor && step === STEP.REGISTER_CODES) {
    sub = "Type the code from each one below. You'll verify your bank account next.";
  }

  const fieldClass =
    'w-full bg-[#F1F7F3] border border-[#DCE9E1] rounded-xl px-4 py-3.5 text-[15px] text-[#0F1F17] ' +
    'placeholder:text-[#5B6B62]/60 focus:outline-none focus:bg-white focus:border-[#16A34A] ' +
    'focus:ring-[3px] focus:ring-[#16A34A]/18 transition';

  const labelClass = 'block text-[12.5px] font-bold text-[#0F1F17] mb-2';

  // #0B7A37 rather than the lighter brand green: white 15px bold needs 4.5:1,
  // which #16A34A misses at 3.3. This clears it at 5.4.
  const primaryButton =
    'w-full bg-[#0B7A37] hover:bg-[#08652C] text-white text-[15px] font-bold py-4 rounded-xl ' +
    'shadow-[0_8px_18px_-8px_rgba(11,122,55,0.75)] active:translate-y-[1px] transition-all ' +
    'flex items-center justify-center gap-2 ' +
    'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[#16A34A]/35 ' +
    'disabled:opacity-55 disabled:cursor-not-allowed disabled:shadow-none disabled:translate-y-0';

  const quietButton =
    'text-[12.5px] font-bold text-[#0B7A37] hover:text-[#08652C] underline underline-offset-4 ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#16A34A]/40 rounded';

  // A definite height, not a minimum: flex-shrink only engages when the
  // container has a real size to overflow, and the shrinking hero is what makes
  // this fit a screen of any height. overflow-y-auto is the safety net for the
  // taller registration step.
  return (
    <div className="si-scope flex h-[100dvh] flex-col overflow-y-auto">

      {/* Full bleed to the screen edges — the artwork's own white margin is the
          only padding it needs, and the page continues in the same white where
          the crop ends.

          alt names the shop rather than being empty: the wordmark is painted
          into this artwork, so it is the only place the brand is stated. */}
      {/* Shrinks below the image's natural height so the artwork is the only
          thing that gives — the form below is shrink-0.

          The floor lives here rather than on the image: the image is bounded by
          max-height:100% of this box, so a min-height on the image itself would
          let it outgrow its parent and paint over the form. 15rem is where the
          shrinking has to stop before the wordmark itself starts getting
          clipped by the box. */}
      <header className="min-h-[15rem] shrink">
        <img
          src={HERO_SRC}
          alt="VegDrop"
          width="768"
          height="790"
          fetchPriority="high"
          className="si-hero-img"
        />
      </header>

      <main className="shrink-0 px-4 pt-1 pb-2 sm:px-5">
        <div className="mx-auto w-full max-w-[26rem]">

          {/* The photo is shared with the customer app, so this heading is the
              one place a shopkeeper is told this screen is theirs. Prefixed
              rather than swapped outright, so "Login" and "Sign up" still say
              what step this is — "Shopkeeper" alone would not. */}
          <h1 className="mb-2 px-1 text-[1.6rem] sm:text-[1.75rem] font-extrabold text-[#0F1F17]">
            {isVendor ? `Shopkeeper ${PAGE_TITLE[step]}` : PAGE_TITLE[step]}
          </h1>

          <section className="si-sheet p-5 sm:p-6">

            {/* h2, not h1: the page heading above the card owns that level, and
                skipping straight back to h1 here would break the outline. */}
            <div className="si-underline mb-4">
              <h2 className="text-[1.25rem] font-extrabold text-[#0F1F17]">{title}</h2>
              <p className="mt-1 text-[13.5px] leading-relaxed text-[#5B6B62]">{sub}</p>
            </div>

            {/* STEP 1 — one box, number or email */}
            {step === STEP.IDENTIFIER && (
              <form onSubmit={handleContinue} className="si-step space-y-4">
                <div>
                  <label htmlFor="identifier" className={labelClass}>
                    Mobile number or email
                  </label>
                  <input
                    id="identifier"
                    type="text"
                    inputMode="email"
                    autoComplete="username"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    maxLength={254}
                    className={fieldClass}
                    required
                    disabled={isSubmitting}
                  />
                </div>

                <label className="flex items-center gap-2.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="w-4 h-4 rounded border-[#C9D4CD] accent-[#0B7A37] focus:ring-[#16A34A]"
                  />
                  <span className="text-[13px] text-[#5B6B62]">Remember me on this device</span>
                </label>

                {error && <Notice tone="error">{error}</Notice>}

                <button type="submit" disabled={isSubmitting} className={primaryButton}>
                  {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  <span>{isSubmitting ? 'Checking' : 'Next'}</span>
                  {!isSubmitting && <ArrowRight className="w-4 h-4" />}
                </button>

              </form>
            )}

            {/* STEP 2A — sign in, one code across both channels */}
            {step === STEP.LOGIN_CODE && (
              <form onSubmit={handleVerifyLogin} className="si-step space-y-4">
                <div className="flex items-center justify-between gap-3 rounded-xl bg-[#F4F7F5] px-3.5 py-3">
                  <div className="min-w-0">
                    <span className="block text-[11px] font-bold text-[#5B6B62]">Sent to</span>
                    <span className="si-num block truncate text-[13px] text-[#0F1F17]">
                      {challenge?.destination || identifier}
                    </span>
                  </div>
                  <button type="button" onClick={resetToStart} className={`${quietButton} shrink-0 flex items-center gap-1`}>
                    <ArrowLeft className="w-3 h-3" />
                    Change
                  </button>
                </div>

                <div>
                  <label className={labelClass}>Six-digit code</label>
                  <OTPBoxGroup tone="brand" value={code} onChange={setCode} />
                </div>

                {error && <Notice tone="error">{error}</Notice>}

                <button type="submit" disabled={isSubmitting} className={primaryButton}>
                  {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  <span>{isSubmitting ? 'Checking' : 'Verify and sign in'}</span>
                </button>
              </form>
            )}

            {/* STEP 2B — register, both contacts */}
            {step === STEP.REGISTER && (
              <form onSubmit={handleStartRegistration} className="si-step space-y-4">
                <Notice tone="info">
                  Two ways to reach you means you can always get in, even when WhatsApp is down.
                </Notice>

                <div>
                  <label htmlFor="phone" className={labelClass}>WhatsApp number</label>
                  <div className="relative flex items-center">
                    <span className="si-num absolute left-4 text-[14px] text-[#5B6B62] pointer-events-none">
                      +91
                    </span>
                    <input
                      id="phone"
                      type="tel"
                      inputMode="numeric"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                      maxLength={10}
                      className={`${fieldClass} si-num pl-[3.4rem]`}
                      required
                      disabled={isSubmitting}
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="email" className={labelClass}>Email address</label>
                  <input
                    id="email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    maxLength={254}
                    className={fieldClass}
                    required
                    disabled={isSubmitting}
                  />
                </div>

                <div>
                  <label htmlFor="name" className={labelClass}>
                    Your name <span className="font-medium text-[#5B6B62]">— optional</span>
                  </label>
                  <input
                    id="name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Ramesh Kumar"
                    maxLength={120}
                    className={fieldClass}
                    disabled={isSubmitting}
                  />
                </div>

                {error && <Notice tone="error">{error}</Notice>}

                <button type="submit" disabled={isSubmitting} className={primaryButton}>
                  {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  <span>{isSubmitting ? 'Sending' : 'Send my codes'}</span>
                  {!isSubmitting && <ArrowRight className="w-4 h-4" />}
                </button>

                <div className="text-center">
                  <button type="button" onClick={resetToStart} className={quietButton}>Back</button>
                </div>
              </form>
            )}

            {/* STEP 3 — one code per contact */}
            {step === STEP.REGISTER_CODES && (
              <form onSubmit={handleVerifyRegistration} className="si-step space-y-4">

                {/* Hidden entirely when WhatsApp could not deliver. The number is
                    still kept against the account, unverified, to confirm later. */}
                {registration?.phone?.delivered ? (
                  <div>
                    <label className={labelClass}>
                      WhatsApp <span className="si-num font-medium text-[#5B6B62]">{registration.phone.destination}</span>
                    </label>
                    <OTPBoxGroup tone="brand" value={phoneCode} onChange={setPhoneCode} />
                  </div>
                ) : (
                  <Notice tone="info">
                    WhatsApp is unavailable right now, so we saved your number and skipped that code.
                    Verify your email below to finish — you can confirm the number later.
                  </Notice>
                )}

                <div>
                  <label className={labelClass}>
                    Email <span className="si-num font-medium text-[#5B6B62]">{registration?.email?.destination}</span>
                  </label>
                  <OTPBoxGroup tone="brand" value={emailCode} onChange={setEmailCode} />
                </div>

                {error && <Notice tone="error">{error}</Notice>}

                <button type="submit" disabled={isSubmitting} className={primaryButton}>
                  {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  <span>{isSubmitting ? 'Checking' : 'Create account'}</span>
                </button>

                <div className="text-center">
                  <button type="button" onClick={resetToStart} className={quietButton}>Start over</button>
                </div>
              </form>
            )}
          </section>

        </div>
      </main>
    </div>
  );
}

/** Inline message. Errors state what happened; info explains why we ask. */
function Notice({ tone = 'info', children }) {
  const styles =
    tone === 'error'
      ? 'bg-[#DC2626]/[0.07] border-[#DC2626]/30 text-[#9B1C1C]'
      : 'bg-[#16A34A]/[0.07] border-[#16A34A]/20 text-[#0F1F17]/80';

  return (
    <p
      role={tone === 'error' ? 'alert' : undefined}
      className={`flex gap-2 rounded-xl border px-3.5 py-3 text-[12.5px] leading-relaxed ${styles}`}
    >
      {tone === 'info' && <Info className="w-3.5 h-3.5 shrink-0 mt-[3px]" />}
      <span>{children}</span>
    </p>
  );
}
