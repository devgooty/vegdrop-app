import React, { useId } from 'react';

/**
 * The droplet, drawn as vector.
 *
 * Lived inside SplashScreen.jsx until the launch screen started handing the
 * mark to the home screen's header. A handoff between two drawings of the same
 * logo is a redraw however carefully it is timed, so both ends now render this
 * one component and the seam has nothing to show.
 *
 * That replaced `public/logo.png` in the header: a 512px raster of a flat shape
 * painted at 26 device-independent pixels, soft at the edges of the lens and
 * the leaves, and a 41 KB request on the first screen after launch. The same
 * argument the splash already made for itself — the PNG is the wrong tool at
 * either size, and drawn here the mark carries the logo's own green rather than
 * an approximation of it.
 *
 * Every gradient and clip path is suffixed with a per-instance id. SVG ids are
 * document-global: two of these on screen at once — a header behind an open
 * splash, say — would have the second instance's `url(#vd-drop-body)` resolve
 * to the first one's definition, which is invisible until the day the two
 * differ.
 */
export default function VegDropMark({ className = 'w-[4.75rem] h-[4.75rem]' }) {
  // `useId` returns ':r0:'. Colons are legal in a fragment identifier but have
  // a history of tripping `url(#…)` parsing; stripping them costs nothing.
  const uid = useId().replace(/:/g, '');
  const id = (name) => `${name}-${uid}`;

  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={id('vd-drop-body')} x1="20%" y1="0%" x2="80%" y2="100%">
          <stop offset="0%" stopColor="#3FBE73" />
          <stop offset="55%" stopColor="#1F9D4D" />
          <stop offset="100%" stopColor="#12793C" />
        </linearGradient>
        <linearGradient id={id('vd-leaf-left')} x1="0%" y1="100%" x2="60%" y2="0%">
          <stop offset="0%" stopColor="#8CC63F" />
          <stop offset="100%" stopColor="#C3EC6E" />
        </linearGradient>
        <linearGradient id={id('vd-leaf-right')} x1="100%" y1="100%" x2="40%" y2="0%">
          <stop offset="0%" stopColor="#3E9B45" />
          <stop offset="100%" stopColor="#6BC153" />
        </linearGradient>
        {/* The leaves are clipped to the lens rather than trusted to stay
            inside it. Drawn free they overshot its edge and sat half on white,
            half on the droplet's own green — which read as a printing
            misregistration rather than as a mark. */}
        <clipPath id={id('vd-lens-clip')}>
          <circle cx="32" cy="43" r="13" />
        </clipPath>

        {/* Body clip, so the modelling passes below can be drawn as plain
            shapes and cut to the silhouette instead of each one having to trace
            the teardrop's own curves. */}
        <clipPath id={id('vd-body-clip')}>
          <path d="M32 4 C32 4 12 26 12 41 C12 52.05 20.95 61 32 61 C43.05 61 52 52.05 52 41 C52 26 32 4 32 4 Z" />
        </clipPath>

        {/* The broad soft catchlight down the upper left. A gradient, not a
            shape with an edge — an edge here reads as a second object sitting
            on the droplet. */}
        <radialGradient id={id('vd-drop-gloss')} cx="32%" cy="26%" r="52%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.5" />
          <stop offset="60%" stopColor="#FFFFFF" stopOpacity="0.1" />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
        </radialGradient>

        {/* Occlusion at the bottom edge. Without it the droplet is evenly lit
            all the way round and reads flat however bright the top is. */}
        <radialGradient id={id('vd-drop-depth')} cx="50%" cy="88%" r="46%">
          <stop offset="0%" stopColor="#0A5B30" stopOpacity="0.32" />
          <stop offset="100%" stopColor="#0A5B30" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Teardrop: a circle of r=20 at (32,41), closed off with two long
          curves that meet at the apex. */}
      <path
        d="M32 4 C32 4 12 26 12 41 C12 52.05 20.95 61 32 61 C43.05 61 52 52.05 52 41 C52 26 32 4 32 4 Z"
        fill={`url(#${id('vd-drop-body')})`}
      />

      {/* Modelling, in light-over-dark order, all cut to the silhouette. */}
      <g clipPath={`url(#${id('vd-body-clip')})`}>
        <rect x="0" y="0" width="64" height="64" fill={`url(#${id('vd-drop-depth')})`} />
        <rect x="0" y="0" width="64" height="64" fill={`url(#${id('vd-drop-gloss')})`} />
        {/* A bright edge along the lit side, drawn by offsetting a stroked copy
            of the silhouette up and left and keeping only what lands inside.
            Same light source as the gloss and the specular pin, and most of
            what makes the body read as glass rather than as filled vector. */}
        <path
          d="M32 4 C32 4 12 26 12 41 C12 52.05 20.95 61 32 61 C43.05 61 52 52.05 52 41 C52 26 32 4 32 4 Z"
          fill="none"
          stroke="#FFFFFF"
          strokeOpacity="0.32"
          strokeWidth="1.6"
          transform="translate(-0.9 -1.1)"
        />
      </g>

      {/* A hairline of shadow under the lens rim, so the white circle sits IN
          the droplet rather than on top of it. */}
      <circle cx="32" cy="43.5" r="13" fill="#0A5B30" opacity="0.18" />
      <circle cx="32" cy="43" r="13" fill="#FFFFFF" />

      {/* Mirrored about x=32, so the pair sits square in the lens. */}
      <g clipPath={`url(#${id('vd-lens-clip')})`}>
        <path d="M32 52 C24.5 49.5 21.5 43 23 35.5 C29.5 38.5 32.5 45 32 52 Z" fill={`url(#${id('vd-leaf-left')})`} />
        <path d="M32 52 C39.5 49.5 42.5 43 41 35.5 C34.5 38.5 31.5 45 32 52 Z" fill={`url(#${id('vd-leaf-right')})`} />
        {/* Midribs. At 4.75rem they are barely there; at the 2.15× opening pose
            they are what keeps the leaves from reading as two plain wedges. */}
        <path d="M32 51.5 C30.8 45 28.4 40.2 24.6 36.9" stroke="#FFFFFF" strokeOpacity="0.5" strokeWidth="0.7" fill="none" strokeLinecap="round" />
        <path d="M32 51.5 C33.2 45 35.6 40.2 39.4 36.9" stroke="#FFFFFF" strokeOpacity="0.42" strokeWidth="0.7" fill="none" strokeLinecap="round" />
      </g>

      {/* Specular pin — the small hard glint that sells a wet surface, sitting
          inside the broad gloss above. Narrow and well off-centre; anything
          rounder reads as a smudge once the mark is scaled up to fill the
          screen. */}
      <ellipse cx="23.5" cy="25" rx="2.3" ry="4.6" fill="#FFFFFF" opacity="0.72" transform="rotate(-22 23.5 25)" />
    </svg>
  );
}
