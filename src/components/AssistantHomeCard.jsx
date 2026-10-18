import React from 'react';
import { ChefHat, ArrowRight, Carrot, CookingPot } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';

/**
 * The cooking helper's own greeting, on the home screen.
 *
 * The helper used to be reachable only by finding its bottom-nav tab, so the
 * first thing it ever said was said to people who had already gone looking for
 * it. This card is the other direction: it greets the shopper where they land,
 * in the language they chose, and names the two things it can actually do.
 *
 * The greeting is translated rather than written in English for everyone,
 * because a greeting is the one string where the wrong language is actively
 * unwelcoming — "Hello!" to someone who picked Telugu reads as the app not
 * having listened. `LANGUAGES` governs it the same way it governs the rest of
 * the chrome; what the helper then *replies* is the model's business, and it
 * answers in whatever language the customer writes in.
 *
 * Each prompt opens the chat with that question already asked, rather than
 * dropping the shopper at an empty box: a blank chat and a blinking cursor is
 * the state people close. `onAsk` is given the prompt text to send, and `onOpen`
 * is the plain "open it, I'll type my own thing" path.
 */
export default function AssistantHomeCard({ onOpen, onAsk }) {
  const { t } = useLanguage();

  const prompts = [
    { key: 'assistant.askVeggies', icon: Carrot },
    { key: 'assistant.askCook', icon: CookingPot },
  ];

  return (
    <section className="mx-4 mt-3 rounded-[1.75rem] bg-gradient-to-br from-[#1B4D3E] to-[#15402F] text-white p-4 shadow-[0_10px_28px_-12px_rgba(27,77,62,0.65)]">
      <button
        type="button"
        onClick={onOpen}
        className="w-full flex items-center gap-3 text-left cursor-pointer"
      >
        <span className="w-11 h-11 shrink-0 rounded-2xl bg-white/15 flex items-center justify-center">
          <ChefHat className="w-5 h-5" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-[15.5px] font-black leading-tight">{t('assistant.hello')}</span>
          <span className="block text-[12px] font-semibold text-white/80 leading-snug mt-0.5">
            {t('assistant.homeIntro')}
          </span>
        </span>
        <ArrowRight className="w-4.5 h-4.5 shrink-0 text-white/70" />
      </button>

      {/* The two questions the helper would otherwise have to ask first. Tapping
          one is the shopper answering it, so the chat opens mid-conversation
          rather than at a greeting they have already read here. */}
      <div className="mt-3 space-y-2">
        {prompts.map(({ key, icon: Icon }) => (
          <button
            key={key}
            type="button"
            /* The key, not `t(key)`: the chat re-renders it in whatever
               language is current, so changing language later moves it. */
            onClick={() => onAsk(key)}
            className="w-full flex items-center gap-2.5 text-left rounded-2xl bg-white/10 hover:bg-white/15 border border-white/10 px-3 py-2.5 transition-colors cursor-pointer active:scale-[0.99]"
          >
            <Icon className="w-4 h-4 shrink-0 text-emerald-200" />
            <span className="flex-1 min-w-0 text-[12.5px] font-bold leading-snug">{t(key)}</span>
            <ArrowRight className="w-3.5 h-3.5 shrink-0 text-white/50" />
          </button>
        ))}
      </div>
    </section>
  );
}
