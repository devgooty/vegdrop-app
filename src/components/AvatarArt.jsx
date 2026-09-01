import React from 'react';

/**
 * The built-in avatars, drawn.
 *
 * Inline SVG rather than image files, for the same reason the splash screen is
 * CSS and SVG: twelve raster mascots would be twelve requests and a few hundred
 * kilobytes on a screen most people open once, and they would blur on the
 * account header where the same art is drawn at four times the picker's size.
 * Vector costs bytes measured in hundreds and is sharp at every size.
 *
 * The animation lives in `.vd-mascot-*` in index.css, not here, so
 * `prefers-reduced-motion` can decline all of it in one block. Every element
 * these classes touch is drawn at its SETTLED position in the markup and the
 * keyframes move away from it and back — take the motion away and the mascot is
 * still a mascot, which is what makes the reduced-motion rule a single
 * `animation: none`.
 *
 * Keys match `AVATAR_PRESETS` in src/data/avatars.js. A key with no drawing
 * here falls through to initials rather than rendering an empty circle — see
 * ProfileAvatar.
 */

/**
 * One face for every mascot, deliberately.
 *
 * What makes a set of these read as a family is that the faces are identical
 * and only the bodies differ; drawing a bespoke expression per vegetable is how
 * a mascot set ends up looking like twelve unrelated stickers.
 */
function Face({ y = 56, spread = 10, scale = 1 }) {
  return (
    <g transform={`translate(50 ${y}) scale(${scale})`}>
      <g className="vd-mascot-eyes">
        <ellipse cx={-spread} cy="0" rx="3.6" ry="4.4" fill="#3B2B24" />
        <ellipse cx={spread} cy="0" rx="3.6" ry="4.4" fill="#3B2B24" />
        <circle cx={-spread + 1.3} cy="-1.6" r="1.2" fill="#fff" />
        <circle cx={spread + 1.3} cy="-1.6" r="1.2" fill="#fff" />
      </g>
      <ellipse cx={-spread - 5.5} cy="6" rx="3.6" ry="2.4" fill="#F87171" opacity="0.35" />
      <ellipse cx={spread + 5.5} cy="6" rx="3.6" ry="2.4" fill="#F87171" opacity="0.35" />
      <path
        d="M -5 7 Q 0 12 5 7"
        fill="none"
        stroke="#3B2B24"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </g>
  );
}

/**
 * The swaying wrapper for anything that sits on a mascot's head.
 *
 * The placement transform and the animated one MUST be on different elements.
 * In SVG 2 a `transform` attribute and the CSS `transform` property are the
 * same property, and a stylesheet rule outranks a presentation attribute — so
 * putting `.vd-mascot-top` on the element that carries `transform="translate(…)"`
 * silently discards the translate and parks the leaves in the corner of the
 * tile. Position outside, animate inside.
 */
function Top({ x = 50, y = 26, scale = 1, children }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <g className="vd-mascot-top">{children}</g>
    </g>
  );
}

/** A leafy sprig, used as the hat on everything that grows with one. */
function Sprig({ x = 50, y = 26, scale = 1 }) {
  return (
    <Top x={x} y={y} scale={scale}>
      <path d="M0 8 C -12 6 -15 -4 -4 -3 C -1 -3 0 2 0 8 Z" fill="#3F9D52" />
      <path d="M0 8 C 12 6 15 -4 4 -3 C 1 -3 0 2 0 8 Z" fill="#4FB765" />
      <rect x="-1.6" y="-8" width="3.2" height="12" rx="1.6" fill="#3F9D52" />
    </Top>
  );
}

function Tomato() {
  return (
    <>
      <circle cx="50" cy="60" r="31" fill="#EF4444" />
      <path d="M19 60 A31 31 0 0 1 50 29 A26 31 0 0 0 19 60 Z" fill="#F87171" />
      <Face y={60} />
      <Sprig y={28} />
    </>
  );
}

function Carrot() {
  return (
    <>
      <path d="M50 96 C 38 78 33 60 34 46 C 34 38 66 38 66 46 C 67 60 62 78 50 96 Z" fill="#F97316" />
      <path d="M50 96 C 44 78 41 60 41 46 C 41 40 50 39 50 39 Z" fill="#FB923C" />
      <path d="M40 62 L 60 58 M 42 74 L 58 70" stroke="#EA580C" strokeWidth="2" strokeLinecap="round" opacity="0.5" />
      <Face y={54} spread={9} scale={0.92} />
      <Top y={40}>
        <path d="M0 2 C -14 -2 -18 -14 -6 -12 C -1 -11 0 -4 0 2 Z" fill="#3F9D52" />
        <path d="M0 2 C 14 -2 18 -14 6 -12 C 1 -11 0 -4 0 2 Z" fill="#4FB765" />
        <path d="M0 2 C -4 -12 0 -20 2 -18 C 5 -15 3 -6 0 2 Z" fill="#58C96F" />
      </Top>
    </>
  );
}

function Broccoli() {
  return (
    <>
      <path d="M40 62 L 60 62 L 57 92 Q 50 97 43 92 Z" fill="#BBF7D0" />
      <circle cx="34" cy="52" r="15" fill="#3F9D52" />
      <circle cx="66" cy="52" r="15" fill="#3F9D52" />
      <circle cx="50" cy="40" r="18" fill="#4FB765" />
      <circle cx="50" cy="56" r="17" fill="#58C96F" />
      <Face y={57} spread={9} scale={0.9} />
    </>
  );
}

function Corn() {
  return (
    <>
      {/*
        A narrow cob with husks that clearly clear its silhouette on both
        sides. The first attempt tucked them in behind a wide cob, where they
        were entirely hidden and the mascot read as a lemon — the husks ARE the
        thing that says "corn", so they have to be outside the body, not behind
        it.
      */}
      <Top x={50} y={90}>
        <path d="M0 0 C -30 -8 -38 -34 -28 -52 C -16 -40 -8 -18 0 0 Z" fill="#4FB765" />
        <path d="M0 0 C 30 -8 38 -34 28 -52 C 16 -40 8 -18 0 0 Z" fill="#3F9D52" />
      </Top>
      <ellipse cx="50" cy="56" rx="17" ry="28" fill="#FACC15" />
      <ellipse cx="44" cy="50" rx="9" ry="19" fill="#FDE047" />
      <g stroke="#EAB308" strokeWidth="1.8" strokeLinecap="round" opacity="0.55">
        <path d="M36 40 H 64 M 35 52 H 65 M 36 64 H 64 M 39 76 H 61" />
      </g>
      <Face y={56} spread={8} scale={0.82} />
    </>
  );
}

function Aubergine() {
  return (
    <>
      <ellipse cx="50" cy="62" rx="25" ry="30" fill="#8B5CF6" />
      <ellipse cx="41" cy="55" rx="12" ry="19" fill="#A78BFA" />
      <Face y={62} />
      <Top y={30}>
        <path d="M-14 4 C -10 -4 10 -4 14 4 C 8 8 -8 8 -14 4 Z" fill="#3F9D52" />
        <rect x="-2" y="-10" width="4" height="10" rx="2" fill="#4FB765" />
      </Top>
    </>
  );
}

function Leafy() {
  return (
    <>
      {/* Outer leaves peeling away from the head, so it reads as a cabbage
          rather than a green circle with a face on it. */}
      <path d="M50 34 C 26 30 12 48 20 66 C 26 50 36 40 50 34 Z" fill="#3F9D52" />
      <path d="M50 34 C 74 30 88 48 80 66 C 74 50 64 40 50 34 Z" fill="#3F9D52" />
      <circle cx="50" cy="60" r="29" fill="#4FB765" />
      <path d="M21 60 A29 29 0 0 1 50 31 A23 29 0 0 0 21 60 Z" fill="#6EE7A0" />
      <path
        d="M50 31 C 40 45 38 60 44 88 M50 31 C 60 45 62 60 56 88 M50 31 V 88"
        fill="none"
        stroke="#3F9D52"
        strokeWidth="2.2"
        strokeLinecap="round"
        opacity="0.55"
      />
      <Face y={60} />
    </>
  );
}

function Chilli() {
  return (
    <>
      <path d="M56 34 C 76 44 78 74 58 88 C 44 97 28 88 30 76 C 32 66 42 70 46 62 C 50 52 48 38 56 34 Z" fill="#EF4444" />
      <path d="M56 34 C 66 42 68 62 58 76 C 54 82 48 82 46 78 C 50 66 50 46 56 34 Z" fill="#F87171" />
      <Face y={62} spread={8} scale={0.82} />
      <Top x={55} y={30}>
        <path d="M-9 4 C -5 -2 6 -2 9 4 C 4 7 -5 7 -9 4 Z" fill="#3F9D52" />
        <path d="M0 -1 C 4 -8 10 -11 12 -9 C 10 -4 5 -1 0 -1 Z" fill="#4FB765" />
      </Top>
    </>
  );
}

function Avocado() {
  return (
    <>
      <path d="M50 22 C 66 22 74 42 74 60 C 74 79 63 92 50 92 C 37 92 26 79 26 60 C 26 42 34 22 50 22 Z" fill="#4FB765" />
      <path d="M50 30 C 62 30 68 46 68 61 C 68 76 60 86 50 86 C 40 86 32 76 32 61 C 32 46 38 30 50 30 Z" fill="#DCFCE7" />
      <ellipse cx="50" cy="66" rx="13" ry="14" fill="#A16207" />
      <ellipse cx="46" cy="62" rx="5" ry="6" fill="#CA8A04" opacity="0.6" />
      <Face y={46} spread={8} scale={0.78} />
    </>
  );
}

function Grapes() {
  return (
    <>
      <g fill="#8B5CF6">
        <circle cx="36" cy="52" r="11" /><circle cx="64" cy="52" r="11" />
        <circle cx="30" cy="70" r="11" /><circle cx="70" cy="70" r="11" />
        <circle cx="50" cy="80" r="11" />
      </g>
      <circle cx="50" cy="62" r="15" fill="#A78BFA" />
      <Top y={34}>
        <rect x="-2" y="-6" width="4" height="12" rx="2" fill="#7C4A21" />
        <path d="M2 0 C 12 -6 20 -2 16 4 C 12 9 4 6 2 0 Z" fill="#4FB765" />
      </Top>
      <Face y={62} spread={8} scale={0.82} />
    </>
  );
}

function Mango() {
  return (
    <>
      <path d="M56 28 C 78 32 84 58 72 76 C 60 94 34 92 26 74 C 18 56 32 30 56 28 Z" fill="#F59E0B" />
      <path d="M56 28 C 44 34 34 50 34 66 C 34 76 38 84 44 88 C 30 84 20 66 26 50 C 31 37 43 29 56 28 Z" fill="#FBBF24" />
      <Face y={60} spread={9} scale={0.9} />
      <Sprig y={26} scale={0.7} />
    </>
  );
}

function Basket() {
  return (
    <>
      <circle cx="38" cy="44" r="11" fill="#EF4444" />
      <circle cx="62" cy="44" r="11" fill="#4FB765" />
      <circle cx="50" cy="38" r="11" fill="#F59E0B" />
      <path
        d="M28 50 Q 50 42 72 50"
        fill="none"
        stroke="#A16207"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
      <path d="M24 52 L 76 52 L 68 90 Q 50 95 32 90 Z" fill="#D9A441" />
      <path d="M24 52 L 46 52 L 44 93 Q 37 92 32 90 Z" fill="#E8BC63" />
      <path d="M27 66 L 73 66 M 29 78 L 71 78" stroke="#A16207" strokeWidth="2.4" opacity="0.55" />
      <Face y={72} spread={9} scale={0.85} />
    </>
  );
}

function Sprout() {
  return (
    <>
      <Top y={44}>
        <path d="M0 14 C -18 12 -24 -4 -8 -4 C -1 -4 0 6 0 14 Z" fill="#4FB765" />
        <path d="M0 14 C 18 12 24 -4 8 -4 C 1 -4 0 6 0 14 Z" fill="#58C96F" />
        <rect x="-1.8" y="-6" width="3.6" height="20" rx="1.8" fill="#3F9D52" />
      </Top>
      <path d="M28 62 L 72 62 L 66 90 Q 50 95 34 90 Z" fill="#C2703C" />
      <path d="M28 62 L 48 62 L 46 93 Q 39 92 34 90 Z" fill="#D98A54" />
      <rect x="25" y="56" width="50" height="9" rx="4.5" fill="#D98A54" />
      <Face y={76} spread={9} scale={0.85} />
    </>
  );
}

const ART = {
  tomato: Tomato,
  carrot: Carrot,
  broccoli: Broccoli,
  corn: Corn,
  aubergine: Aubergine,
  leafy: Leafy,
  chilli: Chilli,
  avocado: Avocado,
  grapes: Grapes,
  mango: Mango,
  basket: Basket,
  sprout: Sprout,
};

/** Whether this build can draw the named mascot. */
export function hasAvatarArt(key) {
  return Boolean(ART[key]);
}

/**
 * One mascot, filling its box.
 *
 * `delay` staggers the idle animation across a grid. Without it twelve mascots
 * bob in perfect unison, which reads as one mechanism rather than twelve
 * characters.
 */
export default function AvatarArt({ avatarKey, delay = 0, className = '' }) {
  const Art = ART[avatarKey];
  if (!Art) return null;

  return (
    <svg
      viewBox="0 0 100 100"
      className={className}
      aria-hidden="true"
      style={{ '--vd-mascot-delay': `${delay}ms` }}
    >
      <g className="vd-mascot">
        <Art />
      </g>
    </svg>
  );
}
