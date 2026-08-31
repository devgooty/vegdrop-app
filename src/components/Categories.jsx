import React from 'react';
import { Sparkles } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';
import { categoryTitle, categoryBadge } from '../i18n/catalog';

export default function Categories({ categories, onSelectCategory }) {
  const { t, language } = useLanguage();

  return (
    <section className="p-4 select-none">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h2 className="font-vintage text-lg font-bold text-[#1B4D3E] tracking-tight">{t('categories.title')}</h2>
          <span className="bg-[#EAE4D7] text-[#1B4D3E] text-[11.5px] font-bold px-2.5 py-0.5 rounded-full border border-[#D5CDBC] shadow-2xs flex items-center gap-1">
            <Sparkles className="w-3 h-3 text-[#1B4D3E]" />
            {t('categories.farmSections', { count: categories.length })}
          </span>
        </div>
      </div>

      {/* REFINED SLEEK CATEGORY GRID WITH STAGGERED ANIMATIONS */}
      <div className="grid grid-cols-2 gap-3">
        {categories.map((item, idx) => (
          <div
            key={item.id}
            onClick={() => onSelectCategory(item)}
            className="skeuo-card-interactive ripple-effect rounded-2xl p-3 flex items-center gap-3 cursor-pointer group animate-fade-in"
            style={{ animationDelay: `${idx * 100}ms` }}
          >
            {/* Category Image Frame */}
            <div className="relative flex-shrink-0">
              <div className="w-14 h-14 rounded-xl overflow-hidden p-0.5 bg-gradient-to-b from-[#FFFDF9] to-[#F3EFE6] border border-[#DCD5C6] shadow-xs">
                <img
                  src={item.imageUrl}
                  alt={categoryTitle(item, language)}
                  className="w-full h-full object-cover rounded-lg group-hover:scale-105 transition-transform duration-300"
                  onError={(e) => {
                    e.target.src = 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=150';
                  }}
                />
              </div>
            </div>

            {/* Title, Badge & CTA */}
            <div className="flex flex-col justify-center min-w-0 flex-1">
              <div className="flex items-center gap-1.5 mb-0.5">
                <h3 className="font-vintage font-bold text-sm text-[#23201C] leading-tight truncate group-hover:text-[#1B4D3E] transition-colors">
                  {categoryTitle(item, language)}
                </h3>
              </div>

              {/* Deliberately NOT whitespace-nowrap. On a 375px screen this
                  column is 71px wide, and measured against Figtree the badge
                  needs 80px and "Explore harvest ›" needs 84px even at 10.5px —
                  neither has ever fitted on one line at that width, before or
                  after the type ramp. nowrap does not buy a single line here,
                  it only swaps a legible two-line wrap for a clipped one. */}
              {item.badge && (
                <span className="inline-block text-[10.5px] font-bold text-[#1B4D3E] bg-[#EAE4D7] px-1.5 py-0.2 rounded-md border border-[#D5CDBC] w-fit mb-1">
                  {categoryBadge(item.badge, language)}
                </span>
              )}

              <span className="text-[#23201C] font-extrabold text-[12.5px] flex items-center gap-0.5 group-hover:underline">
                {t('categories.explore')} <span className="text-xs font-black">›</span>
              </span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
