import React, { useState } from 'react';
import { ArrowRight, ArrowLeft, Loader2, Check, Info, Sprout, IndianRupee } from 'lucide-react';
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

/**
 * The same catalogue photographs the shop itself uses, so the hero shows real
 * stock rather than stock photography. Requested at thumbnail width — these are
 * above the fold on the very first screen, and the full 300px catalogue crop
 * would be four times the bytes for no visible gain.
 *
 * Longer than fits on a phone on purpose: the row scrolls, and a tile cut off
 * by the screen edge is what tells you it does.
 */
const PRODUCE = [
  { name: 'Palak', id: 'photo-1576045057995-568f588f82fb' },
  { name: 'Tamatar', id: 'photo-1592924357228-91a4daadcfea' },
  { name: 'Pudina', id: 'photo-1628556270448-4d4e4148e1b1' },
  { name: 'Capsicum', id: 'photo-1563565375-f3fdfdbefa83' },
  { name: 'Apple', id: 'photo-1560806887-1e4cd0b6cbd6' },
  { name: 'Kale', id: 'photo-1524179091875-bf99a9a6af57' },
  { name: 'Lettuce', id: 'photo-1622206151226-18ca2c9ab4a1' },
  { name: 'Avocado', id: 'photo-1523049673857-eb18f1d7b578' },
  { name: 'Jamun', id: 'photo-1498557850523-fd3d118b962e' },
  { name: 'Tulsi', id: 'photo-1608686207856-001b95cf60ca' },
];

const produceSrc = (id) => `https://images.unsplash.com/${id}?w=160&h=160&auto=format&fit=crop&q=70`;

/** Customer-facing only — a rider does not need to be sold on the shop. */
const PROMISES = [
  { Icon: Sprout, head: 'Picked', sub: 'this morning' },
  { Icon: IndianRupee, head: 'Mandi', sub: 'rate, no markup' },
];

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

  return (
    <div className="si-scope min-h-[100dvh] flex flex-col">

      {/* Header — the shop's name, and what is actually in it today. */}
      <header className="px-5 pt-9 pb-6 sm:pt-12">
        <div className="mx-auto w-full max-w-[26rem]">

          <div className="si-wordmark text-[2rem] sm:text-[2.35rem] leading-none">
            VegBazzar
          </div>

          {/* Bled past the column with -mx-5 so the row runs to both screen
              edges and fades out against the mask.

              The list is rendered twice so the marquee can loop without a
              seam; the second copy is hidden from screen readers, which would
              otherwise announce ten vegetables twice. Decorative alt on the
              images because each name is already visible text below. */}
          <div className="si-rail -mx-5 mt-7 pb-2">
            <ul className="si-track">
              {[...PRODUCE, ...PRODUCE].map(({ name, id }, i) => (
                <li
                  key={`${id}-${i}`}
                  aria-hidden={i >= PRODUCE.length || undefined}
                  className="mr-3.5 w-[68px] shrink-0 text-center"
                >
                  <div className="si-tile aspect-square w-full overflow-hidden rounded-full">
                    <img
                      src={produceSrc(id)}
                      alt=""
                      width="160"
                      height="160"
                      decoding="async"
                      className="h-full w-full object-cover"
                    />
                  </div>
                  <span className="mt-2 block text-[11px] font-semibold text-[#0F1F17]">{name}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </header>

      <main className="flex-1 px-4 pb-7 sm:px-5">
        <div className="mx-auto w-full max-w-[26rem]">

          <h1 className="mb-3 px-1 text-[1.6rem] sm:text-[1.75rem] font-extrabold text-[#0F1F17]">
            {PAGE_TITLE[step]}
          </h1>

          <section className="si-sheet p-5 sm:p-6">

            {/* h2, not h1: the page heading above the card owns that level, and
                skipping straight back to h1 here would break the outline. */}
            <div className="si-underline mb-5">
              <h2 className="text-[1.25rem] font-extrabold text-[#0F1F17]">{title}</h2>
              <p className="mt-1 text-[13.5px] leading-relaxed text-[#5B6B62]">{sub}</p>
            </div>

            {/* STEP 1 — one box, number or email */}
            {step === STEP.IDENTIFIER && (
              <form onSubmit={handleContinue} className="si-step space-y-5">
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

                <p className="text-center text-[12px] text-[#5B6B62]">
                  New here? We set up your account next.
                </p>
              </form>
            )}

            {/* STEP 2A — sign in, one code across both channels */}
            {step === STEP.LOGIN_CODE && (
              <form onSubmit={handleVerifyLogin} className="si-step space-y-5">
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
              <form onSubmit={handleStartRegistration} className="si-step space-y-5">
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
                      placeholder="9876543210"
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
              <form onSubmit={handleVerifyRegistration} className="si-step space-y-5">

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

          {/* Customer-only — a rider does not need to be sold the delivery time. */}
          {appType === 'customer' && (
            <ul className="mt-3.5 grid grid-cols-2 gap-2.5">
              {PROMISES.map(({ Icon, head, sub: line }) => (
                <li key={head} className="rounded-2xl border border-[#E4EAE6] bg-white px-2 py-3 text-center">
                  <Icon className="mx-auto w-4 h-4 text-[#0B7A37]" />
                  <p className="mt-1.5 text-[12.5px] font-extrabold leading-tight text-[#0F1F17]">{head}</p>
                  <p className="text-[10.5px] leading-tight text-[#5B6B62]">{line}</p>
                </li>
              ))}
            </ul>
          )}

          <p className="mt-5 text-center text-[11.5px] text-[#5B6B62]">
            No password needed · One code and you&apos;re in
          </p>
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
