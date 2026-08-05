import React from 'react';
import { Search, CornerDownLeft, LayoutGrid } from 'lucide-react';

/**
 * The suggestion panel under the header search box.
 *
 * Presentation only — the option list, the active index and what a pick means
 * all live in Header, because the keyboard handler has to own that state and
 * splitting it across two components is how a highlighted row and the row Enter
 * actually picks end up disagreeing.
 *
 * Rows are `role="option"` inside a listbox the input owns via
 * aria-activedescendant. That is the reason the rows are divs rather than
 * buttons: a focusable control inside the popup would pull focus off the input
 * and break typing mid-selection.
 */
export default function SearchSuggestions({
  options,
  activeIndex,
  listboxId,
  optionIdPrefix,
  onPick,
  onHoverOption,
}) {
  if (options.length === 0) return null;

  return (
    <div
      className="absolute left-0 right-0 top-full z-50 mt-1 max-h-[min(60vh,26rem)] overflow-y-auto overscroll-contain rounded-2xl border border-[#DCD5C6] bg-[#FFFDF9] shadow-[0_12px_28px_-8px_rgba(45,38,25,0.28)] animate-fade-in"
      // Pointer-down rather than click is what stops the input blurring before
      // the pick lands — blur closes the panel, and the click would then be
      // delivered to whatever the page moved under the cursor.
      onMouseDown={(e) => e.preventDefault()}
    >
      <ul id={listboxId} role="listbox" aria-label="Search suggestions" className="py-1.5">
        {options.map((option, index) => (
          <li
            key={option.id}
            id={`${optionIdPrefix}${index}`}
            role="option"
            aria-selected={index === activeIndex}
            onMouseEnter={() => onHoverOption(index)}
            onClick={() => onPick(option)}
            className={`flex cursor-pointer items-center gap-3 px-3 py-2 transition-colors ${
              index === activeIndex ? 'bg-[#EAE4D7]' : 'hover:bg-[#F3EFE6]'
            }`}
          >
            <OptionIcon option={option} />

            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold text-[#2D2A26]">
                {option.kind === 'query' ? (
                  <>
                    Search for <span className="font-extrabold text-[#1B4D3E]">“{option.label}”</span>
                  </>
                ) : (
                  <Highlighted text={option.label} match={option.match} />
                )}
              </p>
              <p className="mt-0.5 truncate text-[10px] font-bold uppercase tracking-wider text-[#9A8F7C]">
                {describe(option)}
              </p>
            </div>

            {index === activeIndex && (
              <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-[#8A7E6B]" aria-hidden="true" />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function describe(option) {
  if (option.kind === 'category') {
    return `Section · ${option.count} ${option.count === 1 ? 'item' : 'items'}`;
  }
  if (option.kind === 'term') {
    // One match opens that item's page, so the row says what it costs rather
    // than counting to one — "1 option" told the shopper nothing they wanted.
    if (option.count === 1) {
      const [product] = option.products;
      return [product.weight, product.price != null ? `₹${product.price}` : null]
        .filter(Boolean)
        .join(' · ');
    }
    return `${option.count} options`;
  }
  return 'See all matches';
}

function OptionIcon({ option }) {
  const thumbnail =
    option.kind === 'category' ? option.category?.imageUrl : option.products?.[0]?.image;

  if (thumbnail) {
    return (
      <div className="h-9 w-9 shrink-0 overflow-hidden rounded-xl border border-[#E5DFD1] bg-[#F3EFE6] shadow-inner">
        <img
          src={thumbnail}
          alt=""
          aria-hidden="true"
          loading="lazy"
          className="h-full w-full object-cover"
          onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
        />
      </div>
    );
  }

  const Icon = option.kind === 'category' ? LayoutGrid : Search;
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#E5DFD1] bg-[#F3EFE6] text-[#8A7E6B]">
      <Icon className="h-4 w-4" aria-hidden="true" />
    </div>
  );
}

/**
 * Bold the part of the label the shopper has already typed.
 *
 * Located on the raw label with a case-insensitive indexOf rather than on the
 * normalised form: normalisation collapses punctuation, so its offsets do not
 * map back onto the original string and the emphasis would land a character or
 * two off on any name containing a bracket or a slash. No match found simply
 * means no emphasis — never a crash and never a mangled label.
 */
function Highlighted({ text, match }) {
  const at = match ? text.toLowerCase().indexOf(match.toLowerCase()) : -1;
  if (at === -1) return <>{text}</>;

  return (
    <>
      {text.slice(0, at)}
      <span className="font-extrabold text-[#1B4D3E]">{text.slice(at, at + match.length)}</span>
      {text.slice(at + match.length)}
    </>
  );
}
