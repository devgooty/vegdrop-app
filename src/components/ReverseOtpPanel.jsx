import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Copy, Check, MessageCircle, MessageSquare, RefreshCw, Info } from 'lucide-react';
import {
  startReverseOtp,
  startReverseOtpPhoneChange,
  getReverseOtpStatus,
  completeReverseOtp,
  completeReverseOtpPhoneChange,
  smsLinkFor,
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
 * phone that holds +91 {phone}.
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

export default function ReverseOtpPanel({
  phone,
  purpose = 'login',
  app,
  name,
  onVerified,
  onUnavailable,
  completeHere = true,
}) {
  const [challenge, setChallenge] = useState(null);
  const [state, setState] = useState('starting');
  const [expectedPhone, setExpectedPhone] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [copiedWhat, setCopiedWhat] = useState('');
  const [remaining, setRemaining] = useState(0);

  const completingRef = useRef(false);
  const startingRef = useRef(false);
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;
  const onVerifiedRef = useRef(onVerified);
  onVerifiedRef.current = onVerified;

  const begin = useCallback(async () => {
    if (startingRef.current) return;
    startingRef.current = true;

    setState('starting');
    setError('');
    setChallenge(null);
    setExpectedPhone(null);
    completingRef.current = false;

    try {
      const started =
        purpose === 'phone_change'
          ? await startReverseOtpPhoneChange({ phone })
          : await startReverseOtp({ phone, purpose, app, name });
      setChallenge(started);
      setState('pending');
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'REVERSE_OTP_NOT_CONFIGURED' && onUnavailableRef.current) {
        onUnavailableRef.current();
        return;
      }
      setError(describeError(err));
      setState('failed');
    } finally {
      startingRef.current = false;
    }
  }, [phone, purpose, app, name]);

  useEffect(() => {
    begin();
  }, [begin]);

  useEffect(() => {
    if (!challenge?.expiresAt) return undefined;
    setRemaining(secondsLeft(challenge.expiresAt));
    const timer = setInterval(() => setRemaining(secondsLeft(challenge.expiresAt)), 1000);
    return () => clearInterval(timer);
  }, [challenge?.expiresAt]);

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
  }, [challenge?.token, state, finish]);

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
        <button type="button" onClick={begin} className={SECONDARY_BUTTON}>
          <RefreshCw className="h-4 w-4" />
          <span>Try again</span>
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
        <button type="button" onClick={begin} className={SECONDARY_BUTTON}>
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
        . If this SIM is in another phone, open WhatsApp/SMS there — do not rely on the buttons below
        opening the right account on this device.
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
