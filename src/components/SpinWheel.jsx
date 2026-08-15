import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Ticket, Coins, Info, History } from 'lucide-react';
import {
  PRIZES,
  TOKENS_PER_SPIN,
  pickPrize,
  isWin,
  loadSpins,
  recordSpin,
  availableTokens,
} from '../services/spinWheel';
import { useLanguage } from '../i18n/LanguageContext';

const SEGMENT_ANGLE = 360 / PRIZES.length;
const SPIN_MS = 4200;

/** Wheel radius in the SVG's own units. The viewBox is centred on (0, 0). */
const R = 100;

/**
 * One pie slice, drawn from the centre.
 *
 * Segment `i` spans [i * SEGMENT_ANGLE, (i + 1) * SEGMENT_ANGLE), measured
 * clockwise from twelve o'clock, which is where the pointer sits. Keeping that
 * convention identical here and in `rotationFor` is the whole trick: if the
 * drawing and the maths disagree by even half a segment, the wheel lands
 * visibly off the prize it announces.
 */
function segmentPath(index) {
  const start = (index * SEGMENT_ANGLE - 90) * (Math.PI / 180);
  const end = ((index + 1) * SEGMENT_ANGLE - 90) * (Math.PI / 180);

  const x1 = R * Math.cos(start);
  const y1 = R * Math.sin(start);
  const x2 = R * Math.cos(end);
  const y2 = R * Math.sin(end);

  // Every segment here is well under a semicircle, so the large-arc flag is
  // always 0. Stated rather than computed because it is a property of the fixed
  // five-slice face, and a stray 1 would turn one slice inside out.
  return `M 0 0 L ${x1} ${y1} A ${R} ${R} 0 0 1 ${x2} ${y2} Z`;
}

/**
 * Where to stop so `index` sits under the pointer.
 *
 * The wheel only ever rotates forwards, so the returned angle is always greater
 * than the current one — winding back to a smaller number would visibly unspin.
 * Landing is aimed at the segment's centre and then jittered within it, so two
 * consecutive wins of the same prize don't stop at a pixel-identical angle and
 * read as a stuck animation.
 */
function rotationFor(index, current, random = Math.random) {
  const centre = index * SEGMENT_ANGLE + SEGMENT_ANGLE / 2;
  const jitter = (random() - 0.5) * (SEGMENT_ANGLE * 0.6);
  const target = 360 - centre - jitter;

  const turns = 5 * 360;
  const base = Math.ceil(current / 360) * 360;
  return base + turns + target;
}

/**
 * The rewards spin wheel.
 *
 * The outcome is drawn *before* the animation starts and the wheel is then
 * rotated to match, rather than the angle deciding the prize. Reading a result
 * off a CSS transform means rounding decides what someone wins, and it breaks
 * outright if the tab is backgrounded mid-spin and the transition never fires.
 *
 * See services/spinWheel.js: this whole flow is client-side and forgeable, which
 * is why the panel says prizes are not redeemable yet.
 */
export default function SpinWheel({ userId, totalTokens, onResult }) {
  const { t } = useLanguage();
  const [spins, setSpins] = useState(() => loadSpins(userId));
  const [rotation, setRotation] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const [result, setResult] = useState(null);
  const timerRef = useRef(null);

  const tokensLeft = availableTokens(totalTokens, spins);
  const canSpin = tokensLeft >= TOKENS_PER_SPIN && !spinning;

  const prizeById = useMemo(() => new Map(PRIZES.map((p) => [p.id, p])), []);

  // Leaving the Rewards screen mid-spin abandons that spin rather than settling
  // it into an unmounted component. The tokens come back with it, which is the
  // forgiving way round — the shopper never saw what they landed on.
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleSpin = () => {
    if (!canSpin) return;

    const prize = pickPrize();
    const index = PRIZES.indexOf(prize);

    setSpinning(true);
    setResult(null);
    setRotation((current) => rotationFor(index, current));

    // The result is committed on a timer rather than on transitionend: a
    // backgrounded tab never fires the event, and the shopper would come back
    // to a wheel that spun and then swallowed their tokens without saying what
    // they won.
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setSpins((current) => recordSpin(userId, prize, current));
      setResult(prize);
      setSpinning(false);
      onResult?.(prize);
    }, SPIN_MS);
  };

  return (
    <div className="bg-white border border-amber-100 rounded-3xl p-4 shadow-sm">
      <h3 className="font-black text-slate-800 text-sm flex items-center gap-2 mb-1">
        <Ticket className="w-4 h-4 text-amber-500" />
        {t('spin.title')}
      </h3>
      <p className="text-[11px] font-semibold text-slate-500 leading-relaxed mb-4">
        {t('spin.cost', { cost: TOKENS_PER_SPIN, left: tokensLeft })}
      </p>

      {/* Wheel */}
      <div className="relative w-56 h-56 mx-auto mb-4">
        {/* Pointer, at twelve o'clock — the origin every angle above is measured from. */}
        <div
          className="absolute left-1/2 -translate-x-1/2 -top-1 z-20 w-0 h-0 drop-shadow-md
                     border-l-[10px] border-l-transparent
                     border-r-[10px] border-r-transparent
                     border-t-[18px] border-t-amber-500"
          aria-hidden="true"
        />

        <svg
          viewBox="-110 -110 220 220"
          className="w-full h-full drop-shadow-lg"
          style={{
            transform: `rotate(${rotation}deg)`,
            // Heavy ease-out so it decelerates into the result like a real wheel.
            transition: spinning ? `transform ${SPIN_MS}ms cubic-bezier(0.17, 0.67, 0.16, 1)` : 'none',
          }}
          role="img"
          aria-label={t('spin.wheelAria', { count: PRIZES.length })}
        >
          <circle cx="0" cy="0" r={R + 6} fill="#FFFDF9" stroke="#DCD5C6" strokeWidth="3" />

          {PRIZES.map((prize, index) => {
            // Text sits along the segment's centre line, pushed out toward the
            // rim and rotated to match so it reads outward rather than sideways.
            const mid = index * SEGMENT_ANGLE + SEGMENT_ANGLE / 2 - 90;
            const rad = mid * (Math.PI / 180);
            const tx = R * 0.62 * Math.cos(rad);
            const ty = R * 0.62 * Math.sin(rad);

            return (
              <g key={prize.id}>
                <path d={segmentPath(index)} fill={prize.color} stroke="#FFFDF9" strokeWidth="1.5" />
                <g transform={`translate(${tx} ${ty}) rotate(${mid + 90})`}>
                  <text
                    textAnchor="middle"
                    y="-4"
                    fontSize="15"
                    style={{ userSelect: 'none' }}
                  >
                    {prize.emoji}
                  </text>
                  <text
                    textAnchor="middle"
                    y="10"
                    fontSize="8.5"
                    fontWeight="800"
                    fill="#FFFDF9"
                    style={{ userSelect: 'none' }}
                  >
                    {t(prize.shortKey)}
                  </text>
                </g>
              </g>
            );
          })}

          <circle cx="0" cy="0" r="14" fill="#FFFDF9" stroke="#DCD5C6" strokeWidth="3" />
        </svg>
      </div>

      <button
        onClick={handleSpin}
        disabled={!canSpin}
        className={`w-full py-3 rounded-2xl font-black text-sm transition-all ${
          canSpin
            ? 'skeuo-btn-emerald active:scale-95 cursor-pointer'
            : 'bg-slate-100 text-slate-400 cursor-not-allowed'
        }`}
      >
        {spinning
          ? t('spin.spinning')
          : tokensLeft >= TOKENS_PER_SPIN
            ? t('spin.spinFor', { cost: TOKENS_PER_SPIN })
            : t('spin.needMore', { count: TOKENS_PER_SPIN - tokensLeft })}
      </button>

      {/* Result */}
      {result && !spinning && (
        <div
          role="status"
          aria-live="polite"
          className={`mt-3 rounded-2xl px-3 py-3 text-center animate-scale-in border ${
            isWin(result)
              ? 'bg-amber-50 border-amber-200'
              : 'bg-slate-50 border-slate-200'
          }`}
        >
          <span className="text-2xl block mb-0.5">{result.emoji}</span>
          <p
            className={`font-black text-sm ${
              isWin(result) ? 'text-amber-700' : 'text-slate-500'
            }`}
          >
            {/* "the", not "a" — "a Egg Basket" is wrong, and picking the article
                per prize is a lot of machinery for one word. Telugu and Hindi
                have no article at all, so `spin.youWon` simply drops it. */}
            {isWin(result)
              ? t('spin.youWon', { prize: t(result.labelKey) })
              : t(result.labelKey)}
          </p>
        </div>
      )}

      {/* Past spins */}
      {spins.length > 0 && (
        <div className="mt-4 border-t border-slate-100 pt-3">
          <h4 className="font-black text-slate-700 text-[11px] flex items-center gap-1.5 mb-2">
            <History className="w-3.5 h-3.5 text-slate-400" />
            {t('spin.recentSpins')}
          </h4>
          <div className="space-y-1.5 max-h-32 overflow-y-auto">
            {spins.slice(0, 8).map((entry, index) => {
              const prize = prizeById.get(entry.prizeId);
              return (
                <div
                  key={`${entry.at}-${index}`}
                  className="flex items-center justify-between gap-2 text-[11px]"
                >
                  <span className="font-bold text-slate-600 truncate">
                    {prize ? `${prize.emoji} ${t(prize.labelKey)}` : t('spin.unknownPrize')}
                  </span>
                  <span className="shrink-0 font-bold text-slate-400 flex items-center gap-0.5">
                    <Coins className="w-3 h-3" />-{TOKENS_PER_SPIN}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Said up front, exactly as the token balance above it is. */}
      <p className="flex items-start gap-2 text-[10px] font-semibold text-slate-400 leading-relaxed mt-3">
        <Info className="w-3 h-3 shrink-0 mt-0.5" />
        <span>{t('spin.disclaimer')}</span>
      </p>
    </div>
  );
}
