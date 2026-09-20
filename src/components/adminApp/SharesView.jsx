import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, Save, Trash2 } from 'lucide-react';
import {
  clearMarketSharePolicy,
  fetchAdminMarkets,
  fetchMarketSharePolicy,
  fetchSharePolicy,
  saveMarketSharePolicy,
  saveSharePolicy,
} from '../../services/admin';

const SHARE_FIELDS = [
  { key: 'platformBps', label: 'Platform' },
  { key: 'shopkeeperBps', label: 'Shopkeeper' },
  { key: 'deliveryBps', label: 'Delivery' },
  { key: 'marketOwnerBps', label: 'Market owner' },
  { key: 'customerIncentiveBps', label: 'Customer incentive' },
];

const emptyShareForm = () =>
  SHARE_FIELDS.reduce((form, field) => ({ ...form, [field.key]: '' }), {});

function percentFromBps(value) {
  if (value == null) return '';
  return String(Number(value) / 100);
}

function formatPercentFromBps(value) {
  if (value == null || Number.isNaN(value)) return 'inherit';
  return `${(Number(value) / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

function formFromPolicy(policy, { allowInherited = false } = {}) {
  const next = emptyShareForm();
  for (const field of SHARE_FIELDS) {
    const value = policy?.[field.key];
    next[field.key] = allowInherited && value == null ? '' : percentFromBps(value);
  }
  return next;
}

function parsePercentToBps(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  const number = Number(trimmed);
  if (!Number.isFinite(number) || number < 0 || number > 100) return Number.NaN;
  return Math.round(number * 100);
}

function resolveForm(form, fallbackPolicy, { allowInherited = false } = {}) {
  let hasInvalid = false;
  const explicit = {};
  const effective = {};

  for (const field of SHARE_FIELDS) {
    const parsed = parsePercentToBps(form[field.key]);
    if (Number.isNaN(parsed) || (!allowInherited && parsed == null)) {
      hasInvalid = true;
    }
    explicit[field.key] = parsed;
    effective[field.key] = parsed == null && allowInherited ? fallbackPolicy?.[field.key] : parsed;
    if (effective[field.key] == null || Number.isNaN(effective[field.key])) {
      hasInvalid = true;
    }
  }

  const totalBps = SHARE_FIELDS.reduce((sum, field) => sum + (effective[field.key] || 0), 0);
  return { explicit, effective, totalBps, isValid: !hasInvalid && totalBps === 10000 };
}

function shareBodyFromResolved(resolved, { allowInherited = false, promosEnabled }) {
  const body = {};
  for (const field of SHARE_FIELDS) {
    body[field.key] = allowInherited ? resolved.explicit[field.key] : resolved.effective[field.key];
  }
  if (promosEnabled !== undefined) body.promosEnabled = Boolean(promosEnabled);
  return body;
}

function ShareInputs({ form, onChange, inheritedPolicy, disabled = false }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
      {SHARE_FIELDS.map((field) => {
        const inherited = inheritedPolicy?.[field.key];
        const inherits = form[field.key] === '' && inherited != null;
        return (
          <label key={field.key} className="space-y-1.5">
            <span className="text-xs font-bold uppercase tracking-wide text-slate-500">
              {field.label}
            </span>
            <div className="relative">
              <input
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={form[field.key]}
                disabled={disabled}
                onChange={(event) => onChange(field.key, event.target.value)}
                placeholder={inherited == null ? '0' : formatPercentFromBps(inherited)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 pr-8 text-sm font-bold text-slate-900 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 disabled:bg-slate-50 disabled:text-slate-400"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-black text-slate-400">
                %
              </span>
            </div>
            {inherits && (
              <span className="text-[11.5px] font-semibold text-slate-400">
                Inherits {formatPercentFromBps(inherited)}
              </span>
            )}
          </label>
        );
      })}
    </div>
  );
}

export default function SharesView() {
  const [loading, setLoading] = useState(true);
  const [savingGlobal, setSavingGlobal] = useState(false);
  const [savingMarket, setSavingMarket] = useState(false);
  const [marketLoading, setMarketLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [globalPolicy, setGlobalPolicy] = useState(null);
  const [globalForm, setGlobalForm] = useState(emptyShareForm);
  const [globalPromosEnabled, setGlobalPromosEnabled] = useState(true);
  const [markets, setMarkets] = useState([]);
  const [editMarket, setEditMarket] = useState(false);
  const [selectedMarketId, setSelectedMarketId] = useState('');
  const [marketPolicy, setMarketPolicy] = useState(null);
  const [marketEffective, setMarketEffective] = useState(null);
  const [marketForm, setMarketForm] = useState(emptyShareForm);
  const [marketPromosEnabled, setMarketPromosEnabled] = useState(true);

  const loadInitial = async () => {
    try {
      setLoading(true);
      setError('');
      const [policy, marketRows] = await Promise.all([fetchSharePolicy(), fetchAdminMarkets()]);
      setGlobalPolicy(policy);
      setGlobalForm(formFromPolicy(policy));
      setGlobalPromosEnabled(policy?.promosEnabled !== false);
      setMarkets(marketRows || []);
      setSelectedMarketId((current) => current || marketRows?.[0]?.id || '');
    } catch (err) {
      setError(err?.message || 'Could not load share policies.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadInitial();
  }, []);

  useEffect(() => {
    if (!editMarket || !selectedMarketId) return;

    let cancelled = false;
    async function loadMarketPolicy() {
      try {
        setMarketLoading(true);
        setError('');
        const result = await fetchMarketSharePolicy(selectedMarketId);
        if (cancelled) return;
        setMarketPolicy(result.policy);
        setMarketEffective(result.effective);
        setMarketForm(formFromPolicy(result.policy, { allowInherited: true }));
        setMarketPromosEnabled(result.effective?.promosEnabled !== false);
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Could not load market override.');
      } finally {
        if (!cancelled) setMarketLoading(false);
      }
    }

    loadMarketPolicy();
    return () => {
      cancelled = true;
    };
  }, [editMarket, selectedMarketId]);

  const globalResolved = useMemo(() => resolveForm(globalForm, null), [globalForm]);
  const marketResolved = useMemo(
    () => resolveForm(marketForm, globalPolicy, { allowInherited: true }),
    [globalPolicy, marketForm]
  );

  const updateGlobalField = (key, value) => {
    setGlobalForm((current) => ({ ...current, [key]: value }));
  };

  const updateMarketField = (key, value) => {
    setMarketForm((current) => ({ ...current, [key]: value }));
  };

  const handleSaveGlobal = async () => {
    if (!globalResolved.isValid) return;
    try {
      setSavingGlobal(true);
      setError('');
      setNotice('');
      const policy = await saveSharePolicy(
        shareBodyFromResolved(globalResolved, { promosEnabled: globalPromosEnabled })
      );
      setGlobalPolicy(policy);
      setGlobalForm(formFromPolicy(policy));
      setGlobalPromosEnabled(policy?.promosEnabled !== false);
      setNotice('Global share policy saved.');
    } catch (err) {
      setError(err?.message || 'Could not save global share policy.');
    } finally {
      setSavingGlobal(false);
    }
  };

  const handleSaveMarket = async () => {
    if (!selectedMarketId || !marketResolved.isValid) return;
    try {
      setSavingMarket(true);
      setError('');
      setNotice('');
      const result = await saveMarketSharePolicy(
        selectedMarketId,
        shareBodyFromResolved(marketResolved, {
          allowInherited: true,
          promosEnabled: marketPromosEnabled,
        })
      );
      setMarketPolicy(result.policy);
      setMarketEffective(result.effective);
      setMarketForm(formFromPolicy(result.policy, { allowInherited: true }));
      setMarketPromosEnabled(result.effective?.promosEnabled !== false);
      setNotice('Market share override saved.');
    } catch (err) {
      setError(err?.message || 'Could not save market override.');
    } finally {
      setSavingMarket(false);
    }
  };

  const handleClearMarket = async () => {
    if (!selectedMarketId) return;
    try {
      setSavingMarket(true);
      setError('');
      setNotice('');
      const result = await clearMarketSharePolicy(selectedMarketId);
      setMarketPolicy(null);
      setMarketEffective(result.effective);
      setMarketForm(emptyShareForm());
      setMarketPromosEnabled(result.effective?.promosEnabled !== false);
      setNotice('Market override cleared.');
    } catch (err) {
      setError(err?.message || 'Could not clear market override.');
    } finally {
      setSavingMarket(false);
    }
  };

  const globalTotalClass = globalResolved.isValid ? 'text-emerald-700' : 'text-rose-700';
  const marketTotalClass = marketResolved.isValid ? 'text-emerald-700' : 'text-rose-700';

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-600">
            Shares
          </p>
          <h2 className="mt-2 text-2xl font-black tracking-tight text-slate-900">
            Settlement share policies
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">
            Configure the five settlement buckets. The total must be exactly 100% before saving.
          </p>
        </div>
        <button
          type="button"
          onClick={loadInitial}
          disabled={loading}
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-60"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs font-bold text-rose-800">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-xs font-bold text-emerald-800">
          {notice}
        </div>
      )}

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 className="text-lg font-black text-slate-900">Global policy</h3>
            <p className="mt-1 text-xs font-medium text-slate-500">
              Used by every market unless an override changes a field.
            </p>
          </div>
          <div className={`rounded-full px-3 py-1 text-xs font-black ${globalTotalClass} bg-slate-50`}>
            Total {(globalResolved.totalBps / 100).toFixed(2).replace(/\.?0+$/, '')}%
          </div>
        </div>

        {loading && !globalPolicy ? (
          <div className="py-10 text-center text-xs font-bold text-slate-400">
            <Loader2 className="mx-auto mb-2 h-6 w-6 animate-spin text-emerald-500" />
            Loading share policy...
          </div>
        ) : (
          <div className="mt-5 space-y-5">
            <ShareInputs form={globalForm} onChange={updateGlobalField} disabled={savingGlobal} />
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs font-semibold text-slate-500">
                Global promos are currently {globalPromosEnabled ? 'enabled' : 'disabled'} and are preserved on save.
              </p>
              <button
                type="button"
                onClick={handleSaveGlobal}
                disabled={!globalResolved.isValid || savingGlobal}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-xs font-black text-white shadow-sm transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {savingGlobal ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                Save global policy
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h3 className="text-lg font-black text-slate-900">Market override</h3>
            <p className="mt-1 max-w-2xl text-xs font-medium text-slate-500">
              Blank percentage fields inherit the global policy. Clear removes every stored override for the market.
            </p>
          </div>
          <label className="inline-flex items-center gap-2 text-xs font-black text-slate-700">
            <input
              type="checkbox"
              checked={editMarket}
              onChange={(event) => setEditMarket(event.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
            />
            Edit market override
          </label>
        </div>

        {editMarket && (
          <div className="mt-5 space-y-5">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
              <label className="space-y-1.5">
                <span className="text-xs font-bold uppercase tracking-wide text-slate-500">
                  Market
                </span>
                <select
                  value={selectedMarketId}
                  onChange={(event) => setSelectedMarketId(event.target.value)}
                  disabled={loading || marketLoading || savingMarket || markets.length === 0}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-900 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 disabled:bg-slate-50 disabled:text-slate-400"
                >
                  {markets.length === 0 ? (
                    <option value="">No markets found</option>
                  ) : (
                    markets.map((market) => (
                      <option key={market.id} value={market.id}>
                        {market.name}
                      </option>
                    ))
                  )}
                </select>
              </label>
              <div className={`rounded-full px-3 py-2 text-center text-xs font-black ${marketTotalClass} bg-slate-50`}>
                Effective total {(marketResolved.totalBps / 100).toFixed(2).replace(/\.?0+$/, '')}%
              </div>
            </div>

            {marketLoading ? (
              <div className="py-10 text-center text-xs font-bold text-slate-400">
                <Loader2 className="mx-auto mb-2 h-6 w-6 animate-spin text-emerald-500" />
                Loading market override...
              </div>
            ) : (
              <>
                <ShareInputs
                  form={marketForm}
                  onChange={updateMarketField}
                  inheritedPolicy={globalPolicy}
                  disabled={savingMarket || !selectedMarketId}
                />

                <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-black text-slate-900">Promotions</p>
                      <p className="mt-1 text-xs font-medium text-slate-500">
                        Market effective value: {marketEffective?.promosEnabled === false ? 'disabled' : 'enabled'}
                      </p>
                    </div>
                    <label className="inline-flex items-center gap-2 text-xs font-black text-slate-700">
                      <input
                        type="checkbox"
                        checked={marketPromosEnabled}
                        onChange={(event) => setMarketPromosEnabled(event.target.checked)}
                        disabled={savingMarket || !selectedMarketId}
                        className="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                      />
                      promosEnabled
                    </label>
                  </div>
                </div>

                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs font-semibold text-slate-500">
                    {marketPolicy ? 'This market has a stored override.' : 'This market currently inherits global percentages.'}
                  </p>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <button
                      type="button"
                      onClick={handleClearMarket}
                      disabled={!selectedMarketId || !marketPolicy || savingMarket}
                      className="inline-flex items-center justify-center gap-2 rounded-xl border border-rose-200 bg-white px-4 py-2 text-xs font-black text-rose-700 shadow-sm transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-300"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Clear override
                    </button>
                    <button
                      type="button"
                      onClick={handleSaveMarket}
                      disabled={!selectedMarketId || !marketResolved.isValid || savingMarket}
                      className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-xs font-black text-white shadow-sm transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                    >
                      {savingMarket ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                      Save override
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
