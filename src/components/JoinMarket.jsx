import React, { useEffect, useState } from 'react';
import { Store, Clock, XCircle, Loader2, ArrowLeft, MapPin, Check, Ban } from 'lucide-react';

import {
  fetchJoinableMarkets,
  requestToJoinMarket,
  withdrawJoinRequest,
} from '../services/markets';

/**
 * A shopkeeper asking to trade in a market.
 *
 * The counterpart already existed — a market owner could open a stall for
 * someone via POST /markets/:id/stalls — but it needs the owner to know the
 * applicant's user id, which is not something one trader can discover about
 * another. In practice that only worked for people already known off-platform.
 * This is the direction that scales: the shopkeeper introduces themselves.
 *
 * The states are told apart deliberately. Waiting and refused are very different
 * situations, and collapsing them into "you have no stall" invites the first to
 * apply again — creating a duplicate the server then rejects — and leaves the
 * second waiting on a decision that has already been made.
 */
export default function JoinMarket({ request, onChanged, onBack }) {
  const status = request?.status ?? null;

  if (status === 'pending') return <Waiting request={request} onChanged={onChanged} />;

  /**
   * Accepted, then switched off by the market owner.
   *
   * This must not fall through to the picker. A suspended stall is still an
   * approved one, so it occupies the shopkeeper's slot in the partial unique
   * index on `owner` — applying to another market comes back 409 "you already
   * run a stall". Offering the picker here would be offering the one thing that
   * cannot work.
   */
  if (status === 'approved' && request?.isActive === false) {
    return <Suspended request={request} />;
  }

  return <Picker request={request} onChanged={onChanged} onBack={onBack} />;
}

/** Suspended: the stall exists, it is simply switched off. */
function Suspended({ request }) {
  return (
    <Shell>
      <div className="text-center space-y-3">
        <div className="w-14 h-14 rounded-full bg-red-50 border border-red-200 flex items-center justify-center mx-auto">
          <Ban className="w-7 h-7 text-red-600" />
        </div>
        <h1 className="text-xl font-extrabold text-gray-900">Your stall is suspended</h1>
        <p className="text-sm text-gray-600">
          The market has switched off stall {request.proposedStallNumber}, so you will not be
          offered new orders for now.
        </p>
        <p className="text-xs text-gray-500">
          Nothing has been deleted — your stall and your earnings are exactly as you left them, and
          the market can switch it back on. Speak to the market office to sort it out.
        </p>
      </div>
    </Shell>
  );
}

/** Applied, and the market owner has not decided. */
function Waiting({ request, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function withdraw() {
    setBusy(true);
    setError(null);
    try {
      await withdrawJoinRequest();
      await onChanged();
    } catch (err) {
      setError(err.message || 'Could not withdraw that request.');
      setBusy(false);
    }
  }

  return (
    <Shell>
      <div className="text-center space-y-3">
        <div className="w-14 h-14 rounded-full bg-amber-100 flex items-center justify-center mx-auto">
          <Clock className="w-7 h-7 text-amber-700" />
        </div>
        <h1 className="text-xl font-extrabold text-gray-900">Waiting for approval</h1>
        <p className="text-sm text-gray-600">
          You asked to trade at{' '}
          <span className="font-bold text-gray-900">{request?.market?.name || 'this market'}</span>.
          The market owner has been told and will accept or decline. You will get an email either
          way.
        </p>
        <p className="text-xs text-gray-400">Asked {new Date(request.requestedAt).toLocaleString()}</p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl p-3">
          {error}
        </div>
      )}

      <button
        onClick={withdraw}
        disabled={busy}
        className="w-full py-3 rounded-xl border border-gray-300 text-gray-700 text-sm font-bold disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {busy && <Loader2 className="w-4 h-4 animate-spin" />}
        Withdraw and choose another market
      </button>
    </Shell>
  );
}

/** No live application: choose a market and apply. */
function Picker({ request, onChanged, onBack }) {
  const [markets, setMarkets] = useState(null);
  const [chosen, setChosen] = useState(null);
  const [stallNumber, setStallNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetchJoinableMarkets()
      .then((list) => !cancelled && setMarkets(list))
      .catch((err) => !cancelled && setError(err.message || 'Could not load markets.'));
    return () => {
      cancelled = true;
    };
  }, []);

  async function apply() {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      await requestToJoinMarket(chosen.id, {
        ...(stallNumber.trim() ? { stallNumber: stallNumber.trim() } : {}),
      });
      await onChanged();
    } catch (err) {
      setError(err.message || 'Could not send that request.');
      setBusy(false);
    }
  }

  return (
    <Shell>
      {onBack && (
        <button
          onClick={onBack}
          className="text-sm text-gray-500 font-semibold flex items-center gap-1 -mt-1"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>
      )}

      {/* A previous refusal, with whatever the owner said about it. */}
      {request?.status === 'rejected' && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 space-y-1">
          <div className="flex items-center gap-2 text-red-800 font-bold text-sm">
            <XCircle className="w-4 h-4" />
            Your last request was declined
          </div>
          {request.rejectionReason && (
            <p className="text-xs text-red-700">“{request.rejectionReason}”</p>
          )}
          <p className="text-xs text-red-700/80">You can apply to a different market below.</p>
        </div>
      )}

      <div className="space-y-1">
        <h1 className="text-xl font-extrabold text-gray-900">Join a market</h1>
        <p className="text-sm text-gray-600">
          Pick the market you trade at. The owner accepts you before you can start selling.
        </p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl p-3">
          {error}
        </div>
      )}

      {markets === null ? (
        <div className="py-8 flex justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
        </div>
      ) : markets.length === 0 ? (
        <p className="text-sm text-gray-500 py-4 text-center">
          No markets are open to new stalls right now.
        </p>
      ) : (
        <div className="space-y-2">
          {markets.map((m) => {
            const selected = chosen?.id === m.id;
            return (
              <button
                key={m.id}
                onClick={() => setChosen(m)}
                className={`w-full text-left p-3 rounded-xl border transition ${
                  selected
                    ? 'border-[#0B7A37] bg-emerald-50 ring-1 ring-[#0B7A37]'
                    : 'border-gray-200 bg-white'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-bold text-sm text-gray-900 block truncate">
                      <Store className="w-3.5 h-3.5 inline mr-1 text-gray-400" />
                      {m.name}
                    </span>
                    <span className="text-xs text-gray-500 block truncate">
                      <MapPin className="w-3 h-3 inline mr-0.5" />
                      {m.address}
                    </span>
                  </div>
                  {selected && <Check className="w-5 h-5 text-[#0B7A37] shrink-0" />}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {chosen && (
        <div className="space-y-2 pt-1">
          <label className="block">
            <span className="text-xs font-bold text-gray-700 block mb-1">
              Your stall number (optional)
            </span>
            <input
              value={stallNumber}
              onChange={(e) => setStallNumber(e.target.value)}
              placeholder="e.g. A-12"
              maxLength={24}
              className="w-full px-3 py-2.5 rounded-xl border border-gray-300 text-sm"
            />
            {/* Set honestly: the applicant's number is a proposal, and the owner
                confirms or changes it, because they are the one who knows which
                pitches are free. */}
            <span className="text-[11px] text-gray-400 block mt-1">
              The market owner confirms the final number when they accept you.
            </span>
          </label>

          <button
            onClick={apply}
            disabled={busy}
            className="w-full py-3 rounded-xl bg-[#0B7A37] text-white text-sm font-bold disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            Ask to join {chosen.name}
          </button>
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div className="min-h-screen bg-[#F6F8F6] px-4 py-8">
      <div className="max-w-md mx-auto space-y-4">{children}</div>
    </div>
  );
}
