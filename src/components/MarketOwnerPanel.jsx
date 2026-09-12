import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  Tags,
  Settings,
  LayoutDashboard,
  Search,
  Plus,
  Ban,
  RotateCcw,
  Pencil,
  AlertTriangle,
  PackageX,
  Package,
  ChevronLeft,
  Save,
  MapPin,
  Footprints,
  CalendarCheck,
  TrendingDown,
  CircleCheck,
  Sparkles,
} from 'lucide-react';

import {
  fetchMyMarkets,
  fetchStallRequests,
  fetchMarketAnalytics,
  fetchMarketStalls,
  fetchMarketPrices,
  saveMarketPrices,
  confirmMarketPrices,
  approveStallRequest,
  rejectStallRequest,
  updateMarketStall,
  updateMarket,
  createMarket,
  saveMarketBoundary,
  currentPosition,
} from '../services/markets';
import { fetchProducts } from '../services/products';
import { ORDER_STATUSES } from '../services/orders';
import { formatPaise } from '../services/stalls';
import { useToast } from './Toast';
import BoundaryWalk from './BoundaryWalk';
import CatalogSuggestionsQueue from './CatalogSuggestionsQueue';
import { initialCategories } from '../data/mockData';

/**
 * The market owner's dashboard.
 *
 * Everything here is read from the server and scoped to the markets this
 * account owns. The first version of this panel computed a 15% commission in
 * the browser from whatever orders happened to be loaded and listed three
 * hardcoded vendor names beside an invented "+24.5% this week". None of it
 * corresponded to anything, which is worse than an empty state: a number that is
 * wrong is acted on, while a number that is missing is asked about.
 *
 * Takings come from the stall earnings ledger rather than order totals. An
 * order's total is what the customer agreed to pay; an earning is what one
 * stall is owed for the lines it actually supplied. Those diverge on every
 * split order, cancellation and market hop.
 *
 * WHY THIS IS TABBED, AND WHY POLLING IS NOT UNIFORM
 *
 * A market owner does four unrelated jobs — watch the numbers, answer people
 * waiting to trade, keep the trader roster honest, and set today's prices. The
 * first three are monitoring and are polled on the same 10s cycle the rest of
 * the app uses. The last two hold unsaved edits, and are deliberately NOT
 * polled: a background refresh that overwrote a half-typed price sheet would
 * lose work silently, which is the one failure mode a pricing screen cannot
 * have.
 */

const TABS = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'requests', label: 'Requests', icon: Inbox },
  { id: 'catalog', label: 'Catalog', icon: Package },
  { id: 'stalls', label: 'Traders', icon: Store },
  { id: 'prices', label: 'Prices', icon: Tags },
  { id: 'settings', label: 'Settings', icon: Settings },
];

/** Tabs safe to refresh underneath the user. See the note above. */
const POLLED_TABS = new Set(['overview', 'requests', 'stalls']);

const WINDOWS = [
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
  { days: 365, label: '1y' },
];

/** The coarse order statuses, in the order an order actually moves through them. */
// Was a local copy of the same five strings. See `ORDER_STATUSES`.
const ORDER_FUNNEL = ORDER_STATUSES;

export default function MarketOwnerPanel({ onExit }) {
  const toast = useToast();

  const [markets, setMarkets] = useState([]);
  const [marketId, setMarketId] = useState(null);
  const [tab, setTab] = useState('overview');
  const [windowDays, setWindowDays] = useState(30);

  const [analytics, setAnalytics] = useState(null);
  const [requests, setRequests] = useState([]);
  const [decided, setDecided] = useState({ approved: [], rejected: [] });
  const [stalls, setStalls] = useState([]);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);

  const market = useMemo(() => markets.find((m) => m.id === marketId) || null, [markets, marketId]);

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

  /**
   * Everything the monitoring tabs read, in one pass.
   *
   * Requested together but settled independently: an analytics failure should
   * not hide the approval queue, which is the part with work waiting in it.
   * A `quiet` refresh is the polling tick — it must not raise a banner, because
   * a momentary blip while somebody reads the screen is not news.
   */
  const loadOverview = useCallback(
    async (id, days, { quiet = false } = {}) => {
      if (!id) return;
      if (!quiet) setRefreshing(true);

      const [stats, queue, roster, approved, rejected] = await Promise.allSettled([
        fetchMarketAnalytics(id, { days }),
        fetchStallRequests(id),
        fetchMarketStalls(id),
        fetchStallRequests(id, { status: 'approved' }),
        fetchStallRequests(id, { status: 'rejected' }),
      ]);

      if (stats.status === 'fulfilled') setAnalytics(stats.value);
      if (roster.status === 'fulfilled') setStalls(roster.value);
      if (queue.status === 'fulfilled') {
        setRequests(queue.value);
        // The badge on the market selector went stale the moment somebody
        // applied or was decided on; this is the authoritative count.
        setMarkets((prev) =>
          prev.map((m) => (m.id === id ? { ...m, pendingRequests: queue.value.length } : m))
        );
      }
      setDecided({
        approved: approved.status === 'fulfilled' ? approved.value : [],
        rejected: rejected.status === 'fulfilled' ? rejected.value : [],
      });

      if (!quiet) setRefreshing(false);

      const failure = [stats, queue, roster].find((r) => r.status === 'rejected');
      if (!quiet) setError(failure ? failure.reason?.message || 'Could not refresh.' : null);
    },
    []
  );

  useEffect(() => {
    setError(null);
    loadOverview(marketId, windowDays);
  }, [marketId, windowDays, loadOverview]);

  /**
   * Keep the monitoring tabs current.
   *
   * Paused while the tab is hidden, for the reason the other three apps give:
   * a background tab hammering the API is pure waste, and a stale list nobody
   * is looking at costs nothing.
   */
  useEffect(() => {
    if (!marketId || !POLLED_TABS.has(tab)) return;

    const poll = () => {
      if (document.hidden) return;
      loadOverview(marketId, windowDays, { quiet: true });
    };

    const interval = setInterval(poll, 10000);
    const onVisible = () => {
      if (!document.hidden) poll();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [marketId, windowDays, tab, loadOverview]);

  const refresh = useCallback(
    () => loadOverview(marketId, windowDays),
    [loadOverview, marketId, windowDays]
  );

  /** One place that knows how to turn a failed call into a sentence. */
  const report = useCallback(
    (err, fallback) => {
      const message = err?.message || fallback;
      toast.error(message);
      setError(message);
    },
    [toast]
  );

  const onMarketPatched = useCallback((updated) => {
    setMarkets((prev) =>
      prev.map((m) =>
        m.id === updated.id
          ? {
              ...m,
              name: updated.name,
              address: updated.address,
              isOpen: updated.isOpen,
              isActive: updated.isActive,
              serviceRadiusMeters: updated.serviceRadiusMeters,
              contactPhone: updated.contactPhone || '',
              lat: updated.lat ?? m.lat,
              lng: updated.lng ?? m.lng,
              /**
               * Kept only when the response actually carried one.
               *
               * This merge is an allow-list, which is why the boundary has to
               * be named here at all — without it, saving a boundary updated
               * the server and the card went on showing the old outline,
               * because nothing copied the new one across.
               *
               * `??` rather than a plain assignment because the two writers
               * differ: the boundary PUT returns a boundary, and an ordinary
               * settings PATCH may not. Overwriting unconditionally would blank
               * a perfectly good fence every time somebody changed the market's
               * phone number.
               */
              boundary: updated.boundary ?? m.boundary,
            }
          : m
      )
    );
  }, []);

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center text-gray-500 gap-2 min-h-screen">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-sm font-semibold">Loading your market…</span>
      </div>
    );
  }

  if (markets.length === 0) {
    return (
      <div className="p-6 pb-20 min-h-screen bg-amber-50/40">
        {onExit && <ExitBar onExit={onExit} />}
        <div className="bg-white rounded-2xl p-6 border border-gray-200 text-center space-y-3 mt-3">
          <Building2 className="w-8 h-8 text-gray-300 mx-auto" />
          <h3 className="font-extrabold text-gray-900">No market yet</h3>
          <p className="text-sm text-gray-500">
            You do not run a market on this account. Set one up and shopkeepers can start applying
            to trade in it — or wait for staff to hand you one that already exists.
          </p>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="bg-amber-900 text-white text-xs font-bold px-4 py-2.5 rounded-xl inline-flex items-center gap-1.5 hover:bg-amber-800 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            Set up my market
          </button>
        </div>

        {creating && (
          <CreateMarketDialog
            onClose={() => setCreating(false)}
            onCreated={(created) => {
              setCreating(false);
              setMarkets([{ ...created, pendingRequests: 0 }]);
              setMarketId(created.id);
              toast.success(`${created.name} is live. Shopkeepers can apply to trade here now.`);
            }}
            onReport={report}
          />
        )}
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4 pb-24 bg-amber-50/40 min-h-screen">
      {onExit && <ExitBar onExit={onExit} />}

      <MarketHeader
        market={market}
        markets={markets}
        marketId={marketId}
        onSelect={setMarketId}
        analytics={analytics}
        pendingCount={requests.length}
      />

      <nav
        className="flex bg-white p-1 rounded-2xl border border-gray-200 shadow-sm overflow-x-auto"
        aria-label="Market owner sections"
      >
        {TABS.map(({ id, label, icon: Icon }) => {
          const isActive = tab === id;
          const badge = id === 'requests' && requests.length > 0 ? requests.length : null;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              aria-current={isActive ? 'page' : undefined}
              className={`flex-1 min-w-[72px] py-2 px-2 rounded-xl flex items-center justify-center gap-1.5 text-[12.5px] font-bold transition-all cursor-pointer ${
                isActive
                  ? 'bg-amber-900 text-white shadow-md'
                  : 'text-gray-500 hover:text-gray-900 hover:bg-gray-50'
              }`}
            >
              <Icon className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{label}</span>
              {badge && (
                <span
                  className={`px-1.5 rounded-full text-[11.5px] font-black ${
                    isActive ? 'bg-white text-amber-900' : 'bg-amber-100 text-amber-800'
                  }`}
                >
                  {badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {error && (
        <div
          role="alert"
          className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl p-3 font-medium flex items-start gap-2"
        >
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="flex-1">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-red-400 hover:text-red-700 cursor-pointer"
            aria-label="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {tab === 'overview' && (
        <OverviewTab
          analytics={analytics}
          windowDays={windowDays}
          onWindowChange={setWindowDays}
          onRefresh={refresh}
          refreshing={refreshing}
        />
      )}

      {tab === 'requests' && (
        <RequestsTab
          marketId={marketId}
          requests={requests}
          decided={decided}
          onRefresh={refresh}
          refreshing={refreshing}
          onReport={report}
          toast={toast}
        />
      )}

      {tab === 'catalog' && (
        <div className="px-4 pb-24 pt-2">
          <CatalogSuggestionsQueue
            categories={initialCategories}
            onReport={report}
            toast={toast.success}
          />
        </div>
      )}

      {tab === 'stalls' && (
        <StallsTab
          marketId={marketId}
          stalls={stalls}
          onStallPatched={(row) =>
            setStalls((prev) => prev.map((s) => (s.id === row.id ? row : s)))
          }
          onRefresh={refresh}
          refreshing={refreshing}
          onReport={report}
          toast={toast}
        />
      )}

      {tab === 'prices' && (
        <PricesTab marketId={marketId} onReport={report} toast={toast} />
      )}

      {tab === 'settings' && (
        <SettingsTab
          market={market}
          onSaved={onMarketPatched}
          onReport={report}
          toast={toast}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

/**
 * A way back to the rest of the app.
 *
 * The panel replaces the whole screen — App.jsx hides both the header and the
 * bottom navigation while it is open — so without this a market owner who
 * opened the dashboard had no route back to their account short of reloading
 * the page.
 */
function ExitBar({ onExit }) {
  return (
    <button
      type="button"
      onClick={onExit}
      className="flex items-center gap-1.5 text-xs font-bold text-amber-900 hover:text-amber-700 cursor-pointer"
    >
      <ChevronLeft className="w-4 h-4" />
      Back to app
    </button>
  );
}

function MarketHeader({ market, markets, marketId, onSelect, analytics, pendingCount }) {
  const closed = market && (!market.isActive || !market.isOpen);

  return (
    <header className="bg-gradient-to-r from-amber-900 via-amber-800 to-yellow-950 text-white p-4 rounded-2xl shadow-xl border border-amber-500/30">
      <div className="flex items-center justify-between gap-2">
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
        <span className="px-2.5 py-1 bg-amber-400/20 text-amber-200 rounded-full text-[12.5px] font-bold border border-amber-300/30 flex items-center gap-1 shrink-0">
          <Award className="w-3.5 h-3.5" />
          Owner
        </span>
      </div>

      {/* Trading state is stated rather than left to be inferred from an empty
          order list — a market switched off is the single likeliest explanation
          for "why is nothing coming in", and it is two taps away in Settings. */}
      {closed && (
        <p className="mt-3 flex items-center gap-1.5 text-[12.5px] font-bold bg-red-500/20 text-red-100 border border-red-300/30 rounded-lg px-2.5 py-1.5">
          <PackageX className="w-3.5 h-3.5 shrink-0" />
          {!market.isActive
            ? 'This market is switched off. Customers cannot see it at all.'
            : 'Closed for trading. No orders will be offered to your stalls.'}
        </p>
      )}

      {/* Only shown when there is a choice to make. */}
      {markets.length > 1 && (
        <>
          <label htmlFor="market-picker" className="sr-only">
            Choose a market
          </label>
          <select
            id="market-picker"
            value={marketId || ''}
            onChange={(e) => onSelect(e.target.value)}
            className="mt-3 w-full bg-black/25 text-white text-sm font-semibold rounded-xl px-3 py-2 border border-white/15 cursor-pointer"
          >
            {markets.map((m) => (
              <option key={m.id} value={m.id} className="text-gray-900">
                {m.name}
                {m.pendingRequests > 0 ? ` — ${m.pendingRequests} waiting` : ''}
              </option>
            ))}
          </select>
        </>
      )}

      <div className="grid grid-cols-4 gap-2 mt-4 pt-3 border-t border-white/10 text-center">
        <Metric label="Sold" value={formatPaise(analytics?.sales?.grossPaise)} tone="text-amber-300" />
        <Metric
          label="Traders"
          value={analytics ? String(analytics.stalls.approved) : '—'}
          tone="text-white"
        />
        <Metric
          label="Delivered"
          value={analytics ? String(analytics.deliveries.total) : '—'}
          tone="text-emerald-300"
        />
        <Metric
          label="Waiting"
          value={String(pendingCount)}
          tone={pendingCount > 0 ? 'text-amber-300' : 'text-white/50'}
        />
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function OverviewTab({ analytics, windowDays, onWindowChange, onRefresh, refreshing }) {
  const sales = analytics?.sales;
  const orders = analytics?.orders || {};

  // Counted from the funnel rather than from the sales rows: an order that was
  // cancelled or never sourced produces no stall earning at all, so it would be
  // invisible in a total built only from what was paid out.
  const totalOrders = ORDER_FUNNEL.reduce((sum, s) => sum + (orders[s]?.count || 0), 0);

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <div
          className="flex bg-white rounded-xl border border-gray-200 p-0.5 text-[12.5px] font-bold"
          role="group"
          aria-label="Reporting window"
        >
          {WINDOWS.map((w) => (
            <button
              key={w.days}
              type="button"
              onClick={() => onWindowChange(w.days)}
              aria-pressed={windowDays === w.days}
              className={`px-3 py-1.5 rounded-lg transition-colors cursor-pointer ${
                windowDays === w.days
                  ? 'bg-amber-900 text-white'
                  : 'text-gray-500 hover:text-gray-900'
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
        <RefreshButton onClick={onRefresh} busy={refreshing} label="Refresh figures" />
      </div>

      {/* The money, split the way it is actually owed. Gross is what customers
          paid the stalls; net is what reaches them after commission. Showing
          only one of the two invites the wrong one being quoted. */}
      <div className="grid grid-cols-3 gap-2">
        <Figure label="Gross" value={formatPaise(sales?.grossPaise)} tone="text-[#1B4D3E]" />
        <Figure label="Commission" value={formatPaise(sales?.commissionPaise ?? commissionOf(sales))} tone="text-amber-700" />
        <Figure label="To stalls" value={formatPaise(sales?.netPaise)} tone="text-gray-900" />
      </div>

      <Card
        icon={<TrendingUp className="w-5 h-5 text-amber-600" />}
        title="Orders"
        action={
          analytics && (
            <span className="text-[12.5px] text-gray-400 font-semibold">
              last {analytics.windowDays} days
            </span>
          )
        }
      >
        {totalOrders === 0 ? (
          <Empty>No orders placed at this market in this window.</Empty>
        ) : (
          <div className="space-y-2">
            {ORDER_FUNNEL.map((status) => {
              const row = orders[status];
              if (!row?.count) return null;
              const share = Math.round((row.count / totalOrders) * 100);
              return (
                <div key={status} className="space-y-1">
                  <div className="flex justify-between items-baseline text-xs">
                    <span className="font-bold text-gray-900">{status}</span>
                    <span className="text-gray-500">
                      <span className="font-bold text-gray-900">{row.count}</span> ·{' '}
                      {formatPaise(row.valuePaise)}
                    </span>
                  </div>
                  <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${
                        status === 'Cancelled' ? 'bg-red-300' : 'bg-amber-500'
                      }`}
                      style={{ width: `${share}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card icon={<Store className="w-5 h-5 text-amber-600" />} title="Sold by stall">
        {!sales?.byStall?.length ? (
          <Empty>
            Nothing sold in this window yet. A stall appears here once it has supplied an order the
            customer has taken delivery of.
          </Empty>
        ) : (
          <div className="space-y-2">
            {sales.byStall.map((s) => (
              <div
                key={s.stallId}
                className="flex justify-between items-center p-2.5 bg-gray-50 rounded-xl border border-gray-100"
              >
                <div className="min-w-0">
                  <span className="font-bold text-xs text-gray-900 block truncate">
                    <Store className="w-3 h-3 inline mr-1 text-gray-400" />
                    {s.stallNumber} — {s.stallName || s.ownerName || 'Stall'}
                  </span>
                  <span className="text-[11.5px] text-gray-500">
                    {s.orders} order{s.orders === 1 ? '' : 's'}
                    {s.ownerName ? ` • ${s.ownerName}` : ''}
                  </span>
                </div>
                <div className="text-right shrink-0 pl-2">
                  <span className="font-extrabold text-sm text-[#1B4D3E] block">
                    {formatPaise(s.grossPaise)}
                  </span>
                  <span className="text-[11.5px] text-gray-500">
                    {formatPaise(s.netPaise)} to stall
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card icon={<Bike className="w-5 h-5 text-amber-600" />} title="Deliveries by rider">
        {!analytics?.deliveries?.byRider?.length ? (
          <Empty>No completed deliveries in this window.</Empty>
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
                  <span className="text-[11.5px] text-gray-500">{r.phone || ''}</span>
                </div>
                <span className="font-extrabold text-sm text-gray-900 shrink-0">{r.deliveries}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {analytics?.stalls && (
        <Card icon={<Building2 className="w-5 h-5 text-amber-600" />} title="Stalls in this market">
          <div className="grid grid-cols-3 gap-2 text-center">
            <Tally label="Trading" value={analytics.stalls.approved} tone="text-[#1B4D3E]" />
            <Tally label="Waiting" value={analytics.stalls.pending} tone="text-amber-700" />
            <Tally label="Declined" value={analytics.stalls.rejected} tone="text-gray-400" />
          </div>
        </Card>
      )}
    </>
  );
}

/**
 * Commission the server did not send.
 *
 * `sales.commissionPaise` is not part of the aggregate total today — only the
 * per-stall rows carry it — so it is summed here rather than shown as a blank.
 * Derived from the rows the breakdown already displays, so it always agrees
 * with what is on screen.
 */
function commissionOf(sales) {
  if (!sales?.byStall?.length) return 0;
  return sales.byStall.reduce((sum, row) => sum + (row.commissionPaise || 0), 0);
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

function RequestsTab({ marketId, requests, decided, onRefresh, refreshing, onReport, toast }) {
  const [dialog, setDialog] = useState(null); // { mode: 'approve'|'decline', request }
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState('approved');

  async function submit({ stallNumber, autoAccept, reason }) {
    const { mode, request } = dialog;
    setBusy(true);

    try {
      if (mode === 'approve') {
        await approveStallRequest(marketId, request.id, { stallNumber, autoAccept });
        toast.success(`${request.applicant?.name || 'Trader'} is now stall ${stallNumber}.`);
      } else {
        await rejectStallRequest(marketId, request.id, { reason });
        toast.info(`${request.applicant?.name || 'The applicant'} has been told.`);
      }
      setDialog(null);
      await onRefresh();
    } catch (err) {
      /**
       * The dialog deliberately stays open on failure.
       *
       * The commonest rejection here is STALL_NUMBER_TAKEN, and the fix is to
       * type a different number — which is only possible if the number they
       * typed is still on screen to correct.
       */
      onReport(err, 'That did not go through.');
    } finally {
      setBusy(false);
    }
  }

  const historyRows = decided[history] || [];

  return (
    <>
      <Card
        icon={<Inbox className="w-5 h-5 text-amber-600" />}
        title={`Waiting on you${requests.length ? ` (${requests.length})` : ''}`}
        action={<RefreshButton onClick={onRefresh} busy={refreshing} label="Refresh requests" />}
      >
        {requests.length === 0 ? (
          <Empty>
            Nobody is waiting. Shopkeepers who apply to trade here will show up in this list.
          </Empty>
        ) : (
          <div className="space-y-2">
            {requests.map((r) => (
              <div key={r.id} className="p-3 bg-amber-50/60 rounded-xl border border-amber-100 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-bold text-sm text-gray-900 block truncate">
                      {r.applicant?.name || r.name}
                    </span>
                    <span className="text-[12.5px] text-gray-500 block">
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
                    {r.name && r.name !== r.applicant?.name && (
                      <span className="text-[12.5px] text-gray-400 block truncate">
                        trading as {r.name}
                      </span>
                    )}
                  </div>
                  <span className="text-[11.5px] text-amber-700 font-bold flex items-center gap-1 shrink-0">
                    <Clock className="w-3 h-3" />
                    {timeAgo(r.requestedAt)}
                  </span>
                </div>

                <PresenceEvidence presence={r.presence} />

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setDialog({ mode: 'approve', request: r })}
                    className="flex-1 bg-[#1B4D3E] text-white text-xs font-bold py-2 rounded-lg flex items-center justify-center gap-1 hover:bg-[#143B2B] transition-colors cursor-pointer"
                  >
                    <Check className="w-3.5 h-3.5" />
                    Accept
                  </button>
                  <button
                    type="button"
                    onClick={() => setDialog({ mode: 'decline', request: r })}
                    className="flex-1 bg-white text-gray-700 border border-gray-300 text-xs font-bold py-2 rounded-lg flex items-center justify-center gap-1 hover:bg-gray-50 transition-colors cursor-pointer"
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

      {/* Decisions already made. A rejection with a reason is the record of why
          somebody was turned away, and is the thing to reread when they ask. */}
      <Card
        icon={<Clock className="w-5 h-5 text-amber-600" />}
        title="Already decided"
        action={
          <div className="flex bg-gray-100 rounded-lg p-0.5 text-[12.5px] font-bold">
            {['approved', 'rejected'].map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setHistory(key)}
                aria-pressed={history === key}
                className={`px-2.5 py-1 rounded-md capitalize transition-colors cursor-pointer ${
                  history === key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
                }`}
              >
                {key}
              </button>
            ))}
          </div>
        }
      >
        {historyRows.length === 0 ? (
          <Empty>Nothing {history} yet.</Empty>
        ) : (
          <div className="space-y-1.5">
            {historyRows.map((r) => (
              <div
                key={r.id}
                className="flex justify-between items-start gap-2 p-2.5 bg-gray-50 rounded-xl border border-gray-100"
              >
                <div className="min-w-0">
                  <span className="font-bold text-xs text-gray-900 block truncate">
                    {r.applicant?.name || r.name}
                    {r.status === 'approved' && r.proposedStallNumber !== 'TBD'
                      ? ` — stall ${r.proposedStallNumber}`
                      : ''}
                  </span>
                  {r.rejectionReason && (
                    <span className="text-[11.5px] text-gray-500 block">“{r.rejectionReason}”</span>
                  )}
                </div>
                <span className="text-[11.5px] text-gray-400 font-semibold shrink-0">
                  {timeAgo(r.reviewedAt || r.requestedAt)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {dialog?.mode === 'approve' && (
        <ApproveDialog
          request={dialog.request}
          busy={busy}
          onCancel={() => setDialog(null)}
          onSubmit={submit}
        />
      )}
      {dialog?.mode === 'decline' && (
        <DeclineDialog
          request={dialog.request}
          busy={busy}
          onCancel={() => setDialog(null)}
          onSubmit={submit}
        />
      )}
    </>
  );
}

/**
 * Accepting somebody, with the pitch number settled here.
 *
 * This replaced a `window.prompt`. A prompt cannot show the applicant it refers
 * to, cannot carry the auto-accept choice, is unstyled on mobile, and is
 * blocked outright by some browsers — so the one irreversible action in this
 * panel was the least explained thing in it.
 */
/**
 * What the applicant's phone reported, shown beside their request.
 *
 * This is the whole reason the reading is collected. The server already refuses
 * an application from outside a fenced market, so a row that reaches this queue
 * has passed — but "passed" spans a range, and the owner is the one deciding
 * whether to let a stranger into their market. Standing 2 m inside with a ±6 m
 * fix and squeaking in 60 m outside with a ±90 m one are different facts, and
 * flattening both to a green tick throws away the part worth reading.
 *
 * Silent when there is nothing to report rather than showing "not checked":
 * most markets have no boundary yet, and a warning on every request in those
 * markets would be noise the owner cannot act on.
 */
function PresenceEvidence({ presence }) {
  if (!presence) return null;

  const inside = presence.inside === true;
  const accuracy = Math.round(presence.accuracyMeters);
  const off = presence.metersOutside;

  return (
    <div
      className={`rounded-lg px-2.5 py-1.5 border flex items-start gap-1.5 ${
        inside ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'
      }`}
    >
      <MapPin
        className={`w-3.5 h-3.5 mt-px shrink-0 ${inside ? 'text-emerald-700' : 'text-amber-700'}`}
      />
      <span
        className={`text-[11.5px] font-semibold leading-snug ${
          inside ? 'text-emerald-800' : 'text-amber-900'
        }`}
      >
        {inside ? (
          <>
            Applied from inside the market
            {off !== null && off < 0 ? `, ${Math.abs(off)} m from the edge` : ''}
          </>
        ) : (
          <>
            Applied from about {off} m outside
            {presence.basis === 'radius' ? ' the market area' : ' the boundary'}
          </>
        )}
        <span className="font-normal opacity-70"> · phone reported ±{accuracy} m</span>
      </span>
    </div>
  );
}

function ApproveDialog({ request, busy, onCancel, onSubmit }) {
  const proposed = request.proposedStallNumber === 'TBD' ? '' : request.proposedStallNumber || '';
  const [stallNumber, setStallNumber] = useState(proposed);
  const [autoAccept, setAutoAccept] = useState(false);

  const trimmed = stallNumber.trim();

  return (
    <Dialog title={`Accept ${request.applicant?.name || 'this trader'}`} onClose={onCancel}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!trimmed || busy) return;
          onSubmit({ stallNumber: trimmed, autoAccept });
        }}
        className="space-y-3"
      >
        <p className="text-xs text-gray-500">
          {proposed
            ? `They asked for stall ${proposed}. You decide which pitch they actually get.`
            : 'They did not name a pitch. Give them the number painted on the stall — the rider reads it off their screen and walks to it.'}
        </p>

        <label className="block">
          <span className="text-[12.5px] font-bold text-gray-700 uppercase tracking-wide">
            Stall number
          </span>
          <input
            autoFocus
            value={stallNumber}
            onChange={(e) => setStallNumber(e.target.value)}
            maxLength={24}
            placeholder="A-12"
            className="mt-1 w-full border border-gray-300 rounded-xl px-3 py-2.5 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-amber-500"
          />
        </label>

        <label className="flex items-start gap-2.5 p-2.5 bg-gray-50 rounded-xl border border-gray-100 cursor-pointer">
          <input
            type="checkbox"
            checked={autoAccept}
            onChange={(e) => setAutoAccept(e.target.checked)}
            className="mt-0.5 w-4 h-4 accent-amber-700 cursor-pointer"
          />
          <span className="text-[12.5px] text-gray-600 leading-snug">
            <span className="font-bold text-gray-900 block">Answer offers automatically</span>
            Only fires on lines they have declared stock for. They can change this themselves later.
          </span>
        </label>

        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 bg-white border border-gray-300 text-gray-700 text-xs font-bold py-2.5 rounded-xl hover:bg-gray-50 cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!trimmed || busy}
            className="flex-1 bg-[#1B4D3E] text-white text-xs font-bold py-2.5 rounded-xl flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            Accept
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function DeclineDialog({ request, busy, onCancel, onSubmit }) {
  const [reason, setReason] = useState('');

  return (
    <Dialog title={`Decline ${request.applicant?.name || 'this request'}`} onClose={onCancel}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (busy) return;
          onSubmit({ reason: reason.trim() });
        }}
        className="space-y-3"
      >
        <p className="text-xs text-gray-500">
          The applicant sees this reason. Declining frees them to apply to a different market, so
          saying why saves them guessing.
        </p>

        <label className="block">
          <span className="text-[12.5px] font-bold text-gray-700 uppercase tracking-wide">
            Reason <span className="text-gray-400 font-semibold normal-case">(optional)</span>
          </span>
          <textarea
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={300}
            rows={3}
            placeholder="No free pitches until next month."
            className="mt-1 w-full border border-gray-300 rounded-xl px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-amber-500"
          />
          <span className="text-[11.5px] text-gray-400">{reason.length}/300</span>
        </label>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 bg-white border border-gray-300 text-gray-700 text-xs font-bold py-2.5 rounded-xl hover:bg-gray-50 cursor-pointer"
          >
            Keep waiting
          </button>
          <button
            type="submit"
            disabled={busy}
            className="flex-1 bg-red-600 text-white text-xs font-bold py-2.5 rounded-xl flex items-center justify-center gap-1.5 disabled:opacity-50 cursor-pointer"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
            Decline
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Traders
// ---------------------------------------------------------------------------

function StallsTab({ marketId, stalls, onStallPatched, onRefresh, refreshing, onReport, toast }) {
  const [busyId, setBusyId] = useState(null);
  const [renaming, setRenaming] = useState(null); // stall row
  const [confirming, setConfirming] = useState(null); // stall row

  async function patch(stall, changes, message) {
    setBusyId(stall.id);
    try {
      const row = await updateMarketStall(marketId, stall.id, changes);
      onStallPatched(row);
      toast.success(message);
      setRenaming(null);
      setConfirming(null);
    } catch (err) {
      onReport(err, 'Could not update that stall.');
    } finally {
      setBusyId(null);
    }
  }

  const trading = stalls.filter((s) => s.isActive);
  const suspended = stalls.filter((s) => !s.isActive);

  return (
    <>
      <Card
        icon={<Store className="w-5 h-5 text-amber-600" />}
        title={`Traders${stalls.length ? ` (${stalls.length})` : ''}`}
        action={<RefreshButton onClick={onRefresh} busy={refreshing} label="Refresh traders" />}
      >
        {stalls.length === 0 ? (
          <Empty>
            Nobody trades here yet. Accept a stall request and the trader appears in this list.
          </Empty>
        ) : (
          <div className="space-y-2">
            {[...trading, ...suspended].map((s) => (
              <div
                key={s.id}
                className={`p-3 rounded-xl border space-y-2 ${
                  s.isActive ? 'bg-gray-50 border-gray-100' : 'bg-red-50/60 border-red-100'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-bold text-sm text-gray-900 block truncate">
                      {s.stallNumber} — {s.name}
                    </span>
                    <span className="text-[12.5px] text-gray-500 block truncate">
                      {s.owner?.name || 'Unknown owner'}
                      {s.owner?.phone ? ` • ${s.owner.phone}` : ''}
                    </span>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    {!s.isActive ? (
                      <Pill tone="red">Suspended</Pill>
                    ) : s.isOpen ? (
                      <Pill tone="green">Open</Pill>
                    ) : (
                      <Pill tone="gray">Shutter down</Pill>
                    )}
                    {s.activeLoad > 0 && (
                      <span className="text-[11.5px] text-gray-500 font-semibold">
                        {s.activeLoad} packing
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={busyId === s.id}
                    onClick={() => setRenaming(s)}
                    className="flex-1 bg-white text-gray-700 border border-gray-300 text-[12.5px] font-bold py-1.5 rounded-lg flex items-center justify-center gap-1 hover:bg-gray-50 disabled:opacity-50 cursor-pointer"
                  >
                    <Pencil className="w-3 h-3" />
                    Move pitch
                  </button>
                  {s.isActive ? (
                    <button
                      type="button"
                      disabled={busyId === s.id}
                      onClick={() => setConfirming(s)}
                      className="flex-1 bg-white text-red-700 border border-red-200 text-[12.5px] font-bold py-1.5 rounded-lg flex items-center justify-center gap-1 hover:bg-red-50 disabled:opacity-50 cursor-pointer"
                    >
                      {busyId === s.id ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <Ban className="w-3 h-3" />
                      )}
                      Suspend
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busyId === s.id}
                      onClick={() => patch(s, { isActive: true }, `${s.name} is trading again.`)}
                      className="flex-1 bg-[#1B4D3E] text-white text-[12.5px] font-bold py-1.5 rounded-lg flex items-center justify-center gap-1 disabled:opacity-50 cursor-pointer"
                    >
                      {busyId === s.id ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <RotateCcw className="w-3 h-3" />
                      )}
                      Reinstate
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {renaming && (
        <RenumberDialog
          stall={renaming}
          busy={busyId === renaming.id}
          onCancel={() => setRenaming(null)}
          onSubmit={(stallNumber) =>
            patch(renaming, { stallNumber }, `${renaming.name} moved to ${stallNumber}.`)
          }
        />
      )}

      {confirming && (
        <Dialog title={`Suspend ${confirming.name}?`} onClose={() => setConfirming(null)}>
          <div className="space-y-3">
            <p className="text-xs text-gray-600 leading-relaxed">
              They stop being offered new orders straight away, and are emailed to say so.
              {confirming.activeLoad > 0 && (
                <>
                  {' '}
                  <span className="font-bold text-gray-900">
                    They are still holding {confirming.activeLoad} line
                    {confirming.activeLoad === 1 ? '' : 's'} to pack
                  </span>{' '}
                  — those stay with them, because a customer has already paid for the goods.
                </>
              )}{' '}
              You can reinstate them at any time.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setConfirming(null)}
                className="flex-1 bg-white border border-gray-300 text-gray-700 text-xs font-bold py-2.5 rounded-xl hover:bg-gray-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busyId === confirming.id}
                onClick={() =>
                  patch(confirming, { isActive: false }, `${confirming.name} is suspended.`)
                }
                className="flex-1 bg-red-600 text-white text-xs font-bold py-2.5 rounded-xl flex items-center justify-center gap-1.5 disabled:opacity-50 cursor-pointer"
              >
                {busyId === confirming.id ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Ban className="w-3.5 h-3.5" />
                )}
                Suspend
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}

function RenumberDialog({ stall, busy, onCancel, onSubmit }) {
  const [value, setValue] = useState(stall.stallNumber || '');
  const trimmed = value.trim();

  return (
    <Dialog title={`Move ${stall.name}`} onClose={onCancel}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!trimmed || busy) return;
          onSubmit(trimmed);
        }}
        className="space-y-3"
      >
        <p className="text-xs text-gray-500">
          Riders walk to whatever is on their screen, so this must match the number actually painted
          on the pitch.
        </p>
        <label className="block">
          <span className="text-[12.5px] font-bold text-gray-700 uppercase tracking-wide">
            Stall number
          </span>
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            maxLength={24}
            className="mt-1 w-full border border-gray-300 rounded-xl px-3 py-2.5 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-amber-500"
          />
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 bg-white border border-gray-300 text-gray-700 text-xs font-bold py-2.5 rounded-xl hover:bg-gray-50 cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!trimmed || trimmed === stall.stallNumber || busy}
            className="flex-1 bg-amber-900 text-white text-xs font-bold py-2.5 rounded-xl flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            Move
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

/**
 * The market's own price sheet.
 *
 * This is the one screen that decides what a customer is charged, and it had no
 * interface at all — the endpoints existed and nothing called them, so a market
 * owner could not change a single price without a developer running a request
 * by hand.
 *
 * Edits are held locally and sent in one PUT, because the server upserts the
 * whole batch: saving per keystroke would write a price for every intermediate
 * number typed, and "9" is a real price on the way to "95".
 */
/**
 * The daily price round.
 *
 * A vegetable market reprices every morning, and the sheet is the market
 * owner's first job of the day — so this screen is built around the DAY rather
 * than around the list. What it has to answer, in order: how much of today is
 * left, what has moved since yesterday, and how do I sign off the rest without
 * retyping numbers that have not changed.
 *
 * THE TWO VERBS, AND WHY THERE ARE TWO
 *
 * Saving sets a new price. Confirming says yesterday's price still stands.
 * They are different acts and they write different things — a confirm records
 * the owner's attention (`confirmedAt`) and deliberately writes NO history,
 * because a price that did not change must not appear on the customer's price
 * chart as though it had. Collapsing them into one button would mean either
 * fabricating history or having no way to clear a line that genuinely held.
 * See models/MarketPrice.js.
 *
 * NOT POLLED, DELIBERATELY
 *
 * `POLLED_TABS` excludes this tab and must go on excluding it: a background
 * refresh landing mid-edit would replace a half-typed sheet with the server's
 * copy and discard the owner's morning.
 */
function PricesTab({ marketId, onReport, toast }) {
  const [rows, setRows] = useState([]);
  const [edits, setEdits] = useState({}); // productId -> { price?, isAvailable? }
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [lens, setLens] = useState('todo');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const sheet = await fetchMarketPrices(marketId);
      setRows(sheet);
      setEdits({});
    } catch (err) {
      onReport(err, 'Could not load the price sheet.');
    } finally {
      setLoading(false);
    }
  }, [marketId, onReport]);

  useEffect(() => {
    load();
  }, [load]);

  const dirty = Object.keys(edits);

  /** What a row looks like right now, unsaved edit included. */
  const current = useCallback(
    (row) => {
      const productId = row.product?.id;
      const edit = edits[productId] || {};
      return {
        price: edit.price !== undefined ? edit.price : String(row.price),
        isAvailable: edit.isAvailable !== undefined ? edit.isAvailable : row.isAvailable,
      };
    },
    [edits]
  );

  function edit(productId, change) {
    setEdits((prev) => ({ ...prev, [productId]: { ...prev[productId], ...change } }));
  }

  /**
   * Nudge a price by a whole rupee.
   *
   * Vegetable prices move in rupees, and the alternative on a phone is
   * summoning a numeric keyboard, selecting the existing value and retyping it
   * — four gestures to change ₹38 to ₹40.
   *
   * The new value is derived INSIDE the updater, from `prev`, rather than from
   * `current(row)` in the handler body. Raising a price by ₹5 means tapping +
   * five times in quick succession, and React batches those: every handler in
   * one batch closes over the same `edits`, so each would compute 42 + 1 and
   * five taps would land on 43. Reading `prev` makes each tap see the one
   * before it and compound properly.
   */
  function nudge(row, delta) {
    const productId = row.product?.id;

    setEdits((prev) => {
      const pending = prev[productId]?.price;
      const from = Number.parseFloat(pending !== undefined ? pending : String(row.price));
      const base = Number.isFinite(from) ? from : row.price;
      const next = Math.max(0, Math.round((base + delta) * 100) / 100);
      return { ...prev, [productId]: { ...prev[productId], price: String(next) } };
    });
  }

  /**
   * A line is "done today" if it was priced today OR confirmed today.
   *
   * An unsaved edit counts too. Without that the counter ticks down only on
   * save, so an owner working through the sheet watches a number that does not
   * move and cannot tell how far they have got.
   */
  const isDone = useCallback(
    (row) => Boolean(row.changedToday || row.confirmedToday || edits[row.product?.id]),
    [edits]
  );

  const todo = useMemo(() => rows.filter((r) => !isDone(r)), [rows, isDone]);

  const moved = useMemo(
    () =>
      rows.filter(
        (r) => r.previousPricePaise !== null && r.previousPricePaise !== r.pricePaise
      ),
    [rows]
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    let list = rows;

    if (lens === 'todo') list = rows.filter((r) => !isDone(r));
    else if (lens === 'moved') list = moved;
    else if (lens === 'off') list = rows.filter((r) => !current(r).isAvailable);

    if (!needle) return list;
    return list.filter((r) => (r.product?.name || '').toLowerCase().includes(needle));
  }, [rows, query, lens, isDone, moved, current]);

  /**
   * Memoised because the add dialog searches on it.
   *
   * A fresh Set each render would change identity on every parent render, and
   * the dialog's debounced search lists it as a dependency — so an unrelated
   * re-render would restart the search and flash a spinner over results the
   * user was reading.
   */
  const alreadyListed = useMemo(
    () => new Set(rows.map((r) => r.product?.id).filter(Boolean)),
    [rows]
  );

  async function save() {
    // Only the rows that actually changed. The endpoint upserts, so sending the
    // untouched ones would bump `updatedBy` and `updatedAt` on lines nobody
    // edited and make the sheet's history useless.
    const payload = [];
    for (const productId of dirty) {
      const row = rows.find((r) => r.product?.id === productId);
      if (!row) continue;
      const { price, isAvailable } = current(row);
      const rupees = Number.parseFloat(price);
      if (!Number.isFinite(rupees) || rupees < 0) {
        toast.error(`${row.product?.name || 'A line'} has a price that is not a number.`);
        return;
      }
      payload.push({ productId, price: rupees, isAvailable });
    }

    if (payload.length === 0) return;

    setSaving(true);
    try {
      await saveMarketPrices(marketId, payload);
      toast.success(`${payload.length} price${payload.length === 1 ? '' : 's'} updated.`);
      await load();
    } catch (err) {
      onReport(err, 'Could not save the price sheet.');
    } finally {
      setSaving(false);
    }
  }

  /**
   * Sign off every line still outstanding, at the price it already carries.
   *
   * Sends only the outstanding ids, never the whole sheet: a line the owner has
   * already dealt with this morning does not need re-confirming, and a line
   * they are still thinking about — one with an unsaved edit — must not be
   * signed off behind them. `todo` is exactly that set.
   */
  async function confirmRest() {
    if (todo.length === 0) return;

    setConfirming(true);
    try {
      const ids = todo.map((r) => r.product?.id).filter(Boolean);
      await confirmMarketPrices(marketId, ids);
      toast.success(
        `${ids.length} line${ids.length === 1 ? '' : 's'} confirmed at yesterday's price.`
      );
      await load();
    } catch (err) {
      onReport(err, 'Could not confirm those prices.');
    } finally {
      setConfirming(false);
    }
  }

  if (loading) {
    return (
      <Card icon={<Tags className="w-5 h-5 text-amber-600" />} title="Price sheet">
        <div className="flex items-center gap-2 text-gray-500 text-sm py-4 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading prices…
        </div>
      </Card>
    );
  }

  const done = rows.length - todo.length;
  const allDone = rows.length > 0 && todo.length === 0;

  return (
    <>
      {rows.length > 0 && (
        <DailyRound
          done={done}
          total={rows.length}
          movedCount={moved.length}
          allDone={allDone}
          busy={confirming || saving}
          onConfirmRest={confirmRest}
        />
      )}

      <Card
        icon={<Tags className="w-5 h-5 text-amber-600" />}
        title={`Price sheet${rows.length ? ` (${rows.length})` : ''}`}
        action={
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="text-[12.5px] font-bold text-amber-800 flex items-center gap-1 hover:text-amber-600 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            Add line
          </button>
        }
      >
        {rows.length === 0 ? (
          <Empty>
            This market sells nothing yet. Add a line and it appears in the customer's catalog at
            the price you set.
          </Empty>
        ) : (
          <>
            <div className="flex items-center gap-1.5 flex-wrap">
              <Lens id="todo" lens={lens} onPick={setLens} count={todo.length}>
                To do
              </Lens>
              <Lens id="moved" lens={lens} onPick={setLens} count={moved.length}>
                Moved
              </Lens>
              <Lens id="all" lens={lens} onPick={setLens} count={rows.length}>
                All
              </Lens>
              <Lens
                id="off"
                lens={lens}
                onPick={setLens}
                count={rows.filter((r) => !current(r).isAvailable).length}
              >
                Off sale
              </Lens>
            </div>

            {rows.length > 6 && (
              <label className="relative block">
                <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <span className="sr-only">Search the price sheet</span>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Find a line…"
                  className="w-full border border-gray-200 rounded-xl pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
                />
              </label>
            )}

            {visible.length === 0 ? (
              <Empty>
                {query
                  ? `Nothing matches “${query}”.`
                  : lens === 'todo'
                    ? 'Every line has been dealt with today. Good morning’s work.'
                    : lens === 'moved'
                      ? 'No price has moved since yesterday.'
                      : 'Nothing here.'}
              </Empty>
            ) : (
              <div className="space-y-1.5">
                {visible.map((row) => (
                  <PriceRow
                    key={row.id}
                    row={row}
                    state={current(row)}
                    edited={Boolean(edits[row.product?.id])}
                    done={isDone(row)}
                    onEdit={edit}
                    onNudge={nudge}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </Card>

      {/* A save bar rather than a button inside the card: with a long sheet the
          control has to stay reachable from wherever the scroll ends up. */}
      {dirty.length > 0 && (
        <div className="sticky bottom-4 z-20 flex items-center gap-2 bg-white border border-amber-300 shadow-lg rounded-2xl p-2.5">
          <span className="flex-1 text-xs font-bold text-gray-700 pl-1">
            {dirty.length} unsaved change{dirty.length === 1 ? '' : 's'}
          </span>
          <button
            type="button"
            onClick={() => setEdits({})}
            disabled={saving}
            className="text-xs font-bold text-gray-500 px-3 py-2 rounded-xl hover:bg-gray-50 disabled:opacity-50 cursor-pointer"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="bg-[#1B4D3E] text-white text-xs font-bold px-4 py-2 rounded-xl flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            Save
          </button>
        </div>
      )}

      {adding && (
        <AddLineDialog
          marketId={marketId}
          alreadyListed={alreadyListed}
          onClose={() => setAdding(false)}
          onAdded={async (count) => {
            setAdding(false);
            toast.success(`${count} line${count === 1 ? '' : 's'} added to the sheet.`);
            await load();
          }}
          onReport={onReport}
        />
      )}
    </>
  );
}

/**
 * The header that makes this a daily job rather than a list.
 *
 * Leads with what is LEFT rather than what is done, because the outstanding
 * count is the thing the owner is working towards zero. The bulk confirm sits
 * here and nowhere else: it is the day's closing action, and putting it beside
 * the rows would invite tapping it while still halfway down the sheet.
 */
function DailyRound({ done, total, movedCount, allDone, busy, onConfirmRest }) {
  const left = total - done;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);

  return (
    <section
      className={`rounded-2xl p-4 border shadow-sm space-y-3 ${
        allDone ? 'bg-emerald-50 border-emerald-200' : 'bg-white border-amber-200'
      }`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
            allDone ? 'bg-emerald-100' : 'bg-amber-100'
          }`}
        >
          {allDone ? (
            <CircleCheck className="w-5 h-5 text-emerald-700" />
          ) : (
            <CalendarCheck className="w-5 h-5 text-amber-700" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <h3 className="font-extrabold text-gray-900 text-[15px]">
            {allDone ? "Today's prices are set" : "Today's price round"}
          </h3>
          <p className="text-[12.5px] text-gray-500 leading-snug">
            {allDone
              ? `All ${total} lines dealt with${movedCount > 0 ? `, ${movedCount} moved since yesterday` : ' — nothing moved since yesterday'}.`
              : `${left} of ${total} line${total === 1 ? '' : 's'} still carry yesterday's price.`}
          </p>
        </div>
      </div>

      {/* A bar rather than a bare fraction: the owner glances at this between
          crates, and a filled proportion is legible at arm's length in a way
          "31/40" is not. */}
      <div
        className="h-2 rounded-full bg-gray-100 overflow-hidden"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Lines dealt with today"
      >
        <div
          className={`h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none ${
            allDone ? 'bg-emerald-600' : 'bg-amber-600'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>

      {!allDone && (
        <button
          type="button"
          onClick={onConfirmRest}
          disabled={busy}
          className="w-full bg-amber-900 text-white text-xs font-bold py-2.5 rounded-xl flex items-center justify-center gap-1.5 hover:bg-amber-800 disabled:opacity-50 cursor-pointer"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
          The remaining {left} are unchanged today
        </button>
      )}
    </section>
  );
}

/** One filter chip. The count is the point — an empty lens says so before it is opened. */
function Lens({ id, lens, onPick, count, children }) {
  const active = lens === id;
  return (
    <button
      type="button"
      onClick={() => onPick(id)}
      aria-pressed={active}
      className={`px-2.5 py-1.5 rounded-full text-[12px] font-bold border transition-colors cursor-pointer ${
        active
          ? 'bg-amber-900 text-white border-amber-900'
          : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
      }`}
    >
      {children}
      <span className={active ? 'text-amber-200 ml-1' : 'text-gray-400 ml-1'}>{count}</span>
    </button>
  );
}

function PriceRow({ row, state, edited, done, onEdit, onNudge }) {
  const productId = row.product?.id;
  const delta = deltaFrom(row);

  return (
    <div
      className={`flex items-center gap-2 p-2 rounded-xl border ${
        edited
          ? 'bg-amber-50 border-amber-200'
          : done
            ? 'bg-white border-gray-100'
            : 'bg-amber-50/40 border-amber-100'
      } ${state.isAvailable ? '' : 'opacity-60'}`}
    >
      {row.product?.image && (
        <img
          src={row.product.image}
          alt=""
          className="w-9 h-9 rounded-lg object-cover shrink-0 bg-white"
          loading="lazy"
        />
      )}

      <div className="min-w-0 flex-1">
        <span className="font-bold text-xs text-gray-900 block truncate">
          {row.product?.name || 'Unknown product'}
        </span>
        <span className="text-[11.5px] text-gray-500 flex items-center gap-1.5">
          {row.product?.weight || ''}
          {delta && (
            <span
              className={`font-bold inline-flex items-center gap-0.5 ${
                delta.up ? 'text-red-600' : 'text-emerald-700'
              }`}
            >
              {delta.up ? (
                <TrendingUp className="w-3 h-3" />
              ) : (
                <TrendingDown className="w-3 h-3" />
              )}
              {delta.label}
            </span>
          )}
          {row.previousPricePaise === null && (
            <span className="text-amber-700 font-bold inline-flex items-center gap-0.5">
              <Sparkles className="w-3 h-3" />
              new
            </span>
          )}
        </span>
      </div>

      {/* Whole-rupee nudges. Hidden below `sm` only in the sense that they stay
          small — they are the primary gesture on a phone, not a desktop nicety,
          so they are not hidden at all. */}
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={() => onNudge(row, -1)}
          aria-label={`Reduce ${row.product?.name || 'this line'} by one rupee`}
          className="w-7 h-8 rounded-lg border border-gray-300 text-gray-600 text-sm font-bold flex items-center justify-center hover:bg-gray-50 cursor-pointer"
        >
          −
        </button>

        <div className="flex items-center gap-0.5">
          <span className="text-xs font-bold text-gray-400">₹</span>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={state.price}
            onChange={(e) => onEdit(productId, { price: e.target.value })}
            aria-label={`Price for ${row.product?.name || 'this line'}`}
            className="w-16 border border-gray-300 rounded-lg px-1.5 py-1.5 text-sm font-bold text-right focus:outline-none focus:ring-2 focus:ring-amber-500"
          />
        </div>

        <button
          type="button"
          onClick={() => onNudge(row, 1)}
          aria-label={`Raise ${row.product?.name || 'this line'} by one rupee`}
          className="w-7 h-8 rounded-lg border border-gray-300 text-gray-600 text-sm font-bold flex items-center justify-center hover:bg-gray-50 cursor-pointer"
        >
          +
        </button>
      </div>

      <button
        type="button"
        onClick={() => onEdit(productId, { isAvailable: !state.isAvailable })}
        aria-pressed={state.isAvailable}
        title={state.isAvailable ? 'Selling — tap to hide' : 'Hidden — tap to sell'}
        className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center border transition-colors cursor-pointer ${
          state.isAvailable
            ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
            : 'bg-white border-gray-300 text-gray-400'
        }`}
      >
        {state.isAvailable ? <Check className="w-4 h-4" /> : <PackageX className="w-4 h-4" />}
      </button>
    </div>
  );
}

/**
 * How far a line has moved since the close of yesterday.
 *
 * Returns null when there is nothing honest to say — no prior price (the line
 * is new today) or no movement. A zero delta is deliberately NOT rendered: a
 * row of "▲ 0%" against every unchanged line is noise that buries the handful
 * that did move, which is the only reason this column exists.
 */
function deltaFrom(row) {
  if (row.previousPricePaise === null || row.previousPricePaise === row.pricePaise) return null;

  const diff = row.pricePaise - row.previousPricePaise;
  const pct = row.previousPricePaise === 0 ? null : Math.round((diff / row.previousPricePaise) * 100);

  return {
    up: diff > 0,
    label: `₹${Math.abs(diff / 100).toFixed(2).replace(/\.00$/, '')}${pct === null ? '' : ` (${Math.abs(pct)}%)`}`,
  };
}

/**
 * Put a product on this market's sheet.
 *
 * Seeded with the platform catalog price as a starting point, not as the price
 * — the whole reason a market has its own sheet is that it charges its own
 * prices, so the number is editable before anything is written.
 */
function AddLineDialog({ marketId, alreadyListed, onClose, onAdded, onReport }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(true);
  const [picked, setPicked] = useState({}); // productId -> rupee string
  const [saving, setSaving] = useState(false);

  // Debounced so typing does not fire a request per keystroke.
  useEffect(() => {
    let cancelled = false;
    setSearching(true);

    const timer = setTimeout(async () => {
      try {
        const found = await fetchProducts({ search: query.trim() || undefined, limit: 60 });
        if (!cancelled) setResults(found.filter((p) => !alreadyListed.has(p.id)));
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, alreadyListed]);

  const chosen = Object.keys(picked);

  async function save() {
    const payload = [];
    for (const productId of chosen) {
      const rupees = Number.parseFloat(picked[productId]);
      if (!Number.isFinite(rupees) || rupees < 0) return;
      payload.push({ productId, price: rupees, isAvailable: true });
    }
    if (payload.length === 0) return;

    setSaving(true);
    try {
      await saveMarketPrices(marketId, payload);
      await onAdded(payload.length);
    } catch (err) {
      onReport(err, 'Could not add those lines.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title="Add to the price sheet" onClose={onClose}>
      <div className="space-y-3">
        <label className="relative block">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <span className="sr-only">Search the catalog</span>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the catalog…"
            className="w-full border border-gray-300 rounded-xl pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
          />
        </label>

        <div className="max-h-64 overflow-y-auto space-y-1.5 -mx-1 px-1">
          {searching ? (
            <div className="flex items-center gap-2 text-gray-500 text-xs py-6 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" />
              Searching…
            </div>
          ) : results.length === 0 ? (
            <Empty>
              {query.trim()
                ? `Nothing in the catalog matches “${query.trim()}” that you are not already selling.`
                : 'Every product in the catalog is already on your sheet.'}
            </Empty>
          ) : (
            results.map((p) => {
              const isPicked = picked[p.id] !== undefined;
              return (
                <div
                  key={p.id}
                  className={`flex items-center gap-2 p-2 rounded-xl border ${
                    isPicked ? 'bg-amber-50 border-amber-200' : 'bg-gray-50 border-gray-100'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() =>
                      setPicked((prev) => {
                        if (prev[p.id] !== undefined) {
                          const { [p.id]: _removed, ...rest } = prev;
                          return rest;
                        }
                        return { ...prev, [p.id]: String(p.price ?? 0) };
                      })
                    }
                    className="flex-1 min-w-0 text-left cursor-pointer"
                  >
                    <span className="font-bold text-xs text-gray-900 block truncate">{p.name}</span>
                    <span className="text-[11.5px] text-gray-500">
                      {p.weight || ''}
                      {p.price !== undefined ? ` • catalog ₹${p.price}` : ''}
                    </span>
                  </button>

                  {isPicked && (
                    <div className="flex items-center gap-1 shrink-0">
                      <span className="text-xs font-bold text-gray-400">₹</span>
                      <input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="0.01"
                        value={picked[p.id]}
                        onChange={(e) =>
                          setPicked((prev) => ({ ...prev, [p.id]: e.target.value }))
                        }
                        aria-label={`Your price for ${p.name}`}
                        className="w-20 border border-gray-300 rounded-lg px-2 py-1.5 text-sm font-bold text-right focus:outline-none focus:ring-2 focus:ring-amber-500"
                      />
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 bg-white border border-gray-300 text-gray-700 text-xs font-bold py-2.5 rounded-xl hover:bg-gray-50 cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={chosen.length === 0 || saving}
            className="flex-1 bg-[#1B4D3E] text-white text-xs font-bold py-2.5 rounded-xl flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            Add {chosen.length || ''}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function SettingsTab({ market, onSaved, onReport, toast }) {
  const [form, setForm] = useState(() => formFrom(market));
  const [saving, setSaving] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);

  // Switching market resets the form, so edits never leak across markets.
  const marketKey = market?.id;
  useEffect(() => {
    setForm(formFrom(market));
  }, [marketKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!market) return null;

  const changes = diffFrom(market, form);
  const dirty = Object.keys(changes).length > 0;

  async function commit(patch, message) {
    setSaving(true);
    try {
      const updated = await updateMarket(market.id, patch);
      onSaved(updated);
      setForm(formFrom(updated));
      toast.success(message);
      setConfirmOff(false);
    } catch (err) {
      onReport(err, 'Could not save those changes.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {/* Trading switches sit above the form and save on their own: closing a
          market is something you do in a hurry, and burying it behind a Save
          button next to eight text fields would be the wrong shape for it. */}
      <Card icon={<Store className="w-5 h-5 text-amber-600" />} title="Trading">
        <Toggle
          label="Open for orders"
          hint="Closed means no new order is offered to your stalls. Anything already accepted still goes out."
          checked={market.isOpen}
          disabled={saving || !market.isActive}
          onChange={(next) =>
            commit({ isOpen: next }, next ? 'Market is open.' : 'Market closed for orders.')
          }
        />
        <Toggle
          label="Listed to customers"
          hint="Switching this off removes the market from the app entirely. Use it between seasons, not to close for the night."
          checked={market.isActive}
          disabled={saving}
          danger
          onChange={(next) => {
            if (!next) return setConfirmOff(true);
            commit({ isActive: true }, 'Market is listed again.');
          }}
        />
      </Card>

      <Card icon={<Settings className="w-5 h-5 text-amber-600" />} title="Market details">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!dirty || saving) return;
            commit(changes, 'Saved.');
          }}
          className="space-y-3"
        >
          <Field label="Name">
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              maxLength={160}
              className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
            />
          </Field>

          <Field label="Address">
            <textarea
              value={form.address}
              onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
              maxLength={500}
              rows={2}
              className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-amber-500"
            />
          </Field>

          <Field label="Market office phone" hint="Shown to riders who cannot find a stall.">
            <input
              value={form.contactPhone}
              onChange={(e) => setForm((f) => ({ ...f, contactPhone: e.target.value }))}
              maxLength={20}
              inputMode="tel"
              className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
            />
          </Field>

          <Field
            label={`Delivery radius — ${(Number(form.serviceRadiusMeters) / 1000).toFixed(1)} km`}
            hint="Customers further out than this still see the market, marked as too far to deliver."
          >
            <input
              type="range"
              min="500"
              max="50000"
              step="500"
              value={form.serviceRadiusMeters}
              onChange={(e) => setForm((f) => ({ ...f, serviceRadiusMeters: e.target.value }))}
              className="w-full accent-amber-700 cursor-pointer"
            />
          </Field>

          {/* Coordinates are shown, not edited: moving a market is a map
              gesture, and a pair of raw decimal boxes is the classic way to end
              up with a market in the Indian Ocean because lat and lng were
              swapped. */}
          {market.lat !== null && market.lng !== null && (
            <p className="text-[12.5px] text-gray-400">
              Pinned at {Number(market.lat).toFixed(5)}, {Number(market.lng).toFixed(5)}
            </p>
          )}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={() => setForm(formFrom(market))}
              disabled={!dirty || saving}
              className="flex-1 bg-white border border-gray-300 text-gray-700 text-xs font-bold py-2.5 rounded-xl hover:bg-gray-50 disabled:opacity-40 cursor-pointer"
            >
              Reset
            </button>
            <button
              type="submit"
              disabled={!dirty || saving}
              className="flex-1 bg-[#1B4D3E] text-white text-xs font-bold py-2.5 rounded-xl flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              Save changes
            </button>
          </div>
        </form>
      </Card>

      <BoundaryCard market={market} onSaved={onSaved} onReport={onReport} toast={toast} />

      {confirmOff && (
        <Dialog title="Take this market off the app?" onClose={() => setConfirmOff(false)}>
          <div className="space-y-3">
            <p className="text-xs text-gray-600 leading-relaxed">
              Customers will not see {market.name} at all — not in the nearby list, not in search.
              Your traders, prices and history are kept, and switching it back on restores
              everything. To stop taking orders for a few hours, close the market instead.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmOff(false)}
                className="flex-1 bg-white border border-gray-300 text-gray-700 text-xs font-bold py-2.5 rounded-xl hover:bg-gray-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => commit({ isActive: false }, 'Market taken off the app.')}
                className="flex-1 bg-red-600 text-white text-xs font-bold py-2.5 rounded-xl flex items-center justify-center gap-1.5 disabled:opacity-50 cursor-pointer"
              >
                {saving ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <PackageX className="w-3.5 h-3.5" />
                )}
                Take it off
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}

/**
 * Set up a market.
 *
 * Pinned from the device's own position rather than a pair of decimal boxes.
 * The person filling this in is standing in the market — "use where I am" is
 * both the easiest answer and the accurate one, and it removes the classic way
 * to end up in the Indian Ocean, which is typing latitude into the longitude
 * field. There is no manual coordinate entry here on purpose.
 */
/**
 * The market's fence, in Settings — walk it, see it, redraw it.
 *
 * Its own card rather than a field in the settings form, because it is the one
 * setting on this screen that cannot be typed and does not save with the
 * others: it is the output of physically walking the market, and it commits
 * through its own endpoint the moment the walk is closed. Sitting it inside the
 * form would put a Save button next to something already saved.
 */
function BoundaryCard({ market, onSaved, onReport, toast }) {
  const [walking, setWalking] = useState(false);
  const [saving, setSaving] = useState(false);

  const boundary = market.boundary || null;
  const nodes = boundary?.nodes || [];

  async function commit(walked) {
    setWalking(false);
    setSaving(true);
    try {
      const result = await saveMarketBoundary(market.id, walked);
      // Merged into the market the dashboard already holds rather than
      // refetching: the response carries the stored boundary, and a reload here
      // would flash the whole settings screen for a change to one card.
      onSaved({ ...market, boundary: result.boundary });
      toast.success(
        `Boundary saved — ${walked.length} corners, about ${formatArea(result.areaSqMeters)}.`
      );
    } catch (err) {
      onReport(err, 'Could not save that boundary.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Card icon={<Footprints className="w-5 h-5 text-amber-600" />} title="Market boundary">
        <p className="text-[12.5px] text-gray-500 -mt-1 leading-relaxed">
          The outline of your market, walked corner by corner. A shopkeeper has to be standing
          inside it to apply for a stall here.
        </p>

        {boundary ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <Pill tone="green">{boundary.nodeCount} corners</Pill>
              <Pill tone="gray">{formatArea(boundary.areaSqMeters)}</Pill>
              {boundary.capturedAt && (
                <span className="text-[11.5px] text-gray-400">
                  walked {timeAgo(boundary.capturedAt)}
                </span>
              )}
            </div>

            <MiniOutline nodes={nodes} />

            <button
              type="button"
              onClick={() => setWalking(true)}
              disabled={saving}
              className="w-full bg-white border border-gray-300 text-gray-800 text-xs font-bold py-2.5 rounded-xl flex items-center justify-center gap-1.5 hover:bg-gray-50 disabled:opacity-50 cursor-pointer"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Footprints className="w-3.5 h-3.5" />}
              Walk it again
            </button>
            <p className="text-[11.5px] text-gray-400 text-center">
              Markets extend and stalls move. Re-walking replaces the old outline.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-700 mt-0.5 shrink-0" />
              <p className="text-[12px] text-amber-900 leading-snug">
                No boundary walked yet. Until there is one, a shopkeeper applying here is only
                checked against a rough radius around your pin — which will accept someone standing
                on the road outside.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setWalking(true)}
              disabled={saving}
              className="w-full bg-amber-900 text-white text-xs font-bold py-2.5 rounded-xl flex items-center justify-center gap-1.5 hover:bg-amber-800 disabled:opacity-50 cursor-pointer"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Footprints className="w-3.5 h-3.5" />}
              Walk the boundary
            </button>
          </div>
        )}
      </Card>

      {walking && (
        <BoundaryWalk
          title={boundary ? 'Re-walk the boundary' : 'Walk your market'}
          /* No initialNodes: a stored boundary comes back without the per-node
             accuracy the server demands on write, so its corners cannot be
             resumed — see the note in BoundaryWalk. The shape being replaced is
             on the card behind this dialog. */
          onCancel={() => setWalking(false)}
          onDone={commit}
        />
      )}
    </>
  );
}

/** A read-only thumbnail of a stored boundary. Same projection as the walk screen. */
function MiniOutline({ nodes }) {
  const W = 280;
  const H = 120;

  const shape = useMemo(() => {
    if (!nodes || nodes.length < 3) return null;

    const originLat = nodes.reduce((s, n) => s + n.lat, 0) / nodes.length;
    const mLat = 111320;
    const mLng = mLat * Math.cos((originLat * Math.PI) / 180);
    const pts = nodes.map((n) => ({ x: n.lng * mLng, y: -n.lat * mLat }));

    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const span = Math.max(maxX - minX, maxY - minY, 1);
    const scale = Math.min(W - 24, H - 24) / span;

    return pts
      .map((p) => {
        const x = W / 2 + (p.x - (minX + maxX) / 2) * scale;
        const y = H / 2 + (p.y - (minY + maxY) / 2) * scale;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }, [nodes]);

  if (!shape) return null;

  return (
    <div className="rounded-xl border border-gray-200 bg-[#FAF7F1] overflow-hidden">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full block" role="img" aria-label="Your market's outline">
        <polygon
          points={shape}
          fill="rgba(11,122,55,0.13)"
          stroke="#0B7A37"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

function formatArea(sqm) {
  if (!sqm) return '—';
  return sqm >= 100000
    ? `${(sqm / 1e6).toFixed(2)} km²`
    : `${Math.round(sqm).toLocaleString('en-IN')} m²`;
}

function CreateMarketDialog({ onClose, onCreated, onReport }) {
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [coords, setCoords] = useState(null);
  const [locating, setLocating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [boundary, setBoundary] = useState([]);
  const [walking, setWalking] = useState(false);

  async function locate() {
    setLocating(true);
    const found = await currentPosition();
    setLocating(false);
    if (!found) {
      onReport(
        new Error('Could not read your location. Allow location access and try again.'),
        'Could not read your location.'
      );
      return;
    }
    setCoords(found);
  }

  const ready = name.trim().length > 1 && address.trim().length > 3 && coords;

  async function submit(e) {
    e.preventDefault();
    if (!ready || saving) return;

    setSaving(true);
    try {
      const created = await createMarket({
        name: name.trim(),
        // Derived rather than asked for: a slug is a URL detail, and making
        // somebody invent one is a question about our database, not their
        // market. A random suffix keeps two "Rythu Bazaar"s from colliding on
        // the unique index.
        slug: slugify(name),
        address: address.trim(),
        lat: coords.lat,
        lng: coords.lng,
        ...(contactPhone.trim() ? { contactPhone: contactPhone.trim() } : {}),
        ...(boundary.length >= 3 ? { boundary } : {}),
      });
      onCreated(created);
    } catch (err) {
      onReport(err, 'Could not set up that market.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title="Set up your market" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Market name">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={160}
            placeholder="Rythu Bazaar, Mehdipatnam"
            className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
          />
        </Field>

        <Field label="Address" hint="What a rider would type into a map to get here.">
          <textarea
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            maxLength={500}
            rows={2}
            className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-amber-500"
          />
        </Field>

        <Field label="Market office phone" hint="Optional. Riders call this when a stall is hard to find.">
          <input
            value={contactPhone}
            onChange={(e) => setContactPhone(e.target.value)}
            maxLength={20}
            inputMode="tel"
            className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
          />
        </Field>

        <div className="p-3 bg-gray-50 rounded-xl border border-gray-100 space-y-2">
          <p className="text-[12.5px] text-gray-600 leading-snug">
            Which customers see this market is worked out from where it is, so stand in the market
            when you pin it.
          </p>
          <button
            type="button"
            onClick={locate}
            disabled={locating}
            className="w-full bg-white border border-gray-300 text-gray-800 text-xs font-bold py-2 rounded-lg flex items-center justify-center gap-1.5 hover:bg-gray-100 disabled:opacity-50 cursor-pointer"
          >
            {locating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MapPin className="w-3.5 h-3.5" />}
            {coords ? 'Re-pin here' : 'Pin where I am'}
          </button>
          {coords && (
            <p className="text-[12.5px] font-bold text-emerald-700 text-center">
              Pinned at {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}
            </p>
          )}
        </div>

        {/* The perimeter. Offered after the pin because the pin is one tap and
            this is a walk — putting the long task first reads as the price of
            entry, when in fact a market can be created without it and fenced
            later from Settings. */}
        <div className="p-3 bg-amber-50/70 rounded-xl border border-amber-200 space-y-2">
          <div className="flex items-start gap-2">
            <Footprints className="w-4 h-4 text-amber-700 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="text-[12.5px] font-bold text-amber-900">Walk the boundary</p>
              <p className="text-[12px] text-amber-800/80 leading-snug">
                Drop a point at each corner. Shopkeepers then have to be inside this outline to
                apply for a stall here.
              </p>
            </div>
          </div>

          {boundary.length > 0 ? (
            <div className="flex items-center gap-2">
              <span className="flex-1 text-[12.5px] font-bold text-emerald-700 flex items-center gap-1">
                <Check className="w-3.5 h-3.5" />
                {boundary.length} corners walked
              </span>
              <button
                type="button"
                onClick={() => setWalking(true)}
                className="text-[12px] font-bold text-amber-800 underline cursor-pointer"
              >
                Redo
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setWalking(true)}
              className="w-full bg-white border border-amber-300 text-amber-900 text-xs font-bold py-2 rounded-lg flex items-center justify-center gap-1.5 hover:bg-amber-100 cursor-pointer"
            >
              <Footprints className="w-3.5 h-3.5" />
              Start the walk
            </button>
          )}

          {/* Said plainly rather than hidden, because skipping is a real and
              reasonable choice — a market can be fenced later, and pretending
              otherwise would push someone into a bad walk to get past a form. */}
          <p className="text-[11.5px] text-amber-800/70 leading-snug">
            Optional now. Without it, being on site is checked against a rough radius instead.
          </p>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 bg-white border border-gray-300 text-gray-700 text-xs font-bold py-2.5 rounded-xl hover:bg-gray-50 cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!ready || saving}
            className="flex-1 bg-[#1B4D3E] text-white text-xs font-bold py-2.5 rounded-xl flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            Create market
          </button>
        </div>
      </form>

      {walking && (
        <BoundaryWalk
          title="Walk your market"
          initialNodes={boundary}
          onCancel={() => setWalking(false)}
          onDone={(nodes) => {
            setBoundary(nodes);
            setWalking(false);
          }}
        />
      )}
    </Dialog>
  );
}

/** A URL-safe, collision-resistant slug. The owner never sees or types this. */
function slugify(name) {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${base || 'market'}-${suffix}`;
}

function formFrom(market) {
  return {
    name: market?.name || '',
    address: market?.address || '',
    contactPhone: market?.contactPhone || '',
    serviceRadiusMeters: String(market?.serviceRadiusMeters ?? 6000),
  };
}

/**
 * Only what actually changed.
 *
 * PATCH /markets/:id refuses an empty body, and sending every field back would
 * make an unrelated save look like an edit to all of them.
 */
function diffFrom(market, form) {
  const changes = {};
  if (form.name.trim() && form.name.trim() !== market.name) changes.name = form.name.trim();
  if (form.address.trim() && form.address.trim() !== market.address) {
    changes.address = form.address.trim();
  }
  if (form.contactPhone.trim() !== (market.contactPhone || '')) {
    changes.contactPhone = form.contactPhone.trim();
  }
  const radius = Number(form.serviceRadiusMeters);
  if (Number.isFinite(radius) && radius !== market.serviceRadiusMeters) {
    changes.serviceRadiusMeters = radius;
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

/**
 * A modal that behaves like one: Escape closes it, the backdrop closes it,
 * focus starts inside it, and the page behind does not scroll away underneath.
 */
function Dialog({ title, onClose, children }) {
  const panelRef = useRef(null);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);

    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-end sm:items-center justify-center p-3"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="bg-white w-full max-w-md rounded-2xl shadow-2xl border border-gray-200 p-4 space-y-3 max-h-[90vh] overflow-y-auto animate-fade-in"
      >
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-extrabold text-sm text-gray-900">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-gray-400 hover:text-gray-700 cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function RefreshButton({ onClick, busy, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="text-gray-400 hover:text-gray-700 p-1 disabled:opacity-50 cursor-pointer"
      aria-label={label}
    >
      <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} />
    </button>
  );
}

function Toggle({ label, hint, checked, onChange, disabled, danger }) {
  return (
    <label
      className={`flex items-start gap-3 py-1.5 ${
        disabled ? 'opacity-50' : 'cursor-pointer'
      }`}
    >
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className={`mt-0.5 w-4 h-4 shrink-0 ${
          danger ? 'accent-red-600' : 'accent-emerald-700'
        } ${disabled ? '' : 'cursor-pointer'}`}
      />
      <span className="min-w-0">
        <span className="text-xs font-bold text-gray-900 block">{label}</span>
        <span className="text-[12.5px] text-gray-500 leading-snug block">{hint}</span>
      </span>
    </label>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="block space-y-1">
      <span className="text-[12.5px] font-bold text-gray-700 uppercase tracking-wide block">
        {label}
      </span>
      {children}
      {hint && <span className="text-[11.5px] text-gray-400 block leading-snug">{hint}</span>}
    </label>
  );
}

function Pill({ tone, children }) {
  const tones = {
    green: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    red: 'bg-red-50 text-red-700 border-red-200',
    gray: 'bg-gray-100 text-gray-500 border-gray-200',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-[11.5px] font-bold border ${tones[tone]}`}>
      {children}
    </span>
  );
}

function Metric({ label, value, tone }) {
  return (
    <div className="bg-black/20 p-2 rounded-xl backdrop-blur-xs">
      <div className="text-[11.5px] text-amber-200 font-semibold uppercase tracking-wider truncate">
        {label}
      </div>
      <div className={`text-base font-black truncate ${tone}`}>{value}</div>
    </div>
  );
}

function Figure({ label, value, tone }) {
  return (
    <div className="bg-white rounded-2xl p-3 border border-gray-200 shadow-sm">
      <div className="text-[11.5px] text-gray-500 font-semibold uppercase tracking-wider">
        {label}
      </div>
      <div className={`text-base font-black truncate ${tone}`}>{value}</div>
    </div>
  );
}

function Tally({ label, value, tone }) {
  return (
    <div className="bg-gray-50 rounded-xl p-2.5 border border-gray-100">
      <div className={`text-xl font-black ${tone}`}>{value}</div>
      <div className="text-[11.5px] text-gray-500 font-semibold uppercase tracking-wider">
        {label}
      </div>
    </div>
  );
}

function Card({ icon, title, action, children }) {
  return (
    <section className="bg-white rounded-2xl p-4 border border-gray-200 shadow-sm space-y-3">
      <div className="flex items-center justify-between gap-2 border-b border-gray-100 pb-2.5">
        <div className="flex items-center gap-2 min-w-0">
          {icon}
          <h3 className="font-extrabold text-sm text-gray-900 truncate">{title}</h3>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }) {
  return <p className="text-xs text-gray-500 py-2 leading-relaxed">{children}</p>;
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
