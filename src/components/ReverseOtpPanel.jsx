import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Copy, Check, MessageCircle, RefreshCw } from 'lucide-react';
import {
  startReverseOtp,
  startReverseOtpPhoneChange,
  getReverseOtpStatus,
  completeReverseOtp,
  completeReverseOtpPhoneChange,
  smsLinkFor,
  startPhoneHandover,
  getHandoverStatus,
  pairPhoneHandover,
} from '../services/reverseOtp';
import { ApiRequestError, NetworkError, refreshSession } from '../services/apiClient';

/**
 * Reverse OTP — "I'll send the code instead".
 *
 * Default path follows where the SIM is likely to be:
 *   - phone viewport  → this-device send buttons
 *   - laptop viewport → QR handover
 *
 * Either screen can ask for the other route. Phone-change always stays local.
 */

function isDesktopViewport() {
  if (typeof window === 'undefined') return true;
  return !window.matchMedia('(max-width: 768px)').matches;
}

function defaultModeFor(purpose) {
  if (purpose === 'phone_change') return 'local';
  return isDesktopViewport() ? 'handover' : 'local';
}

function pollDelay(elapsedMs) {
  if (elapsedMs < 30_000) return 2000;
  if (elapsedMs < 90_000) return 3000;
  return 5000;
}

function secondsLeft(expiresAt) {
  if (!expiresAt) return 0;
  return Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000));
}

/** Digits-only inbox → display form for humans. */
function formatPhoneHint(phone) {
  const digits = String(phone || '').replace(/\D/g, '').slice(-10);
  if (digits.length !== 10) return digits ? `+${digits}` : '';
  return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
}

/** "1 min 30 sec" under the QR drain — normal UI type, not monospace. */
function formatCountdown(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  if (mins <= 0) return `${secs} sec`;
  if (secs === 0) return `${mins} min`;
  return `${mins} min ${secs} sec`;
}

function describeError(err) {
  if (err instanceof NetworkError) return 'No connection. Check your network and try again.';
  if (err instanceof ApiRequestError) {
    if (err.code === 'REVERSE_OTP_NOT_CONFIGURED') {
      return 'This option is not available right now. Please try again later.';
    }
    return err.message;
  }
  return 'Something went wrong. Please try again.';
}

function formatInbox(to) {
  const digits = String(to || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  if (digits.length === 10) return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
  return digits ? `+${digits}` : '';
}

const QR_STEPS = [
  { n: 1, label: 'Phone' },
  { n: 2, label: 'Scan' },
  { n: 3, label: 'Pair' },
  { n: 4, label: 'Send' },
];

const MESSAGE_STEPS = [
  { n: 1, label: 'Phone' },
  { n: 2, label: 'Send' },
];

function VerifyStepper({ currentStep, steps = QR_STEPS }) {
  return (
    <ol className="vd-vsteps" aria-label="Verification steps">
      {steps.map((s) => {
        const state = s.n < currentStep ? 'vd-vs-done' : s.n === currentStep ? 'vd-vs-now' : 'vd-vs-todo';
        const glyph = s.n < currentStep ? '✓' : String(s.n);
        return (
          <li key={s.n} className={`vd-vs ${state}`}>
            <span className="vd-vs-b" aria-hidden="true">
              {glyph}
            </span>
            <span className="vd-vs-l">{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function FooterLinks({ children }) {
  return <div className="vd-verify-foot">{children}</div>;
}

export default function ReverseOtpPanel({
  phone,
  purpose = 'login',
  app,
  name,
  onVerified,
  onUnavailable,
  completeHere = true,
  onBack,
}) {
  const [mode, setMode] = useState(() => defaultModeFor(purpose));
  const [challenge, setChallenge] = useState(null);
  const [state, setState] = useState(() =>
    defaultModeFor(purpose) === 'handover' ? 'handover_pending' : 'starting'
  );
  const [expectedPhone, setExpectedPhone] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [copiedWhat, setCopiedWhat] = useState('');
  const [remaining, setRemaining] = useState(0);
  const [ttlTotal, setTtlTotal] = useState(0);
  const [handover, setHandover] = useState(null);
  const [pairDigits, setPairDigits] = useState('');
  const [pairing, setPairing] = useState(false);
  const [viaHandover, setViaHandover] = useState(false);

  const completingRef = useRef(false);
  const startingRef = useRef(false);
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;
  const onVerifiedRef = useRef(onVerified);
  onVerifiedRef.current = onVerified;

  const resetChallengeUi = (nextMode) => {
    setMode(nextMode);
    setState(nextMode === 'handover' ? 'handover_pending' : 'starting');
    setError('');
    setChallenge(null);
    setExpectedPhone(null);
    setHandover(null);
    setPairDigits('');
    setViaHandover(false);
    setTtlTotal(0);
    setRemaining(0);
    completingRef.current = false;
  };

  const handleStartError = (err) => {
    if (err instanceof ApiRequestError && err.code === 'REVERSE_OTP_NOT_CONFIGURED' && onUnavailableRef.current) {
      onUnavailableRef.current();
      return;
    }
    setError(describeError(err));
    setState('failed');
  };

  const beginLocal = useCallback(async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    resetChallengeUi('local');

    try {
      const started =
        purpose === 'phone_change'
          ? await startReverseOtpPhoneChange({ phone })
          : await startReverseOtp({ phone, purpose, app, name });
      setChallenge(started);
      setState('pending');
      const ttl = started.expiresAt
        ? Math.max(1, secondsLeft(started.expiresAt))
        : 0;
      setTtlTotal(ttl);
      setRemaining(ttl);
    } catch (err) {
      handleStartError(err);
    } finally {
      startingRef.current = false;
    }
  }, [phone, purpose, app, name]);

  const beginHandover = useCallback(async () => {
    if (startingRef.current || purpose === 'phone_change') return;
    startingRef.current = true;
    resetChallengeUi('handover');

    try {
      const started = await startPhoneHandover({ phone, purpose, app, name });
      setHandover(started);
      setState('handover_pending');
      const ttl = Number(started.expiresInSeconds) || secondsLeft(started.expiresAt) || 300;
      setTtlTotal(ttl);
      setRemaining(secondsLeft(started.expiresAt) || ttl);
    } catch (err) {
      try {
        const started = await startReverseOtp({ phone, purpose, app, name });
        setMode('local');
        setChallenge(started);
        setState('pending');
        setError('');
        const ttl = started.expiresAt ? Math.max(1, secondsLeft(started.expiresAt)) : 0;
        setTtlTotal(ttl);
        setRemaining(ttl);
      } catch (fallbackErr) {
        handleStartError(err.code === 'REVERSE_OTP_NOT_CONFIGURED' ? err : fallbackErr);
      }
    } finally {
      startingRef.current = false;
    }
  }, [phone, purpose, app, name]);

  const startDefault = purpose === 'phone_change' || !isDesktopViewport() ? beginLocal : beginHandover;

  useEffect(() => {
    startDefault();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- identity via begin* only
  }, [startDefault]);

  useEffect(() => {
    const expiresAt = challenge?.expiresAt || handover?.expiresAt;
    if (!expiresAt) return undefined;
    setRemaining(secondsLeft(expiresAt));
    const timer = setInterval(() => setRemaining(secondsLeft(expiresAt)), 1000);
    return () => clearInterval(timer);
  }, [challenge?.expiresAt, handover?.expiresAt]);

  useEffect(() => {
    if (mode !== 'handover' || !handover?.sessionId || !handover?.claimToken) return undefined;
    if (!['handover_pending', 'handover_scanned'].includes(state)) return undefined;

    let cancelled = false;
    let timer = null;
    const startedAt = Date.now();
    const controller = new AbortController();

    async function tick() {
      if (cancelled) return;
      try {
        const next = await getHandoverStatus(handover.sessionId, handover.claimToken, {
          signal: controller.signal,
        });
        if (cancelled) return;
        if (next.state === 'expired' || next.state === 'failed') {
          setState(next.state === 'failed' ? 'failed' : 'expired');
          setError(next.state === 'failed' ? 'Too many wrong pair numbers. Start again.' : '');
          return;
        }
        if (next.state === 'scanned' || next.state === 'paired' || next.pairNumberNeeded) {
          setState('handover_scanned');
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiRequestError && err.status === 429) {
          timer = setTimeout(tick, 10_000);
          return;
        }
      }
      if (!cancelled) timer = setTimeout(tick, pollDelay(Date.now() - startedAt));
    }

    timer = setTimeout(tick, pollDelay(0));
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [mode, handover?.sessionId, handover?.claimToken, state]);

  const submitPair = useCallback(async () => {
    if (!handover || pairing) return;
    const digits = pairDigits.replace(/\D/g, '').slice(0, 4);
    if (digits.length !== 4) {
      setError('Enter the 4-digit number shown on your phone.');
      return;
    }
    setPairing(true);
    setError('');
    try {
      const started = await pairPhoneHandover({
        sessionId: handover.sessionId,
        claimToken: handover.claimToken,
        pairNumber: digits,
      });
      setChallenge(started);
      setHandover(null);
      setViaHandover(true);
      setMode('local');
      setState('pending');
      const ttl = started.expiresAt ? Math.max(1, secondsLeft(started.expiresAt)) : 0;
      setTtlTotal(ttl);
      setRemaining(ttl);
    } catch (err) {
      setError(describeError(err));
      if (err instanceof ApiRequestError && err.code === 'HANDOVER_PAIR_LOCKED') {
        setState('failed');
      }
    } finally {
      setPairing(false);
    }
  }, [handover, pairDigits, pairing]);

  const finish = useCallback(async () => {
    if (completingRef.current) return;
    completingRef.current = true;

    try {
      if (!completeHere) {
        await onVerifiedRef.current?.({ token: challenge.token, user: null });
        setState('verified');
        return;
      }

      const user =
        purpose === 'phone_change'
          ? await completeReverseOtpPhoneChange(challenge.token)
          : await completeReverseOtp(challenge.token);
      setState('verified');
      await onVerifiedRef.current?.({ token: challenge.token, user });
    } catch (err) {
      if (err instanceof NetworkError && completeHere && purpose !== 'phone_change') {
        try {
          const user = await refreshSession();
          if (user) {
            setState('verified');
            await onVerifiedRef.current?.({ token: challenge.token, user });
            return;
          }
        } catch {
          // fall through
        }
      }

      setError(describeError(err));
      setState('failed');
      completingRef.current = false;
    }
  }, [challenge, completeHere, purpose]);

  useEffect(() => {
    if (!challenge?.token) return undefined;
    if (['verified', 'expired', 'failed'].includes(state)) return undefined;
    if (mode === 'handover') return undefined;

    let cancelled = false;
    let timer = null;
    const startedAt = Date.now();
    const controller = new AbortController();

    async function tick() {
      if (cancelled) return;
      if (typeof document !== 'undefined' && document.hidden) {
        timer = setTimeout(tick, 1000);
        return;
      }

      try {
        const next = await getReverseOtpStatus(challenge.token, { signal: controller.signal });
        if (cancelled) return;
        setState(next.state);
        if (next.state === 'mismatch') setExpectedPhone(next.expectedPhone || null);
        if (next.state === 'verified') {
          finish();
          return;
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiRequestError && err.status === 429) {
          timer = setTimeout(tick, 10_000);
          return;
        }
      }

      if (!cancelled) timer = setTimeout(tick, pollDelay(Date.now() - startedAt));
    }

    timer = setTimeout(tick, pollDelay(0));
    const onVisible = () => {
      if (!document.hidden && !cancelled) {
        clearTimeout(timer);
        tick();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [challenge?.token, state, finish, mode]);

  const copyText = async (text, label) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setCopiedWhat(label);
      setTimeout(() => {
        setCopied(false);
        setCopiedWhat('');
      }, 2000);
    } catch {
      // stays on screen
    }
  };

  const restart = mode === 'handover' ? beginHandover : beginLocal;

  if (state === 'starting' || (mode === 'handover' && !handover && state === 'handover_pending' && !error)) {
    return (
      <div className="vd-verify">
        <div className="vd-verify-loading">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Setting up…</span>
        </div>
      </div>
    );
  }

  if (state === 'failed') {
    return (
      <div className="vd-verify">
        <p className="vd-verify-error" role="alert">
          {error || 'Something went wrong.'}
        </p>
        <button type="button" onClick={restart} className={PRIMARY_BUTTON}>
          Try again
        </button>
        <FooterLinks>
          {onBack ? (
            <button type="button" onClick={onBack} className={BACK_LINK}>
              ← Back
            </button>
          ) : null}
        </FooterLinks>
      </div>
    );
  }

  // --- Handover: Scan / Pair -------------------------------------------------
  if (mode === 'handover' && handover && !challenge) {
    const expired =
      state === 'expired' ||
      remaining <= 0 ||
      (handover.expiresAt && new Date(handover.expiresAt).getTime() <= Date.now());
    const step = state === 'handover_scanned' ? 3 : 2;
    const waShare = handover.signinUrl
      ? `https://wa.me/?text=${encodeURIComponent(
          `Please open this link to verify my mobile number for VegDrop: ${handover.signinUrl}`
        )}`
      : null;

    if (expired) {
      return (
        <div className="vd-verify">
          <VerifyStepper currentStep={2} />
          <p className="vd-verify-hint vd-verify-expired-msg">QR is expired</p>
          <button type="button" onClick={beginHandover} className={PRIMARY_BUTTON}>
            Get a new code
          </button>
          <FooterLinks>
            <button type="button" onClick={beginLocal} className={TEXT_LINK}>
              Verify from this device
            </button>
          </FooterLinks>
        </div>
      );
    }

    return (
      <div className="vd-verify">
        <VerifyStepper currentStep={step} />

        {step === 2 ? (
          <>
            {handover.qrSvg ? (
              <div
                className="vd-verify-qr"
                dangerouslySetInnerHTML={{ __html: handover.qrSvg }}
              />
            ) : null}

            <p className="vd-verify-hint">
              Scan with the phone that has{' '}
              <span className="vd-verify-phone">{formatPhoneHint(phone)}</span>
            </p>

            <div className="vd-verify-actions">
              {waShare ? (
                <a href={waShare} target="_blank" rel="noopener noreferrer" className={GHOST_BUTTON}>
                  Send link on WhatsApp
                </a>
              ) : null}
              <button type="button" onClick={() => copyText(handover.signinUrl, 'link')} className={GHOST_BUTTON}>
                {copied && copiedWhat === 'link' ? 'Copied' : 'Copy link'}
              </button>
            </div>

            <div className="vd-verify-timer" aria-live="polite">
              <div className="vd-qr-drain" aria-hidden="true">
                <i
                  style={{
                    width: `${ttlTotal > 0 ? Math.max(0, Math.min(100, (remaining / ttlTotal) * 100)) : 0}%`,
                  }}
                />
              </div>
              <p className="vd-verify-timer-label">{formatCountdown(remaining)}</p>
            </div>
          </>
        ) : null}

        {step === 3 ? (
          <>
            <p className="vd-verify-hint">Enter the number on your phone</p>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={4}
              value={pairDigits}
              onChange={(e) => setPairDigits(e.target.value.replace(/\D/g, '').slice(0, 4))}
              className="vd-verify-pin"
              placeholder="••••"
              autoFocus
            />
            <button type="button" onClick={submitPair} disabled={pairing || pairDigits.length !== 4} className={PRIMARY_BUTTON}>
              {pairing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              <span>{pairing ? 'Confirming…' : 'Continue'}</span>
            </button>
            <p className="vd-verify-timer-label">{formatCountdown(remaining)}</p>
          </>
        ) : null}

        {error ? (
          <p className="vd-verify-error" role="alert">
            {error}
          </p>
        ) : null}

        <FooterLinks>
          <button type="button" onClick={beginLocal} className={TEXT_LINK}>
            Verify from this device
          </button>
          {step === 2 ? (
            <button type="button" onClick={beginHandover} className={SOFT_LINK}>
              <RefreshCw className="h-3 w-3" />
              Get a new code
            </button>
          ) : null}
          {onBack ? (
            <button type="button" onClick={onBack} className={BACK_LINK}>
              ← Back
            </button>
          ) : null}
        </FooterLinks>
      </div>
    );
  }

  // --- Local / post-pair Send step -------------------------------------------
  const expired =
    state === 'expired' || (challenge && new Date(challenge.expiresAt).getTime() <= Date.now());
  const whatsapp = challenge?.channels?.whatsapp;
  const sms = challenge?.channels?.sms;
  const smsHref = smsLinkFor(sms);
  const primaryChannel = whatsapp || sms;
  const fullMessage =
    primaryChannel?.message || (challenge?.code ? `Verify my number for VegDrop: ${challenge.code}` : '');
  const railStep = viaHandover ? 4 : 2;
  const railSteps = viaHandover ? QR_STEPS : MESSAGE_STEPS;

  if (expired && state !== 'verified') {
    return (
      <div className="vd-verify">
        <VerifyStepper currentStep={railStep} steps={railSteps} />
        <p className="vd-verify-hint">That code expired.</p>
        <button type="button" onClick={restart} className={PRIMARY_BUTTON}>
          Get a new code
        </button>
      </div>
    );
  }

  return (
    <div className="vd-verify">
      <VerifyStepper currentStep={railStep} steps={railSteps} />

      <div className="vd-verify-code">
        <span className="si-num">{challenge.code}</span>
      </div>

      <p className="vd-verify-hint">
        Send from <span className="vd-verify-phone">{formatPhoneHint(phone)}</span>
        {whatsapp ? (
          <>
            {' '}
            to <span className="vd-verify-phone">{formatInbox(whatsapp.to)}</span>
          </>
        ) : null}
      </p>

      <div className="vd-verify-stack">
        {whatsapp ? (
          <a href={whatsapp.link} target="_blank" rel="noopener noreferrer" className={PRIMARY_BUTTON}>
            <MessageCircle className="h-4 w-4" />
            Open WhatsApp &amp; send
          </a>
        ) : null}
        {sms ? (
          <a href={smsHref} className={GHOST_BUTTON}>
            Send by SMS instead
          </a>
        ) : null}
        <button type="button" onClick={() => copyText(fullMessage, 'message')} className={SOFT_LINK}>
          {copied && copiedWhat === 'message' ? (
            <>
              <Check className="h-3.5 w-3.5" /> Copied
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" /> Copy message
            </>
          )}
        </button>
      </div>

      <StatusLine state={state} expectedPhone={expectedPhone} code={challenge.code} remaining={remaining} />

      {error ? (
        <p className="vd-verify-error" role="alert">
          {error}
        </p>
      ) : null}

      {sms?.relayHealthy === false ? (
        <p className="vd-verify-note">SMS inbox looks offline — prefer WhatsApp if you can.</p>
      ) : null}

      <FooterLinks>
        {!viaHandover && purpose !== 'phone_change' ? (
          <button type="button" onClick={beginHandover} className={TEXT_LINK}>
            SIM in another device?
          </button>
        ) : null}
        <button type="button" onClick={restart} className={SOFT_LINK}>
          <RefreshCw className="h-3 w-3" />
          Get a new code
        </button>
        {onBack ? (
          <button type="button" onClick={onBack} className={BACK_LINK}>
            ← Back
          </button>
        ) : null}
      </FooterLinks>
    </div>
  );
}

function StatusLine({ state, expectedPhone, code, remaining }) {
  if (state === 'verified') {
    return (
      <p className="vd-verify-ok">
        <Check className="h-4 w-4" />
        Number confirmed
      </p>
    );
  }

  if (state === 'mismatch') {
    return (
      <p className="vd-verify-error" role="alert">
        That message came from a different number. Send again from{' '}
        <span className="si-num font-semibold">{expectedPhone || 'your number'}</span>.
      </p>
    );
  }

  if (state === 'bad_code') {
    return (
      <p className="vd-verify-error" role="alert">
        Code didn&rsquo;t match. Send exactly <span className="si-num font-semibold">{code}</span>.
      </p>
    );
  }

  return (
    <p className="vd-verify-wait">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      Waiting for your message
      <span className="vd-verify-timer-label">{formatCountdown(remaining)}</span>
    </p>
  );
}

const PRIMARY_BUTTON =
  'vd-verify-btn vd-verify-btn-primary';

const GHOST_BUTTON = 'vd-verify-btn vd-verify-btn-ghost';

const TEXT_LINK = 'vd-verify-text-link';

const SOFT_LINK = 'vd-verify-soft-link';

const BACK_LINK = 'vd-verify-back';
