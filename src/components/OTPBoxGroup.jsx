import React, { useRef } from 'react';

/**
 * Six-box one-time-code input.
 *
 * Presentation only — it collects digits and nothing else. Verification happens
 * on the server; there is deliberately no expected value anywhere in this file.
 */
/**
 * @param {'default'|'board'} [tone] `board` is the sign-in screen's market-board
 *   styling, where a filled box turns turmeric. Anything else keeps the original
 *   look, so the profile screens that also use this are untouched.
 */
export default function OTPBoxGroup({ length = 6, value, onChange, tone = 'default' }) {
  const inputs = useRef([]);

  const handleChange = (e, index) => {
    const val = e.target.value.replace(/\D/g, '');

    // Paste of a full code: distribute across the boxes and jump to the end.
    if (val.length > 1) {
      const pasted = val.slice(0, length);
      onChange(pasted);
      const nextIndex = Math.min(length - 1, pasted.length);
      inputs.current[nextIndex]?.focus();
      return;
    }

    const next = value.split('');
    next[index] = val === '' ? ' ' : val;
    onChange(next.join('').trimEnd());

    if (val !== '' && index < length - 1) {
      inputs.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (e, index) => {
    if (e.key === 'Backspace' && (!value[index] || value[index] === ' ') && index > 0) {
      inputs.current[index - 1]?.focus();
    }
  };

  const boxClass = (filled) =>
    tone === 'board'
      ? `mb-otp w-full h-14 text-center text-xl font-medium rounded-lg${filled ? ' is-filled' : ''}`
      : 'w-full h-12 text-center text-lg font-black text-gray-900 bg-gray-50 border border-gray-300 rounded-xl focus:bg-white focus:outline-none focus:border-[#1B4D3E] focus:ring-2 focus:ring-[#1B4D3E]/30 transition-all shadow-sm';

  return (
    <div className="flex gap-2 justify-between">
      {Array.from({ length }).map((_, index) => {
        const digit = value[index] === ' ' ? '' : value[index] || '';
        return (
          <input
            key={index}
            ref={(el) => (inputs.current[index] = el)}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={length}
            aria-label={`Digit ${index + 1} of ${length}`}
            value={digit}
            onChange={(e) => handleChange(e, index)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            className={boxClass(digit !== '')}
          />
        );
      })}
    </div>
  );
}
