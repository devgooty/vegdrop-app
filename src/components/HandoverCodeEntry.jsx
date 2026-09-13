import React, { useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import OTPBoxGroup from './OTPBoxGroup';
import { useLanguage } from '../i18n/LanguageContext';

/**
 * The refusals a rider meets at a counter or a door, in the rider's language.
 *
 * The server's own message is English and names the holder; these say the same
 * thing without needing to. Anything else falls back to the server's message.
 */
function describeRefusal(err, t) {
  switch (err?.code) {
    case 'WRONG_CODE':
      return t('handover.err.wrong', { count: err.details?.attemptsRemaining ?? '?' });
    case 'CODE_LOCKED':
      return t('handover.err.locked');
    case 'CODE_NOT_ISSUED':
      return t('handover.err.notIssued');
    default:
      return err?.message || t('handover.entryFailed');
  }
}

/**
 * Where the rider types a code somebody else is showing them - the shop's at
 * the counter, a stall's at its pitch, the customer's at the door.
 *
 * Presentation only. It holds the digits and nothing else: there is no expected
 * value anywhere on the rider's side, because a rider who could see the code
 * would not need anyone to show it to them. The server decides, and a refusal
 * comes back beside the digits - including how many tries are left, so a
 * mistyped digit is a retry and not a mystery.
 *
 * `onSubmit(code)` should throw on refusal (an ApiRequestError). On success the
 * digits clear.
 */
export default function HandoverCodeEntry({ title, hint, submitLabel, onSubmit, disabled = false }) {
  const { t } = useLanguage();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const complete = /^\d{6}$/.test(code);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!complete || busy || disabled) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit(code);
      setCode('');
    } catch (err) {
      setError(describeRefusal(err, t));
      // A locked code will never work, so the old digits are only in the way of
      // typing the new one the holder is about to read out.
      if (err?.code === 'CODE_LOCKED') setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-[#1B4D3E]/20 bg-[#1B4D3E]/5 px-3 py-3 space-y-2.5"
    >
      <div className="flex items-start gap-2.5">
        <KeyRound className="w-4 h-4 text-[#1B4D3E] shrink-0 mt-0.5" />
        <div>
          <p className="text-[12px] font-bold text-[#1B4D3E] uppercase tracking-wide">{title}</p>
          <p className="text-[13px] text-[#5C5448] leading-snug">{hint}</p>
        </div>
      </div>

      <OTPBoxGroup
        value={code}
        onChange={(next) => {
          setCode(next);
          if (error) setError('');
        }}
        autoComplete="off"
      />

      {error && (
        <p role="alert" className="text-[12.5px] font-bold text-[#9B3A3A] leading-snug">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={!complete || busy || disabled}
        className="w-full skeuo-btn-emerald text-[15px] font-bold py-3 rounded-xl disabled:opacity-40 disabled:shadow-none"
      >
        <span className="flex items-center justify-center gap-2">
          {busy && <Loader2 className="w-4 h-4 animate-spin" />}
          {submitLabel}
        </span>
      </button>
    </form>
  );
}
