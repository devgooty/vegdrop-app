import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Store,
  Clock,
  XCircle,
  Loader2,
  ArrowLeft,
  MapPin,
  Check,
  Ban,
  LocateFixed,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';

import {
  fetchJoinableMarkets,
  requestToJoinMarket,
  withdrawJoinRequest,
  checkStallNumber,
  checkPresenceAtMarket,
} from '../services/markets';
import { liveFix } from '../services/geo';

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

  /** null = not checked, or { checking } | { available } | { failed } */
  const [numberCheck, setNumberCheck] = useState(null);

  /** null = not taken, or { checking } | { ok, message } */
  const [presence, setPresence] = useState(null);
  const [fix, setFix] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetchJoinableMarkets()
      .then((list) => !cancelled && setMarkets(list))
      .catch((err) => !cancelled && setError(err.message || 'Could not load markets.'));
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Everything already established is about the market that was chosen.
   *
   * Picking a different one has to clear both — a stall number verified free in
   * one market says nothing about another, and a location fix accepted at one
   * market is the strongest possible evidence of NOT being at the next.
   * Carrying either across would show a green tick for a claim nobody checked.
   */
  function choose(market) {
    setChosen(market);
    setNumberCheck(null);
    setPresence(null);
    setFix(null);
    setError(null);
  }

  /**
   * Ask whether the typed stall number is free, once typing settles.
   *
   * Debounced at 500ms and guarded by a sequence number: the answers are one
   * request per keystroke-burst and they can land out of order, so a slow reply
   * about "A-1" must not overwrite a fast one about "A-12". The ref holds the
   * id of the only request whose answer is still wanted.
   */
  const checkSeq = useRef(0);

  const runNumberCheck = useCallback(
    (marketId, value) => {
      const trimmed = value.trim();
      const seq = (checkSeq.current += 1);

      if (!trimmed || !marketId) {
        setNumberCheck(null);
        return;
      }

      setNumberCheck({ checking: true });

      checkStallNumber(marketId, trimmed)
        .then((result) => {
          if (seq !== checkSeq.current) return;
          setNumberCheck({ available: result.available, stallNumber: result.stallNumber });
        })
        .catch(() => {
          if (seq !== checkSeq.current) return;
          // A failed check is reported as unknown rather than as "taken". The
          // number may well be free, and blocking on our own outage would be
          // the wrong way round.
          setNumberCheck({ failed: true });
        });
    },
    []
  );

  useEffect(() => {
    if (!chosen || !stallNumber.trim()) {
      setNumberCheck(null);
      return undefined;
    }
    const timer = setTimeout(() => runNumberCheck(chosen.id, stallNumber), 500);
    return () => clearTimeout(timer);
  }, [chosen, stallNumber, runNumberCheck]);

  /**
   * Take a live fix and ask the server whether it lands inside the market.
   *
   * Two calls rather than one because the answer is worth showing BEFORE the
   * application is sent: told "you are 180 m outside" while still holding the
   * phone, the applicant can walk in. Told it on submit, they have filled in a
   * form to reach a dead end.
   */
  async function verifyHere() {
    if (!chosen) return;
    setPresence({ checking: true });
    setError(null);

    try {
      const taken = await liveFix();
      const verdict = await checkPresenceAtMarket(chosen.id, taken);
      setFix(verdict.ok ? taken : null);
      setPresence(verdict);
    } catch (err) {
      setFix(null);
      setPresence({ ok: false, message: err.message || 'Could not read your location.' });
    }
  }

  const needsPresence = Boolean(chosen?.hasBoundary);
  const presenceSettled = !needsPresence || Boolean(presence?.ok && fix);

  async function apply() {
    if (!chosen || !presenceSettled) return;
    setBusy(true);
    setError(null);
    try {
      /**
       * The fix is re-taken at submit rather than reusing the one from the
       * check above.
       *
       * The server bounds how old a fix may be, and an applicant may well have
       * verified, then typed a stall number and a trading name — easily longer
       * than that window. Reusing the earlier reading would fail as stale for
       * someone standing exactly where they said they were. Re-taking is one
       * extra second and it is the honest reading anyway.
       */
      const presenceNow = needsPresence || fix ? await liveFix().catch(() => null) : null;

      await requestToJoinMarket(chosen.id, {
        ...(stallNumber.trim() ? { stallNumber: stallNumber.trim() } : {}),
        ...(presenceNow ? { presence: presenceNow } : {}),
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
                onClick={() => choose(m)}
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
                    {/* Flagged on the card, before the market is picked, so
                        "you must be standing there" is not a surprise sprung
                        on someone who has already started an application. */}
                    {m.hasBoundary && (
                      <span className="text-[11.5px] text-[#0B7A37] font-bold inline-flex items-center gap-1 mt-1">
                        <ShieldCheck className="w-3 h-3" />
                        Apply from inside the market
                      </span>
                    )}
                  </div>
                  {selected && <Check className="w-5 h-5 text-[#0B7A37] shrink-0" />}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {chosen && (
        <div className="space-y-3 pt-1">
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

            <StallNumberNote check={numberCheck} />

            {/* Set honestly: the applicant's number is a proposal, and the owner
                confirms or changes it, because they are the one who knows which
                pitches are free. */}
            <span className="text-[12.5px] text-gray-400 block mt-1">
              The market owner confirms the final number when they accept you.
            </span>
          </label>

          <PresenceGate
            market={chosen}
            required={needsPresence}
            state={presence}
            onVerify={verifyHere}
          />

          <button
            onClick={apply}
            disabled={busy || !presenceSettled}
            className="w-full py-3 rounded-xl bg-[#0B7A37] text-white text-sm font-bold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            Ask to join {chosen.name}
          </button>

          {needsPresence && !presenceSettled && (
            <p className="text-[12px] text-gray-400 text-center -mt-1">
              Confirm you are at the market to send your request.
            </p>
          )}
        </div>
      )}
    </Shell>
  );
}

/**
 * Whether the typed stall number is already let.
 *
 * Worded as information rather than as a verdict, in every branch. "Taken" is
 * not a refusal — the owner settles the real number at approval and may place
 * the applicant elsewhere, and an applicant who genuinely trades at a number
 * our records show as let is exactly the conversation approval exists for.
 * Styling it as an error would tell them to give up on a true statement.
 */
function StallNumberNote({ check }) {
  if (!check) return null;

  if (check.checking) {
    return (
      <span className="text-[12.5px] text-gray-400 flex items-center gap-1 mt-1">
        <Loader2 className="w-3 h-3 animate-spin" />
        Checking…
      </span>
    );
  }

  if (check.failed) {
    // Silent rather than alarming: our check failing tells the applicant
    // nothing about their stall, so it should not occupy their attention.
    return null;
  }

  return check.available ? (
    <span className="text-[12.5px] text-[#0B7A37] font-bold flex items-center gap-1 mt-1">
      <Check className="w-3 h-3" />
      Stall {check.stallNumber} is free in this market.
    </span>
  ) : (
    <span className="text-[12.5px] text-amber-700 font-bold flex items-center gap-1.5 mt-1">
      <TriangleAlert className="w-3 h-3 shrink-0" />
      <span className="font-semibold">
        Stall {check.stallNumber} is already let here. Apply anyway if it is yours — the owner will
        sort out the number.
      </span>
    </span>
  );
}

/**
 * "Confirm you are standing in this market."
 *
 * Renders in two modes, and the difference is real rather than cosmetic: for a
 * market with a walked boundary this is a gate the application cannot pass
 * without, and for one without it is an optional courtesy that strengthens the
 * request. Saying which is which matters — presenting an optional step as a
 * requirement trains people to distrust the ones that are.
 */
function PresenceGate({ market, required, state, onVerify }) {
  const passed = Boolean(state?.ok);

  if (passed) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 flex items-start gap-2">
        <ShieldCheck className="w-4 h-4 text-emerald-700 mt-0.5 shrink-0" />
        <div className="min-w-0">
          <p className="text-[12.5px] font-bold text-emerald-800">
            Confirmed — you are at {market.name}.
          </p>
          {state.inside === false && state.metersOutside > 0 && (
            <p className="text-[11.5px] text-emerald-700/80">
              About {state.metersOutside} m from the edge, within the allowance.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`rounded-xl border p-3 space-y-2 ${
        required ? 'border-amber-200 bg-amber-50' : 'border-gray-200 bg-gray-50'
      }`}
    >
      <div className="flex items-start gap-2">
        <LocateFixed
          className={`w-4 h-4 mt-0.5 shrink-0 ${required ? 'text-amber-700' : 'text-gray-400'}`}
        />
        <div className="min-w-0">
          <p className={`text-[12.5px] font-bold ${required ? 'text-amber-900' : 'text-gray-700'}`}>
            {required ? 'This market checks you are on site' : 'Confirm you are here (optional)'}
          </p>
          <p className={`text-[11.5px] leading-snug ${required ? 'text-amber-800/80' : 'text-gray-500'}`}>
            {required
              ? 'Stand inside the market and take a location reading. Your request cannot be sent without it.'
              : 'Not required for this market, but it tells the owner you are a real trader here.'}
          </p>
        </div>
      </div>

      {state && !state.checking && !state.ok && (
        <p className="text-[12px] font-semibold text-red-700 bg-red-50 border border-red-200 rounded-lg px-2.5 py-2">
          {state.message}
        </p>
      )}

      <button
        type="button"
        onClick={onVerify}
        disabled={state?.checking}
        className={`w-full py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-50 cursor-pointer ${
          required
            ? 'bg-amber-900 text-white hover:bg-amber-800'
            : 'bg-white border border-gray-300 text-gray-800 hover:bg-gray-50'
        }`}
      >
        {state?.checking ? (
          <>
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Finding you…
          </>
        ) : (
          <>
            <LocateFixed className="w-3.5 h-3.5" />
            {state ? 'Try again' : "I'm at the market"}
          </>
        )}
      </button>
    </div>
  );
}

function Shell({ children }) {
  return (
    <div className="min-h-screen bg-[#F6F8F6] px-4 py-8">
      <div className="max-w-md mx-auto space-y-4">{children}</div>
    </div>
  );
}
