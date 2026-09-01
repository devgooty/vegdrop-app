/**
 * The built-in avatars: a key, the gradient behind it, and a fallback glyph.
 *
 * Nothing is stored per account but the `key`, so an avatar costs the database
 * twenty-odd bytes where even a small PNG per user would be a collection nobody
 * prunes. The mascot itself is vector, drawn in components/AvatarArt.jsx — this
 * file is the roster and the palette, that one is the artwork.
 *
 * `emoji` is a FALLBACK, not the design. It renders only for a key with no
 * drawing, which keeps adding an entry here a one-line change that degrades
 * visibly rather than to an empty circle.
 *
 * This list is the only definition of what avatars exist. The server stores
 * whatever key it is sent (a slug, length-capped) rather than an enum of its
 * own, so adding one here is the whole change — see the note on `avatar.preset`
 * in server/models/User.js. An unrecognised key falls back to initials.
 */

/**
 * Each background is chosen to CONTRAST with its mascot, not to match it — a
 * red tomato on a red tile is a silhouette. That is why the greens sit on warm
 * grounds and the reds and oranges on cool ones.
 */
export const AVATAR_PRESETS = [
  { key: 'tomato', emoji: '🍅', from: '#ECFDF5', to: '#A7F3D0' },
  { key: 'carrot', emoji: '🥕', from: '#EFF6FF', to: '#BFDBFE' },
  { key: 'broccoli', emoji: '🥦', from: '#FFFBEB', to: '#FDE68A' },
  { key: 'corn', emoji: '🌽', from: '#F0F9FF', to: '#BAE6FD' },
  { key: 'aubergine', emoji: '🍆', from: '#FEFCE8', to: '#FEF08A' },
  { key: 'leafy', emoji: '🥬', from: '#FFF7ED', to: '#FED7AA' },
  { key: 'chilli', emoji: '🌶️', from: '#F7FEE7', to: '#D9F99D' },
  { key: 'avocado', emoji: '🥑', from: '#F5F3FF', to: '#DDD6FE' },
  { key: 'grapes', emoji: '🍇', from: '#F0FDFA', to: '#99F6E4' },
  { key: 'mango', emoji: '🥭', from: '#EEF2FF', to: '#C7D2FE' },
  { key: 'basket', emoji: '🧺', from: '#F0F9FF', to: '#A5D8F3' },
  { key: 'sprout', emoji: '🌱', from: '#FDF2F8', to: '#FBCFE8' },
];

const BY_KEY = new Map(AVATAR_PRESETS.map((preset, index) => [preset.key, { ...preset, index }]));

/**
 * The preset for a stored key, or null when it names nothing we can draw.
 *
 * Carries its `index` so a lone avatar on the account screen picks up the same
 * animation offset it has in the picker grid — the mascot does not visibly
 * re-time itself when you move between the two.
 */
export function avatarPreset(key) {
  return (key && BY_KEY.get(key)) || null;
}
