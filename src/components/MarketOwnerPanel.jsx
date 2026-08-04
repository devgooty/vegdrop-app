import React, { useCallback, useEffect, useState } from 'react';
import {
  Building2,
  Award,
  Store,
  Bike,
  Check,
  X,
  Clock,
  Loader2,
  RefreshCw,
  Inbox,
  TrendingUp,
} from 'lucide-react';

import {
  fetchMyMarkets,
  fetchStallRequests,
  fetchMarketAnalytics,
  approveStallRequest,
  rejectStallRequest,
} from '../services/markets';
import { formatPaise } from '../services/stalls';

/**
 * The market owner's dashboard.
 *
 * Everything here is read from the server and scoped to the markets this
 * account owns. The previous version of this panel computed a 15% commission in
 * the browser from whatever orders happened to be loaded and listed three
 * hardcoded vendor names — "Green Valley Organic Farms" and friends — beside an
 * invented "+24.5% this week". None of it corresponded to anything, which is
 * worse than an empty state: a number that is wrong is acted on, while a number
 * that is missing is asked about.
 *
 * Takings come from the stall earnings ledger rather than order totals. An
 * order's total is what the customer agreed to pay; an earning is what one
 * stall is owed for the lines it actually supplied. Those diverge on every
 * split order, cancellation and market hop.
 */
export default function MarketOwnerPanel() {
  const [markets, setMarkets] = useState([]);
  const [marketId, setMarketId] = useState(null);
  const [requests, setRequests] = useState([]);
  const [analytics, setAnalytics] = useState(null);

  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);

  /** Markets first — every other call needs an id. */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const mine = await fetchMyMarkets();
        if (cancelled) return;
        setMarkets(mine);
        // Open on the market that needs attention, not simply the first.
        const needsAttention = mine.find((m) => m.pendingRequests > 0);
        setMarketId((needsAttention || mine[0])?.id ?? null);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Could not load your markets.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async (id) => {
    if (!id) return;
    // Requested together but settled independently: an analytics failure should
    // not hide the approval queue, which is the part with work waiting in it.
    const [queue, stats] = await Promise.allSettled([
      fetchStallRequests(id),
      fetchMarketAnalytics(id),
    ]);
    if (queue.status === 'fulfilled') setRequests(queue.value);
    if (stats.status === 'fulfilled') setAnalytics(stats.value);
  }, []);

  useEffect(() => {
    load(marketId);
  }, [marketId, load]);

  async function decide(request, action) {
    setBusyId(request.id);
    setError(null);

    try {
      if (action === 'approve') {
        /**
         * The number is confirmed rather than assumed. What the applicant typed
         * is a guess — the owner is the one who knows which pitches are free,
         * and the server enforces uniqueness among trading stalls, so a clash
         * would be rejected anyway. Better to ask than to surface that as an
         * error after the fact.
         */
        const proposed = request.proposedStallNumber === 'TBD' ? '' : request.proposedStallNumber;
        const stallNumber = window.prompt(
          `Which stall number is ${request.applicant?.name || 'this trader'} taking?`,
          proposed
        );
        if (!stallNumber) return;
        await approveStallRequest(marketId, request.id, { stallNumber: stallNumber.trim() });
      } else {
        // Optional: a blank reason still rejects, it just says less.
        const reason = window.prompt('Reason (optional) — the applicant sees this:', '');
        if (reason === null) return;
        await rejectStallRequest(marketId, request.id, { reason: reason.trim() });
      }

      await load(marketId);
      // The badge on the market selector is now stale.
      setMarkets((prev) =>
        prev.map((m) =>
          m.id === marketId ? { ...m, pendingRequests: Math.max(0, m.pendingRequests - 1) } : m
        )
      );
    } catch (err) {
      setError(err.message || 'That did not go through.');
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center text-gray-500 gap-2">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-sm font-semibold">Loading your market…</span>
      </div>
    );
  }

  if (markets.length === 0) {
    return (
      <div className="p-6 pb-20">
        <div className="bg-white rounded-2xl p-6 border border-gray-200 text-center space-y-2">
          <Building2 className="w-8 h-8 text-gray-300 mx-auto" />
          <h3 className="font-extrabold text-gray-900">No market yet</h3>
          <p className="text-sm text-gray-500">
            You do not run a market on this account. Once one is assigned to you, its stalls,
            requests and takings appear here.
          </p>
        </div>
      </div>
    );
  }

  const market = markets.find((m) => m.id === marketId);
  const stalls = analytics?.stalls;

  return (
    <div className="p-4 space-y-4 pb-20 bg-amber-50/40 min-h-screen">
      {/* Header */}
      <div className="bg-gradient-to-r from-amber-900 via-amber-800 to-yellow-950 text-white p-4 rounded-2xl shadow-xl border border-amber-500/30">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2.5 bg-white/10 backdrop-blur-md rounded-xl border border-white/20 shrink-0">
              <Building2 className="w-6 h-6 text-amber-200" />
            </div>
            <div className="min-w-0">
              <h2 className="font-extrabold text-lg tracking-tight truncate">
                {market?.name || 'Your market'}
              </h2>
              <p className="text-xs text-amber-100/90 font-medium truncate">{market?.address}</p>
            </div>
          </div>
          <span className="px-2.5 py-1 bg-amber-400/20 text-amber-200 rounded-full text-[11px] font-bold border border-amber-300/30 flex items-center gap-1 shrink-0">
            <Award className="w-3.5 h-3.5" />
            Owner
          </span>
        </div>

        {/* Only shown when there is a choice to make. */}
        {markets.length > 1 && (
          <select
            value={marketId || ''}
            onChange={(e) => setMarketId(e.target.value)}
            className="mt-3 w-full bg-black/25 text-white text-sm font-semibold rounded-xl px-3 py-2 border border-white/15"
          >
            {markets.map((m) => (
              <option key={m.id} value={m.id} className="text-gray-900">
                {m.name}
                {m.pendingRequests > 0 ? ` — ${m.pendingRequests} waiting` : ''}
              </option>
            ))}
          </select>
        )}

        <div className="grid grid-cols-3 gap-2 mt-4 pt-3 border-t border-white/10 text-center">
          <Metric label="Sold" value={formatPaise(analytics?.sales?.grossPaise)} tone="text-amber-300" />
          <Metric label="Stalls" value={stalls ? String(stalls.approved) : '—'} tone="text-white" />
          <Metric
            label="Deliveries"
            value={analytics ? String(analytics.deliveries.total) : '—'}
            tone="text-emerald-300"
          />
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl p-3 font-medium">
          {error}
        </div>
      )}

      {/* Requests waiting on a decision */}
      <Card
        icon={<Inbox className="w-5 h-5 text-amber-600" />}
        title={`Stall requests${requests.length ? ` (${requests.length})` : ''}`}
        action={
          <button
            onClick={() => load(marketId)}
            className="text-gray-400 hover:text-gray-700 p-1"
            aria-label="Refresh requests"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        }
      >
        {requests.length === 0 ? (
          <p className="text-xs text-gray-500 py-2">
            Nobody is waiting. Shopkeepers who apply to trade here will show up in this list.
          </p>
        ) : (
          <div className="space-y-2">
            {requests.map((r) => (
              <div
                key={r.id}
                className="p-3 bg-amber-50/60 rounded-xl border border-amber-100 space-y-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-bold text-sm text-gray-900 block truncate">
                      {r.applicant?.name || r.name}
                    </span>
                    <span className="text-[11px] text-gray-500 block">
                      {/* An unverified number is labelled rather than shown as
                          if confirmed: it is what they typed, not something the
                          platform has proved they answer. */}
                      {r.applicant?.phone ||
                        (r.applicant?.unverifiedPhone
                          ? `${r.applicant.unverifiedPhone} (unverified)`
                          : 'no phone')}
                      {r.proposedStallNumber && r.proposedStallNumber !== 'TBD'
                        ? ` • asked for ${r.proposedStallNumber}`
                        : ''}
                    </span>
                  </div>
                  <span className="text-[10px] text-amber-700 font-bold flex items-center gap-1 shrink-0">
                    <Clock className="w-3 h-3" />
                    {timeAgo(r.requestedAt)}
                  </span>
                </div>

                <div className="flex gap-2">
                  <button
                    disabled={busyId === r.id}
                    onClick={() => decide(r, 'approve')}
                    className="flex-1 bg-[#1B4D3E] text-white text-xs font-bold py-2 rounded-lg flex items-center justify-center gap-1 disabled:opacity-50"
                  >
                    {busyId === r.id ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Check className="w-3.5 h-3.5" />
                    )}
                    Accept
                  </button>
                  <button
                    disabled={busyId === r.id}
                    onClick={() => decide(r, 'reject')}
                    className="flex-1 bg-white text-gray-700 border border-gray-300 text-xs font-bold py-2 rounded-lg flex items-center justify-center gap-1 disabled:opacity-50"
                  >
                    <X className="w-3.5 h-3.5" />
                    Decline
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Takings per stall */}
      <Card
        icon={<TrendingUp className="w-5 h-5 text-amber-600" />}
        title="Sold by stall"
        action={
          analytics && (
            <span className="text-[11px] text-gray-400 font-semibold">
              last {analytics.windowDays} days
            </span>
          )
        }
      >
        {!analytics?.sales?.byStall?.length ? (
          <p className="text-xs text-gray-500 py-2">
            Nothing sold in this window yet. A stall appears here once it has supplied an order the
            customer has taken delivery of.
          </p>
        ) : (
          <div className="space-y-2">
            {analytics.sales.byStall.map((s) => (
              <div
                key={s.stallId}
                className="flex justify-between items-center p-2.5 bg-gray-50 rounded-xl border border-gray-100"
              >
                <div className="min-w-0">
                  <span className="font-bold text-xs text-gray-900 block truncate">
                    <Store className="w-3 h-3 inline mr-1 text-gray-400" />
                    {s.stallNumber} — {s.stallName || s.ownerName || 'Stall'}
                  </span>
                  <span className="text-[10px] text-gray-500">
                    {s.orders} order{s.orders === 1 ? '' : 's'}
                    {s.ownerName ? ` • ${s.ownerName}` : ''}
                  </span>
                </div>
                <div className="text-right shrink-0 pl-2">
                  <span className="font-extrabold text-sm text-[#1B4D3E] block">
                    {formatPaise(s.grossPaise)}
                  </span>
                  <span className="text-[10px] text-gray-500">
                    {formatPaise(s.netPaise)} to stall
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Who is delivering */}
      <Card icon={<Bike className="w-5 h-5 text-amber-600" />} title="Deliveries by rider">
        {!analytics?.deliveries?.byRider?.length ? (
          <p className="text-xs text-gray-500 py-2">No completed deliveries in this window.</p>
        ) : (
          <div className="space-y-2">
            {analytics.deliveries.byRider.map((r) => (
              <div
                key={r.riderId}
                className="flex justify-between items-center p-2.5 bg-gray-50 rounded-xl border border-gray-100"
              >
                <div className="min-w-0">
                  <span className="font-bold text-xs text-gray-900 block truncate">
                    {r.name || 'Rider'}
                  </span>
                  <span className="text-[10px] text-gray-500">{r.phone || ''}</span>
                </div>
                <span className="font-extrabold text-sm text-gray-900 shrink-0">
                  {r.deliveries}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Stall roll-call, including the ones not trading */}
      {stalls && (
        <Card icon={<Store className="w-5 h-5 text-amber-600" />} title="Stalls in this market">
          <div className="grid grid-cols-3 gap-2 text-center">
            <Tally label="Trading" value={stalls.approved} tone="text-[#1B4D3E]" />
            <Tally label="Waiting" value={stalls.pending} tone="text-amber-700" />
            <Tally label="Declined" value={stalls.rejected} tone="text-gray-400" />
          </div>
        </Card>
      )}
    </div>
  );
}

function Metric({ label, value, tone }) {
  return (
    <div className="bg-black/20 p-2 rounded-xl backdrop-blur-xs">
      <div className="text-[10px] text-amber-200 font-semibold uppercase tracking-wider">
        {label}
      </div>
      <div className={`text-lg font-black ${tone}`}>{value}</div>
    </div>
  );
}

function Tally({ label, value, tone }) {
  return (
    <div className="bg-gray-50 rounded-xl p-2.5 border border-gray-100">
      <div className={`text-xl font-black ${tone}`}>{value}</div>
      <div className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider">
        {label}
      </div>
    </div>
  );
}

function Card({ icon, title, action, children }) {
  return (
    <div className="bg-white rounded-2xl p-4 border border-gray-200 shadow-sm space-y-3">
      <div className="flex items-center justify-between border-b border-gray-100 pb-2.5">
        <div className="flex items-center gap-2">
          {icon}
          <h3 className="font-extrabold text-sm text-gray-900">{title}</h3>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

/** "3h ago" — enough to judge how long somebody has been kept waiting. */
function timeAgo(iso) {
  if (!iso) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
