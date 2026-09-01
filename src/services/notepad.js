/**
 * The freeform shopping notepad behind the header's clipboard icon.
 *
 * Lives in localStorage for the same reason the wishlist does (see
 * services/wishlist.js): a scratch line like "get onions" is not a fact the
 * platform needs to be authoritative about, so there is no server model to
 * build for it. Separate storage key from the wishlist and the cart — this is
 * plain notes, not catalog items, and never resolves against a product.
 */

const NOTEPAD_KEY = 'vegdrop_notepad';

function readAll() {
  try {
    const raw = localStorage.getItem(NOTEPAD_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Corrupt JSON or private-mode Safari throwing on read; either way there
    // is nothing usable to recover.
    return [];
  }
}

function writeAll(notes) {
  try {
    localStorage.setItem(NOTEPAD_KEY, JSON.stringify(notes));
  } catch {
    // Nothing to do: the caller's own state still reflects the change for
    // this session, it just will not survive a reload.
  }
  return notes;
}

/** Notes, most recently added first. */
export function getNotes() {
  return readAll();
}

export function addNote(text) {
  const trimmed = text.trim();
  if (!trimmed) return readAll();
  const note = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text: trimmed, checked: false };
  return writeAll([note, ...readAll()]);
}

export function toggleNote(id) {
  return writeAll(readAll().map((note) => (note.id === id ? { ...note, checked: !note.checked } : note)));
}

export function editNote(id, text) {
  const trimmed = text.trim();
  const notes = readAll();
  if (!trimmed) return writeAll(notes.filter((note) => note.id !== id));
  return writeAll(notes.map((note) => (note.id === id ? { ...note, text: trimmed } : note)));
}

export function removeNote(id) {
  return writeAll(readAll().filter((note) => note.id !== id));
}

/** Drops every checked-off note, keeps the rest. */
export function clearChecked() {
  return writeAll(readAll().filter((note) => !note.checked));
}
