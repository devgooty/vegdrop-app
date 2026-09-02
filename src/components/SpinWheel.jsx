import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
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
 * The carnival bulbs set into the gold bezel, computed once — they never move
 * relative to the rim, so there is nothing here for a render to recompute.
 * Twenty four evenly spaced points at the rim's own radius, alternating lit
 * and unlit exactly the way a real marquee wheel does.
 */
const RIM_BULBS = Array.from({ length: 24 }, (_, index) => {
  const angle = (index / 24) * 360 * (Math.PI / 180);
  const radius = R + 8;
  return {
    x: radius * Math.cos(angle),
    y: radius * Math.sin(angle),
    lit: index % 2 === 0,
  };
});

/**
 * The prize, and where it sits in its slice. Local units, on the segment group,
 * where -y points outward toward the rim.
 *
 * The photo used to be a small disc pushed out against the rim with the name
 * tucked between it and the hub, and THAT ORDER is what kept it small. A label
 * needs tangential room, which only exists far from the centre; parking it at
 * radius 52 spent the widest part of the slice on one line of text and left the
 * prize a 31-unit band to live in. Growing the photo inside that band was never
 * going to amount to much — the band was the problem.
 *
 * So the two are swapped. The name now runs along the outer band, where the
 * slice is 100 units across and the longest label ("Juice Glass") uses barely
 * half of it, and the prize takes the whole of the rest.
 *
 * `PHOTO_R` and `GROUP_R` are solved together against three walls rather than
 * chosen, so moving either one alone walks the photo into something:
 *
 * - **The two straight edges**, cleared by `GROUP_R·sin(36°) − PHOTO_R` = 2.7
 *   units. This is the binding constraint, and it is the reason the photo
 *   cannot simply be pushed further out: the slice narrows toward the hub, so
 *   every unit inward costs 0.59 of radius.
 * - **The label**, whose baseline sits at radius 86, 4.5 units clear of the
 *   photo's outer edge at 81.5.
 * - **The hub** at 16, cleared by 8.5.
 *
 * The object inside each file is drawn at 94% of its frame, so a 57-unit frame
 * puts ~53 units of prize in a slice whose inscribed circle is 31 — it fills
 * the slot, which is the whole point of these numbers.
 */
const PHOTO_R = 28.5;
const GROUP_R = 53;

/**
 * The name's baseline, in the same local units — negative is outward, so this
 * is radius 86.
 */
const LABEL_Y = -33;

/**
 * The clover on the blank, sized off `PHOTO_R` rather than independently so the
 * two cannot drift apart the next time one of them moves. An emoji's box runs
 * about 1.08x its font size ABOVE the baseline and has almost nothing below it,
 * so the baseline drops by roughly half that to centre the glyph on the same
 * point a photo is centred on. Left a little smaller than the photos on
 * purpose: the blank is not a fifth prize.
 */
const EMOJI_SIZE = PHOTO_R * 1.55;
const EMOJI_BASELINE = EMOJI_SIZE * 0.54;

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

  // Namespaces the prize-photo clip path to this instance. See the <defs> below.
  const photoClipId = `spin-photo-${useId().replace(/:/g, '')}`;
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
      <p className="text-[12.5px] font-semibold text-slate-500 leading-relaxed mb-4">
        {t('spin.cost', { cost: TOKENS_PER_SPIN, left: tokensLeft })}
      </p>

      {/* Wheel */}
      <div className="relative w-56 h-56 mx-auto mb-4">
        {/* A halo behind the rim: a quiet amber glow at rest, brighter and
            pulsing once the wheel is actually turning — so the wheel reads as
            something worth tapping before anyone has touched it, not only
            once it is already spinning. */}
        <div
          className={`absolute inset-2 rounded-full pointer-events-none ${
            spinning ? 'vd-wheel-glow-spin' : 'vd-wheel-glow-idle'
          }`}
          aria-hidden="true"
        />

        {/* Pointer, at twelve o'clock — the origin every angle above is
            measured from. A pin rather than a flat CSS triangle, so it reads
            as part of the same gold hardware as the rim and hub rather than a
            flat sticker sitting above them. */}
        <svg
          viewBox="0 0 32 36"
          className="absolute left-1/2 -translate-x-1/2 -top-3 z-20 w-8 h-9 drop-shadow-md"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id={`${photoClipId}-pointer`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#FDE68A" />
              <stop offset="55%" stopColor="#D97706" />
              <stop offset="100%" stopColor="#92400E" />
            </linearGradient>
          </defs>
          <path
            d="M16 36 C8 24 4 17 4 11 A12 12 0 0 1 28 11 C28 17 24 24 16 36 Z"
            fill={`url(#${photoClipId}-pointer)`}
            stroke="#7C4A0A"
            strokeWidth="1"
          />
          <circle cx="16" cy="11" r="5.5" fill="#FFF7DA" opacity="0.9" />
          <circle cx="16" cy="11" r="5.5" fill="none" stroke="#B8791A" strokeWidth="1" />
        </svg>

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
          {/*
            One clip path for every prize photo, in objectBoundingBox units so a
            single circle works whatever size or transform the <image> it is
            applied to happens to carry. `useId` keeps it unique per instance —
            a hardcoded id would be silently reused if this component ever
            rendered twice on a page, and the first definition would win.
          */}
          <defs>
            <clipPath id={photoClipId} clipPathUnits="objectBoundingBox">
              <circle cx="0.5" cy="0.5" r="0.5" />
            </clipPath>
            {/* The gold hardware — bezel, pointer and hub — is gradient rather
                than flat, which is what makes it read as metal. The FACE is
                deliberately not: the segments carry no colour of their own, so
                the only things on it are the prizes themselves. */}
            <linearGradient id={`${photoClipId}-rim`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#FDE68A" />
              <stop offset="45%" stopColor="#D97706" />
              <stop offset="100%" stopColor="#92400E" />
            </linearGradient>
            <radialGradient id={`${photoClipId}-hub`} cx="35%" cy="30%" r="75%">
              <stop offset="0%" stopColor="#FFF7DA" />
              <stop offset="55%" stopColor="#F5C453" />
              <stop offset="100%" stopColor="#B8791A" />
            </radialGradient>
          </defs>

          <circle cx="0" cy="0" r={R + 8} fill="none" stroke={`url(#${photoClipId}-rim)`} strokeWidth="7" />
          <circle cx="0" cy="0" r={R + 3.5} fill="none" stroke="#FFFDF9" strokeWidth="2.5" />

          {/* Marquee bulbs set into the gold bezel — the detail that reads as
              "carnival prize wheel" rather than "pie chart" at a glance. */}
          {RIM_BULBS.map((bulb, index) => (
            <circle
              key={index}
              cx={bulb.x}
              cy={bulb.y}
              r={bulb.lit ? 2.1 : 1.6}
              fill={bulb.lit ? '#FDE68A' : '#FFFDF9'}
              stroke="#92400E"
              strokeWidth="0.5"
            />
          ))}

          {PRIZES.map((prize, index) => {
            // Text sits along the segment's centre line, pushed out toward the
            // rim and rotated to match so it reads outward rather than sideways.
            const mid = index * SEGMENT_ANGLE + SEGMENT_ANGLE / 2 - 90;
            const rad = mid * (Math.PI / 180);
            const tx = GROUP_R * Math.cos(rad);
            const ty = GROUP_R * Math.sin(rad);

            return (
              <g key={prize.id}>
                {/*
                  Every segment is the same cream. The wheel used to carry a
                  colour per slice, and the colour was doing the work the
                  prize should: five saturated wedges around four small
                  photographs read as a colour wheel someone had stuck objects
                  onto. Undressed, the only thing on the face is what can be
                  won, and the gold bezel is left as the sole piece of colour.

                  The slices are still separated, by a hairline rather than by
                  hue — without it the five prizes float on one white disc and
                  the wheel stops reading as something divided into chances.
                */}
                <path d={segmentPath(index)} fill="#FFFDF9" stroke="#E8DAC0" strokeWidth="1.1" />
                <g transform={`translate(${tx} ${ty}) rotate(${mid + 90})`}>
                  {/*
                    Undoes the segment's rotation about the photo's own centre,
                    so the prize stands upright while the label keeps reading
                    outward. Without it each segment holds its object at a
                    different angle — the juice glass arrives upside down — and
                    enlarging the photos only made that more obvious. The label
                    stays outside this group because it SHOULD follow the slice.
                  */}
                  <g transform={`rotate(${-(mid + 90)})`}>
                    {prize.image ? (
                      <>
                        {/*
                          Drawn UNDER the photo so a slow or failed load leaves
                          a deliberate-looking disc rather than a hole in the
                          segment. It is the same cream as the segment and as
                          the photo's own background, so on a face with no
                          colour it is invisible until it is needed.
                        */}
                        <circle cx="0" cy="0" r={PHOTO_R + 0.5} fill="#FFFDF9" opacity="0.95" />
                        <image
                          href={prize.image}
                          x={-PHOTO_R}
                          y={-PHOTO_R}
                          width={PHOTO_R * 2}
                          height={PHOTO_R * 2}
                          clipPath={`url(#${photoClipId})`}
                          preserveAspectRatio="xMidYMid slice"
                          style={{ userSelect: 'none' }}
                        />
                      </>
                    ) : (
                      /* Sized and centred by EMOJI_SIZE / EMOJI_BASELINE, which
                         are derived from PHOTO_R — see their definition. */
                      <text
                        textAnchor="middle"
                        y={EMOJI_BASELINE}
                        fontSize={EMOJI_SIZE}
                        style={{ userSelect: 'none' }}
                      >
                        {prize.emoji}
                      </text>
                    )}
                  </g>
                  {/* Dark on cream, where it was cream on a saturated wedge.
                      Kept in the bezel's own brown rather than a neutral grey,
                      so the face reads as one object with the gold around it. */}
                  <text
                    textAnchor="middle"
                    y={LABEL_Y}
                    fontSize="8.5"
                    fontWeight="800"
                    fill="#7C4A0A"
                    style={{ userSelect: 'none' }}
                  >
                    {t(prize.shortKey)}
                  </text>
                </g>
              </g>
            );
          })}

          {/* The hub, in the same gold as the rim and pointer rather than the
              plain cream disc it was — three unrelated materials on one
              object is what made it read as parts rather than a wheel. */}
          <circle cx="0" cy="0" r="16" fill={`url(#${photoClipId}-hub)`} stroke="#92400E" strokeWidth="1.5" />
          <circle cx="-4" cy="-5.5" r="5.5" fill="#FFFFFF" opacity="0.4" />
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
          {result.image ? (
            <img
              src={result.image}
              alt=""
              aria-hidden="true"
              loading="lazy"
              className="w-14 h-14 rounded-full object-cover mx-auto mb-1.5 shadow-sm ring-2 ring-white"
            />
          ) : (
            <span className="text-2xl block mb-0.5">{result.emoji}</span>
          )}
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
          <h4 className="font-black text-slate-700 text-[12.5px] flex items-center gap-1.5 mb-2">
            <History className="w-3.5 h-3.5 text-slate-400" />
            {t('spin.recentSpins')}
          </h4>
          <div className="space-y-1.5 max-h-32 overflow-y-auto">
            {spins.slice(0, 8).map((entry, index) => {
              const prize = prizeById.get(entry.prizeId);
              return (
                <div
                  key={`${entry.at}-${index}`}
                  className="flex items-center justify-between gap-2 text-[12.5px]"
                >
                  <span className="font-bold text-slate-600 truncate flex items-center gap-1.5 min-w-0">
                    {prize?.image ? (
                      <img
                        src={prize.image}
                        alt=""
                        aria-hidden="true"
                        loading="lazy"
                        className="w-5 h-5 rounded-full object-cover shrink-0"
                      />
                    ) : (
                      <span aria-hidden="true">{prize ? prize.emoji : '•'}</span>
                    )}
                    <span className="truncate">
                      {prize ? t(prize.labelKey) : t('spin.unknownPrize')}
                    </span>
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
      <p className="flex items-start gap-2 text-[11.5px] font-semibold text-slate-400 leading-relaxed mt-3">
        <Info className="w-3 h-3 shrink-0 mt-0.5" />
        <span>{t('spin.disclaimer')}</span>
      </p>
    </div>
  );
}
