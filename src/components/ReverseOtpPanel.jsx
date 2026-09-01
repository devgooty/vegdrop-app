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
import { ApiRequestError, NetworkError } from '../services/apiClient';

/**
 * Reverse OTP — "I'll send the code instead".
 *
 * Shows a code and a prefilled message link. The user taps, their messaging app
 * opens with the text ready, they hit send, and this panel notices.
 *
 * WHY THE CODE IS ON SCREEN
 *
 * It has to be: the user is the one sending it. The secret is not the code, it
 * is that the message arrives from the number being claimed. So this panel
 * displays the code prominently rather than hiding it, and offers a copy button
 * — a user whose link does not open still has a way through.
 *
 * POLLING
 *
 * Backs off — fast while the user is likely still in the messaging app, slower
 * once they clearly are not — and pauses entirely while the tab is hidden, which
 * is most of the time here, since the user is in WhatsApp. Both matter: at a
 * flat 2s this would spend a third of the API's per-IP budget on one sign-in,
 * and on a shared connection that locks out everyone else.
 *
 * This component never decides a verification succeeded. It reports what the
 * server says and calls `complete` when told the number was proved.
 */

/**
 * How long to wait before the next poll, given how long we have been waiting.
 *
 * Quick at first because the round trip through a messaging app is short when it
 * works; slower afterwards because someone who has not sent it in ninety seconds
 * is reading, not sending.
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
      return 'This option is not available right now. Please use the code we send you instead.';
    }
    return err.message;
  }
  return 'Something went wrong. Please try again.';
}

/**
 * @param {object}   props
 * @param {string}   props.phone      the number being claimed, 10 digits
 * @param {string}   props.purpose    login | registration | vendor_registration |
 *                                    delivery_registration | phone_change
 * @param {string}   [props.app]      customer | shopkeeper | delivery
 * @param {string}   [props.name]     used only if this number becomes a new account
 * @param {Function} props.onVerified called with `{ token, user }`. `user` is the
 *                                    signed-in account for flows this panel
 *                                    completes, and null for registration, whose
 *                                    caller spends the token on `/register/verify`
 *                                    (that endpoint is what creates the account).
 * @param {Function} [props.onUnavailable] called instead of showing a dead-end
 *                                    error when reverse OTP is not configured.
 *                                    The parent should switch to the outbound
 *                                    code — this is the fallback, not a failure.
 * @param {boolean}  [props.completeHere=true] whether this panel spends the
 *                                    token itself. False for registration.
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
  const [challenge, setChallenge] = useState(null);
  const [state, setState] = useState('starting');
  const [expectedPhone, setExpectedPhone] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [remaining, setRemaining] = useState(0);

  // Guards the one-shot completion. A poll landing while `complete` is in flight
  // must not fire a second one — the server would refuse it, but the panel would
  // show an error over a sign-in that actually worked.
  const completingRef = useRef(false);

  /**
   * Whether a `start` call is already in flight.
   *
   * Two must never overlap. Issuing a challenge supersedes this number's
   * previous one, so of two concurrent starts the one the SERVER handles second
   * kills the other — and the client cannot tell which that was. The panel would
   * then display a code whose row is already dead: the countdown runs normally
   * and every poll answers `expired`, with nothing on screen explaining why.
   *
   * Ordering the responses on the client does not fix it, because the damage is
   * decided server-side. The only reliable answer is to never issue two at once.
   * Both triggers are real: StrictMode double-invokes the mount effect in
   * development, and a double tap on "get a new code" does the same in
   * production.
   */
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

  // The countdown. Its own ticker so the poll cadence and the clock stay
  // independent — the clock must keep moving between polls.
  useEffect(() => {
    if (!challenge?.expiresAt) return undefined;
    setRemaining(secondsLeft(challenge.expiresAt));
    const timer = setInterval(() => setRemaining(secondsLeft(challenge.expiresAt)), 1000);
    return () => clearInterval(timer);
  }, [challenge?.expiresAt]);

  /** Spend a verified token. Runs at most once per challenge. */
  const finish = useCallback(async () => {
    if (completingRef.current) return;
    completingRef.current = true;

    try {
      if (!completeHere) {
        // Registration: the caller spends this token on /register/verify, which
        // is what creates the account. Await it so a failed create surfaces here
        // rather than leaving "Number confirmed" over an account that was not.
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
      setError(describeError(err));
      setState('failed');
      // The token is spent either way, so there is nothing left to poll for.
      // Let the user raise a fresh one rather than stranding them.
      completingRef.current = false;
    }
  }, [challenge, completeHere, purpose]);

  // Polling. Chained timeouts rather than setInterval, so a slow response can
  // never stack requests on top of each other.
  useEffect(() => {
    if (!challenge?.token) return undefined;
    if (['verified', 'expired', 'failed'].includes(state)) return undefined;

    let cancelled = false;
    let timer = null;
    const startedAt = Date.now();
    const controller = new AbortController();

    async function tick() {
      if (cancelled) return;

      // Pause while the tab is hidden — which is exactly when the user is over
      // in WhatsApp. The visibility listener below polls the moment they return.
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
        // A dropped poll is not a failed verification — the code is still live
        // and the next tick will pick it up. Only a definitive server answer
        // changes state.
        if (cancelled) return;
        if (err instanceof ApiRequestError && err.status === 429) {
          // Backed off too far; slow down rather than hammering.
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

  const copyCode = async () => {
    if (!challenge?.code) return;
    try {
      await navigator.clipboard.writeText(challenge.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused (insecure context, permissions). The
      // code is on screen regardless, so this is not worth an error message.
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

  /**
   * Anything that has stopped and cannot recover on its own gets the same
   * treatment: say what happened, and offer a fresh code.
   *
   * `failed` belongs here whether or not a challenge exists. It used to fall
   * through to the main panel when one did, which left the screen showing a
   * code, an error, and "waiting for your message…" all at once — while polling
   * had already stopped, so nothing that screen promised was still happening.
   */
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

  /**
   * Decided from the challenge's own timestamp, not the countdown.
   *
   * `remaining` starts at 0 and is only filled in by an effect, which runs after
   * paint — so keying expiry off it rendered "that code has expired" for a frame
   * every single time a code was issued.
   */
  const expired =
    state === 'expired' || (challenge && new Date(challenge.expiresAt).getTime() <= Date.now());
  const whatsapp = challenge?.channels?.whatsapp;
  const sms = challenge?.channels?.sms;
  const smsHref = smsLinkFor(sms);

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
        <button
          type="button"
          onClick={copyCode}
          className="mt-2 inline-flex items-center gap-1.5 text-[13.5px] font-bold text-[#0B7A37] underline underline-offset-4 hover:text-[#08652C]"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          <span>{copied ? 'Copied' : 'Copy code'}</span>
        </button>
      </div>

      <p className="text-[14px] leading-relaxed text-[#5B6B62]">
        Tap a button below — your messaging app opens with the message ready. Just
        hit send, from <span className="si-num font-bold text-[#0F1F17]">+91 {phone}</span>.
      </p>

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

      {/* Says out loud that the two channels are not equally strong, rather than
          leaving the weaker one to look identical to the stronger. */}
      {sms && !whatsapp && (
        <PanelNotice tone="info">
          SMS is a little less secure than WhatsApp — make sure you send it from your own number.
        </PanelNotice>
      )}

      <StatusLine state={state} expectedPhone={expectedPhone} code={challenge.code} remaining={remaining} />

      {error && <PanelNotice tone="error">{error}</PanelNotice>}
    </div>
  );
}

/**
 * What is happening, in the user's terms.
 *
 * Every failure state says what to DO next. Silence is the failure mode this
 * whole feature has to avoid — a user staring at "waiting" with no idea their
 * message went to the wrong place learns nothing and gives up.
 */
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
        <span className="si-num font-bold">{expectedPhone || 'your own number'}</span>.
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

// Matches the sign-in screen's buttons — see LoginPage.jsx, where the same
// contrast reasoning applies: #0B7A37 rather than the lighter brand green,
// because white bold text needs 4.5:1 and #16A34A only reaches 3.3.
const PRIMARY_BUTTON =
  'w-full bg-[#0B7A37] hover:bg-[#08652C] text-white text-[16.5px] font-bold py-4 rounded-xl ' +
  'shadow-[0_8px_18px_-8px_rgba(11,122,55,0.75)] active:translate-y-[1px] transition-all ' +
  'flex items-center justify-center gap-2 ' +
  'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[#16A34A]/35';

const SECONDARY_BUTTON =
  'w-full bg-white border border-[#DCE9E1] hover:border-[#16A34A] text-[#0F1F17] text-[16.5px] font-bold ' +
  'py-4 rounded-xl active:translate-y-[1px] transition-all flex items-center justify-center gap-2 ' +
  'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[#16A34A]/35';
