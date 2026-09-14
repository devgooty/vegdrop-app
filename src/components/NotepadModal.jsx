import React, { useEffect, useRef, useState } from 'react';
import { ClipboardList, X, Plus, Trash2, Check, ListChecks, Mic, Search } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';
import { getNotes, addNote, toggleNote, removeNote, clearChecked } from '../services/notepad';
import { spokenKey } from '../services/voiceList';
import VoiceListSession from './VoiceListSession';

/**
 * A freeform shopping notepad — "remember to get ginger" rather than a saved
 * catalog product. Reads and writes through services/notepad.js the same way
 * AccountWishlist does through services/wishlist.js: this modal is a door
 * onto that one stored list, not state of its own, so it always shows what
 * is actually saved.
 */
export default function NotepadModal({ isOpen, initialMode, products = [], categories = [], onBuildCart, onClose }) {
  const { t } = useLanguage();
  const [notes, setNotes] = useState([]);
  const [draft, setDraft] = useState('');
  const inputRef = useRef(null);

  // Voice add: a list dictated one item at a time (VoiceListSession), which
  // lands here as notes when the shopper taps OK.
  const [voiceOpen, setVoiceOpen] = useState(false);
  const voiceSessionRef = useRef(null);

  // Re-read on every open rather than once on mount: the modal instance stays
  // mounted-or-not across the app's lifetime, so a stale open would otherwise
  // show whatever the list looked like the first time it was ever opened.
  useEffect(() => {
    if (isOpen) setNotes(getNotes());
  }, [isOpen]);

  // Closing the modal must not leave a mic session listening behind it. The
  // session stays mounted (see `voiceSession`), and stops its recogniser when
  // `open` goes false.
  useEffect(() => {
    if (!isOpen) setVoiceOpen(false);
  }, [isOpen]);

  /**
   * Carries out whichever choice NotepadChooser made — this modal itself has
   * no opinion about how it was opened. 'voice' starts listening the instant
   * the sheet is up, matching what tapping the mic on the chooser promised.
   * 'write' focuses the field once the slide-up has had time to finish;
   * focusing on the same frame the sheet opens fights that transition and
   * sometimes loses the focus outright.
   */
  useEffect(() => {
    if (!isOpen) return undefined;

    if (initialMode === 'voice') {
      openVoiceAdd();
      return undefined;
    }
    if (initialMode === 'write') {
      const id = setTimeout(() => inputRef.current?.focus(), 350);
      return () => clearTimeout(id);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialMode]);

  const openVoiceAdd = () => {
    setVoiceOpen(true);
    // Started here, inside the tap, not by the session in an effect — see
    // createSpeechRecognition for why Chrome cares.
    voiceSessionRef.current?.start();
  };

  /**
   * Write what was said into the list, and hand back the notes it became, in
   * the order spoken. A line already waiting on the list is reused rather than
   * written twice: saying "tomato" when "tomato" is still unticked means the
   * same tomato.
   */
  const saveSpokenItems = (items) => {
    let list = getNotes();
    const saved = items.map((text) => {
      const existing = list.find((note) => !note.checked && spokenKey(note.text) === spokenKey(text));
      if (existing) return existing;
      list = addNote(text);
      return list[0];
    });
    setNotes(list);
    return saved;
  };

  // OK: the list is saved and answered with what the shop sells.
  const handleVoiceDone = (items) => {
    const saved = saveSpokenItems(items);
    setVoiceOpen(false);
    onBuildCart?.(saved);
  };

  // Closed without OK: keep what was said. Throwing away a list someone just
  // dictated because the X was nearer than OK would be the worse surprise, and
  // every line is one tap to delete here.
  const handleVoiceClose = (items) => {
    if (items.length > 0) saveSpokenItems(items);
    setVoiceOpen(false);
  };

  /**
   * Rendered whether or not the modal is open, and first, so it keeps the same
   * place in the tree across both returns below. Mounting it on open would put
   * `start()` on a component React had created in that same commit — and in
   * development StrictMode then runs its unmount cleanup straight after, which
   * switches the microphone off before a word is heard.
   */
  const voiceSession = (
    <VoiceListSession
      ref={voiceSessionRef}
      open={voiceOpen}
      products={products}
      categories={categories}
      onDone={handleVoiceDone}
      onClose={handleVoiceClose}
    />
  );

  if (!isOpen) return <>{voiceSession}</>;

  const handleAdd = (e) => {
    e.preventDefault();
    if (!draft.trim()) return;
    setNotes(addNote(draft));
    setDraft('');
    inputRef.current?.focus();
  };

  const handleToggle = (id) => setNotes(toggleNote(id));
  const handleRemove = (id) => setNotes(removeNote(id));
  const handleClearChecked = () => setNotes(clearChecked());

  const checkedCount = notes.filter((n) => n.checked).length;
  const outstanding = notes.filter((n) => !n.checked);

  return (
    <>
      {voiceSession}
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex justify-center z-[200] animate-fade-in">
        <div className="bg-[#FAFAF8] w-full max-w-md h-[100dvh] flex flex-col shadow-2xl overflow-hidden relative animate-slide-up">
          {/* Handle */}
          <div className="flex-shrink-0 pt-4 pb-3 px-6 flex items-center justify-between border-b border-gray-100 bg-white z-10">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-emerald-100 rounded-xl flex items-center justify-center">
                <ClipboardList className="w-4 h-4 text-[#1B4D3E]" />
              </div>
              <span className="font-black text-gray-900 text-base">{t('header.myList')}</span>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-full hover:bg-gray-200 transition-colors cursor-pointer">
              <X className="w-5 h-5 text-gray-500" />
            </button>
          </div>

          {/* Add row */}
          <form onSubmit={handleAdd} className="flex-shrink-0 p-4 pb-3 flex items-center gap-2 bg-white border-b border-gray-100">
            <input
              ref={inputRef}
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={t('notepad.placeholder')}
              className="flex-1 min-w-0 skeuo-inset-input rounded-full py-2.5 px-4 text-sm font-medium text-[#2D2A26] placeholder-[#9A8F7C] focus:outline-none focus:ring-2 focus:ring-[#1B4D3E]/30"
            />
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={openVoiceAdd}
              className="shrink-0 w-11 h-11 rounded-full flex items-center justify-center border border-slate-200 bg-white text-[#1B4D3E] hover:bg-slate-50 transition-all active:scale-95 cursor-pointer"
              aria-label={t('notepad.voiceAdd')}
              title={t('notepad.voiceAdd')}
            >
              <Mic className="w-5 h-5" />
            </button>
            <button
              type="submit"
              disabled={!draft.trim()}
              className="skeuo-btn-emerald shrink-0 w-11 h-11 rounded-full flex items-center justify-center disabled:opacity-40 transition-all active:scale-95 cursor-pointer"
              aria-label={t('notepad.add')}
              title={t('notepad.add')}
            >
              <Plus className="w-5 h-5" />
            </button>
          </form>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-4">
            {notes.length === 0 ? (
              <div className="bg-slate-50 border border-slate-100 rounded-3xl p-8 text-center text-slate-400 animate-fade-in mt-4">
                <ClipboardList className="w-12 h-12 mx-auto mb-3 opacity-20" />
                <p className="font-bold text-sm">{t('notepad.emptyTitle')}</p>
                <p className="text-xs font-medium mt-1 opacity-70">{t('notepad.emptySub')}</p>
              </div>
            ) : (
              <div className="space-y-2">
                {notes.map((note) => (
                  <div
                    key={note.id}
                    className="flex items-center gap-3 bg-white/90 backdrop-blur-sm p-3 rounded-2xl border border-white/50 shadow-sm"
                  >
                    <button
                      type="button"
                      onClick={() => handleToggle(note.id)}
                      aria-pressed={note.checked}
                      aria-label={note.checked ? t('notepad.markUndone') : t('notepad.markDone')}
                      className={`shrink-0 w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all cursor-pointer active:scale-90 ${
                        note.checked
                          ? 'bg-[#1B4D3E] border-[#1B4D3E] text-white'
                          : 'border-slate-300 text-transparent hover:border-[#1B4D3E]'
                      }`}
                    >
                      <Check className="w-3.5 h-3.5 stroke-[3]" />
                    </button>

                    <p
                      className={`flex-1 min-w-0 text-sm font-semibold break-words ${
                        note.checked ? 'text-slate-400 line-through' : 'text-slate-800'
                      }`}
                    >
                      {note.text}
                    </p>

                    <button
                      onClick={() => handleRemove(note.id)}
                      title={t('common.delete')}
                      className="shrink-0 p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Footer: item count + clear-completed, only once there is something to clear */}
          {notes.length > 0 && (
            <div className="flex-shrink-0 px-4 py-3 border-t border-gray-100 bg-white space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-400">
                  {t('notepad.itemCount', { count: notes.length })}
                </span>
                {checkedCount > 0 && (
                  <button
                    onClick={handleClearChecked}
                    className="flex items-center gap-1.5 text-xs font-black text-[#1B4D3E] hover:underline cursor-pointer"
                  >
                    <ListChecks className="w-3.5 h-3.5" />
                    {t('notepad.clearChecked', { count: checkedCount })}
                  </button>
                )}
              </div>

              {/*
                Turns the written list into something buyable. Offered on the
                items still OUTSTANDING: a ticked line means "already got it", so
                searching the shop for it is work nobody asked for. With every
                line ticked there is nothing to find and the button is gone
                rather than sitting there promising an empty screen.
              */}
              {outstanding.length > 0 && (
                <button
                  type="button"
                  onClick={() => onBuildCart?.(outstanding)}
                  className="w-full flex items-center justify-center gap-2 bg-[#1B4D3E] text-white rounded-2xl py-3 text-sm font-black shadow-[0_6px_18px_rgba(27,77,62,0.25)] active:scale-[0.99] transition hover:bg-[#123B2F] cursor-pointer"
                >
                  <Search className="w-4 h-4" strokeWidth={2.5} />
                  {t('notepad.buildCart')}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
