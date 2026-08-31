import React, { useState, useEffect } from 'react';
import { 
  Search, Filter, Download, MoreVertical, ShieldCheck, 
  ShieldAlert, RefreshCw, UserPlus, Trash2, Edit, CheckCircle,
  AlertCircle
} from 'lucide-react';
import { fetchUsers, updateUserRole, updateUserStatus, deleteUser } from '../../../services/users';

const ROLE_OPTIONS = [
  { id: 'customer', label: 'Customer', color: 'bg-blue-50 text-blue-700 border-blue-200' },
  { id: 'shopkeeper', label: 'Shopkeeper', color: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  { id: 'delivery', label: 'Delivery Rider', color: 'bg-amber-50 text-amber-700 border-amber-200' },
  { id: 'market_owner', label: 'Market Owner', color: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  { id: 'developer', label: 'Developer', color: 'bg-purple-50 text-purple-700 border-purple-200' },
];

export default function UsersManagement() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [activeTab, setActiveTab] = useState('All');
  const [searchQuery, setSearchQuery] = useState('');
  
  // Edit Role Modal State
  const [selectedUser, setSelectedUser] = useState(null);
  const [newRole, setNewRole] = useState('');
  const [isUpdating, setIsUpdating] = useState(false);

  // Quick Role Assign Form
  const [assignIdentifier, setAssignIdentifier] = useState('');
  const [assignRole, setAssignRole] = useState('shopkeeper');
  const [showAssignForm, setShowAssignForm] = useState(false);

  const loadUsers = async () => {
    try {
      setLoading(true);
      setError('');
      const res = await fetchUsers({ limit: 100 });
      setUsers(res || []);
    } catch (err) {
      setError(err?.message || 'Failed to fetch registered users from database.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
  }, []);

  const handleRoleChange = async (userId, targetRole) => {
    try {
      setIsUpdating(true);
      setError('');
      await updateUserRole(userId, targetRole);
      setSuccessMsg(`Role updated to ${targetRole} successfully.`);
      setSelectedUser(null);
      await loadUsers();
      setTimeout(() => setSuccessMsg(''), 4000);
    } catch (err) {
      setError(err?.message || 'Failed to update role.');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleStatusToggle = async (user) => {
    try {
      const nextStatus = user.status === 'suspended' ? 'active' : 'suspended';
      if (!window.confirm(`Are you sure you want to change ${user.name}'s status to ${nextStatus}?`)) return;
      
      await updateUserStatus(user.id || user._id, nextStatus);
      setSuccessMsg(`User status updated to ${nextStatus}.`);
      await loadUsers();
      setTimeout(() => setSuccessMsg(''), 4000);
    } catch (err) {
      setError(err?.message || 'Failed to update status.');
    }
  };

  const handleDeleteUser = async (user) => {
    try {
      if (!window.confirm(`Are you sure you want to delete ${user.name || user.phone}? This is a soft delete.`)) return;
      await deleteUser(user.id || user._id);
      setSuccessMsg(`User deleted.`);
      await loadUsers();
      setTimeout(() => setSuccessMsg(''), 4000);
    } catch (err) {
      setError(err?.message || 'Failed to delete user.');
    }
  };

  const handleAssignRoleSubmit = async (e) => {
    e.preventDefault();
    if (!assignIdentifier.trim()) return;

    try {
      setIsUpdating(true);
      setError('');
      // Find matching user by phone or email in loaded list
      const cleanTarget = assignIdentifier.trim();
      const match = users.find(u => 
        (u.phone && u.phone === cleanTarget) || 
        (u.email && u.email.toLowerCase() === cleanTarget.toLowerCase())
      );

      if (!match) {
        throw new Error(`No account found matching "${cleanTarget}". Ensure user has signed in once before promoting.`);
      }

      await updateUserRole(match.id || match._id, assignRole);
      setSuccessMsg(`Successfully assigned ${assignRole} role to ${match.name || match.phone}.`);
      setAssignIdentifier('');
      setShowAssignForm(false);
      await loadUsers();
      setTimeout(() => setSuccessMsg(''), 4000);
    } catch (err) {
      setError(err?.message || 'Failed to assign role.');
    } finally {
      setIsUpdating(false);
    }
  };

  // Filtered users
  const filteredUsers = users.filter((u) => {
    const roleMatch = activeTab === 'All' || u.role?.toLowerCase() === activeTab.toLowerCase();
    if (!roleMatch) return false;

    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      (u.name && u.name.toLowerCase().includes(q)) ||
      (u.phone && u.phone.includes(q)) ||
      (u.email && u.email.toLowerCase().includes(q)) ||
      (u.id && u.id.toLowerCase().includes(q))
    );
  });

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-extrabold text-slate-800 tracking-tight">Registered IDs (User Management)</h2>
          <p className="text-sm text-slate-500 mt-1 font-medium">Live MongoDB User collection with instant role and status management.</p>
        </div>
        <div className="flex items-center gap-2">
          <button 
            onClick={() => setShowAssignForm(!showAssignForm)}
            className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer shadow-sm shadow-emerald-600/20"
          >
            <UserPlus className="w-3.5 h-3.5" />
            {showAssignForm ? 'Close Form' : 'Promote / Assign Role'}
          </button>
          <button 
            onClick={loadUsers}
            className="flex items-center gap-2 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 px-3 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer shadow-sm"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Notifications */}
      {successMsg && (
        <div className="bg-emerald-50 border border-emerald-200 p-3 rounded-xl flex items-center gap-2 text-emerald-800 text-xs font-bold">
          <CheckCircle className="w-4 h-4 text-emerald-600" />
          {successMsg}
        </div>
      )}
      {error && (
        <div className="bg-rose-50 border border-rose-200 p-3 rounded-xl flex items-center gap-2 text-rose-800 text-xs font-bold">
          <AlertCircle className="w-4 h-4 text-rose-600" />
          {error}
        </div>
      )}

      {/* Quick Role Assignment Form */}
      {showAssignForm && (
        <form onSubmit={handleAssignRoleSubmit} className="bg-slate-900 text-white p-5 rounded-2xl space-y-4 shadow-lg">
          <div>
            <h4 className="text-sm font-black text-white">Assign Role to Existing Account</h4>
            <p className="text-xs text-slate-400">Promotes an account in MongoDB to shopkeeper, delivery, market owner, or developer.</p>
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[12.5px] font-bold text-slate-300 uppercase mb-1">Phone Number or Email</label>
              <input
                type="text"
                value={assignIdentifier}
                onChange={(e) => setAssignIdentifier(e.target.value)}
                placeholder="e.g. 9876543210"
                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs font-semibold text-white focus:outline-none focus:border-emerald-500"
                required
              />
            </div>
            <div>
              <label className="block text-[12.5px] font-bold text-slate-300 uppercase mb-1">Target Role</label>
              <select
                value={assignRole}
                onChange={(e) => setAssignRole(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs font-semibold text-white focus:outline-none focus:border-emerald-500"
              >
                <option value="shopkeeper">🏪 Shopkeeper (Store Vendor)</option>
                <option value="delivery">🚚 Delivery (Rider Fleet)</option>
                <option value="market_owner">📊 Market Owner (Mandi Admin)</option>
                <option value="developer">💻 Developer (Platform Staff)</option>
                <option value="customer">🛒 Customer</option>
              </select>
            </div>
          </div>
          <button
            type="submit"
            disabled={isUpdating}
            className="px-4 py-2 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-slate-950 font-black rounded-xl text-xs cursor-pointer transition-all"
          >
            {isUpdating ? 'Assigning…' : 'Save Role to Database'}
          </button>
        </form>
      )}

      {/* Main Table Card */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-[0_4px_20px_rgb(0,0,0,0.03)] overflow-hidden">
        
        {/* Tabs & Search */}
        <div className="p-4 border-b border-slate-100 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex gap-1.5 bg-slate-50 p-1 rounded-xl w-full md:w-auto overflow-x-auto">
            {['All', 'Customer', 'Shopkeeper', 'Delivery', 'Market_Owner', 'Developer'].map(tab => (
              <button 
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-3 py-1.5 text-xs font-bold rounded-lg whitespace-nowrap transition-colors cursor-pointer ${
                  activeTab === tab ? 'bg-white text-emerald-700 shadow-sm border border-slate-200' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab.replace('_', ' ')}
              </button>
            ))}
          </div>

          <div className="relative group w-full md:w-64">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 group-focus-within:text-emerald-500 transition-colors" />
            <input 
              type="text" 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by name, phone, ID..." 
              className="w-full pl-9 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all placeholder:text-slate-400"
            />
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50/70">
                <th className="px-5 py-3.5 text-[12.5px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100">User Details</th>
                <th className="px-5 py-3.5 text-[12.5px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100">Phone / Email</th>
                <th className="px-5 py-3.5 text-[12.5px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100">Role</th>
                <th className="px-5 py-3.5 text-[12.5px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100">Status</th>
                <th className="px-5 py-3.5 text-[12.5px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100">Registered</th>
                <th className="px-5 py-3.5 text-[12.5px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && users.length === 0 ? (
                <tr>
                  <td colSpan="6" className="py-12 text-center text-xs text-slate-400">
                    <RefreshCw className="w-6 h-6 animate-spin mx-auto text-emerald-500 mb-2" />
                    Loading users from MongoDB…
                  </td>
                </tr>
              ) : filteredUsers.length === 0 ? (
                <tr>
                  <td colSpan="6" className="py-12 text-center text-xs text-slate-400">
                    No users matching criteria.
                  </td>
                </tr>
              ) : (
                filteredUsers.map((u) => {
                  const roleBadge = ROLE_OPTIONS.find(r => r.id === u.role) || { color: 'bg-slate-100 text-slate-700' };
                  return (
                    <tr key={u.id || u._id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="px-5 py-3.5">
                        <div className="font-bold text-slate-800 text-xs">{u.name || 'Anonymous'}</div>
                        <div className="font-mono text-[11.5px] text-slate-400">ID: {(u.id || u._id)?.slice(-8)}</div>
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="text-xs font-semibold text-slate-700">{u.phone || '—'}</div>
                        {u.email && <div className="text-[12.5px] text-slate-400">{u.email}</div>}
                      </td>
                      <td className="px-5 py-3.5">
                        <span className={`text-[11.5px] font-extrabold px-2.5 py-1 rounded-full border uppercase ${roleBadge.color}`}>
                          {u.role?.replace('_', ' ')}
                        </span>
                      </td>
                      <td className="px-5 py-3.5">
                        <span className={`text-[11.5px] font-bold px-2 py-0.5 rounded-md ${
                          u.status === 'suspended' ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700'
                        }`}>
                          {u.status || 'active'}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-xs text-slate-500">
                        {u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—'}
                      </td>
                      <td className="px-5 py-3.5 text-right space-x-1">
                        <button
                          onClick={() => {
                            setSelectedUser(u);
                            setNewRole(u.role);
                          }}
                          className="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-[12.5px] font-bold cursor-pointer transition-colors"
                          title="Change Role"
                        >
                          Role
                        </button>
                        <button
                          onClick={() => handleStatusToggle(u)}
                          className={`px-2 py-1 rounded-lg text-[12.5px] font-bold cursor-pointer transition-colors ${
                            u.status === 'suspended'
                              ? 'bg-emerald-100 hover:bg-emerald-200 text-emerald-800'
                              : 'bg-amber-100 hover:bg-amber-200 text-amber-800'
                          }`}
                          title="Toggle Status"
                        >
                          {u.status === 'suspended' ? 'Activate' : 'Suspend'}
                        </button>
                        <button
                          onClick={() => handleDeleteUser(u)}
                          className="px-1.5 py-1 bg-rose-50 hover:bg-rose-100 text-rose-600 rounded-lg text-[12.5px] font-bold cursor-pointer transition-colors"
                          title="Soft Delete"
                        >
                          <Trash2 className="w-3.5 h-3.5 inline" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Role Change Modal */}
      {selectedUser && (
        <div className="fixed inset-0 bg-slate-900/60 z-50 flex items-center justify-center p-4 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-sm w-full p-6 space-y-4 shadow-2xl animate-in zoom-in-95">
            <h3 className="text-base font-extrabold text-slate-800">
              Change Role for {selectedUser.name || selectedUser.phone}
            </h3>
            <p className="text-xs text-slate-500">
              Select a new role for this account. Changing role invalidates current sessions immediately.
            </p>
            <div className="space-y-2">
              {ROLE_OPTIONS.map((r) => (
                <label 
                  key={r.id} 
                  className={`flex items-center justify-between p-3 rounded-xl border cursor-pointer transition-all ${
                    newRole === r.id ? 'border-emerald-500 bg-emerald-50/50' : 'border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <span className="text-xs font-bold text-slate-800">{r.label}</span>
                  <input
                    type="radio"
                    name="role"
                    value={r.id}
                    checked={newRole === r.id}
                    onChange={(e) => setNewRole(e.target.value)}
                    className="text-emerald-600 focus:ring-emerald-500"
                  />
                </label>
              ))}
            </div>
            <div className="flex gap-2 pt-2">
              <button
                onClick={() => setSelectedUser(null)}
                className="flex-1 px-4 py-2 border border-slate-200 text-slate-600 rounded-xl text-xs font-bold hover:bg-slate-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => handleRoleChange(selectedUser.id || selectedUser._id, newRole)}
                disabled={isUpdating || newRole === selectedUser.role}
                className="flex-1 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-xl text-xs font-bold cursor-pointer transition-colors shadow-sm"
              >
                {isUpdating ? 'Saving…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
