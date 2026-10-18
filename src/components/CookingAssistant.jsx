import React, { useState, useRef, useEffect } from 'react';
import { ChefHat, Send, Loader2, Check, ShoppingBasket, ShoppingCart } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';
import { sendAssistantMessage, confirmAssistantOrder } from '../services/agent';
import { ApiRequestError, NetworkError } from '../services/apiClient';
import useAssistantChat, { updateAssistantChat, historyForServer, liveProposal } from '../hooks/useAssistantChat';

/**
 * Customer cooking assistant.
 *
 * Talk about vegetables / dish names → steps → optional cart preview → confirm.
 * Orders only go through after an explicit Confirm (button or "confirm" in chat).
 *
 * The conversation is held by `useAssistantChat`, not here: this component is
 * unmounted on every tab switch, and state kept in it was wiped each time.
 */

/** Turn `**bold**` and `*italic*` markers from the agent into real emphasis — no markdown lib. */
function formatChatText(text) {
  const parts = String(text || '').split(/(\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g);
  return parts.map((part, i) => {
    if (/^\*\*[^*\n]+\*\*$/.test(part)) {
      return (
        <strong key={i} className="font-extrabold">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (/^\*[^*\n]+\*$/.test(part)) {
      return (
        <em key={i} className="font-semibold not-italic text-emerald-800">
          {part.slice(1, -1)}
        </em>
      );
    }
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
}

/** Paise to rupees, showing paise only when there are any — so the lines add up to the total. */
function rupees(paise) {
  const n = Number(paise) || 0;
  return n % 100 === 0 ? String(n / 100) : (n / 100).toFixed(2);
}

const FRACTIONS = { 0.25: '¼', 0.5: '½', 0.75: '¾' };

/** 0.5 → "½", 1.25 → "1¼", 3 → "3". */
function niceQty(n) {
  if (n == null || !Number.isFinite(Number(n))) return '';
  const whole = Math.floor(n);
  const frac = Math.round((n - whole) * 100) / 100;
  const f = FRACTIONS[frac];
  if (f) return whole ? `${whole}${f}` : f;
  return String(Math.round(n * 100) / 100);
}

function ingredientAmount(ing) {
  if (ing.produce) return ing.unit === 'kg' ? `${ing.quantity} kg` : `${ing.quantity} g`;
  if (ing.unit === 'to taste') return 'to taste';
  const q = niceQty(ing.quantity);
  return q ? `${q} ${ing.unit}` : ing.unit;
}

const STARTERS = ['Gutti vankaya', 'Aloo gobi for 4', 'I have potato and beans', 'How to stop bhindi getting sticky'];

function RecipeCard({ r }) {
  const produce = (r.ingredients || []).filter((i) => i.produce);
  const pantry = (r.ingredients || []).filter((i) => i.pantry);
  return (
    <div className="mt-2 rounded-xl border border-emerald-100 bg-emerald-50/70 px-3 py-2.5 text-[12px] text-emerald-950 whitespace-normal">
      <p className="font-black text-[13px] leading-tight">{r.name}</p>
      <p className="mt-0.5 text-[11px] font-semibold text-emerald-800/80">
        {[r.minutes != null ? `${r.minutes} min` : null, r.servings ? `serves ${r.servings}` : null, r.cuisine, r.vegan ? 'vegan' : null]
          .filter(Boolean)
          .join(' · ')}
      </p>

      {produce.length > 0 && (
        <>
          <p className="mt-2 text-[11px] font-black uppercase tracking-wide text-emerald-900/70">Vegetables</p>
          <ul className="mt-0.5 space-y-0.5">
            {produce.map((i, k) => (
              <li key={`p${k}`} className="flex justify-between gap-2">
                <span className="font-semibold">
                  {i.name}
                  {i.prep ? <span className="font-medium text-emerald-800/70"> — {i.prep}</span> : null}
                  {i.optional ? <span className="font-medium text-emerald-800/70"> (optional)</span> : null}
                </span>
                <span className="shrink-0 font-bold">{ingredientAmount(i)}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {pantry.length > 0 && (
        <>
          <p className="mt-2 text-[11px] font-black uppercase tracking-wide text-emerald-900/70">From your kitchen</p>
          <ul className="mt-0.5 space-y-0.5">
            {pantry.map((i, k) => (
              <li key={`k${k}`} className="flex justify-between gap-2">
                <span className="font-medium">
                  {i.name}
                  {i.optional ? <span className="text-emerald-800/70"> (optional)</span> : null}
                </span>
                <span className="shrink-0 font-semibold">{ingredientAmount(i)}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {Array.isArray(r.steps) && r.steps.length > 0 && (
        <>
          <p className="mt-2 text-[11px] font-black uppercase tracking-wide text-emerald-900/70">Steps</p>
          <ol className="mt-0.5 space-y-1 list-decimal pl-4 font-medium">
            {r.steps.map((step, si) => (
              <li key={si}>{step}</li>
            ))}
          </ol>
        </>
      )}

      {Array.isArray(r.tips) && r.tips.length > 0 && (
        <div className="mt-2 rounded-lg bg-amber-50 border border-amber-100 px-2 py-1.5 text-amber-950">
          {r.tips.map((tip, ti) => (
            <p key={ti} className="font-medium">
              💡 {tip}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

export default function CookingAssistant({
  user,
  marketId,
  shopId,
  address,
  deliveryLat,
  deliveryLng,
  onOrderPlaced,
  onRequireSignIn,
  onAddToCart,
  onCartFilled,
  opener,
  onOpenerTaken,
}) {
  const { t } = useLanguage();
  const userId = user?.id;
  const chat = useAssistantChat(userId);
  const { messages, busy } = chat;
  const proposedOrder = liveProposal(chat.proposedOrder);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const bottomRef = useRef(null);
  const hasScrolledRef = useRef(false);

  useEffect(() => {
    // Jump straight to the latest message when coming back to the tab; only
    // animate for messages that arrive while it is open. A smooth scroll on
    // mount would visibly sweep through the whole conversation on every visit.
    bottomRef.current?.scrollIntoView({ behavior: hasScrolledRef.current ? 'smooth' : 'auto' });
    hasScrolledRef.current = true;
  }, [messages, proposedOrder, busy]);

  const context = {
    ...(marketId ? { marketId } : {}),
    ...(shopId ? { shopId } : {}),
    ...(address ? { address } : {}),
    paymentMethod: 'cod',
    ...(typeof deliveryLat === 'number' && typeof deliveryLng === 'number'
      ? { lat: deliveryLat, lng: deliveryLng }
      : {}),
  };

  const send = async (text) => {
    const content = String(text || '').trim();
    if (!content || busy || !userId) return;

    const nextMessages = [...messages, { role: 'user', content }];
    updateAssistantChat(userId, () => ({ messages: nextMessages, busy: true }), { claim: true });
    setInput('');
    setError('');

    try {
      const data = await sendAssistantMessage({ messages: historyForServer(nextMessages), context });
      updateAssistantChat(userId, (prev) => ({
        messages: [...prev.messages, { role: 'assistant', content: data.reply, cards: data.cards }],
        proposedOrder: data.proposedOrder || null,
      }));
      if (data.cards?.some((c) => c.type === 'order')) {
        onOrderPlaced?.();
      }
    } catch (err) {
      const msg =
        err instanceof NetworkError
          ? 'No connection. Check your network and try again.'
          : err instanceof ApiRequestError
            ? err.message
            : 'Something went wrong. Please try again.';
      setError(msg);
    } finally {
      updateAssistantChat(userId, () => ({ busy: false }));
    }
  };

  const handleConfirm = async () => {
    if (!proposedOrder?.proposalId || busy || !userId) return;
    updateAssistantChat(userId, () => ({ busy: true }), { claim: true });
    setError('');
    try {
      const placed = await confirmAssistantOrder({
        proposalId: proposedOrder.proposalId,
        address: address || user?.address,
        ...(typeof deliveryLat === 'number' && typeof deliveryLng === 'number'
          ? { lat: deliveryLat, lng: deliveryLng }
          : {}),
      });
      updateAssistantChat(userId, (prev) => ({
        proposedOrder: null,
        messages: [
          ...prev.messages,
          {
            role: 'assistant',
            content: `Order placed ✅ ${placed.orderNumber} — ₹${placed.totalAmount}. Track it under Orders.`,
            cards: [{ type: 'order', ...placed }],
          },
        ],
      }));
      onOrderPlaced?.();
    } catch (err) {
      setError(err?.message || 'Could not place that order.');
    } finally {
      updateAssistantChat(userId, () => ({ busy: false }));
    }
  };

  /**
   * The helper's basket into the real cart, and the cart opened over it.
   *
   * This is where the conversation hands control back. Up to here the helper
   * has been asking and deciding; from here the shopper checks the cart and
   * goes to payment, which is the existing flow and not something the helper
   * should be driving. So it adds, says what it added — and what it could not,
   * because a line silently dropped is one the shopper discovers at the door —
   * and opens the cart.
   *
   * No order is placed. `handleConfirm` above is still the path for "order it
   * now without looking", which the server also reaches when the customer types
   * "confirm"; this one stops at a full cart.
   */
  const handleAddLinesToCart = () => {
    if (!proposedOrder || busy || !userId || !onAddToCart) return;
    setError('');

    const { added, missing } = onAddToCart(proposedOrder.lines || []);

    const message =
      added.length === 0
        ? t('assistant.addedNothing')
        : missing.length > 0
          ? t('assistant.addedSome', { items: added.join(', '), missing: missing.join(', ') })
          : t('assistant.addedToCart', { items: added.join(', ') });

    updateAssistantChat(
      userId,
      (prev) => ({
        // The preview is spent either way: its lines are in the cart now, and
        // leaving it on screen would invite a second tap that doubled them.
        proposedOrder: null,
        messages: [...prev.messages, { role: 'assistant', content: message }],
      }),
      { claim: true }
    );

    // Only when something actually landed. Opening an empty cart over a message
    // explaining that nothing could be added is two contradictory answers.
    if (added.length > 0) onCartFilled?.();
  };

  /**
   * A question the home card asked for the shopper. Sent once, then cleared by
   * the parent — the chat unmounts on every tab switch, so a prop left in place
   * would re-ask it each time they came back.
   */
  useEffect(() => {
    if (!opener || !userId || busy) return;
    onOpenerTaken?.();
    send(opener);
    // `send` and `busy` are read at call time; re-running on either would
    // re-send the question the moment the reply landed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opener, userId]);

  return (
    <div className="flex flex-col flex-1 min-h-0 h-full bg-[#FAF7F2] animate-fade-in">
      <div className="shrink-0 px-4 pt-safe-3 pb-2 border-b border-[#E8E2D6] bg-[#FAF7F2]/95">
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-xl bg-[#1B4D3E] text-white flex items-center justify-center">
            <ChefHat className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-[15px] font-black text-[#1B4D3E]">{t('assistant.title')}</h2>
            <p className="text-[11px] text-[#8A7E6B] font-semibold">{t('assistant.subtitle')}</p>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 py-3 space-y-3">
        {messages.map((m, i) => {
          const matches = m.cards?.filter((c) => c.type === 'recipe_match') || [];
          const recipes = m.cards?.filter((c) => c.type === 'recipe') || [];
          return (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[88%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap ${
                  m.role === 'user'
                    ? 'bg-[#1B4D3E] text-white rounded-br-md'
                    : 'bg-white border border-[#E8E2D6] text-[#1F2937] rounded-bl-md shadow-sm'
                }`}
              >
                {/* The opener is the one line the app wrote rather than the
                    model, so it is the one line that has to follow the language
                    setting — including a change made after the chat started. */}
                {formatChatText(m.greeting ? t('assistant.greeting') : m.content)}
                {matches.length > 0 && (
                  <ul className="mt-2 space-y-1.5 whitespace-normal">
                    {matches.map((c) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => send(String(c.index))}
                          className="w-full text-left text-[12px] font-bold px-2.5 py-2 rounded-xl bg-emerald-50 border border-emerald-100 text-emerald-900 hover:bg-emerald-100"
                        >
                          {c.index}. {c.name}
                          <span className="block font-semibold text-emerald-700/80 text-[11px]">
                            {[c.minutes != null ? `${c.minutes} min` : null, c.cuisine].filter(Boolean).join(' · ')}
                            {Array.isArray(c.missing) && c.missing.length > 0 ? ` · also needs ${c.missing.join(', ')}` : ''}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {recipes.map((r) => (
                  <RecipeCard key={r.id} r={r} />
                ))}
              </div>
            </div>
          );
        })}

        {proposedOrder && (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50/80 p-3 space-y-2 shadow-sm">
            <div className="flex items-center gap-2 text-emerald-900">
              <ShoppingBasket className="w-4 h-4" />
              <span className="text-[12.5px] font-black">{t('assistant.basketTitle')}</span>
            </div>
            <ul className="text-[12px] text-emerald-950 space-y-1">
              {(proposedOrder.lines || [])
                .filter((l) => l.productId)
                .map((l) => (
                  <li key={l.productId} className="flex justify-between gap-2">
                    <span>
                      {l.name} × {l.quantity}
                      {l.weight ? <span className="text-emerald-800/70"> ({l.weight})</span> : null}
                      {l.lowStock ? <span className="text-amber-700 font-bold"> · low stock</span> : null}
                    </span>
                    <span className="font-bold">₹{rupees(l.lineTotalPaise)}</span>
                  </li>
                ))}
            </ul>
            {proposedOrder.deliveryFeePaise > 0 && (
              <p className="text-[11.5px] text-emerald-900 flex justify-between">
                <span>{t('assistant.deliveryFee')}</span>
                <span>₹{rupees(proposedOrder.deliveryFeePaise)}</span>
              </p>
            )}
            {(proposedOrder.lines || []).some((l) => l.missingFromCatalog) && (
              <p className="text-[11.5px] text-amber-800">
                Not available right now:{' '}
                {proposedOrder.lines
                  .filter((l) => l.missingFromCatalog)
                  .map((l) => l.name)
                  .join(', ')}
              </p>
            )}
            {proposedOrder.alreadyHave?.length > 0 && (
              <p className="text-[11.5px] text-emerald-800/80">Left out (you have): {proposedOrder.alreadyHave.join(', ')}</p>
            )}
            {proposedOrder.fromYourKitchen?.length > 0 && (
              <p className="text-[11.5px] text-emerald-800/80">From your kitchen: {proposedOrder.fromYourKitchen.join(', ')}</p>
            )}
            <p className="text-[12.5px] font-black text-emerald-950 flex justify-between">
              <span>{t('assistant.total')}</span>
              <span>₹{rupees(proposedOrder.totalPaise)}</span>
            </p>
            {/*
              Adding to the cart is the primary act, not placing the order.

              The shopper gets to see the helper's work in the basket they
              already know, change it, and start the payment flow that every
              other route into checkout uses — rather than the helper buying on
              their behalf from a preview. "Order now" is kept, quieter, because
              the server still honours a typed "confirm" and a screen that
              offered no such button while the chat accepted the word would be
              two different answers to the same question.
            */}
            <div className="pt-1 space-y-2">
              <button
                type="button"
                onClick={handleAddLinesToCart}
                disabled={busy}
                className="w-full py-3 rounded-xl bg-[#1B4D3E] text-white text-[13px] font-black flex items-center justify-center gap-1.5 disabled:opacity-60"
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShoppingCart className="w-4 h-4" />}
                {t('assistant.addToCart')}
              </button>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => updateAssistantChat(userId, () => ({ proposedOrder: null }), { claim: true })}
                  disabled={busy}
                  className="flex-1 py-2.5 rounded-xl border border-emerald-200 text-[12.5px] font-bold text-emerald-900 disabled:opacity-60"
                >
                  {t('assistant.cancel')}
                </button>
                <button
                  type="button"
                  onClick={handleConfirm}
                  disabled={busy}
                  className="flex-1 py-2.5 rounded-xl border border-emerald-300 bg-white/70 text-[12.5px] font-bold text-emerald-900 flex items-center justify-center gap-1.5 disabled:opacity-60"
                >
                  <Check className="w-3.5 h-3.5" />
                  {t('assistant.orderNow')}
                </button>
              </div>
            </div>
          </div>
        )}

        {busy && (
          <p className="text-[12px] text-[#8A7E6B] flex items-center gap-2 px-1">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> {t('assistant.thinking')}
          </p>
        )}
        {error && (
          <p className="text-[12px] font-bold text-red-700 bg-red-50 border border-red-100 rounded-xl px-3 py-2">
            {error}
          </p>
        )}
        <div ref={bottomRef} />
      </div>

      {userId && messages.length <= 1 && !busy && (
        <div className="shrink-0 px-3 pt-2 flex flex-wrap gap-1.5">
          {STARTERS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => send(s)}
              className="text-[11.5px] font-bold px-2.5 py-1.5 rounded-full bg-white border border-[#DCD5C6] text-[#1B4D3E] hover:bg-emerald-50"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {!userId ? (
        <div className="shrink-0 p-3 border-t border-[#E8E2D6] bg-[#FAF7F2] flex items-center gap-2">
          <p className="flex-1 text-[12.5px] font-semibold text-[#5C5343]">{t('assistant.signInPrompt')}</p>
          <button
            type="button"
            onClick={() => onRequireSignIn?.()}
            className="shrink-0 px-4 py-2.5 rounded-xl bg-[#1B4D3E] text-white text-[12.5px] font-bold"
          >
            Sign in
          </button>
        </div>
      ) : (
      <form
        className="shrink-0 p-3 border-t border-[#E8E2D6] bg-[#FAF7F2] flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={busy ? t('assistant.working') : t('assistant.placeholder')}
          /* The input is closed while the helper is explaining, asking or
             putting things in the cart, and opens again the moment it is done —
             a reply sent into the middle of a turn arrives as the answer to the
             question before last. `busy` lives in the store, not here, so
             leaving the tab mid-reply and coming back still shows it closed. */
          disabled={busy}
          className="flex-1 min-w-0 bg-white border border-[#DCD5C6] rounded-xl px-3.5 py-3 text-[13px] outline-none focus:border-[#1B4D3E]"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="w-11 h-11 shrink-0 rounded-xl bg-[#1B4D3E] text-white flex items-center justify-center disabled:opacity-50"
          aria-label="Send"
        >
          <Send className="w-4 h-4" />
        </button>
      </form>
      )}
    </div>
  );
}
