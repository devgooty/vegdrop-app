import React, { useState } from 'react';
import { ArrowRight, ArrowLeft, Loader2, Check, Info } from 'lucide-react';
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
 * The surface is a vegetable stall's painted rate board, because that is the
 * visual language of the shops this app actually competes with — fat slab
 * lettering with a hard offset shadow, turmeric on leaf green, crate slats.
 * Tokens live in index.css under `.mb-scope`.
 *
 * The board is the brand; the form sits on a chalk panel. Someone reading this
 * at six in the morning to order vegetables should never pay for the styling,
 * so contrast and touch targets win wherever they conflict with the concept.
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

const COPY = {
  [STEP.IDENTIFIER]: {
    title: 'Sign in',
    sub: 'Use your mobile number or email. We send one code.',
  },
  [STEP.LOGIN_CODE]: {
    title: 'Enter your code',
    sub: 'Six digits. The same code goes to WhatsApp and email.',
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

const BOARD_LABEL = {
  customer: 'Fresh every morning',
  shopkeeper: 'Store counter',
  delivery: 'Rider sign-in',
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
      setError(describeError(err, 'That did not work. Check the codes and try again.'));

      if (err instanceof ApiRequestError && ['OTP_EXPIRED', 'OTP_ATTEMPTS_EXCEEDED'].includes(err.code)) {
        resetToStart();
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const { title, sub } = COPY[step];

  const fieldClass =
    'w-full bg-white/70 border border-[#10261D]/20 rounded-lg px-4 py-3.5 text-[15px] text-[#10261D] ' +
    'placeholder:text-[#10261D]/35 focus:outline-none focus:bg-white focus:border-[#12402F] ' +
    'focus:ring-[3px] focus:ring-[#12402F]/15 transition';

  const labelClass =
    'mb-mono block text-[11px] uppercase tracking-[0.14em] text-[#10261D]/55 mb-2';

  const primaryButton =
    'w-full mb-display bg-[#F2A414] hover:bg-[#e09a10] text-[#10261D] text-[15px] py-4 rounded-lg ' +
    'shadow-[0_3px_0_#C9860A] active:shadow-[0_1px_0_#C9860A] active:translate-y-[2px] ' +
    'transition-all flex items-center justify-center gap-2 ' +
    'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[#10261D]/30 ' +
    'disabled:opacity-60 disabled:cursor-not-allowed disabled:shadow-none disabled:translate-y-0';

  const quietButton =
    'mb-mono text-[11px] uppercase tracking-[0.14em] text-[#10261D]/50 hover:text-[#10261D] ' +
    'underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 ' +
    'focus-visible:ring-[#12402F]/40 rounded';

  return (
    <div className="mb-scope mb-board min-h-[100dvh] flex flex-col items-center justify-center p-5 sm:p-8">

      <main className="w-full max-w-[26rem]">

        {/* Painted shop sign — the one loud element on the page. */}
        <header className="text-center mb-7">
          {/* Sized with clamp, not a breakpoint: the offset shadow adds 4px to
              the right of the glyphs, so a fixed size crowds the plaque edge on
              a narrow phone. */}
          <div className="mb-plaque inline-block rounded-xl px-5 py-3.5 sm:px-7 sm:py-4">
            <div className="mb-wordmark text-[clamp(1.9rem,8.5vw,2.9rem)] pr-1">VegBazzar</div>
          </div>
          <p className="mb-mono mt-3.5 text-[11px] uppercase tracking-[0.28em] text-[#F2A414]">
            {BOARD_LABEL[appType] || BOARD_LABEL.customer}
          </p>
        </header>

        {/* Chalk panel. Deliberately high-contrast: the board is the brand, this
            is where someone actually has to read and type. */}
        <section className="bg-[#F6F1E2] rounded-2xl p-6 sm:p-7 shadow-[0_18px_40px_-12px_rgba(0,0,0,0.45)]">

          <div className="mb-6">
            <h1 className="mb-display text-[1.7rem] text-[#10261D]">{title}</h1>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-[#10261D]/60">{sub}</p>
          </div>

          {/* STEP 1 — one box, number or email */}
          {step === STEP.IDENTIFIER && (
            <form onSubmit={handleContinue} className="mb-step space-y-5">
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
                  placeholder="9876543210"
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
                  className="w-4 h-4 rounded border-[#10261D]/30 text-[#12402F] focus:ring-[#12402F]"
                />
                <span className="text-[13px] text-[#10261D]/70">Remember me on this device</span>
              </label>

              {error && <Notice tone="error">{error}</Notice>}

              <button type="submit" disabled={isSubmitting} className={primaryButton}>
                {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                <span>{isSubmitting ? 'Checking' : 'Next'}</span>
                {!isSubmitting && <ArrowRight className="w-4 h-4" />}
              </button>

              <p className="text-center text-[12px] text-[#10261D]/45">
                New here? We set up your account next.
              </p>
            </form>
          )}

          {/* STEP 2A — sign in, one code across both channels */}
          {step === STEP.LOGIN_CODE && (
            <form onSubmit={handleVerifyLogin} className="mb-step space-y-5">
              <div className="flex items-center justify-between gap-3 rounded-lg bg-[#10261D]/[0.055] px-3.5 py-3">
                <div className="min-w-0">
                  <span className="mb-mono block text-[10px] uppercase tracking-[0.14em] text-[#10261D]/45">
                    Sent to
                  </span>
                  <span className="mb-mono block truncate text-[13px] text-[#10261D]">
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
                <OTPBoxGroup tone="board" value={code} onChange={setCode} />
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
            <form onSubmit={handleStartRegistration} className="mb-step space-y-5">
              <Notice tone="info">
                Two ways to reach you means you can always get in, even when WhatsApp is down.
              </Notice>

              <div>
                <label htmlFor="phone" className={labelClass}>WhatsApp number</label>
                <div className="relative flex items-center">
                  <span className="mb-mono absolute left-4 text-[14px] text-[#10261D]/45 pointer-events-none">
                    +91
                  </span>
                  <input
                    id="phone"
                    type="tel"
                    inputMode="numeric"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                    placeholder="9876543210"
                    maxLength={10}
                    className={`${fieldClass} mb-mono pl-[3.4rem]`}
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
                  Your name <span className="normal-case tracking-normal text-[#10261D]/35">— optional</span>
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
            <form onSubmit={handleVerifyRegistration} className="mb-step space-y-5">

              {/* Hidden entirely when WhatsApp could not deliver. The number is
                  still kept against the account, unverified, to confirm later. */}
              {registration?.phone?.delivered ? (
                <div>
                  <label className={labelClass}>
                    WhatsApp <span className="mb-mono normal-case tracking-normal text-[#10261D]/40">{registration.phone.destination}</span>
                  </label>
                  <OTPBoxGroup tone="board" value={phoneCode} onChange={setPhoneCode} />
                </div>
              ) : (
                <Notice tone="info">
                  WhatsApp is unavailable right now, so we saved your number and skipped that code.
                  Verify your email below to finish — you can confirm the number later.
                </Notice>
              )}

              <div>
                <label className={labelClass}>
                  Email <span className="mb-mono normal-case tracking-normal text-[#10261D]/40">{registration?.email?.destination}</span>
                </label>
                <OTPBoxGroup tone="board" value={emailCode} onChange={setEmailCode} />
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

        <p className="mb-mono mt-6 text-center text-[10.5px] uppercase tracking-[0.22em] text-[#F6F1E2]/65">
          No password · One code · That&apos;s it
        </p>
      </main>
    </div>
  );
}

/** Inline message. Errors state what happened; info explains why we ask. */
function Notice({ tone = 'info', children }) {
  const styles =
    tone === 'error'
      ? 'bg-[#D94F35]/10 border-[#D94F35]/35 text-[#8F2E1B]'
      : 'bg-[#12402F]/[0.06] border-[#12402F]/15 text-[#10261D]/75';

  return (
    <p
      role={tone === 'error' ? 'alert' : undefined}
      className={`flex gap-2 rounded-lg border px-3.5 py-3 text-[12.5px] leading-relaxed ${styles}`}
    >
      {tone === 'info' && <Info className="w-3.5 h-3.5 shrink-0 mt-[3px]" />}
      <span>{children}</span>
    </p>
  );
}
