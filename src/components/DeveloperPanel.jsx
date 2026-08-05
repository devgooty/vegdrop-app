import React, { useState } from 'react';
import {
  Code,
  Terminal,
  Database,
  Sliders,
  Copy,
  Check,
  UserPlus,
  ShieldAlert,
  Plus,
  Trash2,
  Users,
  Wallet,
  CheckCircle2,
  XCircle,
  Clock,
  TrendingUp
} from 'lucide-react';

export default function DeveloperPanel({
  products,
  orders,
  categories,
  registeredUsers = [],
  onRegisterUser = () => {},
  walletTransactions = [],
}) {
  const [activeSubTab, setActiveSubTab] = useState('roles'); // 'roles' | 'payloads' | 'flags' | 'wallet'
  const [copied, setCopied] = useState(false);

  // Role-assignment form state. This grants a role to an account that already
  // exists — signing up happens through the app's own OTP flow, so there is
  // nothing here to create.
  const [regIdentifier, setRegIdentifier] = useState('');
  const [regRole, setRegRole] = useState('shopkeeper');
  const [isAssigningRole, setIsAssigningRole] = useState(false);

  const [featureFlags, setFeatureFlags] = useState({
    passwordlessOtp: true,
    autoRoleDetection: true,
    expressDelivery10Min: true,
    mockPaymentGateway: true,
  });

  const handleCopyJSON = () => {
    const fullDump = { categories, products, orders, registeredUsers };
    navigator.clipboard.writeText(JSON.stringify(fullDump, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const toggleFlag = (flagKey) => {
    setFeatureFlags((prev) => ({ ...prev, [flagKey]: !prev[flagKey] }));
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

  return (
    <div className="p-4 space-y-4 pb-20 bg-slate-950 text-slate-100 min-h-screen font-sans">
      {/* Header Banner for Developer */}
      <div className="bg-gradient-to-r from-slate-900 to-cyan-950 text-white p-4 rounded-2xl border border-cyan-500/30 shadow-2xl relative overflow-hidden">
        <div className="flex items-center justify-between relative z-10">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-cyan-500/10 rounded-xl border border-cyan-500/30 text-cyan-400">
              <Code className="w-6 h-6" />
            </div>
            <div>
              <h2 className="font-mono font-extrabold text-lg tracking-tight text-cyan-400">
                Developer Console & Role Registry
              </h2>
              <p className="text-xs text-slate-400 font-medium">
                Auto-Role Detection Database & System Controls
              </p>
            </div>
          </div>
          <span className="px-2.5 py-1 bg-cyan-500/20 text-cyan-300 rounded-full text-[11px] font-mono font-bold border border-cyan-400/30 flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping" />
            Registry Active
          </span>
        </div>

        {/* Quick Diagnostics Bar */}
        <div className="grid grid-cols-3 gap-2 mt-4 pt-3 border-t border-slate-800 text-center font-mono text-xs">
          <div className="bg-slate-900/80 p-2 rounded-xl border border-slate-800">
            <div className="text-[10px] text-slate-400 uppercase">Registered Accounts</div>
            <div className="text-base font-bold text-cyan-400">{registeredUsers.length} Users</div>
          </div>
          <div className="bg-slate-900/80 p-2 rounded-xl border border-slate-800">
            <div className="text-[10px] text-slate-400 uppercase">Products Loaded</div>
            <div className="text-base font-bold text-emerald-400">{products.length}</div>
          </div>
          <div className="bg-slate-900/80 p-2 rounded-xl border border-slate-800">
            <div className="text-[10px] text-slate-400 uppercase">Auth Mode</div>
            <div className="text-base font-bold text-amber-400">Passwordless</div>
          </div>
        </div>
      </div>

      {/* Developer Sub-Tabs */}
      <div className="flex bg-slate-900 p-1 rounded-2xl border border-slate-800 text-xs font-mono">
        <button
          onClick={() => setActiveSubTab('roles')}
          className={`flex-1 py-2 rounded-xl flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
            activeSubTab === 'roles'
              ? 'bg-cyan-600 text-white font-bold shadow-md'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Users className="w-3.5 h-3.5" />
          <span>Registered Roles ({registeredUsers.length})</span>
        </button>

        <button
          onClick={() => setActiveSubTab('payloads')}
          className={`flex-1 py-2 rounded-xl flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
            activeSubTab === 'payloads'
              ? 'bg-cyan-600 text-white font-bold shadow-md'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Terminal className="w-3.5 h-3.5" />
          <span>Raw JSON State</span>
        </button>

        <button
          onClick={() => setActiveSubTab('flags')}
          className={`flex-1 py-2 rounded-xl flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
            activeSubTab === 'flags'
              ? 'bg-cyan-600 text-white font-bold shadow-md'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Sliders className="w-3.5 h-3.5" />
          <span>Feature Flags</span>
        </button>

        <button
          onClick={() => setActiveSubTab('wallet')}
          className={`flex-1 py-2 rounded-xl flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
            activeSubTab === 'wallet'
              ? 'bg-yellow-500 text-slate-900 font-bold shadow-md'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Wallet className="w-3.5 h-3.5" />
          <span>💰 Wallet ({walletTransactions.length})</span>
        </button>
      </div>

      {/* TAB 1: REGISTERED USER ROLES REGISTRY */}
      {activeSubTab === 'roles' && (
        <div className="space-y-4">
          {/* Register New Email / Phone Form */}
          <form
            onSubmit={handleAddRoleSubmit}
            className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3"
          >
            <div className="flex items-center gap-2">
              <UserPlus className="w-4 h-4 text-cyan-400" />
              <h4 className="font-mono text-xs font-bold text-cyan-400 uppercase tracking-wider">
                Assign a Role to an Existing Account
              </h4>
            </div>

            <p className="text-[11px] text-slate-400 font-mono leading-relaxed">
              The person signs up in the app first (they start as a customer), then you
              grant the role here. Every device they are signed in on is signed out, so
              the new role takes effect on their next sign-in.
            </p>

            <div className="grid grid-cols-2 gap-2 text-xs font-mono">
              <div>
                <label className="block text-slate-400 mb-1 text-[11px]">Their Phone or Email</label>
                <input
                  type="text"
                  value={regIdentifier}
                  onChange={(e) => setRegIdentifier(e.target.value)}
                  placeholder="9876543210 or manager@vegdrop.com"
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-cyan-300 focus:outline-none focus:border-cyan-400"
                  required
                  disabled={isAssigningRole}
                />
              </div>

              <div>
                <label className="block text-slate-400 mb-1 text-[11px]">Assign System Role</label>
                <select
                  value={regRole}
                  onChange={(e) => setRegRole(e.target.value)}
                  disabled={isAssigningRole}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-cyan-400 font-bold focus:outline-none focus:border-cyan-400"
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
              className="w-full bg-cyan-600 hover:bg-cyan-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-mono font-bold py-2 rounded-xl text-xs flex items-center justify-center gap-1.5 transition-all shadow-md cursor-pointer mt-1"
            >
              <Plus className="w-4 h-4" />
              <span>{isAssigningRole ? 'Assigning…' : 'Assign Role'}</span>
            </button>
          </form>

          {/* Registered Users Table */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-3 space-y-2">
            <h4 className="font-mono text-xs font-bold text-slate-300 uppercase tracking-wider px-1">
              Active Registered Credentials List
            </h4>

            <div className="space-y-1.5 text-xs font-mono">
              {registeredUsers.map((u) => (
                <div
                  key={u.id}
                  className="p-2.5 bg-slate-950/80 rounded-xl border border-slate-800 flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    {/* Server accounts have no `identifier`; whichever contact
                        they signed up with is the one to type into the form. */}
                    <div className="font-bold text-cyan-300 text-xs truncate">
                      {u.email || u.phone || u.name}
                    </div>
                    <div className="text-[10px] text-slate-400 truncate">
                      {u.name}{u.email && u.phone ? ` • ${u.phone}` : ''}
                    </div>
                  </div>

                  <span
                    className={`px-2.5 py-1 rounded-lg text-[10px] font-extrabold uppercase tracking-wider ${
                      u.role === 'shopkeeper'
                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                        : u.role === 'delivery'
                        ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30'
                        : u.role === 'developer'
                        ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                        : u.role === 'market_owner'
                        ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                        : 'bg-slate-800 text-slate-300'
                    }`}
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
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs text-slate-400 flex items-center gap-1.5">
              <Database className="w-4 h-4 text-cyan-400" />
              Application Global State Tree Dump
            </span>
            <button
              onClick={handleCopyJSON}
              className="bg-slate-800 hover:bg-slate-700 text-cyan-300 px-3 py-1 rounded-lg text-xs font-mono flex items-center gap-1 border border-slate-700 cursor-pointer"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? 'Copied Dump!' : 'Copy JSON'}</span>
            </button>
          </div>

          <div className="bg-slate-900 border border-slate-800 p-3 rounded-2xl font-mono text-[11px] text-cyan-300 overflow-x-auto max-h-96 shadow-inner">
            <pre>{JSON.stringify({ categories, products, orders, registeredUsers }, null, 2)}</pre>
          </div>
        </div>
      )}

      {/* TAB 3: FEATURE FLAGS */}
      {activeSubTab === 'flags' && (
        <div className="space-y-3">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
            <h4 className="font-mono text-xs font-bold text-cyan-400 uppercase tracking-wider mb-2">
              System Feature Flag Toggles
            </h4>

            {Object.entries(featureFlags).map(([key, enabled]) => (
              <div
                key={key}
                className="flex items-center justify-between p-2.5 bg-slate-950/60 rounded-xl border border-slate-800"
              >
                <div>
                  <span className="font-mono text-xs font-bold text-slate-200 block">{key}</span>
                  <span className="text-[10px] text-slate-400">
                    {enabled ? 'Active in production runtime' : 'Disabled'}
                  </span>
                </div>

                <button
                  onClick={() => toggleFlag(key)}
                  className={`px-3 py-1 rounded-lg font-mono text-xs font-bold transition-all cursor-pointer ${
                    enabled
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                      : 'bg-rose-500/20 text-rose-400 border border-rose-500/40'
                  }`}
                >
                  {enabled ? 'ENABLED' : 'DISABLED'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TAB 4: WALLET MANAGEMENT */}
      {/* TAB 4: WALLET MANAGEMENT */}
      {activeSubTab === 'wallet' && (
        <div className="space-y-5">
          {/* Stats Cards */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-slate-900 border border-cyan-500/20 rounded-2xl p-4 text-center">
              <TrendingUp className="w-5 h-5 text-cyan-400 mx-auto mb-1" />
              <div className="text-2xl font-black text-cyan-400">
                {walletTransactions.length}
              </div>
              <div className="text-[10px] text-slate-400 font-bold uppercase">Total Transactions</div>
            </div>
            <div className="bg-slate-900 border border-emerald-500/20 rounded-2xl p-4 text-center">
              <CheckCircle2 className="w-5 h-5 text-emerald-400 mx-auto mb-1" />
              <div className="text-2xl font-black text-emerald-400">
                ₹{walletTransactions.filter(r => r.type === 'credit' && r.status === 'success').reduce((s, r) => s + r.amount, 0)}
              </div>
              <div className="text-[10px] text-slate-400 font-bold uppercase">Total Recharged</div>
            </div>
          </div>

          {/* All Request History */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
            <h4 className="font-mono text-xs font-bold text-cyan-400 uppercase tracking-wider">Automated Razorpay Ledger</h4>
            {walletTransactions.length === 0 ? (
              <p className="text-slate-500 text-xs italic text-center py-4">No wallet transactions yet.</p>
            ) : (
              walletTransactions.map(req => (
                <div key={req.id} className="flex items-center justify-between py-2 border-b border-slate-800 last:border-0">
                  <div>
                    <p className="text-white text-xs font-bold">{req.label} <span className="text-slate-500">• {req.method}</span></p>
                    <p className="text-slate-500 text-[10px] font-mono">{new Date(req.timestamp).toLocaleString()}</p>
                    {req.refId && req.refId !== 'cancelled' && <p className="text-slate-600 text-[9px] font-mono">ID: {req.refId}</p>}
                  </div>
                  <div className="text-right">
                    <p className={`font-black text-sm ${req.type === 'credit' ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {req.type === 'credit' ? '+' : '-'}₹{req.amount}
                    </p>
                    <span className={`text-[9px] font-black px-1.5 py-0.5 rounded-full border ${
                      req.status === 'success' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' :
                      req.status === 'failed' ? 'bg-red-500/10 text-red-400 border-red-500/30' :
                      'bg-amber-500/10 text-amber-400 border-amber-500/30'
                    }`}>{req.status}</span>
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
