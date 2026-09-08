import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Copy, Check, MessageCircle, MessageSquare, RefreshCw, Info, Smartphone } from 'lucide-react';
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
 * Shows a code and a prefilled message link. The user taps, their messaging app
 * opens with the text ready, they hit send, and this panel notices.
 *
 * Cross-device (SIM in another handset): deep links open on THIS device, so the
 * inbox number + full message are shown and copyable — the user sends from the
 * phone that holds +91 {phone}. Prefer the guided handover (QR + 4-digit pair)
 * when the SIM is elsewhere; the copy path remains the manual fallback.
 */

/**
 * Poll backoff: start at 2s while the user is likely still composing the
 * message, then stretch out so a forgotten tab does not hammer the API for
 * the full ten-minute TTL at the fast rate.
 */
function pollDelay(elapsedMs) {
  if (elapsedMs < 30_000) return 2000;
  if (elapsedMs < 90_000) return 3000;
  return 5000;
}

function secondsLeft(expiresAt) {
  if (!expiresAt) return 0;
  return Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000));
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

/** Digits-only inbox → display form for humans. */
function formatInbox(to) {
  const digits = String(to || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  if (digits.length === 10) return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
  return digits ? `+${digits}` : '';
}

/**
 * @param {string} phone
 * @param {string} [purpose='login']
 * @param {string} [app] which role app asked — scopes the account
 * @param {string} [name] registration display name only
 * @param {(result: {token: string, user: object|null}) => void|Promise<void>} onVerified
 * @param {() => void} [onUnavailable] reverse OTP not configured — fall back to outbound
 * @param {boolean} [completeHere=true] false when a parent (register) must spend the token
 */
export default function ReverseOtpPanel({
  phone,
  purpose = 'login',
  app,
  name,
  onVerified,
  onUnavailable,
  completeHere = true,
}) {
  const [mode, setMode] = useState('local'); // 'local' | 'handover'
  const [challenge, setChallenge] = useState(null);
  const [state, setState] = useState('starting');
  const [expectedPhone, setExpectedPhone] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [copiedWhat, setCopiedWhat] = useState('');
  const [remaining, setRemaining] = useState(0);

  const [handover, setHandover] = useState(null);
  const [pairDigits, setPairDigits] = useState('');
  const [pairing, setPairing] = useState(false);

  /**
   * Guards against a double-tap on "start over" (or React Strict Mode's
   * double-mount in dev) issuing two challenges for one screen. Without it the
   * second start supersedes the first, the UI still shows the first code, and
   * the message the user sends never matches what the server is waiting for.
   */
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
    } catch (err) {
      handleStartError(err);
    } finally {
      startingRef.current = false;
    }
  }, [phone, purpose, app, name]);

  useEffect(() => {
    beginLocal();
  }, [beginLocal]);

  useEffect(() => {
    const expiresAt = challenge?.expiresAt || handover?.expiresAt;
    if (!expiresAt) return undefined;
    setRemaining(secondsLeft(expiresAt));
    const timer = setInterval(() => setRemaining(secondsLeft(expiresAt)), 1000);
    return () => clearInterval(timer);
  }, [challenge?.expiresAt, handover?.expiresAt]);

  // Browser handover poll: wait until the phone has scanned, then ask for digits.
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
        // scanned / paired / pairNumberNeeded all mean: show the pair-digit form.
        // Pairing still goes through POST /pair (which mints the reverse challenge).
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
      setMode('local');
      setState('pending');
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
      /**
       * A dropped response after the server minted a session is not "token spent,
       * start over" — the refresh cookie may already be set. Try to recover before
       * forcing a new challenge.
       */
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
      // Code stays on screen.
    }
  };

  if (state === 'starting') {
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl bg-[#F4F7F5] px-3.5 py-6 text-[14.5px] text-[#5B6B62]">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Getting your code…</span>
      </div>
    );
  }

  if (state === 'failed') {
    return (
      <div className="space-y-3">
        <PanelNotice tone="error">{error || 'Something went wrong.'}</PanelNotice>
        <button type="button" onClick={beginLocal} className={SECONDARY_BUTTON}>
          <RefreshCw className="h-4 w-4" />
          <span>Try again</span>
        </button>
      </div>
    );
  }

  // --- Handover UI (before reverse code exists) --------------------------------
  if (mode === 'handover' && handover && !challenge) {
    const expired =
      state === 'expired' || (handover.expiresAt && new Date(handover.expiresAt).getTime() <= Date.now());

    if (expired) {
      return (
        <div className="space-y-3">
          <PanelNotice tone="info">That link has expired. Tap below for a fresh one.</PanelNotice>
          <button type="button" onClick={beginHandover} className={SECONDARY_BUTTON}>
            <RefreshCw className="h-4 w-4" />
            <span>Start again</span>
          </button>
          <button type="button" onClick={beginLocal} className="w-full text-[14px] font-bold text-[#0B7A37] underline">
            Use this device instead
          </button>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <PanelNotice tone="info">
          Open this on the phone that has <span className="si-num font-bold">+91 {phone}</span>. Scan the
          QR or open the link, then type the 4-digit number it shows here.
        </PanelNotice>

        {handover.qrSvg ? (
          <div
            className="mx-auto flex max-w-[230px] justify-center rounded-xl border border-[#DCE9E1] bg-white p-3 [&_svg]:h-auto [&_svg]:w-full"
            // Server-generated SVG from our own encoder — not user HTML.
            dangerouslySetInnerHTML={{ __html: handover.qrSvg }}
          />
        ) : null}

        <div className="space-y-2">
          <button
            type="button"
            onClick={() => copyText(handover.signinUrl, 'link')}
            className={SECONDARY_BUTTON}
          >
            {copied && copiedWhat === 'link' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            <span>{copied && copiedWhat === 'link' ? 'Link copied' : 'Copy phone link'}</span>
          </button>
        </div>

        {state === 'handover_scanned' ? (
          <div className="space-y-3">
            <label className="block text-[13px] font-bold uppercase tracking-wide text-[#5B6B62]">
              Pairing number from your phone
            </label>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={4}
              value={pairDigits}
              onChange={(e) => setPairDigits(e.target.value.replace(/\D/g, '').slice(0, 4))}
              className="si-num w-full rounded-xl border border-[#DCE9E1] bg-white px-3.5 py-3 text-center text-[28px] font-bold tracking-[0.35em] text-[#0F1F17] outline-none focus:border-[#16A34A] focus:ring-[3px] focus:ring-[#16A34A]/25"
              placeholder="••••"
            />
            <button type="button" onClick={submitPair} disabled={pairing} className={PRIMARY_BUTTON}>
              {pairing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              <span>{pairing ? 'Confirming…' : 'Confirm pairing'}</span>
            </button>
          </div>
        ) : (
          <p className="flex items-center gap-2 text-[14px] text-[#5B6B62]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span>Waiting for your phone to open the link…</span>
            <span className="si-num ml-auto tabular-nums font-bold text-[#0F1F17]">
              {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}
            </span>
          </p>
        )}

        {error && <PanelNotice tone="error">{error}</PanelNotice>}

        <button type="button" onClick={beginLocal} className="w-full text-[14px] font-bold text-[#5B6B62] underline">
          Cancel — use this device
        </button>
      </div>
    );
  }

  const expired =
    state === 'expired' || (challenge && new Date(challenge.expiresAt).getTime() <= Date.now());
  const whatsapp = challenge?.channels?.whatsapp;
  const sms = challenge?.channels?.sms;
  const smsHref = smsLinkFor(sms);
  const primaryChannel = whatsapp || sms;
  const fullMessage = primaryChannel?.message || (challenge?.code ? `Verify my number for VegDrop: ${challenge.code}` : '');

  if (expired && state !== 'verified') {
    return (
      <div className="space-y-3">
        <PanelNotice tone="info">That code has expired. Tap below for a fresh one.</PanelNotice>
        <button type="button" onClick={beginLocal} className={SECONDARY_BUTTON}>
          <RefreshCw className="h-4 w-4" />
          <span>Get a new code</span>
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[#DCE9E1] bg-[#F4F7F5] px-3.5 py-4 text-center">
        <span className="block text-[12.5px] font-bold uppercase tracking-wide text-[#5B6B62]">
          Send us this code
        </span>
        <span className="si-num mt-1.5 block text-[29.5px] font-bold tracking-[0.18em] text-[#0B7A37]">
          {challenge.code}
        </span>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
          <button
            type="button"
            onClick={() => copyText(challenge.code, 'code')}
            className="inline-flex items-center gap-1.5 text-[13.5px] font-bold text-[#0B7A37] underline underline-offset-4 hover:text-[#08652C]"
          >
            {copied && copiedWhat === 'code' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            <span>{copied && copiedWhat === 'code' ? 'Copied' : 'Copy code'}</span>
          </button>
          <button
            type="button"
            onClick={() => copyText(fullMessage, 'message')}
            className="inline-flex items-center gap-1.5 text-[13.5px] font-bold text-[#0B7A37] underline underline-offset-4 hover:text-[#08652C]"
          >
            {copied && copiedWhat === 'message' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            <span>{copied && copiedWhat === 'message' ? 'Copied' : 'Copy full message'}</span>
          </button>
        </div>
      </div>

      <PanelNotice tone="info">
        Send from <span className="si-num font-bold text-[#0F1F17]">+91 {phone}</span>
        {whatsapp ? (
          <>
            {' '}
            to WhatsApp <span className="si-num font-bold">{formatInbox(whatsapp.to)}</span>
          </>
        ) : null}
        {sms ? (
          <>
            {whatsapp ? ' (or SMS ' : ' to SMS '}
            <span className="si-num font-bold">{formatInbox(sms.to)}</span>
            {whatsapp ? ')' : ''}
          </>
        ) : null}
        . If this SIM is in another phone, open WhatsApp/SMS there — or use the guided option below.
      </PanelNotice>

      <div className="space-y-2">
        {whatsapp && (
          <a href={whatsapp.link} target="_blank" rel="noopener noreferrer" className={PRIMARY_BUTTON}>
            <MessageCircle className="h-4 w-4" />
            <span>Send on WhatsApp</span>
          </a>
        )}
        {sms && (
          <a href={smsHref} className={SECONDARY_BUTTON}>
            <MessageSquare className="h-4 w-4" />
            <span>Send by SMS</span>
          </a>
        )}
        {purpose !== 'phone_change' && (
          <button type="button" onClick={beginHandover} className={SECONDARY_BUTTON}>
            <Smartphone className="h-4 w-4" />
            <span>SIM in another phone</span>
          </button>
        )}
      </div>

      {sms && (
        <PanelNotice tone="info">
          SMS is a little less secure than WhatsApp — send it from your own number
          {sms.relayHealthy === false
            ? '. Our SMS inbox looks offline right now; prefer WhatsApp if you can, or wait a minute and try again.'
            : '.'}
        </PanelNotice>
      )}

      <StatusLine state={state} expectedPhone={expectedPhone} code={challenge.code} remaining={remaining} />

      {error && <PanelNotice tone="error">{error}</PanelNotice>}
    </div>
  );
}

function StatusLine({ state, expectedPhone, code, remaining }) {
  if (state === 'verified') {
    return (
      <p className="flex items-center gap-2 text-[14px] font-bold text-[#0B7A37]">
        <Check className="h-4 w-4" />
        <span>Number confirmed.</span>
      </p>
    );
  }

  if (state === 'mismatch') {
    return (
      <PanelNotice tone="error">
        That message came from a different number. Send it again from{' '}
        <span className="si-num font-bold">{expectedPhone || 'your own number'}</span>
        . Dual-SIM? Switch to the SIM that matches this login.
      </PanelNotice>
    );
  }

  if (state === 'bad_code') {
    return (
      <PanelNotice tone="error">
        We got your message, but the code didn&rsquo;t match. Send it again, exactly as{' '}
        <span className="si-num font-bold">{code}</span>.
      </PanelNotice>
    );
  }

  const mins = Math.floor(remaining / 60);
  const secs = String(remaining % 60).padStart(2, '0');

  return (
    <p className="flex items-center justify-between gap-2 text-[14px] text-[#5B6B62]">
      <span className="flex items-center gap-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>Waiting for your message…</span>
      </span>
      <span className="si-num tabular-nums font-bold text-[#0F1F17]">
        {mins}:{secs}
      </span>
    </p>
  );
}

function PanelNotice({ tone = 'info', children }) {
  const styles =
    tone === 'error'
      ? 'bg-[#DC2626]/[0.07] border-[#DC2626]/30 text-[#9B1C1C]'
      : 'bg-[#16A34A]/[0.07] border-[#16A34A]/20 text-[#0F1F17]/80';

  return (
    <p
      role={tone === 'error' ? 'alert' : undefined}
      className={`flex gap-2 rounded-xl border px-3.5 py-3 text-[14px] leading-relaxed ${styles}`}
    >
      {tone === 'info' && <Info className="mt-[3px] h-3.5 w-3.5 shrink-0" />}
      <span>{children}</span>
    </p>
  );
}

const PRIMARY_BUTTON =
  'w-full bg-[#0B7A37] hover:bg-[#08652C] text-white text-[16.5px] font-bold py-4 rounded-xl ' +
  'shadow-[0_8px_18px_-8px_rgba(11,122,55,0.75)] active:translate-y-[1px] transition-all ' +
  'flex items-center justify-center gap-2 ' +
  'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[#16A34A]/35';

const SECONDARY_BUTTON =
  'w-full bg-white border border-[#DCE9E1] hover:border-[#16A34A] text-[#0F1F17] text-[16.5px] font-bold ' +
  'py-4 rounded-xl active:translate-y-[1px] transition-all flex items-center justify-center gap-2 ' +
  'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[#16A34A]/35';
