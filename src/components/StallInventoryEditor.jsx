import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Boxes, Loader2, Search, Check, Zap } from 'lucide-react';

import { fetchStallInventory, saveStallInventory } from '../services/stalls';
import { fetchProducts } from '../services/products';

/**
 * What this stall has on the table right now.
 *
 * Declared stock is the only thing auto-accept runs on: `runAutoAccept` matches
 * an offered line against `StallInventory` rows with enough stock, and a stall
 * with the switch on but nothing declared simply never fires. With no screen to
 * declare any, auto-accept could not fire for anyone — the headline "answers in
 * milliseconds" behaviour was unreachable and every order waited on a human.
 *
 * WHAT THIS IS NOT
 *
 * It is not a ledger. The server draws these figures down when a claim is won
 * and treats a failed decrement as stale rather than fatal, because the produce
 * is on a physical table and the shopkeeper is the authority on it. Declaring
 * nothing is a legitimate choice — the stall just accepts by hand instead,
 * which is what the "accept" button on the offers screen is for.
 */
export default function StallInventoryEditor({ autoAccept = false, onOpenSettings }) {
  const [products, setProducts] = useState([]);
  const [rows, setRows] = useState({}); // productId -> string
  const [initial, setInitial] = useState({});
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        const [catalog, inventory] = await Promise.all([
          fetchProducts({ limit: 200 }),
          fetchStallInventory(),
        ]);
        if (cancelled) return;

        const byProduct = {};
        for (const row of inventory) {
          if (!row.product?.id) continue;
          byProduct[row.product.id] = String(row.stock);
        }

        setProducts(catalog);
        setRows(byProduct);
        setInitial(byProduct);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Could not load your stock.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const setRow = useCallback((productId, value) => {
    setSaved(false);
    setRows((prev) => ({ ...prev, [productId]: value }));
  }, []);

  /** Only changed rows: the endpoint upserts what it is given and ignores the rest. */
  const changed = useMemo(() => {
    const out = [];
    for (const [productId, raw] of Object.entries(rows)) {
      if (raw === '') continue;
      const stock = Number(raw);
      if (!Number.isInteger(stock) || stock < 0) continue;
      if (initial[productId] !== undefined && Number(initial[productId]) === stock) continue;
      out.push({ productId, stock });
    }
    return out;
  }, [rows, initial]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return products;
    return products.filter((p) => p.name.toLowerCase().includes(term));
  }, [products, search]);

  async function handleSave() {
    if (changed.length === 0) return;
    setSaving(true);
    setError(null);

    try {
      await saveStallInventory(changed);
      setInitial((prev) => {
        const next = { ...prev };
        for (const row of changed) next[row.productId] = String(row.stock);
        return next;
      });
      setSaved(true);
    } catch (err) {
      setError(err.message || 'Could not save your stock.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="bg-white rounded-2xl p-6 border border-gray-200 flex items-center justify-center gap-2 text-gray-500">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span className="text-sm font-semibold">Loading your stock…</span>
      </div>
    );
  }

  const declared = Object.values(rows).filter((v) => v !== '' && Number(v) > 0).length;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
      <div className="p-4 border-b border-gray-100 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-extrabold text-gray-900 flex items-center gap-2">
              <Boxes className="w-4 h-4 text-emerald-700" />
              On my table
            </h3>
            <p className="text-[11px] text-gray-500 font-medium">
              {declared} item{declared === 1 ? '' : 's'} declared.
            </p>
          </div>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || changed.length === 0}
            className="shrink-0 px-4 py-2 rounded-xl text-xs font-extrabold transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed bg-emerald-700 hover:bg-emerald-800 text-white"
          >
            {saving ? 'Saving…' : changed.length > 0 ? `Save ${changed.length}` : 'Saved'}
          </button>
        </div>

        {/*
          Stating the connection plainly. A shopkeeper who switches auto-accept
          on and declares nothing gets silence, and would have no way to know
          why — the two settings live on different screens.
        */}
        <div
          className={`rounded-xl p-2.5 border text-[11px] font-semibold leading-relaxed ${
            autoAccept
              ? declared > 0
                ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                : 'bg-amber-50 border-amber-200 text-amber-800'
              : 'bg-gray-50 border-gray-200 text-gray-600'
          }`}
        >
          <span className="inline-flex items-center gap-1 font-extrabold">
            <Zap className="w-3.5 h-3.5" />
            Auto-accept {autoAccept ? 'is on' : 'is off'}
          </span>
          {autoAccept ? (
            declared > 0 ? (
              ' — orders for these items are taken for you the moment they arrive.'
            ) : (
              ' — but nothing is declared, so it can never fire. Add quantities below.'
            )
          ) : (
            <>
              {' — you accept each order by hand. '}
              {onOpenSettings && (
                <button type="button" onClick={onOpenSettings} className="underline font-extrabold cursor-pointer">
                  Turn it on
                </button>
              )}
            </>
          )}
        </div>

        <div className="relative">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search items…"
            className="w-full bg-gray-50 border border-gray-200 rounded-xl pl-9 pr-3 py-2 text-sm font-semibold focus:border-emerald-500 outline-none"
          />
        </div>

        {error && (
          <p className="text-[11px] font-bold text-rose-600 bg-rose-50 border border-rose-200 rounded-lg p-2">
            {error}
          </p>
        )}
        {saved && changed.length === 0 && !error && (
          <p className="text-[11px] font-bold text-emerald-700 flex items-center gap-1">
            <Check className="w-3.5 h-3.5" /> Stock saved.
          </p>
        )}
      </div>

      <div className="max-h-[26rem] overflow-y-auto divide-y divide-gray-50">
        {visible.length === 0 && (
          <p className="p-6 text-center text-sm text-gray-400 font-semibold">No items match that search.</p>
        )}

        {visible.map((product) => {
          const value = rows[product.id] ?? '';
          const has = value !== '' && Number(value) > 0;

          return (
            <div key={product.id} className="p-3 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className={`text-sm font-bold truncate ${has ? 'text-gray-900' : 'text-gray-400'}`}>
                  {product.name}
                </p>
                <p className="text-[10px] text-gray-400 font-semibold">{product.weight || '—'}</p>
              </div>

              <input
                type="number"
                min="0"
                step="1"
                inputMode="numeric"
                value={value}
                onChange={(e) => setRow(product.id, e.target.value)}
                placeholder="0"
                className="w-20 bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5 text-sm font-bold text-right focus:border-emerald-500 outline-none shrink-0"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
