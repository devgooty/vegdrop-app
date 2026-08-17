import React, { useState } from 'react';
import { ArrowRight, ArrowLeft, Loader2, Check, Info, Send } from 'lucide-react';
import {
  lookupIdentifier,
  startIdentifierAuth,
  verifyPhoneAuth,
  startRegistration,
  verifyRegistration,
  startVendorRegistration,
  verifyVendorRegistration,
  startRiderRegistration,
  verifyRiderRegistration,
  describeIdentifierProblem,
  describePhoneProblem,
  describeEmailProblem,
} from '../services/auth';
import { ApiRequestError, NetworkError } from '../services/apiClient';
import { marketVegetables } from '../data/mockData';
import { useLanguage } from '../i18n/LanguageContext';
import { LANGUAGES } from '../i18n/translations';

import OTPBoxGroup from './OTPBoxGroup';
import ReverseOtpPanel from './ReverseOtpPanel';

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
const PAGE_TITLE_KEY = {
  [STEP.IDENTIFIER]: 'login.pageLogin',
  [STEP.LOGIN_CODE]: 'login.pageLogin',
  [STEP.REGISTER]: 'login.pageSignUp',
  [STEP.REGISTER_CODES]: 'login.pageSignUp',
};

/**
 * Subtitles are kept to a single line at phone width on purpose. Each one that
 * wraps costs 18px, and the whole screen has to clear the viewport without
 * scrolling — the field's own label already says what to type.
 */
const COPY_KEYS = {
  [STEP.IDENTIFIER]: { title: 'login.signIn', sub: 'login.signInSub' },
  [STEP.LOGIN_CODE]: { title: 'login.enterCode', sub: 'login.enterCodeSub' },
  [STEP.REGISTER]: { title: 'login.createAccount', sub: 'login.createAccountSub' },
  [STEP.REGISTER_CODES]: { title: 'login.checkMessages', sub: 'login.checkMessagesSub' },
};

/**
 * Delivery keeps its own static hero — a rider is a visually distinct
 * persona (helmet, scooter) rather than a variation on produce photography,
 * so it has no shared original to drift out of sync with. Served from
 * `public/`, so it's a same-origin file rather than a remote fetch: this is
 * the first paint of the first screen.
 *
 * Shopkeeper keeps its own static hero for the same reason — a stallholder
 * behind a counter is a distinct persona too, not a variation on the same
 * produce photography the customer marquee below is built from.
 */
const DELIVERY_HERO_SRC = '/delivery-hero.webp';
const DELIVERY_HERO_DIMENSIONS = { width: 1024, height: 1024 };
const SHOPKEEPER_HERO_SRC = '/shopkeeper-hero.jpg';
const SHOPKEEPER_HERO_DIMENSIONS = { width: 980, height: 784 };

/**
 * The customer-only hero: two rows of real vegetable photos scrolling
 * in opposite directions around the wordmark, each in its own square box —
 * replaced a plain emoji version. Earlier attempts (the four
 * `initialCategories` cover photos, then narrower vegetable lists) got
 * reverted for either reading as blurry abstract crops or not covering
 * enough of the aisle.
 *
 * `marketVegetables` is shared with `data/mockData.js`, where the same items
 * back their own tappable category tiles on the home screen — a visitor sees
 * the same produce before and after signing in. Split down the middle so
 * both rows carry roughly equal weight regardless of how many items
 * `marketVegetables` grows to.
 *
 * Each row is rendered twice back to back (see the header markup below) so a
 * `translateX(-50%)` loop has no visible seam — the CSS only has to animate
 * exactly one set-width's worth of motion.
 */
const VEG_ROW_A = marketVegetables.slice(0, Math.ceil(marketVegetables.length / 2));
const VEG_ROW_B = marketVegetables.slice(Math.ceil(marketVegetables.length / 2));

/**
 * How each app signs a NEW account up.
 *
 * Every role registers through the same dual-OTP flow — this app has no
 * passwords, so there is no extra step to insert for a privileged one. The only
 * thing that varies is which endpoint is called, and that is what selects the
 * role, on the server, in routes/auth.js. Nothing here chooses it: this table
 * picks a function and some wording, and a tampered client can only ever reach
 * an endpoint that hardcodes its own role.
 *
 * A table rather than the chain of `isVendor ? … : …` ternaries this replaces —
 * that shape needed a new branch in four places for every role added, which is
 * how the delivery app ended up with no sign-up at all.
 */
const SIGN_UP = {
  customer: {
    start: startRegistration,
    verify: verifyRegistration,
    // The OTP purpose the reverse phone leg must be raised under. It has to
    // match the role's own registration purpose exactly or the server refuses
    // to spend the token — which is the mechanism stopping a code raised for a
    // customer sign-up from minting a shopkeeper.
    reversePurpose: 'registration',
  },
  shopkeeper: {
    start: startVendorRegistration,
    reversePurpose: 'vendor_registration',
    // Also returns `nextStep: 'kyc'`, but the shopkeeper app already checks KYC
    // status on mount for every sign-in, not just a fresh signup, so there is
    // nothing extra to thread through here.
    verify: async (payload) => (await verifyVendorRegistration(payload)).user,
    headingKey: 'login.shopkeeperHeading',
    titleKey: 'login.shopkeeperTitle',
    subKey: 'login.shopkeeperSub',
    codesSubKey: 'login.shopkeeperCodesSub',
  },
  delivery: {
    start: startRiderRegistration,
    verify: verifyRiderRegistration,
    reversePurpose: 'delivery_registration',
    headingKey: 'login.deliveryHeading',
    titleKey: 'login.deliveryTitle',
    subKey: 'login.deliverySub',
    codesSubKey: 'login.deliveryCodesSub',
  },
};

export default function LoginPage({ onLogin, appType = 'customer', storagePrefix = 'vegdrop_' }) {
  const signUp = SIGN_UP[appType] || SIGN_UP.customer;
  const { language, setLanguage, t } = useLanguage();

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
   * Reverse OTP — "I'll send the code instead".
   *
   * An alternative, never a replacement. The outbound code stays the default
   * because it is one step for the user; this is here for the cases where it is
   * the better path: nothing arrived, or the user would rather not wait on a
   * message that costs us money to send.
   *
   * `reverseLogin` swaps the sign-in code box for the panel. `reversePhoneLeg`
   * does the same for the phone half of registration, where the email code is
   * still typed as usual — the reverse token proves ONE contact, and
   * registration deliberately proves two independently.
   */
  const [reverseLogin, setReverseLogin] = useState(false);
  const [reversePhoneLeg, setReversePhoneLeg] = useState(false);
  const [reversePhoneToken, setReversePhoneToken] = useState(null);

  /**
   * The number a reverse sign-in would be raised against.
   *
   * Only set when the user signed in with a phone number. Someone who typed an
   * email has not told us a number to prove, and asking for one here would let
   * anyone attach an arbitrary number to a sign-in — so the option is simply not
   * offered on that path.
   */
  const [loginPhone, setLoginPhone] = useState(null);

  /**
   * Turn any thrown error into something worth showing.
   * A network failure is reported as a failure — never as a reason to fall back
   * to local checking, which is what made the old flow bypassable offline.
   */
  const describeError = (err, fallback) => {
    if (err instanceof NetworkError) {
      return t('login.errNetwork');
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
    setReverseLogin(false);
    setReversePhoneLeg(false);
    setReversePhoneToken(null);
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
      const { exists, type } = await lookupIdentifier({ identifier: typed, app: appType });

      if (exists) {
        const issued = await startIdentifierAuth({ identifier: typed, app: appType });
        setChallenge(issued);
        setCode('');
        // Only a typed number gives us something to prove by reverse OTP.
        setLoginPhone(type === 'phone' ? typed.replace(/\D/g, '').slice(-10) : null);
        setReverseLogin(false);
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
      setError(describeError(err, t('login.errContinue')));
    } finally {
      setIsSubmitting(false);
    }
  };

  /** Existing account: one code, whichever channel it arrived on. */
  const handleVerifyLogin = async (e) => {
    e.preventDefault();
    if (isSubmitting) return;

    if (!code || code.trim().length < 6) {
      setError(t('login.errAllSix'));
      return;
    }
    if (!challenge?.challengeId) {
      setError(t('login.errExpired'));
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
      setError(describeError(err, t('login.errBadCode')));

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
      const issued = await signUp.start({
        phone: phone.trim(),
        email: email.trim(),
        name: name.trim() || undefined,
      });
      setRegistration(issued);
      setEmailCode('');
      setPhoneCode('');
      setReversePhoneToken(null);
      /**
       * If nothing could be delivered to the number, reverse OTP is the only way
       * left to prove it — so it is opened automatically rather than offered.
       * This used to be the dead end where the number was kept unverified and
       * the user had to confirm it later; sending us a message works even when
       * we cannot send them one.
       */
      setReversePhoneLeg(!issued?.phone?.delivered);
      setStep(STEP.REGISTER_CODES);
    } catch (err) {
      setError(describeError(err, t('login.errSendCodes')));
    } finally {
      setIsSubmitting(false);
    }
  };

  /** New account: prove each contact that actually received a code. */
  const handleVerifyRegistration = async (e) => {
    e.preventDefault();
    if (isSubmitting) return;

    // The typed-code path only applies when a code was delivered AND the user
    // has not switched this leg over to sending us one instead.
    const usingTypedPhoneCode = Boolean(registration?.phone?.delivered) && !reversePhoneLeg;

    if (!emailCode || emailCode.trim().length < 6) {
      setError(t('login.errSixEmail'));
      return;
    }
    if (usingTypedPhoneCode && (!phoneCode || phoneCode.trim().length < 6)) {
      setError(t('login.errSixWhatsapp'));
      return;
    }
    if (reversePhoneLeg && !reversePhoneToken) {
      setError(t('login.errReversePending'));
      return;
    }

    setError('');
    setIsSubmitting(true);

    try {
      const payload = {
        emailChallengeId: registration.email.challengeId,
        emailCode: emailCode.trim(),
        /**
         * Exactly one phone leg, or none. The server rejects both at once —
         * which of them proved the number would be ambiguous, and the unused
         * reverse token would stay live and redeemable elsewhere.
         *
         * All three absent is still valid: it is what "nothing could be
         * delivered and the user did not send us anything either" looks like,
         * and the server keeps the number unverified rather than assuming it.
         */
        phoneChallengeId: usingTypedPhoneCode ? registration.phone.challengeId : undefined,
        phoneCode: usingTypedPhoneCode ? phoneCode.trim() : undefined,
        phoneToken: reversePhoneLeg ? reversePhoneToken : undefined,
      };
      // Each entry resolves to the user, whatever else its endpoint returns —
      // `user` is all onLogin needs.
      const user = await signUp.verify(payload);
      onLogin(user);
    } catch (err) {
      setError(describeError(err, t('login.errCheckCodes')));

      if (err instanceof ApiRequestError && ['OTP_EXPIRED', 'OTP_ATTEMPTS_EXCEEDED'].includes(err.code)) {
        resetToStart();
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  let title = t(COPY_KEYS[step].title);
  let sub = t(COPY_KEYS[step].sub);
  if (step === STEP.REGISTER) {
    if (signUp.titleKey) title = t(signUp.titleKey);
    if (signUp.subKey) sub = t(signUp.subKey);
  } else if (step === STEP.REGISTER_CODES) {
    if (signUp.codesSubKey) sub = t(signUp.codesSubKey);
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
    // Same mobile-frame convention as every logged-in screen (App.jsx,
    // ShopkeeperPanel, SplashScreen): a max-w-md column centered on the
    // page's own background, bordered on both sides. Without this wrapper,
    // .si-scope's white background and the hero's full-bleed rows stretched
    // to the real edges of a desktop browser window instead of stopping at
    // a phone-width frame.
    <div className="flex min-h-[100dvh] justify-center bg-[#F8F5EF]">
      <div
        className={
          'si-scope relative flex h-[100dvh] w-full max-w-md flex-col overflow-y-auto border-x border-gray-200/60 shadow-xl' +
          (appType === 'shopkeeper' ? ' si-scope-shopkeeper' : '')
        }
      >

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
        {appType === 'delivery' ? (
          <div className="si-hero-delivery-wrap">
            <span className="si-speed-line si-speed-line-1" aria-hidden="true" />
            <span className="si-speed-line si-speed-line-2" aria-hidden="true" />
            <span className="si-speed-line si-speed-line-3" aria-hidden="true" />
            <img
              src={DELIVERY_HERO_SRC}
              alt="VegDrop"
              width={DELIVERY_HERO_DIMENSIONS.width}
              height={DELIVERY_HERO_DIMENSIONS.height}
              fetchPriority="high"
              className="si-hero-img si-hero-img-bob"
            />
          </div>
        ) : appType === 'shopkeeper' ? (
          <div className="si-hero-shopkeeper-wrap">
            <img
              src={SHOPKEEPER_HERO_SRC}
              alt="VegDrop"
              width={SHOPKEEPER_HERO_DIMENSIONS.width}
              height={SHOPKEEPER_HERO_DIMENSIONS.height}
              fetchPriority="high"
              className="si-hero-img si-hero-img-shopkeeper"
            />
          </div>
        ) : (
          <div className="si-hero-veg">
            <div className="si-veg-row" aria-hidden="true">
              <div className="si-veg-track si-veg-track-a">
                {[...VEG_ROW_A, ...VEG_ROW_A].map((item, i) => (
                  <span key={i} className="si-veg-chip">
                    <img src={item.imageUrl} alt="" />
                  </span>
                ))}
              </div>
            </div>

            <div className="si-hero-wordmark">
              <span className="si-hero-wordmark-veg">Veg</span>
              <span className="si-hero-wordmark-drop">Drop</span>
            </div>

            <div className="si-veg-row" aria-hidden="true">
              <div className="si-veg-track si-veg-track-b">
                {[...VEG_ROW_B, ...VEG_ROW_B].map((item, i) => (
                  <span key={i} className="si-veg-chip">
                    <img src={item.imageUrl} alt="" />
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
      </header>

      {/* flex-1, not shrink-0: on the short identifier step the sheet alone
          doesn't reach the bottom of a normal phone screen, leaving a gap of
          bare page background beneath the card. Growing this to fill
          whatever the (shrunk) header left behind — and letting it shrink
          back on the taller registration step, same as before — keeps that
          space inside the column instead of showing as dead space below
          it. */}
      <main className="flex flex-1 flex-col px-4 pt-6 pb-2 sm:px-5 sm:pt-8">
        <div className="mx-auto flex w-full max-w-[26rem] flex-1 flex-col">

          {/* The photo is shared with the customer app, so this heading is the
              one place a shopkeeper or rider is told this screen is theirs.
              Prefixed rather than swapped outright, so "Login" and "Sign up"
              still say what step this is — "Shopkeeper" alone would not. */}
          <h1 className="mb-3 px-1 text-[1.6rem] sm:text-[1.75rem] font-extrabold text-[#0F1F17]">
            {signUp.headingKey
              ? t('login.headingWithRole', {
                  role: t(signUp.headingKey),
                  step: t(PAGE_TITLE_KEY[step]),
                })
              : t(PAGE_TITLE_KEY[step])}
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
                    {t('login.identifier')}
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
                  <span className="text-[13px] text-[#5B6B62]">{t('login.rememberMe')}</span>
                </label>

                {error && <Notice tone="error">{error}</Notice>}

                <button type="submit" disabled={isSubmitting} className={primaryButton}>
                  {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  <span>{t(isSubmitting ? 'login.checking' : 'login.next')}</span>
                  {!isSubmitting && <ArrowRight className="w-4 h-4" />}
                </button>

              </form>
            )}

            {/* STEP 2A — sign in, one code across both channels */}
            {step === STEP.LOGIN_CODE && (
              <form onSubmit={handleVerifyLogin} className="si-step space-y-4">
                <div className="flex items-center justify-between gap-3 rounded-xl bg-[#F4F7F5] px-3.5 py-3">
                  <div className="min-w-0">
                    <span className="block text-[11px] font-bold text-[#5B6B62]">{t('login.sentTo')}</span>
                    <span className="si-num block truncate text-[13px] text-[#0F1F17]">
                      {challenge?.destination || identifier}
                    </span>
                  </div>
                  <button type="button" onClick={resetToStart} className={`${quietButton} shrink-0 flex items-center gap-1`}>
                    <ArrowLeft className="w-3 h-3" />
                    {t('common.change')}
                  </button>
                </div>

                {reverseLogin ? (
                  <ReverseOtpPanel
                    phone={loginPhone}
                    purpose="login"
                    app={appType}
                    onVerified={({ user: signedIn }) => onLogin(signedIn)}
                  />
                ) : (
                  <>
                    <div>
                      <label className={labelClass}>{t('login.sixDigitCode')}</label>
                      <OTPBoxGroup tone="brand" value={code} onChange={setCode} />
                    </div>

                    {error && <Notice tone="error">{error}</Notice>}

                    <button type="submit" disabled={isSubmitting} className={primaryButton}>
                      {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                      <span>{t(isSubmitting ? 'login.checking' : 'login.verifyAndSignIn')}</span>
                    </button>
                  </>
                )}

                {/* Only offered when we know a number to prove. Someone who
                    signed in with an email has not given us one. */}
                {loginPhone && (
                  <div className="text-center">
                    <button
                      type="button"
                      onClick={() => {
                        setError('');
                        setReverseLogin((on) => !on);
                      }}
                      className={`${quietButton} inline-flex items-center gap-1.5`}
                    >
                      {!reverseLogin && <Send className="h-3 w-3" />}
                      {t(reverseLogin ? 'login.typeCodeInstead' : 'login.sendCodeInstead')}
                    </button>
                  </div>
                )}
              </form>
            )}

            {/* STEP 2B — register, both contacts */}
            {step === STEP.REGISTER && (
              <form onSubmit={handleStartRegistration} className="si-step space-y-4">
                <Notice tone="info">{t('login.twoWays')}</Notice>

                <div>
                  <label htmlFor="phone" className={labelClass}>{t('login.whatsappNumber')}</label>
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
                  <label htmlFor="email" className={labelClass}>{t('login.emailAddress')}</label>
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
                    {t('login.yourName')}{' '}
                    <span className="font-medium text-[#5B6B62]">{t('login.optional')}</span>
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

                {/* Applies immediately, the same way it does in Settings later —
                    so the account this form is about to create starts in
                    whichever language was picked here, not English by default. */}
                <div>
                  <label className={labelClass}>{t('settings.language')}</label>
                  <div className="grid grid-cols-3 gap-2">
                    {LANGUAGES.map((lang) => {
                      const isActive = lang.code === language;
                      return (
                        <button
                          key={lang.code}
                          type="button"
                          onClick={() => setLanguage(lang.code)}
                          aria-pressed={isActive}
                          disabled={isSubmitting}
                          className={`py-2.5 rounded-xl text-[13.5px] font-bold border transition-all active:scale-95 ${
                            isActive
                              ? 'bg-[#0B7A37] text-white border-[#0B7A37] shadow-[0_4px_10px_-4px_rgba(11,122,55,0.6)]'
                              : 'bg-[#F1F7F3] text-[#0F1F17] border-[#DCE9E1] hover:bg-[#E7F1EA]'
                          }`}
                        >
                          {lang.nativeName}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {error && <Notice tone="error">{error}</Notice>}

                <button type="submit" disabled={isSubmitting} className={primaryButton}>
                  {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  <span>{t(isSubmitting ? 'login.sending' : 'login.sendMyCodes')}</span>
                  {!isSubmitting && <ArrowRight className="w-4 h-4" />}
                </button>

                <div className="text-center">
                  <button type="button" onClick={resetToStart} className={quietButton}>{t('common.back')}</button>
                </div>
              </form>
            )}

            {/* STEP 3 — one code per contact */}
            {step === STEP.REGISTER_CODES && (
              <form onSubmit={handleVerifyRegistration} className="si-step space-y-4">

                {/* The phone leg, in one of three shapes: type the code we sent,
                    send us one instead, or — when nothing could be delivered and
                    the reverse panel is unavailable too — skip it and confirm the
                    number later. */}
                {reversePhoneLeg ? (
                  <div>
                    <label className={labelClass}>{t('login.reversePhoneLabel')}</label>
                    {reversePhoneToken ? (
                      <Notice tone="info">{t('login.reverseVerified')}</Notice>
                    ) : (
                      <ReverseOtpPanel
                        phone={phone.trim()}
                        purpose={signUp.reversePurpose}
                        app={appType}
                        name={name.trim() || undefined}
                        // Registration proves two contacts independently, so this
                        // token settles only the phone half. It is handed to the
                        // verify call alongside the email code rather than being
                        // spent here.
                        completeHere={false}
                        onVerified={({ token }) => setReversePhoneToken(token)}
                      />
                    )}
                  </div>
                ) : registration?.phone?.delivered ? (
                  <div>
                    <label className={labelClass}>
                      {t('login.whatsappLabel')}{' '}
                      <span className="si-num font-medium text-[#5B6B62]">{registration.phone.destination}</span>
                    </label>
                    <OTPBoxGroup tone="brand" value={phoneCode} onChange={setPhoneCode} />
                  </div>
                ) : (
                  <Notice tone="info">{t('login.whatsappDown')}</Notice>
                )}

                {/* Toggle between the two. Hidden once the number is proved —
                    switching away would silently drop a verification the user
                    already completed. */}
                {!reversePhoneToken && (
                  <div className="text-center">
                    <button
                      type="button"
                      onClick={() => {
                        setError('');
                        setReversePhoneLeg((on) => !on);
                      }}
                      className={`${quietButton} inline-flex items-center gap-1.5`}
                    >
                      {!reversePhoneLeg && <Send className="h-3 w-3" />}
                      {t(reversePhoneLeg ? 'login.typeCodeInstead' : 'login.sendCodeInstead')}
                    </button>
                  </div>
                )}

                <div>
                  <label className={labelClass}>
                    {t('login.emailLabel')}{' '}
                    <span className="si-num font-medium text-[#5B6B62]">{registration?.email?.destination}</span>
                  </label>
                  <OTPBoxGroup tone="brand" value={emailCode} onChange={setEmailCode} />
                </div>

                {error && <Notice tone="error">{error}</Notice>}

                <button type="submit" disabled={isSubmitting} className={primaryButton}>
                  {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  <span>{t(isSubmitting ? 'login.checking' : 'login.createAccount')}</span>
                </button>

                <div className="text-center">
                  <button type="button" onClick={resetToStart} className={quietButton}>{t('login.startOver')}</button>
                </div>
              </form>
            )}
          </section>

        </div>
      </main>
      </div>
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
