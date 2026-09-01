import React from 'react';
import { X, Mic, Pencil } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';

/**
 * What tapping the header's list button opens first.
 *
 * Neither option is a separate feature — both land on the same NotepadModal,
 * just started in a different mode ('voice' immediately opens the mic,
 * 'write' focuses the text field). This sheet exists only to ask which one
 * before that modal opens, rather than the modal opening straight onto a
 * keyboard for someone who meant to speak the list.
 */
export default function NotepadChooser({ onChoose, onClose }) {
  const { t } = useLanguage();

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-end sm:items-center justify-center z-[200] animate-fade-in">
      <div className="bg-white rounded-t-[2rem] sm:rounded-[2rem] w-full sm:max-w-sm p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom,0px))] shadow-2xl border border-gray-100 animate-scale-in">
        <div className="flex items-start justify-between mb-1">
          <div>
            <h3 className="font-black text-[#1B4D3E] text-base">{t('notepad.chooserTitle')}</h3>
            <p className="text-[0.8rem] font-semibold text-slate-400 mt-0.5">{t('notepad.chooserSubtitle')}</p>
          </div>
          <button
            onClick={onClose}
            aria-label={t('common.close')}
            className="shrink-0 p-1.5 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3 mt-4">
          <button
            type="button"
            onClick={() => onChoose('voice')}
            className="flex flex-col items-center gap-3 rounded-3xl bg-gradient-to-b from-sky-50 to-sky-100/60 border border-sky-100 py-6 active:scale-95 transition-transform cursor-pointer"
          >
            <span className="w-14 h-14 rounded-full bg-white shadow-[0_4px_12px_rgba(14,116,224,0.18)] flex items-center justify-center">
              <Mic className="w-6 h-6 text-sky-600" strokeWidth={2.25} />
            </span>
            <span className="font-black text-slate-700 text-sm">{t('notepad.sayIt')}</span>
          </button>

          <button
            type="button"
            onClick={() => onChoose('write')}
            className="flex flex-col items-center gap-3 rounded-3xl bg-gradient-to-b from-emerald-50 to-emerald-100/60 border border-emerald-100 py-6 active:scale-95 transition-transform cursor-pointer"
          >
            <span className="w-14 h-14 rounded-full bg-white shadow-[0_4px_12px_rgba(16,122,87,0.18)] flex items-center justify-center">
              <Pencil className="w-6 h-6 text-[#1B4D3E]" strokeWidth={2.25} />
            </span>
            <span className="font-black text-slate-700 text-sm">{t('notepad.writeIt')}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
