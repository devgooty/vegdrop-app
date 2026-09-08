import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Copy, Check, MessageCircle, MessageSquare, RefreshCw, Info } from 'lucide-react';
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
 * Default path (login / registration): Unique Skins–style QR handover —
 * Phone → Scan → Enter code → Send. The browsing device shows the QR; the SIM
 * phone opens the helper, shows a pair number, then sends the reverse code.
 *
 * Fallback: "send from this device" mints a reverse challenge on this screen
 * (deep links / copy). Phone-change always uses that local path.
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
  { n: 3, label: 'Enter code' },
  { n: 4, label: 'Send' },
];

const MESSAGE_STEPS = [
  { n: 1, label: 'Phone' },
  { n: 2, label: 'Send' },
];

function VerifyStepper({ currentStep, steps = QR_STEPS }) {
  return (
    <div className="vd-vsteps" aria-label="Verification steps">
      {steps.map((s) => {
        const state = s.n < currentStep ? 'vd-vs-done' : s.n === currentStep ? 'vd-vs-now' : '';
        const glyph = s.n < currentStep ? '✓' : String(s.n);
        return (
          <div key={s.n} className={`vd-vs ${state}`}>
            <div className="vd-vs-b">{glyph}</div>
            <div className="vd-vs-l">{s.label}</div>
          </div>
        );
      })}
    </div>
  );
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
  const preferHandover = purpose !== 'phone_change';
  const [mode, setMode] = useState(preferHandover ? 'handover' : 'local');
  const [challenge, setChallenge] = useState(null);
  const [state, setState] = useState(preferHandover ? 'handover_pending' : 'starting');
  const [expectedPhone, setExpectedPhone] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [copiedWhat, setCopiedWhat] = useState('');
  const [remaining, setRemaining] = useState(0);
  const [handover, setHandover] = useState(null);
  const [pairDigits, setPairDigits] = useState('');
  const [pairing, setPairing] = useState(false);
  /** After a successful pair, keep the QR rail on step 4 even though mode is local. */
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
      // QR unavailable — fall through to this-device buttons rather than dead-end.
      try {
        const started = await startReverseOtp({ phone, purpose, app, name });
        setMode('local');
        setChallenge(started);
        setState('pending');
        setError('');
      } catch (fallbackErr) {
        handleStartError(err.code === 'REVERSE_OTP_NOT_CONFIGURED' ? err : fallbackErr);
      }
    } finally {
      startingRef.current = false;
    }
  }, [phone, purpose, app, name]);

  useEffect(() => {
    if (preferHandover) beginHandover();
    else beginLocal();
    // Identity of the challenge — remount when phone / purpose / app / name change
    // via the memoised begin* callbacks. Prefer one of the two, not both as
    // independent triggers that would restart QR when the unused callback churns.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [preferHandover ? beginHandover : beginLocal]);

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

  const restart = preferHandover ? beginHandover : beginLocal;

  if (state === 'starting' || (mode === 'handover' && !handover && state === 'handover_pending' && !error)) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl bg-[#F4F7F5] px-3.5 py-6 text-[14.5px] text-[#5B6B62]">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Setting up…</span>
      </div>
    );
  }

  if (state === 'failed') {
    return (
      <div className="space-y-3">
        <PanelNotice tone="error">{error || 'Something went wrong.'}</PanelNotice>
        <button type="button" onClick={restart} className={OUTLINE_BUTTON}>
          <RefreshCw className="h-4 w-4" />
          <span>Get a new code</span>
        </button>
        {onBack ? (
          <button type="button" onClick={onBack} className={BACK_LINK}>
            ← Back
          </button>
        ) : null}
      </div>
    );
  }

  // --- Handover: Scan / Enter code -------------------------------------------
  if (mode === 'handover' && handover && !challenge) {
    const expired =
      state === 'expired' || (handover.expiresAt && new Date(handover.expiresAt).getTime() <= Date.now());
    const step = state === 'handover_scanned' ? 3 : 2;
    const waShare = handover.signinUrl
      ? `https://wa.me/?text=${encodeURIComponent(
          `Please open this link to verify my mobile number for VegDrop: ${handover.signinUrl}`
        )}`
      : null;

    if (expired) {
      return (
        <div className="space-y-3 text-center">
          <VerifyStepper currentStep={2} />
          <PanelNotice tone="info">That link has expired. Tap below for a fresh one.</PanelNotice>
          <button type="button" onClick={beginHandover} className={OUTLINE_BUTTON}>
            <RefreshCw className="h-4 w-4" />
            <span>Get a new code</span>
          </button>
          <button type="button" onClick={beginLocal} className={TEXT_LINK}>
            or send from this device instead
          </button>
        </div>
      );
    }

    return (
      <div className="space-y-3 text-center">
        <VerifyStepper currentStep={step} />

        {step === 2 && handover.qrSvg ? (
          <div
            className="mx-auto inline-block max-w-[200px] rounded-[10px] border border-[#DCE9E1] bg-white p-2 [&_svg]:h-auto [&_svg]:w-full"
            dangerouslySetInnerHTML={{ __html: handover.qrSvg }}
          />
        ) : null}

        {step === 2 && (
          <>
            <div className="flex flex-wrap items-center justify-center gap-2">
              {waShare ? (
                <a href={waShare} target="_blank" rel="noopener noreferrer" className={OUTLINE_BUTTON_COMPACT}>
                  Send link on WhatsApp
                </a>
              ) : null}
              <button
                type="button"
                onClick={() => copyText(handover.signinUrl, 'link')}
                className={OUTLINE_BUTTON_COMPACT}
              >
                {copied && copiedWhat === 'link' ? 'Link copied' : 'Copy link'}
              </button>
            </div>
            <p className="text-[11.5px] leading-relaxed text-[#5B6B62]">
              {copied && copiedWhat === 'link'
                ? 'Link copied. Open it on the phone that has your SIM.'
                : 'Scan the code above, or send the link if that phone is not with you.'}
            </p>
            <div className="vd-qr-drain" aria-hidden="true">
              <i />
            </div>
            <p className="text-[11.5px] text-[#5B6B62]">New code shortly</p>
            <p className="text-[13px] text-[#5B6B62]/80">
              Scan this from the phone that has your SIM, or send it the link.
            </p>
          </>
        )}

        {step === 3 ? (
          <div className="space-y-3 text-left">
            <p className="text-center text-[13px] text-[#0F1F17]">Type the number shown on your phone:</p>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={4}
              value={pairDigits}
              onChange={(e) => setPairDigits(e.target.value.replace(/\D/g, '').slice(0, 4))}
              className="si-num mx-auto block w-[130px] rounded-lg border border-[#C9D4CD] bg-white px-2 py-1.5 text-center text-[24px] font-bold tracking-[8px] text-[#0F1F17] outline-none focus:border-[#0B7A37] focus:ring-[3px] focus:ring-[#16A34A]/25"
              placeholder="••••"
            />
            <button type="button" onClick={submitPair} disabled={pairing} className={PRIMARY_BUTTON}>
              {pairing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              <span>{pairing ? 'Confirming…' : 'Confirm'}</span>
            </button>
            <p className="text-center text-[13px] text-[#5B6B62]">
              Keep this screen open — your phone will show what to send next.
            </p>
          </div>
        ) : null}

        {error && <PanelNotice tone="error">{error}</PanelNotice>}

        {step === 2 ? (
          <button type="button" onClick={beginHandover} className={OUTLINE_BUTTON}>
            <RefreshCw className="h-4 w-4" />
            <span>Get a new code</span>
          </button>
        ) : null}

        <button type="button" onClick={beginLocal} className={TEXT_LINK}>
          or send from this device instead
        </button>

        {onBack ? (
          <button type="button" onClick={onBack} className={BACK_LINK}>
            ← Back
          </button>
        ) : null}
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
      <div className="space-y-3 text-center">
        <VerifyStepper currentStep={railStep} steps={railSteps} />
        <PanelNotice tone="info">That code has expired. Tap below for a fresh one.</PanelNotice>
        <button type="button" onClick={restart} className={OUTLINE_BUTTON}>
          <RefreshCw className="h-4 w-4" />
          <span>Get a new code</span>
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3 text-center">
      <VerifyStepper currentStep={railStep} steps={railSteps} />

      <div className="rounded-[10px] border border-[#DCE9E1] bg-white px-3.5 py-4">
        <span className="si-num block text-[26px] font-black tracking-[0.12em] text-[#0B7A37]">
          {challenge.code}
        </span>
        <p className="mt-2 text-[12px] text-[#5B6B62]">
          Send it from <span className="si-num font-bold text-[#0F1F17]">+91 {phone}</span>
          {whatsapp ? (
            <>
              {' '}
              to WhatsApp <span className="si-num font-bold">{formatInbox(whatsapp.to)}</span>
            </>
          ) : null}
          .
        </p>
      </div>

      <div className="space-y-2">
        {whatsapp && (
          <a href={whatsapp.link} target="_blank" rel="noopener noreferrer" className={OUTLINE_BUTTON}>
            <MessageCircle className="h-4 w-4" />
            <span>Open WhatsApp &amp; send</span>
          </a>
        )}
        {sms && (
          <a href={smsHref} className={OUTLINE_BUTTON}>
            <MessageSquare className="h-4 w-4" />
            <span>Send as SMS instead</span>
          </a>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[12.5px]">
        <button
          type="button"
          onClick={() => copyText(challenge.code, 'code')}
          className="inline-flex items-center gap-1 font-bold text-[#0B7A37] underline underline-offset-4"
        >
          {copied && copiedWhat === 'code' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied && copiedWhat === 'code' ? 'Copied' : 'Copy code'}
        </button>
        <button
          type="button"
          onClick={() => copyText(fullMessage, 'message')}
          className="inline-flex items-center gap-1 font-bold text-[#0B7A37] underline underline-offset-4"
        >
          {copied && copiedWhat === 'message' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied && copiedWhat === 'message' ? 'Copied' : 'Copy full message'}
        </button>
      </div>

      {sms && (
        <p className="text-[11.5px] leading-relaxed text-[#5B6B62]">
          SMS is a little less secure than WhatsApp
          {sms.relayHealthy === false ? ' — our SMS inbox looks offline; prefer WhatsApp if you can.' : '.'}
        </p>
      )}

      <StatusLine state={state} expectedPhone={expectedPhone} code={challenge.code} remaining={remaining} />

      {error && <PanelNotice tone="error">{error}</PanelNotice>}

      {!viaHandover && purpose !== 'phone_change' ? (
        <button type="button" onClick={beginHandover} className={TEXT_LINK}>
          SIM in another phone? Verify from that device
        </button>
      ) : null}

      <button type="button" onClick={restart} className={OUTLINE_BUTTON}>
        <RefreshCw className="h-4 w-4" />
        <span>Get a new code</span>
      </button>

      {onBack ? (
        <button type="button" onClick={onBack} className={BACK_LINK}>
          ← Back
        </button>
      ) : null}
    </div>
  );
}

function StatusLine({ state, expectedPhone, code, remaining }) {
  if (state === 'verified') {
    return (
      <p className="flex items-center justify-center gap-2 text-[14px] font-bold text-[#0B7A37]">
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
    <p className="flex items-center justify-center gap-2 text-[13px] text-[#5B6B62]">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      <span>Waiting for your message…</span>
      <span className="si-num tabular-nums font-bold text-[#0F1F17]">
        {mins}:{secs}
      </span>
    </p>
  );
}

function PanelNotice({ tone = 'info', children }) {
  const styles =
    tone === 'error'
      ? 'bg-[#DC2626]/[0.07] border-[#DC2626]/30 text-[#9B1C1C] text-left'
      : 'bg-[#16A34A]/[0.07] border-[#16A34A]/20 text-[#0F1F17]/80 text-left';

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
  'w-full bg-[#0B7A37] hover:bg-[#08652C] text-white text-[16px] font-bold py-3.5 rounded-xl ' +
  'active:translate-y-[1px] transition-all flex items-center justify-center gap-2 ' +
  'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[#16A34A]/35';

const OUTLINE_BUTTON =
  'w-full bg-white border border-[#0B7A37] text-[#0B7A37] text-[15px] font-bold ' +
  'py-3 rounded-xl active:translate-y-[1px] transition-all flex items-center justify-center gap-2 ' +
  'hover:bg-[#F4F7F5] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[#16A34A]/35';

const OUTLINE_BUTTON_COMPACT =
  'inline-flex items-center justify-center bg-white border border-[#0B7A37] text-[#0B7A37] ' +
  'text-[12.5px] font-bold px-3.5 py-2 rounded-lg hover:bg-[#F4F7F5]';

const TEXT_LINK = 'block w-full text-[12px] font-semibold text-[#0B7A37] underline underline-offset-4';

const BACK_LINK = 'block w-full pt-1 text-[13px] font-medium text-[#5B6B62] hover:text-[#0F1F17]';
