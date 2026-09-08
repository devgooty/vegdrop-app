import React, { useState, useRef, useEffect } from 'react';
import { ChefHat, Send, Loader2, Check, ShoppingBasket } from 'lucide-react';
import { sendAssistantMessage, confirmAssistantOrder } from '../services/agent';
import { ApiRequestError, NetworkError } from '../services/apiClient';

/**
 * Customer cooking assistant.
 *
 * Talk about vegetables / dish names → steps → optional cart preview → confirm.
 * Orders only go through after an explicit Confirm (button or "confirm" in chat).
 */

/** Turn `**bold**` markers from the agent into real emphasis — no markdown lib. */
function formatChatText(text) {
  const parts = String(text || '').split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      return (
        <strong key={i} className="font-extrabold">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
}

export default function CookingAssistant({
  user,
  marketId,
  shopId,
  address,
  deliveryLat,
  deliveryLng,
  onOrderPlaced,
}) {
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content:
        "Hi! Name a dish (cabbage fry, aloo gobi, sambar…) or tell me which vegetables you have — I'll suggest curries and help order missing items.",
    },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [proposedOrder, setProposedOrder] = useState(null);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
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
    if (!content || busy) return;

    const nextMessages = [...messages, { role: 'user', content }];
    setMessages(nextMessages);
    setInput('');
    setError('');
    setBusy(true);

    try {
      const history = nextMessages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: m.content }));

      const data = await sendAssistantMessage({ messages: history, context });
      setMessages((prev) => [...prev, { role: 'assistant', content: data.reply, cards: data.cards }]);
      setProposedOrder(data.proposedOrder || null);
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
      setBusy(false);
    }
  };

  const handleConfirm = async () => {
    if (!proposedOrder?.proposalId || busy) return;
    setBusy(true);
    setError('');
    try {
      const placed = await confirmAssistantOrder({
        proposalId: proposedOrder.proposalId,
        address: address || user?.address,
        ...(typeof deliveryLat === 'number' && typeof deliveryLng === 'number'
          ? { lat: deliveryLat, lng: deliveryLng }
          : {}),
      });
      setProposedOrder(null);
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `Order placed ✅ ${placed.orderNumber} — ₹${placed.totalAmount}. Track it under Orders.`,
          cards: [{ type: 'order', ...placed }],
        },
      ]);
      onOrderPlaced?.();
    } catch (err) {
      setError(err?.message || 'Could not place that order.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 h-full bg-[#FAF7F2] animate-fade-in">
      <div className="shrink-0 px-4 pt-3 pb-2 border-b border-[#E8E2D6] bg-[#FAF7F2]/95">
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-xl bg-[#1B4D3E] text-white flex items-center justify-center">
            <ChefHat className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-[15px] font-black text-[#1B4D3E]">Cooking helper</h2>
            <p className="text-[11px] text-[#8A7E6B] font-semibold">Dish or veggies → steps → order</p>
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
                {formatChatText(m.content)}
                {matches.length > 0 && (
                  <ul className="mt-2 space-y-1.5">
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
                            {c.minutes} min
                            {c.matchScore != null ? ` · ${c.matchScore}% match` : ''}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {recipes.map((r) => (
                  <div
                    key={r.id}
                    className="mt-2 rounded-xl border border-emerald-100 bg-emerald-50/70 px-2.5 py-2 text-[12px] text-emerald-950"
                  >
                    <p className="font-black">
                      {r.name}
                      {r.minutes != null ? ` · ${r.minutes} min` : ''}
                    </p>
                    {Array.isArray(r.vegetables) && r.vegetables.length > 0 && (
                      <p className="mt-1 font-semibold text-emerald-800/80">
                        Need: {r.vegetables.join(', ')}
                      </p>
                    )}
                    {Array.isArray(r.steps) && r.steps.length > 0 && (
                      <ol className="mt-1.5 space-y-1 list-decimal list-inside font-medium">
                        {r.steps.map((step, si) => (
                          <li key={si}>{step}</li>
                        ))}
                      </ol>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}

        {proposedOrder && (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50/80 p-3 space-y-2 shadow-sm">
            <div className="flex items-center gap-2 text-emerald-900">
              <ShoppingBasket className="w-4 h-4" />
              <span className="text-[12.5px] font-black">Order preview</span>
            </div>
            <ul className="text-[12px] text-emerald-950 space-y-1">
              {(proposedOrder.lines || [])
                .filter((l) => l.productId)
                .map((l) => (
                  <li key={l.productId} className="flex justify-between gap-2">
                    <span>
                      {l.name} × {l.quantity}
                    </span>
                    <span className="font-bold">₹{(l.lineTotalPaise / 100).toFixed(0)}</span>
                  </li>
                ))}
            </ul>
            <p className="text-[12.5px] font-black text-emerald-950 flex justify-between">
              <span>Total</span>
              <span>₹{proposedOrder.total}</span>
            </p>
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => setProposedOrder(null)}
                disabled={busy}
                className="flex-1 py-2.5 rounded-xl border border-emerald-200 text-[12.5px] font-bold text-emerald-900"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={busy}
                className="flex-1 py-2.5 rounded-xl bg-[#1B4D3E] text-white text-[12.5px] font-bold flex items-center justify-center gap-1.5"
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                Confirm order
              </button>
            </div>
          </div>
        )}

        {busy && (
          <p className="text-[12px] text-[#8A7E6B] flex items-center gap-2 px-1">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Thinking…
          </p>
        )}
        {error && (
          <p className="text-[12px] font-bold text-red-700 bg-red-50 border border-red-100 rounded-xl px-3 py-2">
            {error}
          </p>
        )}
        <div ref={bottomRef} />
      </div>

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
          placeholder="Cabbage fry… or I have potato, tomato…"
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
    </div>
  );
}
