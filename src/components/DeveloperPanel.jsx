import React, { useState } from 'react';
import {
  Code,
  Terminal,
  Database,
  Copy,
  Check,
  UserPlus,
  Plus,
  Users,
  Wallet,
  CheckCircle2,
  TrendingUp,
} from 'lucide-react';

export default function DeveloperPanel({
  products,
  orders,
  categories,
  registeredUsers = [],
  onRegisterUser = () => {},
  walletTransactions = [],
}) {
  const [activeSubTab, setActiveSubTab] = useState('roles'); // 'roles' | 'payloads' | 'wallet'
  const [copied, setCopied] = useState(false);

  // Role-assignment form state. This grants a role to an account that already
  // exists — signing up happens through the app's own OTP flow, so there is
  // nothing here to create.
  const [regIdentifier, setRegIdentifier] = useState('');
  const [regRole, setRegRole] = useState('shopkeeper');
  const [isAssigningRole, setIsAssigningRole] = useState(false);

  const handleCopyJSON = () => {
    const fullDump = { categories, products, orders, registeredUsers };
    navigator.clipboard.writeText(JSON.stringify(fullDump, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleAddRoleSubmit = async (e) => {
    e.preventDefault();
    if (!regIdentifier.trim() || isAssigningRole) return;

    setIsAssigningRole(true);
    try {
      // Cleared only on success, so a mistyped number stays on screen to
      // correct rather than vanishing and leaving nothing to retry from.
      const assigned = await onRegisterUser({ identifier: regIdentifier, role: regRole });
      if (assigned) setRegIdentifier('');
    } finally {
      setIsAssigningRole(false);
    }
  };

  /** Role badge tone. No green anywhere here — blue carries the "this is the
   *  developer's own panel" meaning, so every other role gets a distinct,
   *  non-green tone instead of competing with it. */
  const roleBadgeClass = (role) => {
    switch (role) {
      case 'developer':
        return 'bg-blue-100 text-blue-700 border-blue-200';
      case 'shopkeeper':
        return 'bg-sky-100 text-sky-700 border-sky-200';
      case 'delivery':
        return 'bg-purple-100 text-purple-700 border-purple-200';
      case 'market_owner':
        return 'bg-amber-100 text-amber-700 border-amber-200';
      default:
        return 'bg-gray-100 text-gray-600 border-gray-200';
    }
  };

  return (
    <div className="p-4 space-y-4 pb-20 bg-blue-50/40 min-h-screen">
      {/* Header banner, styled like the other role dashboards: a dark
          gradient card on a light page, not a separate terminal theme. */}
      <div className="bg-gradient-to-r from-blue-900 via-blue-800 to-indigo-950 text-white p-4 rounded-2xl shadow-xl border border-blue-500/30">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2.5 bg-white/10 backdrop-blur-md rounded-xl border border-white/20 shrink-0">
              <Code className="w-6 h-6 text-blue-200" />
            </div>
            <div className="min-w-0">
              <h2 className="font-extrabold text-lg tracking-tight truncate">
                Developer Console &amp; Role Registry
              </h2>
              <p className="text-xs text-blue-100/80 font-medium truncate">
                Account registry &amp; system controls
              </p>
            </div>
          </div>
          <span className="px-2.5 py-1 bg-blue-400/20 text-blue-100 rounded-full text-[11px] font-bold border border-blue-300/30 flex items-center gap-1.5 shrink-0">
            <span className="w-2 h-2 rounded-full bg-blue-300 animate-pulse" />
            Registry Active
          </span>
        </div>

        <div className="grid grid-cols-3 gap-2 mt-4 pt-3 border-t border-white/10 text-center">
          <div>
            <div className="text-[10px] text-blue-200/80 uppercase tracking-wider font-bold">Accounts</div>
            <div className="text-base font-black text-blue-300">{registeredUsers.length}</div>
          </div>
          <div>
            <div className="text-[10px] text-blue-200/80 uppercase tracking-wider font-bold">Products</div>
            <div className="text-base font-black text-sky-300">{products.length}</div>
          </div>
          <div>
            <div className="text-[10px] text-blue-200/80 uppercase tracking-wider font-bold">Auth Mode</div>
            <div className="text-base font-black text-amber-300">Passwordless</div>
          </div>
        </div>
      </div>

      {/* Sub-tabs — one accent colour for the whole component, matching how
          the other panels use a single tone rather than one per tab. */}
      <div className="flex bg-white p-1 rounded-2xl border border-gray-200 shadow-sm text-xs font-bold">
        <button
          onClick={() => setActiveSubTab('roles')}
          className={`flex-1 py-2 rounded-xl flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
            activeSubTab === 'roles'
              ? 'bg-blue-600 text-white shadow-md'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          <Users className="w-3.5 h-3.5" />
          <span>Roles ({registeredUsers.length})</span>
        </button>

        <button
          onClick={() => setActiveSubTab('payloads')}
          className={`flex-1 py-2 rounded-xl flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
            activeSubTab === 'payloads'
              ? 'bg-blue-600 text-white shadow-md'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          <Terminal className="w-3.5 h-3.5" />
          <span>Raw JSON</span>
        </button>

        {/*
          The "Feature Flags" tab is gone.

          It listed four switches — passwordlessOtp, autoRoleDetection,
          expressDelivery10Min, mockPaymentGateway — each labelled "Active in
          production runtime" and each wired to nothing but a `useState` in this
          component. There is no feature-flag system on the server; the values
          reset on every reload and no request ever carried them. An operator
          toggling `mockPaymentGateway` off had every reason to believe they had
          just stopped mocking payments in production, and had done nothing at
          all. Behaviour is configured through environment variables validated at
          boot in config/env.js.
        */}

        <button
          onClick={() => setActiveSubTab('wallet')}
          className={`flex-1 py-2 rounded-xl flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
            activeSubTab === 'wallet'
              ? 'bg-blue-600 text-white shadow-md'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          <Wallet className="w-3.5 h-3.5" />
          <span>Wallet ({walletTransactions.length})</span>
        </button>
      </div>

      {/* TAB 1: REGISTERED USER ROLES REGISTRY */}
      {activeSubTab === 'roles' && (
        <div className="space-y-4">
          <form
            onSubmit={handleAddRoleSubmit}
            className="bg-white border border-gray-200 shadow-sm rounded-2xl p-4 space-y-3"
          >
            <div className="flex items-center gap-2">
              <UserPlus className="w-4 h-4 text-blue-600" />
              <h4 className="text-xs font-extrabold text-gray-900 uppercase tracking-wider">
                Assign a role to an existing account
              </h4>
            </div>

            <p className="text-[11px] text-gray-500 leading-relaxed">
              The person signs up in the app first (they start as a customer), then you
              grant the role here. Every device they are signed in on is signed out, so
              the new role takes effect on their next sign-in.
            </p>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <label className="block text-gray-500 font-bold mb-1 text-[11px] uppercase tracking-wide">
                  Their phone or email
                </label>
                <input
                  type="text"
                  value={regIdentifier}
                  onChange={(e) => setRegIdentifier(e.target.value)}
                  placeholder="9876543210 or manager@vegdrop.com"
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-sm font-semibold text-gray-900 focus:outline-none focus:border-blue-500"
                  required
                  disabled={isAssigningRole}
                />
              </div>

              <div>
                <label className="block text-gray-500 font-bold mb-1 text-[11px] uppercase tracking-wide">
                  Assign system role
                </label>
                <select
                  value={regRole}
                  onChange={(e) => setRegRole(e.target.value)}
                  disabled={isAssigningRole}
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-sm font-bold text-gray-900 focus:outline-none focus:border-blue-500"
                >
                  <option value="shopkeeper">🏪 Shopkeeper Panel</option>
                  <option value="delivery">🚚 Delivery Agent Panel</option>
                  <option value="developer">💻 Developer Console</option>
                  <option value="market_owner">📊 Market Owner Suite</option>
                  <option value="customer">🛒 Customer Storefront</option>
                </select>
              </div>
            </div>

            <button
              type="submit"
              disabled={isAssigningRole}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-extrabold py-2.5 rounded-xl text-xs flex items-center justify-center gap-1.5 transition-all shadow-md cursor-pointer active:scale-95 mt-1"
            >
              <Plus className="w-4 h-4" />
              <span>{isAssigningRole ? 'Assigning…' : 'Assign Role'}</span>
            </button>
          </form>

          <div className="bg-white border border-gray-200 shadow-sm rounded-2xl p-3 space-y-2">
            <h4 className="text-[11px] font-bold text-gray-400 uppercase tracking-wider px-1">
              Active registered credentials
            </h4>

            <div className="space-y-1.5 text-xs">
              {registeredUsers.map((u) => (
                <div
                  key={u.id}
                  className="p-2.5 bg-gray-50 rounded-xl border border-gray-100 flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    {/* Server accounts have no `identifier`; whichever contact
                        they signed up with is the one to type into the form. */}
                    <div className="font-bold text-gray-900 text-xs truncate">
                      {u.email || u.phone || u.name}
                    </div>
                    <div className="text-[10px] text-gray-500 truncate">
                      {u.name}{u.email && u.phone ? ` • ${u.phone}` : ''}
                    </div>
                  </div>

                  <span
                    className={`px-2.5 py-1 rounded-lg text-[10px] font-extrabold uppercase tracking-wider border shrink-0 ${roleBadgeClass(u.role)}`}
                  >
                    {u.role.replace('_', ' ')}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: RAW JSON PAYLOADS */}
      {activeSubTab === 'payloads' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-gray-500 font-semibold flex items-center gap-1.5">
              <Database className="w-4 h-4 text-blue-600" />
              Application state dump
            </span>
            <button
              onClick={handleCopyJSON}
              className="bg-white hover:bg-gray-50 text-blue-700 px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 border border-gray-200 shadow-sm cursor-pointer transition-colors"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-blue-600" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? 'Copied!' : 'Copy JSON'}</span>
            </button>
          </div>

          <div className="bg-gray-50 border border-gray-200 p-3 rounded-2xl font-mono text-[11px] text-gray-700 overflow-x-auto max-h-96 shadow-inner">
            <pre>{JSON.stringify({ categories, products, orders, registeredUsers }, null, 2)}</pre>
          </div>
        </div>
      )}

      {/* TAB 3: WALLET MANAGEMENT */}
      {activeSubTab === 'wallet' && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-white border border-gray-200 shadow-sm rounded-2xl p-4 text-center">
              <TrendingUp className="w-5 h-5 text-blue-600 mx-auto mb-1" />
              <div className="text-2xl font-black text-blue-700">
                {walletTransactions.length}
              </div>
              <div className="text-[10px] text-gray-500 font-bold uppercase tracking-wide">Total Transactions</div>
            </div>
            <div className="bg-white border border-gray-200 shadow-sm rounded-2xl p-4 text-center">
              <CheckCircle2 className="w-5 h-5 text-sky-600 mx-auto mb-1" />
              <div className="text-2xl font-black text-sky-700">
                {/* Filtered on `reason`, not on a `status` field the API has
                    never sent — that comparison matched nothing, so this read
                    ₹0 no matter how many top-ups had landed. Narrowed to
                    top-ups too: refunds and payouts are credits as well, and
                    counting them as "recharged" overstated it. */}
                ₹{walletTransactions
                  .filter(r => r.reason === 'razorpay_topup')
                  .reduce((s, r) => s + r.amount, 0)
                  .toLocaleString('en-IN')}
              </div>
              <div className="text-[10px] text-gray-500 font-bold uppercase tracking-wide">Total Recharged</div>
            </div>
          </div>

          <div className="bg-white border border-gray-200 shadow-sm rounded-2xl p-4 space-y-3">
            <h4 className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Razorpay Ledger</h4>
            {walletTransactions.length === 0 ? (
              <p className="text-gray-400 text-xs italic text-center py-4">No wallet transactions yet.</p>
            ) : (
              walletTransactions.map(req => (
                <div key={req.id} className="flex items-start justify-between gap-3 py-2 border-b border-gray-100 last:border-0">
                  <div className="min-w-0">
                    <p className="text-gray-900 text-xs font-bold">{req.label}</p>
                    {req.note && <p className="text-gray-400 text-[10px] truncate">{req.note}</p>}
                    <p className="text-gray-400 text-[10px]">
                      {req.timestamp ? new Date(req.timestamp).toLocaleString() : '—'}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className={`font-black text-sm ${req.type === 'credit' ? 'text-blue-600' : 'text-rose-600'}`}>
                      {req.type === 'credit' ? '+' : '−'}₹{req.amount.toLocaleString('en-IN')}
                    </p>
                    {/* The running balance. A status chip here was always
                        "undefined": the ledger only records money that moved,
                        so there is no pending or failed row to distinguish. */}
                    <p className="text-gray-400 text-[9px] font-mono">bal ₹{req.balanceAfter.toLocaleString('en-IN')}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
