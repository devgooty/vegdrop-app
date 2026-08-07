import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Store, Clock, Package, CheckCircle2, Zap, LogOut, RefreshCw,
  AlertTriangle, ShoppingBasket, Timer, Check, Wallet, Lock,
  Plus, Search, X, Camera, Trash2, Boxes,
} from 'lucide-react';
import { useToast } from './Toast';
import {
  fetchStallOrders, claimLines, declineOffer, packOrder, updateMyStall, secondsLeft, formatPaise,
  fetchEarnings, withdrawEarnings, timeUntil,
  fetchStallStock, saveStallInventory, saveFreshPhoto, removeFreshPhoto,
} from '../services/stalls';
import { toUploadableJpeg, approximateKb } from '../services/imageCapture';

/**
 * The stall screen.
 *
 * A shopkeeper sees two things: offers addressed to them right now, and the
 * work they have already committed to. Nothing else — no customer name, no phone
 * number, no delivery address. The server does not send those to a stall, and
 * this screen would have nowhere to put them.
 *
 * An offer here is a genuine question, not a race. The server picks the stalls
 * that can cover the most of an order and asks each about its own slice, so the
 * lines on a card are reserved for this stall for the length of the countdown.
 * Declining hands them straight to the next stall rather than making everyone
 * wait out the clock. The exception is an offer flagged `openPool`, where the
 * ranking has been exhausted and it really is first-come.
 *
 * The whole thing is driven by one polled endpoint on the same five-second
 * cycle the rest of the app already uses, so a new offer appears within five
 * seconds with no push infrastructure behind it.
 */
export default function StallPanel({ user, stall: initialStall, onLogout }) {
  const toast = useToast();

  const [stall, setStall] = useState(initialStall);
  const [offers, setOffers] = useState([]);
  const [packing, setPacking] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyOrder, setBusyOrder] = useState(null);
  const [earnings, setEarnings] = useState(null);
  const [withdrawing, setWithdrawing] = useState(false);

  /**
   * What this stall is holding, and everything the market prices that it could
   * hold. One list serves both: `stock > 0` is the table, the rest is the
   * picker.
   */
  const [stock, setStock] = useState([]);
  /** The product being added or edited in the sheet, or null when it is shut. */
  const [editing, setEditing] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  /** Per-order line selection, so a stall can take part of an order. */
  const [selection, setSelection] = useState({});

  // Ticks once a second purely to move the countdowns; the data itself is
  // refreshed by the poll below.
  const [, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [data, money, table] = await Promise.all([
        fetchStallOrders(),
        // Earnings move on a much slower clock than offers, but folding them
        // into the same poll keeps the screen to one request cycle.
        fetchEarnings().catch(() => null),
        // Stock changes only when this shopkeeper changes it — except for the
        // price, which the market owner can move at any moment. Polling it is
        // how a stall finds out their tomatoes are now ₹65.
        fetchStallStock().catch(() => null),
      ]);
      setOffers(data.offers);
      setPacking(data.packing);
      setStall((prev) => ({ ...prev, ...data.stall }));
      if (money) setEarnings(money);
      if (table) setStock(table);
    } catch (err) {
      // Transient; the next tick retries. Only surfaced on the first load.
      if (loading) toast.error(err.message || 'Could not load your stall.');
    } finally {
      setLoading(false);
    }
  }, [loading, toast]);

  const handleWithdraw = async () => {
    setWithdrawing(true);
    try {
      const result = await withdrawEarnings();
      toast.success(`${formatPaise(result.paidPaise)} moved to your wallet 💰`);
      setEarnings(result);
    } catch (err) {
      toast.error(err.message || 'Could not withdraw right now.');
    } finally {
      setWithdrawing(false);
    }
  };

  /** What is actually on the table right now. */
  const held = useMemo(() => stock.filter((p) => p.stock > 0), [stock]);

  /**
   * Save one row of stock, and its photo if one was taken.
   *
   * The inventory endpoint upserts per product, so sending a single row leaves
   * every other line alone — which is what lets the sheet add one product at a
   * time instead of resubmitting the whole table.
   *
   * The photo is a separate request on purpose: it is optional, it is two
   * orders of magnitude larger, and a failed photo must not lose the stock
   * figure the shopkeeper just typed.
   */
  const handleSaveStock = async ({ productId, quantity, photo, removePhoto }) => {
    await saveStallInventory([{ productId, stock: quantity }]);

    if (photo) {
      try {
        await saveFreshPhoto(productId, photo);
      } catch (err) {
        toast.warning(`Stock saved, but the photo did not upload: ${err.message}`);
        await refresh();
        return;
      }
    } else if (removePhoto) {
      await removeFreshPhoto(productId).catch(() => {});
    }

    toast.success(quantity > 0 ? 'Stock updated 🧺' : 'Taken off your table');
    await refresh();
  };

  /** Poll, pausing while the tab is hidden — same pattern as the other apps. */
  useEffect(() => {
    refresh();
    const poll = () => {
      if (!document.hidden) refresh();
    };
    const interval = setInterval(poll, 5000);
    document.addEventListener('visibilitychange', poll);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', poll);
    };
    // `refresh` is stable enough here; re-subscribing every render would reset
    // the interval on each poll and effectively busy-loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleLine = (orderId, lineId) => {
    setSelection((prev) => {
      const current = new Set(prev[orderId] || []);
      if (current.has(lineId)) current.delete(lineId);
      else current.add(lineId);
      return { ...prev, [orderId]: [...current] };
    });
  };

  const selectedFor = (order) => {
    const chosen = selection[order.id];
    // Nothing ticked means "everything still going" — the common case is a
    // stall that can fill the whole order and just wants to hit accept.
    if (!chosen || chosen.length === 0) return order.openLines.map((l) => l.lineId);
    return chosen;
  };

  const handleAccept = async (order) => {
    const lineIds = selectedFor(order);
    if (lineIds.length === 0) return;

    setBusyOrder(order.id);
    try {
      const result = await claimLines(order.id, lineIds);

      if (result.lost.length > 0) {
        toast.warning(`Took ${result.won.length}. Another stall got ${result.lost.length} first.`);
      } else if (result.locked) {
        toast.success('Order complete — start packing 📦');
      } else {
        toast.success(`Accepted ${result.won.length} item${result.won.length === 1 ? '' : 's'} ✅`);
      }

      setSelection((prev) => ({ ...prev, [order.id]: [] }));
      await refresh();
    } catch (err) {
      const message =
        err.code === 'ALREADY_TAKEN'
          ? 'Another stall took those first.'
          : err.code === 'NOT_OFFERED'
            ? 'That offer has moved on to another stall.'
            : err.code === 'NOT_SOURCING'
              ? 'That order has already moved on.'
              : err.code === 'STALL_CLOSED'
                ? 'Your stall is closed. Open it to accept orders.'
                : err.message || 'Could not accept.';
      toast.error(message);
      await refresh();
    } finally {
      setBusyOrder(null);
    }
  };

  /**
   * Say no now rather than letting the clock run out.
   *
   * Both amount to the same thing for this stall — the order goes elsewhere and
   * will not be offered again — but declining promptly is worth a couple of
   * minutes to the customer, so it is worth making it a real button.
   */
  const handleDecline = async (order) => {
    setBusyOrder(order.id);
    try {
      await declineOffer(order.id);
      toast.info('Passed on. It has gone to another stall.');
      await refresh();
    } catch (err) {
      toast.error(err.code === 'NOT_YOURS' ? 'That offer already moved on.' : err.message || 'Could not pass.');
      await refresh();
    } finally {
      setBusyOrder(null);
    }
  };

  const handlePack = async (order) => {
    setBusyOrder(order.id);
    try {
      await packOrder(order.id);
      toast.success('Marked packed. The rider has been told 🚴');
      await refresh();
    } catch (err) {
      toast.error(err.message || 'Could not mark as packed.');
      await refresh();
    } finally {
      setBusyOrder(null);
    }
  };

  const handleToggle = async (field, value) => {
    // Optimistic: these are switches, and a laggy toggle feels broken.
    setStall((prev) => ({ ...prev, [field]: value }));
    try {
      const updated = await updateMyStall({ [field]: value });
      setStall((prev) => ({ ...prev, ...updated }));

      if (field === 'autoAccept' && value && updated.declaredLines === 0) {
        toast.warning('Auto-accept is on, but you have not listed any stock yet, so nothing will be taken automatically.');
      } else {
        toast.success(
          field === 'isOpen'
            ? value ? 'Stall open 🟢' : 'Stall closed 🔴'
            : value ? 'Auto-accept on ⚡' : 'Auto-accept off'
        );
      }
    } catch (err) {
      setStall((prev) => ({ ...prev, [field]: !value }));
      toast.error(err.message || 'Could not save that.');
    }
  };

  return (
    <div className="min-h-screen bg-[#F6F8F6] pb-24">
      <header className="sticky top-0 z-20 bg-white border-b border-gray-200 shadow-sm">
        <div className="px-4 py-3 flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-[#0B7A37] flex items-center justify-center shrink-0">
            <Store className="w-5 h-5 text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-[15px] font-extrabold text-[#0F1F17] truncate">
              Stall {stall?.stallNumber}
            </h1>
            <p className="text-[12px] text-[#5B6B62] truncate">
              {user?.name} · {stall?.activeLoad ?? 0} item{stall?.activeLoad === 1 ? '' : 's'} in hand
            </p>
          </div>
          <button
            onClick={onLogout}
            className="p-2 rounded-xl text-[#5B6B62] hover:bg-gray-100"
            aria-label="Sign out"
          >
            <LogOut className="w-5 h-5" />
          </button>
        </div>

        <div className="px-4 pb-3 flex gap-2">
          <SwitchPill
            active={stall?.isOpen}
            onClick={() => handleToggle('isOpen', !stall?.isOpen)}
            activeLabel="Open"
            inactiveLabel="Closed"
            icon={<Store className="w-3.5 h-3.5" />}
          />
          <SwitchPill
            active={stall?.autoAccept}
            onClick={() => handleToggle('autoAccept', !stall?.autoAccept)}
            activeLabel="Auto-accept on"
            inactiveLabel="Auto-accept off"
            icon={<Zap className="w-3.5 h-3.5" />}
          />
        </div>
      </header>

      <main className="px-4 py-4 space-y-6 max-w-2xl mx-auto">
        {loading && (
          <div className="flex items-center justify-center py-16 text-[#5B6B62] gap-2">
            <RefreshCw className="w-4 h-4 animate-spin" />
            <span className="text-sm">Loading your stall…</span>
          </div>
        )}

        {!loading && !stall?.isOpen && (
          <div className="flex gap-3 p-4 rounded-2xl bg-amber-50 border border-amber-200">
            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <p className="text-[13px] text-amber-900">
              Your stall is closed, so you are not being offered anything. Tap
              <strong> Closed </strong> above to reopen.
            </p>
          </div>
        )}

        {/* --- Money ------------------------------------------------------- */}
        {earnings && <EarningsCard
          earnings={earnings}
          busy={withdrawing}
          onWithdraw={handleWithdraw}
        />}

        {/* --- What is on the table ---------------------------------------- */}
        <section>
          <SectionHeading
            icon={<Boxes className="w-4 h-4" />}
            title="My stock"
            count={held.length}
            tone="emerald"
          />

          {!loading && held.length === 0 && (
            <EmptyState
              icon={<Boxes className="w-6 h-6" />}
              title="Nothing listed yet"
              body="Tap + to say what you are holding today. Orders go to the stalls that can fill most of them, so a stall that lists nothing is never the best answer."
            />
          )}

          <div className="space-y-2">
            {held.map((item) => (
              <StockRow key={item.id} item={item} onEdit={() => setEditing(item)} />
            ))}
          </div>
        </section>

        {/* --- Live offers ------------------------------------------------- */}
        <section>
          <SectionHeading
            icon={<Timer className="w-4 h-4" />}
            title="New offers"
            count={offers.length}
            tone="amber"
          />

          {!loading && offers.length === 0 && (
            <EmptyState
              icon={<ShoppingBasket className="w-6 h-6" />}
              title="Nothing on offer"
              body="Orders come to the stalls that can fill most of them, least busy first. Declaring your stock makes yours easier to pick."
            />
          )}

          <div className="space-y-3">
            {offers.map((order) => {
              // The round clock, not the market-wide backstop — this is the
              // window the shopkeeper actually has to answer in.
              const remaining = secondsLeft(order.offerExpiresAt || order.sourcingDeadline);
              const chosen = selection[order.id] || [];

              return (
                <article
                  key={order.id}
                  className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden"
                >
                  <div className="px-4 py-3 flex items-center justify-between border-b border-gray-100">
                    <div className="min-w-0">
                      <p className="text-[13px] font-bold text-[#0F1F17]">{order.orderNumber}</p>
                      <p className="text-[11.5px] text-[#5B6B62]">
                        {order.openLines.length} item{order.openLines.length === 1 ? '' : 's'}
                        {order.openPool ? ' · open to any stall' : ' · held for you'}
                      </p>
                    </div>
                    <Countdown seconds={remaining} />
                  </div>

                  <ul className="divide-y divide-gray-100">
                    {order.openLines.map((line) => {
                      const ticked = chosen.includes(line.lineId);
                      return (
                        <li key={line.lineId}>
                          <button
                            onClick={() => toggleLine(order.id, line.lineId)}
                            className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-gray-50 active:bg-gray-100"
                          >
                            <span
                              className={`w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition ${
                                ticked ? 'bg-[#0B7A37] border-[#0B7A37]' : 'border-gray-300'
                              }`}
                            >
                              {ticked && <Check className="w-3.5 h-3.5 text-white" strokeWidth={3} />}
                            </span>
                            <span className="flex-1 min-w-0">
                              <span className="block text-[13.5px] font-semibold text-[#0F1F17] truncate">
                                {line.name}
                              </span>
                              <span className="block text-[12px] text-[#5B6B62]">
                                Qty {line.quantity} · {formatPaise(line.unitPricePaise * line.quantity)}
                              </span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>

                  <div className="p-3 bg-gray-50 flex gap-2">
                    {/*
                      No decline button in the open pool: there is nothing to
                      decline, because the order was never reserved for this
                      stall. Passing on it there just means not tapping accept.
                    */}
                    {!order.openPool && (
                      <button
                        onClick={() => handleDecline(order)}
                        disabled={busyOrder === order.id || remaining === 0}
                        className="px-4 text-[14px] font-bold py-3.5 rounded-xl border border-gray-300 text-[#5B6B62] bg-white hover:bg-gray-100 transition active:translate-y-px disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Pass
                      </button>
                    )}
                    <button
                      onClick={() => handleAccept(order)}
                      disabled={busyOrder === order.id || !stall?.isOpen || remaining === 0}
                      className="flex-1 bg-[#0B7A37] hover:bg-[#08652C] text-white text-[14px] font-bold py-3.5 rounded-xl transition active:translate-y-px disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {busyOrder === order.id
                        ? 'Accepting…'
                        : chosen.length > 0
                          ? `Accept ${chosen.length} item${chosen.length === 1 ? '' : 's'}`
                          : 'Accept all'}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        {/* --- Committed work ---------------------------------------------- */}
        <section>
          <SectionHeading
            icon={<Package className="w-4 h-4" />}
            title="To pack"
            count={packing.length}
            tone="green"
          />

          {!loading && packing.length === 0 && (
            <EmptyState
              icon={<Package className="w-6 h-6" />}
              title="Nothing to pack"
              body="Items you accept show up here to bag for the rider."
            />
          )}

          <div className="space-y-3">
            {packing.map((order) => {
              const unpacked = order.myLines.filter((l) => !l.packedAt);
              const collected = order.myLines.every((l) => l.collectedAt);

              return (
                <article
                  key={order.id}
                  className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden"
                >
                  <div className="px-4 py-3 flex items-center justify-between border-b border-gray-100">
                    <div>
                      <p className="text-[13px] font-bold text-[#0F1F17]">{order.orderNumber}</p>
                      <p className="text-[11.5px] text-[#5B6B62]">
                        Your share: {formatPaise(order.myTotalPaise)}
                      </p>
                    </div>
                    <StatusChip status={order.status} collected={collected} />
                  </div>

                  <ul className="divide-y divide-gray-100">
                    {order.myLines.map((line) => (
                      <li key={line.lineId} className="px-4 py-2.5 flex items-center gap-3">
                        {line.collectedAt ? (
                          <CheckCircle2 className="w-4 h-4 text-[#0B7A37] shrink-0" />
                        ) : line.packedAt ? (
                          <Package className="w-4 h-4 text-[#0B7A37] shrink-0" />
                        ) : (
                          <Clock className="w-4 h-4 text-amber-500 shrink-0" />
                        )}
                        <span className="flex-1 text-[13.5px] text-[#0F1F17] truncate">
                          {line.name}
                          {line.auto && (
                            <span className="ml-1.5 text-[10.5px] font-bold text-[#0B7A37] uppercase tracking-wide">
                              auto
                            </span>
                          )}
                        </span>
                        <span className="text-[12.5px] font-semibold text-[#5B6B62] shrink-0">
                          × {line.quantity}
                        </span>
                      </li>
                    ))}
                  </ul>

                  {unpacked.length > 0 && (
                    <div className="p-3 bg-gray-50">
                      <button
                        onClick={() => handlePack(order)}
                        disabled={busyOrder === order.id}
                        className="w-full bg-[#0F1F17] hover:bg-black text-white text-[14px] font-bold py-3.5 rounded-xl transition active:translate-y-px disabled:opacity-50"
                      >
                        {busyOrder === order.id ? 'Saving…' : `Mark ${unpacked.length} packed`}
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      </main>

      {/*
        The + is fixed at the bottom centre, where a thumb reaches it on a phone
        held one-handed. It is the only way onto the stock screen, so it stays
        put rather than scrolling away with the list.
      */}
      <button
        onClick={() => setPickerOpen(true)}
        className="fixed bottom-6 left-1/2 -translate-x-1/2 z-30 w-14 h-14 rounded-full bg-[#0B7A37] text-white shadow-lg shadow-black/20 flex items-center justify-center active:scale-95 transition"
        aria-label="Add a product to your stock"
      >
        <Plus className="w-7 h-7" />
      </button>

      {pickerOpen && (
        <ProductPicker
          products={stock}
          onPick={(item) => {
            setPickerOpen(false);
            setEditing(item);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {editing && (
        <StockSheet
          item={editing}
          onClose={() => setEditing(null)}
          onSave={handleSaveStock}
        />
      )}
    </div>
  );
}

/** One product this stall is holding. Price is the market's, and is not editable. */
function StockRow({ item, onEdit }) {
  const photoAge = item.photoTakenAt ? timeSince(item.photoTakenAt) : null;

  return (
    <button
      onClick={onEdit}
      className="w-full text-left bg-white rounded-2xl border border-gray-200 p-3 flex items-center gap-3 active:scale-[0.99] transition"
    >
      <img
        src={item.image}
        alt=""
        className="w-12 h-12 rounded-xl object-cover bg-gray-100 shrink-0"
        onError={(e) => { e.target.style.visibility = 'hidden'; }}
      />
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-bold text-[#0F1F17] truncate">{item.name}</p>
        <p className="text-[12px] text-[#5B6B62]">
          {formatPaise(item.pricePaise)}{item.weight ? ` · ${item.weight}` : ''}
        </p>
        {photoAge ? (
          <p className="text-[11px] text-emerald-700 font-semibold flex items-center gap-1 mt-0.5">
            <Camera className="w-3 h-3" /> Photo from {photoAge}
          </p>
        ) : (
          <p className="text-[11px] text-[#8A9A91] flex items-center gap-1 mt-0.5">
            <Camera className="w-3 h-3" /> No photo yet
          </p>
        )}
      </div>
      <div className="text-right shrink-0">
        <p className="text-[16px] font-black text-[#0F1F17]">{item.stock}</p>
        <p className="text-[10px] text-[#8A9A91] uppercase tracking-wide">in stock</p>
      </div>
    </button>
  );
}

/**
 * Pick a product to stock.
 *
 * A bottom sheet rather than a native dropdown: the list runs to hundreds of
 * rows and each one carries a picture and a price, which a `<select>` cannot
 * show. Search filters the list already in memory, so it responds on every
 * keystroke without a request.
 */
function ProductPicker({ products, onPick, onClose }) {
  const [query, setQuery] = useState('');

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return products;
    return products.filter((p) => p.name.toLowerCase().includes(q));
  }, [products, query]);

  return (
    <Sheet title="Add to your stock" onClose={onClose}>
      <div className="px-4 pb-3">
        <div className="relative">
          <Search className="w-4 h-4 text-[#8A9A91] absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search vegetables…"
            className="w-full bg-[#F6F8F6] border border-gray-200 rounded-xl pl-9 pr-3 py-2.5 text-[14px] outline-none focus:border-[#0B7A37]"
          />
        </div>
      </div>

      <div className="overflow-y-auto px-4 pb-6 space-y-2">
        {matches.length === 0 && (
          <p className="text-[13px] text-[#5B6B62] text-center py-8">
            Nothing matches “{query}”. The list is what this market is selling today.
          </p>
        )}

        {matches.map((p) => (
          <button
            key={p.id}
            onClick={() => onPick(p)}
            className="w-full text-left bg-white rounded-2xl border border-gray-200 p-3 flex items-center gap-3 active:scale-[0.99] transition"
          >
            {/* The catalog picture, filled in for you — this is the "pre picture". */}
            <img
              src={p.image}
              alt=""
              className="w-11 h-11 rounded-xl object-cover bg-gray-100 shrink-0"
              onError={(e) => { e.target.style.visibility = 'hidden'; }}
            />
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-bold text-[#0F1F17] truncate">{p.name}</p>
              <p className="text-[12px] text-[#5B6B62]">
                {formatPaise(p.pricePaise)}{p.weight ? ` · ${p.weight}` : ''}
              </p>
            </div>
            {p.stock > 0 ? (
              <span className="text-[11px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full shrink-0">
                {p.stock} listed
              </span>
            ) : (
              <Plus className="w-4 h-4 text-[#8A9A91] shrink-0" />
            )}
          </button>
        ))}
      </div>
    </Sheet>
  );
}

/**
 * How much of one product, and optionally a photograph of it.
 *
 * The price sits here as a fact, not a field. One price per product per market,
 * set by the market owner — every stall sells at the same figure, and it
 * changes for all of them at once when the owner edits it.
 */
function StockSheet({ item, onClose, onSave }) {
  const toast = useToast();
  const [quantity, setQuantity] = useState(String(item.stock || ''));
  const [photo, setPhoto] = useState(null);
  const [removePhoto, setRemovePhoto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);

  const parsed = Number.parseInt(quantity, 10);
  const valid = Number.isInteger(parsed) && parsed >= 0;

  const handleFile = async (event) => {
    const file = event.target.files?.[0];
    // Let the same file be chosen again after a failure.
    event.target.value = '';
    if (!file) return;

    setPreparing(true);
    try {
      // A camera original is several megabytes and the limit is 120 KB, so this
      // has to happen before anything reaches the network.
      setPhoto(await toUploadableJpeg(file));
      setRemovePhoto(false);
    } catch (err) {
      toast.error(err.message || 'That photo could not be used.');
    } finally {
      setPreparing(false);
    }
  };

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      await onSave({ productId: item.id, quantity: parsed, photo, removePhoto });
      onClose();
    } catch (err) {
      toast.error(err.message || 'Could not save that.');
    } finally {
      setBusy(false);
    }
  };

  const hasPhoto = Boolean(photo) || (Boolean(item.photoTakenAt) && !removePhoto);

  return (
    <Sheet title={item.name} onClose={onClose}>
      <div className="px-4 pb-6 space-y-5 overflow-y-auto">
        <div className="flex items-center gap-3">
          <img
            src={photo || item.image}
            alt=""
            className="w-16 h-16 rounded-2xl object-cover bg-gray-100 shrink-0"
            onError={(e) => { e.target.style.visibility = 'hidden'; }}
          />
          <div className="min-w-0">
            <p className="text-[20px] font-black text-[#0F1F17]">{formatPaise(item.pricePaise)}</p>
            <p className="text-[11px] text-[#5B6B62] leading-tight">
              Set by the market owner. Every stall here sells at this price.
            </p>
          </div>
        </div>

        <div>
          <label htmlFor="stall-stock" className="block text-[12px] font-bold text-[#0F1F17] mb-1.5">
            How many do you have?
          </label>
          <input
            id="stall-stock"
            type="number"
            inputMode="numeric"
            min="0"
            autoFocus
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            placeholder="0"
            className="w-full bg-[#F6F8F6] border border-gray-200 rounded-xl px-3 py-3 text-[18px] font-bold outline-none focus:border-[#0B7A37]"
          />
          <p className="text-[11px] text-[#8A9A91] mt-1.5">
            This is what auto-accept and the ranking run on. Set it to 0 to take
            the line off your table.
          </p>
        </div>

        <div>
          <p className="text-[12px] font-bold text-[#0F1F17] mb-1.5">
            Today’s photo <span className="font-normal text-[#8A9A91]">— optional</span>
          </p>

          <div className="flex gap-2">
            <label className="flex-1 cursor-pointer">
              <input
                type="file"
                accept="image/*"
                // Opens the camera directly on a phone rather than a file browser.
                capture="environment"
                onChange={handleFile}
                className="hidden"
              />
              <span className="flex items-center justify-center gap-2 w-full bg-white border-2 border-dashed border-gray-300 rounded-xl py-3 text-[13px] font-bold text-[#0F1F17] active:scale-[0.99] transition">
                {preparing
                  ? <><RefreshCw className="w-4 h-4 animate-spin" /> Preparing…</>
                  : <><Camera className="w-4 h-4" /> {hasPhoto ? 'Retake' : 'Take a photo'}</>}
              </span>
            </label>

            {hasPhoto && (
              <button
                onClick={() => { setPhoto(null); setRemovePhoto(true); }}
                className="px-3 rounded-xl border border-gray-200 text-[#8A9A91] active:scale-95 transition"
                aria-label="Remove the photo"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>

          <p className="text-[11px] text-[#8A9A91] mt-1.5 leading-relaxed">
            {photo
              ? `Ready to upload (${approximateKb(photo)} KB). It shows on the product page next to the catalogue picture.`
              : 'A picture of what is actually on your table today. Customers see it next to the catalogue image, so they know what they are getting.'}
          </p>
        </div>

        <button
          onClick={submit}
          disabled={!valid || busy || preparing}
          className="w-full bg-[#0F1F17] hover:bg-black text-white text-[15px] font-bold py-3.5 rounded-xl transition active:translate-y-px disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Sheet>
  );
}

/** A bottom sheet. Shared by the picker and the stock form. */
function Sheet({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 backdrop-blur-sm">
      {/* Tapping the dimmed area closes it, the usual mobile affordance. */}
      <button className="absolute inset-0 cursor-default" onClick={onClose} aria-label="Close" />
      <div className="relative w-full max-w-2xl bg-[#F6F8F6] rounded-t-3xl shadow-2xl max-h-[85vh] flex flex-col animate-slide-up">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 shrink-0">
          <h2 className="text-[15px] font-extrabold text-[#0F1F17] truncate pr-2">{title}</h2>
          <button onClick={onClose} className="p-1.5 rounded-full hover:bg-gray-200 shrink-0">
            <X className="w-5 h-5 text-[#5B6B62]" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** "3 hours ago" for a photo timestamp. */
function timeSince(when) {
  const minutes = Math.round((Date.now() - new Date(when).getTime()) / 60000);
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * The money card.
 *
 * Two numbers matter to a shopkeeper: what is waiting, and when it arrives.
 * Both are stated plainly, because the single most common support question a
 * marketplace gets is "where is my money" — and the honest answer here is
 * "it comes on its own, you do not have to do anything".
 *
 * The withdraw button is shown even when it cannot be used, with the shortfall
 * spelled out. Hiding it would just move the question rather than answer it.
 */
function EarningsCard({ earnings, busy, onWithdraw }) {
  const {
    pendingPaise, releasedPaise, nextReleaseAt,
    canWithdrawNow, minEarlyPayoutPaise, holdHours, pendingCount,
  } = earnings;

  const shortBy = Math.max(0, minEarlyPayoutPaise - pendingPaise);
  const nothingYet = pendingPaise === 0 && releasedPaise === 0;

  return (
    <section className="rounded-2xl bg-[#0F1F17] text-white overflow-hidden shadow-sm">
      <div className="px-5 pt-5 pb-4">
        <div className="flex items-center gap-2 mb-3">
          <Wallet className="w-4 h-4 text-emerald-400" />
          <h2 className="text-[13px] font-bold uppercase tracking-wide text-emerald-400">Earnings</h2>
        </div>

        <div className="flex items-end gap-4">
          <div>
            <p className="text-[28px] font-extrabold leading-none tabular-nums">
              {formatPaise(pendingPaise)}
            </p>
            <p className="text-[12px] text-white/60 mt-1.5">
              {pendingCount > 0
                ? `waiting from ${pendingCount} order${pendingCount === 1 ? '' : 's'}`
                : 'waiting'}
            </p>
          </div>
          {releasedPaise > 0 && (
            <div className="pb-0.5">
              <p className="text-[15px] font-bold text-white/80 tabular-nums">
                {formatPaise(releasedPaise)}
              </p>
              <p className="text-[11.5px] text-white/50">paid out</p>
            </div>
          )}
        </div>

        {nothingYet && (
          <p className="text-[12.5px] text-white/60 mt-3 leading-relaxed">
            You are paid once the customer has the goods — not when you accept or pack.
            The money then reaches your wallet on its own within {holdHours} hours.
          </p>
        )}

        {pendingPaise > 0 && nextReleaseAt && (
          <div className="flex items-start gap-2 mt-3 text-[12.5px] text-white/70 leading-relaxed">
            <Lock className="w-3.5 h-3.5 shrink-0 mt-0.5 text-white/50" />
            <p>
              Reaches your wallet by itself <strong className="text-white">{timeUntil(nextReleaseAt)}</strong>.
              You do not have to do anything.
            </p>
          </div>
        )}
      </div>

      {pendingPaise > 0 && (
        <div className="px-5 pb-5">
          <button
            onClick={onWithdraw}
            disabled={!canWithdrawNow || busy}
            className="w-full bg-emerald-500 hover:bg-emerald-400 text-[#0F1F17] text-[14px] font-extrabold py-3.5 rounded-xl transition active:translate-y-px disabled:bg-white/10 disabled:text-white/40 disabled:cursor-not-allowed"
          >
            {busy ? 'Moving money…' : canWithdrawNow ? 'Withdraw now' : `₹${(shortBy / 100).toFixed(0)} more to withdraw early`}
          </button>
          {!canWithdrawNow && (
            <p className="text-[11.5px] text-white/50 text-center mt-2 leading-relaxed">
              Early withdrawals start at {formatPaise(minEarlyPayoutPaise)}. Below that it simply waits
              for the {holdHours}-hour payout.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function SwitchPill({ active, onClick, activeLabel, inactiveLabel, icon }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-bold transition ${
        active
          ? 'bg-[#0B7A37] text-white'
          : 'bg-gray-100 text-[#5B6B62] hover:bg-gray-200'
      }`}
    >
      {icon}
      {active ? activeLabel : inactiveLabel}
    </button>
  );
}

/**
 * The countdown a shopkeeper is racing.
 *
 * Turns red under fifteen seconds — that is when it stops being information and
 * starts being a prompt.
 */
function Countdown({ seconds }) {
  if (seconds <= 0) {
    return (
      <span className="text-[11.5px] font-bold text-[#5B6B62] bg-gray-100 px-2.5 py-1 rounded-full">
        Closing…
      </span>
    );
  }
  const urgent = seconds <= 15;
  return (
    <span
      className={`text-[12px] font-extrabold px-2.5 py-1 rounded-full tabular-nums ${
        urgent ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-800'
      }`}
    >
      {seconds}s
    </span>
  );
}

function StatusChip({ status, collected }) {
  if (collected) {
    return (
      <span className="text-[11px] font-bold text-[#0B7A37] bg-emerald-50 px-2.5 py-1 rounded-full">
        Collected
      </span>
    );
  }
  const label = {
    packing: 'Packing',
    awaiting_rider: 'Waiting for rider',
    collecting: 'Rider here',
  }[status] || status;

  return (
    <span className="text-[11px] font-bold text-[#0F1F17] bg-gray-100 px-2.5 py-1 rounded-full">
      {label}
    </span>
  );
}

function SectionHeading({ icon, title, count, tone }) {
  const toneClass = tone === 'amber' ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800';
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className="text-[#0F1F17]">{icon}</span>
      <h2 className="text-[15px] font-extrabold text-[#0F1F17]">{title}</h2>
      {count > 0 && (
        <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${toneClass}`}>{count}</span>
      )}
    </div>
  );
}

function EmptyState({ icon, title, body }) {
  return (
    <div className="bg-white rounded-2xl border border-dashed border-gray-300 px-5 py-8 text-center">
      <div className="w-12 h-12 rounded-2xl bg-gray-100 text-[#5B6B62] flex items-center justify-center mx-auto mb-3">
        {icon}
      </div>
      <p className="text-[14px] font-bold text-[#0F1F17]">{title}</p>
      <p className="text-[12.5px] text-[#5B6B62] mt-1 max-w-xs mx-auto leading-relaxed">{body}</p>
    </div>
  );
}
