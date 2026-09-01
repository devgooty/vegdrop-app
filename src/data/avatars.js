/**
 * The built-in avatars: a key, the gradient behind it, and a fallback glyph.
 *
 * Nothing is stored per account but the `key` and, for the people, two more
 * short slugs — so an avatar costs the database a few dozen bytes where even a
 * small PNG per user would be a collection nobody prunes. The mascot itself is
 * vector, drawn in components/AvatarArt.jsx — this file is the roster and the
 * palette, that one is the artwork.
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
 * Skin tones, and the shade each one is contoured with.
 *
 * A single flat fill reads as a sticker, so every person is drawn with the
 * base colour plus `shade` for the neck and the underside of the jaw. Keeping
 * the pair together here is what stops a new tone from arriving without one.
 */
export const SKIN_TONES = [
  { key: 'porcelain', hex: '#F6DCC8', shade: '#E4BCA1' },
  { key: 'light', hex: '#EFC7A2', shade: '#D9A87F' },
  { key: 'tan', hex: '#DCA478', shade: '#BF855B' },
  { key: 'brown', hex: '#B87A4E', shade: '#96603A' },
  { key: 'deep', hex: '#8D5524', shade: '#6F4119' },
  { key: 'rich', hex: '#5C3A21', shade: '#452A17' },
];

/**
 * Hair colours. `shade` is the parting and the far side of the head, which is
 * what gives a flat cap of colour any sense of volume.
 *
 * The STYLE is not a third choice: it comes from which person was picked, so
 * the sheet stays two rows of swatches rather than a character builder.
 */
export const HAIR_COLORS = [
  { key: 'black', hex: '#221C1A', shade: '#100C0B' },
  { key: 'dark-brown', hex: '#3E2A1E', shade: '#2A1B12' },
  { key: 'brown', hex: '#6B4226', shade: '#4E2F1A' },
  { key: 'auburn', hex: '#8C3B21', shade: '#6B2A16' },
  { key: 'blonde', hex: '#D9A441', shade: '#B9832B' },
  { key: 'grey', hex: '#A0A6AC', shade: '#7C838A' },
];

export const DEFAULT_SKIN_TONE = 'tan';
export const DEFAULT_HAIR_COLOR = 'black';

const SKIN_BY_KEY = new Map(SKIN_TONES.map((tone) => [tone.key, tone]));
const HAIR_BY_KEY = new Map(HAIR_COLORS.map((colour) => [colour.key, colour]));

/**
 * The two person avatars, which are the only ones with anything to edit.
 *
 * Their tiles are kept pale on purpose: the skin tone is the thing being
 * chosen, and a saturated ground shifts how every swatch above it reads.
 */
export const PERSON_PRESETS = [
  { key: 'male', emoji: '🧑', from: '#EFF6FF', to: '#C7D2FE' },
  { key: 'female', emoji: '👩', from: '#FDF2F8', to: '#FBCFE8' },
];

/**
 * Each background is chosen to CONTRAST with its mascot, not to match it — a
 * red tomato on a red tile is a silhouette. That is why the greens sit on warm
 * grounds and the reds and oranges on cool ones.
 */
export const PRODUCE_PRESETS = [
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

/** People first: this is a profile picture, so a person is the likelier answer. */
export const AVATAR_PRESETS = [...PERSON_PRESETS, ...PRODUCE_PRESETS];

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

/** Whether this avatar has a skin tone and hair colour to edit. */
export function avatarIsEditable(key) {
  return PERSON_PRESETS.some((preset) => preset.key === key);
}

/**
 * The palette a person is drawn with, from two stored slugs.
 *
 * Falls back rather than failing on an unknown value, for the same reason an
 * unknown preset key falls back to initials: what is stored is a slug this
 * build may simply not have shipped yet, and half a face is worse than a
 * default one.
 */
export function avatarPalette({ skinTone, hair } = {}) {
  return {
    skin: SKIN_BY_KEY.get(skinTone) || SKIN_BY_KEY.get(DEFAULT_SKIN_TONE),
    hair: HAIR_BY_KEY.get(hair) || HAIR_BY_KEY.get(DEFAULT_HAIR_COLOR),
  };
}
