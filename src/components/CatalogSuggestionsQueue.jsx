import React, { useCallback, useEffect, useState } from 'react';
import { Camera, Check, Loader2, RefreshCw, X } from 'lucide-react';
import {
  acceptCatalogSuggestion,
  fetchCatalogSuggestions,
  rejectCatalogSuggestion,
} from '../services/catalogSuggestions';
import { ApiRequestError } from '../services/apiClient';
import { initialCategories } from '../data/mockData';

/**
 * Pending catalog-suggestion review list for market owners and developers.
 *
 * Accept requires a category/section — that is what places the new shared
 * catalog row under the right aisle for other shopkeepers' search-and-add.
 */
export default function CatalogSuggestionsQueue({
  categories = initialCategories,
  onReport,
  toast,
}) {
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [actingId, setActingId] = useState(null);
  const [acceptId, setAcceptId] = useState(null);
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? 1);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const data = await fetchCatalogSuggestions({ status: 'pending' });
      setRows(data);
    } catch (err) {
      const message = err instanceof ApiRequestError ? err.message : 'Could not load suggestions.';
      setError(message);
      onReport?.(message);
    } finally {
      setBusy(false);
    }
  }, [onReport]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleAccept = async (id) => {
    setActingId(id);
    setError('');
    try {
      await acceptCatalogSuggestion(id, { categoryId: Number(categoryId) });
      setRows((prev) => prev.filter((r) => r.id !== id));
      setAcceptId(null);
      toast?.('Added to shared catalog');
    } catch (err) {
      const message = err instanceof ApiRequestError ? err.message : 'Accept failed.';
      setError(message);
      onReport?.(message);
    } finally {
      setActingId(null);
    }
  };

  const handleReject = async (id) => {
    const reason = window.prompt('Optional reason for the shopkeeper:') || undefined;
    setActingId(id);
    setError('');
    try {
      await rejectCatalogSuggestion(id, reason ? { reason } : {});
      setRows((prev) => prev.filter((r) => r.id !== id));
      toast?.('Suggestion rejected');
    } catch (err) {
      const message = err instanceof ApiRequestError ? err.message : 'Reject failed.';
      setError(message);
      onReport?.(message);
    } finally {
      setActingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-black text-gray-900">Catalog suggestions</h3>
          <p className="text-xs font-semibold text-gray-500 mt-0.5">
            Approve custom listings into the shared catalog under a section.
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={busy}
          className="p-2 rounded-xl bg-gray-100 text-gray-600 disabled:opacity-50"
          aria-label="Refresh suggestions"
        >
          <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && (
        <p className="text-xs font-bold text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      {rows.length === 0 && !busy ? (
        <p className="text-sm font-bold text-gray-500 text-center py-10 bg-white rounded-2xl border border-gray-100">
          No pending suggestions.
        </p>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => {
            const shopkeeperName =
              typeof row.shopkeeper === 'object' ? row.shopkeeper?.name : null;
            const shopkeeperPhone =
              typeof row.shopkeeper === 'object' ? row.shopkeeper?.phone : null;
            const isAccepting = acceptId === row.id;

            return (
              <div
                key={row.id}
                className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 space-y-3"
              >
                <div className="flex gap-3 items-start">
                  {row.image ? (
                    <img
                      src={row.image}
                      alt=""
                      className="w-16 h-16 rounded-xl object-cover border border-gray-100 shrink-0"
                    />
                  ) : (
                    <div className="w-16 h-16 rounded-xl bg-gray-100 flex items-center justify-center shrink-0">
                      <Camera className="w-5 h-5 text-gray-300" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="font-black text-gray-900">{row.name}</p>
                    <p className="text-xs font-bold text-gray-500">{row.weight || 'No unit'}</p>
                    {(shopkeeperName || shopkeeperPhone) && (
                      <p className="text-[11.5px] font-semibold text-gray-400 mt-1">
                        {[shopkeeperName, shopkeeperPhone].filter(Boolean).join(' · ')}
                      </p>
                    )}
                  </div>
                </div>

                {isAccepting ? (
                  <div className="space-y-2 border-t border-gray-100 pt-3">
                    <label className="block text-xs font-bold text-gray-500">
                      Section for shared catalog
                    </label>
                    <select
                      value={categoryId}
                      onChange={(e) => setCategoryId(Number(e.target.value))}
                      className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 font-bold outline-none focus:border-green-500"
                    >
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.title}
                        </option>
                      ))}
                    </select>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => handleAccept(row.id)}
                        disabled={actingId === row.id}
                        className="flex-1 py-2.5 rounded-xl bg-green-600 text-white font-black text-sm disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
                      >
                        {actingId === row.id ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Check className="w-4 h-4" />
                        )}
                        Confirm
                      </button>
                      <button
                        type="button"
                        onClick={() => setAcceptId(null)}
                        className="px-4 py-2.5 rounded-xl bg-gray-100 text-gray-700 font-bold text-sm"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2 border-t border-gray-100 pt-3">
                    <button
                      type="button"
                      onClick={() => {
                        setAcceptId(row.id);
                        setCategoryId(categories[0]?.id ?? 1);
                      }}
                      disabled={actingId === row.id}
                      className="flex-1 py-2.5 rounded-xl bg-green-600 text-white font-black text-sm disabled:opacity-50"
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      onClick={() => handleReject(row.id)}
                      disabled={actingId === row.id}
                      className="flex-1 py-2.5 rounded-xl bg-red-50 text-red-700 font-black text-sm border border-red-100 disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
                    >
                      {actingId === row.id ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <X className="w-4 h-4" />
                      )}
                      Reject
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
