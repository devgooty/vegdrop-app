import React, { useState, useEffect, useCallback } from 'react';
import {
  Store, Clock, Package, CheckCircle2, Zap, LogOut, RefreshCw,
  AlertTriangle, ShoppingBasket, Timer, Check, Wallet, Lock,
  Boxes, ChevronDown,
} from 'lucide-react';
import { useToast } from './Toast';
import {
  fetchStallOrders, claimLines, packOrder, updateMyStall, secondsLeft, formatPaise,
  fetchEarnings, withdrawEarnings, timeUntil,
} from '../services/stalls';
import StallInventoryEditor from './StallInventoryEditor';

/**
 * The stall screen.
 *
 * A shopkeeper sees two things: offers going right now in their market, and the
 * work they have already committed to. Nothing else — no customer name, no phone
 * number, no delivery address. The server does not send those to a stall, and
 * this screen would have nowhere to put them.
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
  // Collapsed by default — the offer feed is what this panel is opened for.
  const [showStock, setShowStock] = useState(false);
  const [busyOrder, setBusyOrder] = useState(null);
  const [earnings, setEarnings] = useState(null);
  const [withdrawing, setWithdrawing] = useState(false);

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
      const [data, money] = await Promise.all([
        fetchStallOrders(),
        // Earnings move on a much slower clock than offers, but folding them
        // into the same poll keeps the screen to one request cycle.
        fetchEarnings().catch(() => null),
      ]);
      setOffers(data.offers);
      setPacking(data.packing);
      setStall((prev) => ({ ...prev, ...data.stall }));
      if (money) setEarnings(money);
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

        {/* --- Declared stock ---------------------------------------------
            Auto-accept fires only where the stall has declared enough stock
            for the line, so without this screen the switch above could never
            do anything — which is what the warning on toggling it says, with
            nowhere to send anyone. Collapsed by default: the offer feed is
            what a shopkeeper opens this panel for. */}
        {!loading && (
          <section>
            <button
              type="button"
              onClick={() => setShowStock((v) => !v)}
              className="w-full flex items-center justify-between gap-3 p-3 rounded-2xl bg-white border border-gray-200 hover:border-emerald-300 transition-colors text-left"
            >
              <span className="flex items-center gap-2 min-w-0">
                <Boxes className="w-4 h-4 text-[#0B7A37] shrink-0" />
                <span className="text-[13px] font-extrabold text-[#0F1F17] truncate">
                  On my table
                </span>
                {stall?.autoAccept && (
                  <span className="text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5 shrink-0">
                    powers auto-accept
                  </span>
                )}
              </span>
              <ChevronDown
                className={`w-4 h-4 text-[#5B6B62] shrink-0 transition-transform ${showStock ? 'rotate-180' : ''}`}
              />
            </button>

            {showStock && (
              <div className="mt-3">
                <StallInventoryEditor autoAccept={Boolean(stall?.autoAccept)} />
              </div>
            )}
          </section>
        )}

        {/* --- Money ------------------------------------------------------- */}
        {earnings && <EarningsCard
          earnings={earnings}
          busy={withdrawing}
          onWithdraw={handleWithdraw}
        />}

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
              body="When a customer orders from this market, it appears here within a few seconds."
            />
          )}

          <div className="space-y-3">
            {offers.map((order) => {
              const remaining = secondsLeft(order.sourcingDeadline);
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
                        {order.openLines.length} item{order.openLines.length === 1 ? '' : 's'} going
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

                  <div className="p-3 bg-gray-50">
                    <button
                      onClick={() => handleAccept(order)}
                      disabled={busyOrder === order.id || !stall?.isOpen || remaining === 0}
                      className="w-full bg-[#0B7A37] hover:bg-[#08652C] text-white text-[14px] font-bold py-3.5 rounded-xl transition active:translate-y-px disabled:opacity-50 disabled:cursor-not-allowed"
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
    </div>
  );
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
