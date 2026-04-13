import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom';
import { Activity, Users, Clock, Search, X, AlertTriangle, ShieldOff, CheckCircle, XCircle, Plus, RefreshCcw } from 'lucide-react';

const OverviewPanel = ({ api, user, setActiveTab }) => {
  const [stats, setStats] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [activeConns, setActiveConns] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loadingModal, setLoadingModal] = useState(false);
  const [adAlerts, setAdAlerts] = useState([]);
  const [extendModal, setExtendModal] = useState({ show: false, id: null, username: '', duration: 7, isCustom: false });
  const [syncLoading, setSyncLoading] = useState(false);

  const handleSyncAD = async () => {
    if (!window.confirm('Trigger manual Active Directory membership reconciliation? This will verify all active records against the real-time AD group state.')) return;
    setSyncLoading(true);
    try {
      const res = await api.post('/requests/sync-ad');
      const { membership, expiries, duplicates } = res.data.stats;
      
      let msg = `Total Sync Complete!\n\n`;
      msg += `AD Membership: ${membership.processed} processed, ${membership.revoked} revoked.\n`;
      if (expiries.expired > 0) msg += `Expiries: ${expiries.expired} user(s) removed.\n`;
      if (duplicates.pruned > 0) msg += `Data Integrity: ${duplicates.pruned} duplicate(s) pruned.\n`;
      
      if (membership.warnings && membership.warnings.length > 0) {
        msg += `\nWARNINGS:\n${membership.warnings.join('\n')}`;
      }
      alert(msg);
      fetchActive();
      // Refresh stats
      api.get('/requests/analytics').then(res => setStats(res.data)).catch(console.error);
    } catch(err) {
      alert('Sync Failed: ' + (err.response?.data?.message || err.message));
    } finally {
      setSyncLoading(false);
    }
  };

  const fetchActive = async () => {
    setLoadingModal(true);
    try {
      const res = await api.get('/requests/access/active');
      setActiveConns(res.data);
    } catch(err) {
      console.error('Failed active pool fetch', err);
    } finally {
      setLoadingModal(false);
    }
  };

  const openModal = () => {
    setShowModal(true);
    fetchActive();
  };

  const handleRevoke = async (id) => {
    if (!window.confirm('WARNING: Are you strictly sure you want to terminate this Active Directory routing immediately?')) return;
    try {
      await api.post(`/requests/access/${id}/revoke`);
      fetchActive();
    } catch(err) {
      alert('Failed to execute Kill Switch on mapping cluster.');
    }
  };

  const handleAdminExtend = async () => {
    try {
      if (extendModal.isOnboarding) {
        await api.post('/requests/onboard-unmanaged', {
          username: extendModal.username,
          durationDays: Number(extendModal.duration)
        });
      } else {
        await api.post(`/requests/access/${extendModal.id}/admin-extend`, {
          durationDays: Number(extendModal.duration)
        });
      }
      setExtendModal({ show: false, id: null, username: '', duration: 7, isCustom: false, isOnboarding: false });
      fetchActive();
      // Refresh analytics
      api.get('/requests/analytics').then(res => setStats(res.data)).catch(console.error);
    } catch(err) {
      alert('Action Failed: ' + (err.response?.data?.message || err.message));
    }
  };

  const handleDismissAlert = async (alertId) => {
    try {
      await api.post(`/requests/alerts/${alertId}/dismiss`);
      setAdAlerts(prev => prev.filter(a => a._id !== alertId));
    } catch(err) {
      setAdAlerts(prev => prev.filter(a => a._id !== alertId));
    }
  };

  const getDaysLeft = (endDate) => {
    if (!endDate) return 0;
    const diff = new Date(endDate).getTime() - new Date().getTime();
    return Math.max(0, Math.ceil(diff / (1000 * 3600 * 24)));
  };

  const getTimeLeft = (endDate) => {
    if (!endDate) return 'No Duration';
    const diff = new Date(endDate).getTime() - new Date().getTime();
    if (diff <= 0) return 'Expired';
    const days = Math.floor(diff / (1000 * 3600 * 24));
    const hours = Math.floor((diff % (1000 * 3600 * 24)) / (1000 * 3600));
    const mins = Math.floor((diff % (1000 * 3600)) / (1000 * 60));
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  };

  const filtered = activeConns.filter(c => {
    const sq = searchQuery.toLowerCase();
    const username = (c.userId?.username || '').toLowerCase();
    const email = (c.userId?.email || '').toLowerCase();
    return username.includes(sq) || email.includes(sq);
  });

  useEffect(() => {
    if (['manager', 'it_admin', 'super_admin'].includes(user.role)) {
      api.get('/requests/analytics').then(res => setStats(res.data)).catch(console.error);
    }
    if (['it_admin', 'super_admin'].includes(user.role)) {
      api.get('/requests/alerts/ad-removals')
        .then(res => setAdAlerts(res.data))
        .catch(console.error);
    }
  }, [user.role, api]);

  const extendOptions = [
    { value: 0.000694, label: '1 Minute (Testing)' },
    { value: 1, label: '1 Day' },
    { value: 3, label: '3 Days' },
    { value: 7, label: '7 Days' },
    { value: 14, label: '14 Days' },
    { value: 30, label: '30 Days' }
  ];

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex justify-between items-end mb-8">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Overview</h1>
          <p className="text-slate-500 mt-1">Welcome back, {user.username}. Here's what's happening today.</p>
        </div>
        {['it_admin', 'super_admin'].includes(user.role) && (
          <button
            onClick={handleSyncAD}
            disabled={syncLoading}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-xl hover:bg-indigo-100 transition shadow-sm font-semibold disabled:opacity-50"
          >
            <RefreshCcw className={`w-4 h-4 ${syncLoading ? 'animate-spin' : ''}`} />
            {syncLoading ? 'Syncing AD...' : 'Sync AD Membership'}
          </button>
        )}
      </div>

      {adAlerts.length > 0 && (
        <div className="space-y-3">
          {adAlerts.map(alert => (
            <div
              key={alert._id}
              className="flex items-start gap-4 bg-red-50 border border-red-200 rounded-2xl p-4 shadow-sm animate-in fade-in slide-in-from-top-2 duration-300"
            >
              <div className="flex-shrink-0 bg-red-100 border border-red-200 rounded-xl p-2.5 mt-0.5">
                <ShieldOff className="w-5 h-5 text-red-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-bold text-red-800 text-sm flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 inline-block flex-shrink-0" />
                  Out-of-Band AD Removal Detected
                </p>
                <p className="text-red-700 text-sm mt-1">
                  <span className="font-bold">{alert.userId?.username}</span>
                  {alert.userId?.email && <span className="text-red-500 ml-1">({alert.userId.email})</span>}
                  {' '}was removed from AD group{' '}
                  <span className="font-mono font-bold bg-red-100 px-1.5 py-0.5 rounded text-xs">{alert.groupName}</span>
                  {' '}outside the portal.
                </p>
                <p className="text-red-500 text-xs mt-1.5">
                  Detected: {new Date(alert.updatedAt).toLocaleString()} &nbsp;·&nbsp;
                  Access record has been automatically revoked &amp; user notified.
                </p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  onClick={() => setActiveTab('audit')}
                  className="text-xs font-bold text-red-700 bg-red-100 border border-red-200 px-3 py-1.5 rounded-lg hover:bg-red-200 transition whitespace-nowrap"
                >
                  View Audit Log
                </button>
                <button
                  onClick={() => handleDismissAlert(alert._id)}
                  className="p-1.5 text-red-400 hover:text-red-700 hover:bg-red-100 rounded-lg transition"
                  title="Dismiss alert"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {stats ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <StatCard title="Active Connections" value={stats.totalActive} icon={Activity} color="blue" onClick={openModal} />
          <StatCard title="Pending Approvals" value={stats.pendingRequests} icon={Clock} color="amber" onClick={() => setActiveTab('approvals')} />
          <StatCard title="Total Requests" value={stats.totalRequests} icon={Users} color="indigo" />
        </div>
      ) : (
        <div className="glass p-8 rounded-2xl text-center shadow-sm">
          <div className="bg-blue-50 text-blue-600 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
            <Activity className="w-8 h-8" />
          </div>
          <h2 className="text-xl font-semibold text-slate-800 mb-2">Systems Normal</h2>
          <p className="text-slate-500 max-w-sm mx-auto mb-6">You don't have administrative privileges to view system-wide analytics. You can view your personal access statuses in the My Access tab.</p>
          <button onClick={() => setActiveTab('access')} className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2.5 rounded-xl font-medium transition shadow-md shadow-blue-500/20">
            View My Access
          </button>
        </div>
      )}

      {showModal && ReactDOM.createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white/90 backdrop-blur-md w-full max-w-5xl rounded-3xl shadow-2xl overflow-hidden border border-white/50 flex flex-col max-h-[85vh]">

            <div className="p-6 border-b border-slate-200 flex justify-between items-center bg-white">
              <div>
                <h3 className="text-xl font-bold text-slate-800 flex items-center"><Activity className="w-5 h-5 mr-2 text-blue-600" /> Active System Connections</h3>
                <p className="text-sm text-slate-500 mt-1">Live overview of securely provisioned AD mappings and expiry limits.</p>
              </div>
              <button onClick={() => setShowModal(false)} className="p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600 rounded-full transition"><X className="w-5 h-5" /></button>
            </div>

            <div className="p-6 flex-1 overflow-auto bg-slate-50/50">
              <div className="mb-6 flex gap-3">
                <div className="relative flex-1">
                  <Search className="w-5 h-5 text-slate-400 absolute left-4 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    placeholder="Filter by Username or Email Address..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-xl pl-12 pr-4 py-3 outline-none focus:ring-2 focus:ring-blue-500 shadow-sm"
                  />
                </div>
                <button
                  onClick={handleSyncAD}
                  disabled={syncLoading}
                  className="px-4 py-2 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition shadow-md shadow-indigo-500/20 flex items-center gap-2 disabled:opacity-50"
                  title="Run real-time AD reconciliation"
                >
                  <RefreshCcw className={`w-4 h-4 ${syncLoading ? 'animate-spin' : ''}`} />
                  <span className="hidden sm:inline">Sync AD</span>
                </button>
              </div>

              {loadingModal ? (
                <div className="text-center p-12 text-slate-500">Retrieving secure connection matrix...</div>
              ) : activeConns.length === 0 ? (
                <div className="text-center p-12 bg-white rounded-xl border border-dashed border-slate-200 text-slate-500">No active network tunnels found.</div>
              ) : (
                <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 text-xs uppercase tracking-wider font-semibold">
                        <th className="p-4 pl-6">User Context</th>
                        <th className="p-4">AD Group</th>
                        <th className="p-4">Provisioned</th>
                        <th className="p-4">Expiration</th>
                        <th className="p-4 text-center">Time Left</th>
                        <th className="p-4 text-center">AD Status</th>
                        <th className="p-4 text-center">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-sm">
                      {filtered.map(c => {
                        const daysLeft = getDaysLeft(c.endDate);
                        const timeLeft = getTimeLeft(c.endDate);
                        const isAdRemoved = c.removalReason === 'ad_group_removed';
                        const isRevoked = c.status === 'revoked' && c.removalReason === 'manually_revoked';
                        const isUnmanaged = c.status === 'unmanaged';

                        return (
                          <tr key={c._id} className={`transition-colors ${isAdRemoved ? 'bg-red-50/40 hover:bg-red-50/60' : isUnmanaged ? 'bg-amber-50/30 hover:bg-amber-50/50' : 'hover:bg-blue-50/30'}`}>
                            <td className="p-4 pl-6">
                              <p className="font-bold text-slate-800">{c.userId?.username}</p>
                              <p className="text-xs text-slate-500">{c.userId?.email}</p>
                            </td>
                            <td className="p-4 font-mono text-xs text-slate-600 bg-slate-50/50">{c.groupName}</td>
                            <td className="p-4 text-slate-600 outline-none">
                              {c.startDate ? new Date(c.startDate).toLocaleDateString() : '—'}
                            </td>
                            <td className="p-4 font-medium text-slate-800 outline-none">
                              {c.endDate ? new Date(c.endDate).toLocaleDateString() : '—'}
                              {c.endDate && <p className="text-[10px] text-slate-400">{new Date(c.endDate).toLocaleTimeString()}</p>}
                            </td>
                            <td className="p-4 text-center">
                              <span className={`inline-flex items-center justify-center px-2.5 py-1 text-xs font-bold rounded-lg border ${isUnmanaged ? 'bg-amber-50 text-amber-700 border-amber-200' : daysLeft <= 3 ? 'bg-red-50 text-red-600 border-red-200' : 'bg-green-50 text-green-700 border-green-200'}`}>
                                {timeLeft}
                              </span>
                            </td>
                            <td className="p-4 text-center">
                              {isUnmanaged ? (
                                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold rounded-lg border bg-amber-50 text-amber-600 border-amber-200 whitespace-nowrap">
                                  <AlertTriangle className="w-3.5 h-3.5" /> Unmanaged
                                </span>
                              ) : isAdRemoved ? (
                                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold rounded-lg border bg-red-50 text-red-600 border-red-200 whitespace-nowrap">
                                  <XCircle className="w-3.5 h-3.5" /> AD Removed
                                </span>
                              ) : isRevoked ? (
                                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold rounded-lg border bg-amber-50 text-amber-600 border-amber-200 whitespace-nowrap">
                                  <XCircle className="w-3.5 h-3.5" /> Revoked
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold rounded-lg border bg-green-50 text-green-700 border-green-200 whitespace-nowrap">
                                  <CheckCircle className="w-3.5 h-3.5" /> In Group
                                </span>
                              )}
                            </td>
                            <td className="p-4 text-center">
                              <div className="flex items-center justify-center gap-2">
                                {isUnmanaged ? (
                                  <button
                                    onClick={() => setExtendModal({ show: true, id: null, username: c.userId?.username, duration: 7, isCustom: false, isOnboarding: true })}
                                    className="px-3 py-1.5 bg-amber-600 text-white text-xs font-bold rounded-lg hover:bg-amber-700 transition shadow-sm border border-amber-700"
                                  >
                                    Set Duration
                                  </button>
                                ) : (
                                  <>
                                    {c.status === 'active' && (
                                      <button
                                        onClick={() => setExtendModal({ show: true, id: c._id, username: c.userId?.username, duration: 7, isCustom: false, isOnboarding: false })}
                                        className="px-3 py-1.5 bg-blue-50 text-blue-600 text-xs font-bold rounded-lg border border-blue-200 hover:bg-blue-600 hover:text-white transition shadow-sm"
                                        title="Extend VPN Duration"
                                      >
                                        <Plus className="w-3.5 h-3.5 inline-block mr-1" />Extend
                                      </button>
                                    )}
                                    <button
                                      onClick={() => handleRevoke(c._id)}
                                      disabled={c.status !== 'active'}
                                      className="px-3 py-1.5 bg-red-50 text-red-600 text-xs font-bold rounded-lg border border-red-200 hover:bg-red-600 hover:text-white transition shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                      Revoke
                                    </button>
                                  </>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {filtered.length === 0 && (
                    <div className="text-center p-8 text-slate-500 border-t border-slate-100">No matching tunnels found for "{searchQuery}".</div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {extendModal.show && ReactDOM.createPortal(
        <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white w-full max-w-md rounded-2xl shadow-2xl p-6 animate-in zoom-in-95 duration-200">
            <h3 className="text-xl font-bold text-slate-800 mb-1 flex items-center">
              {extendModal.isOnboarding ? <CheckCircle className="w-5 h-5 mr-2 text-amber-600" /> : <Plus className="w-5 h-5 mr-2 text-blue-600" />}
              {extendModal.isOnboarding ? 'Onboard AD User' : 'Extend VPN Duration'}
            </h3>
            <p className="text-sm text-slate-500 mb-6">
              {extendModal.isOnboarding 
                ? `Set initial portal management duration for `
                : `Extending access for `}
              <span className="font-bold text-slate-800">{extendModal.username}</span>. 
              This bypasses the standard approval workflow.
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">{extendModal.isOnboarding ? 'Initial Duration' : 'Extension Duration'}</label>
                <select
                  className="w-full border-slate-200 bg-white px-3 py-2.5 rounded-xl outline-none focus:ring-2 focus:ring-blue-500 shadow-sm"
                  value={extendModal.isCustom ? 'custom' : extendModal.duration}
                  onChange={(e) => setExtendModal({ ...extendModal, duration: Number(e.target.value) })}
                >
                  {extendOptions.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>

              <div className="flex space-x-3 pt-2">
                <button
                  type="button"
                  onClick={() => setExtendModal({ show: false, id: null, username: '', duration: 7, isCustom: false, isOnboarding: false })}
                  className="flex-1 py-2.5 rounded-xl bg-slate-100 text-slate-700 font-medium hover:bg-slate-200 transition"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAdminExtend}
                  className={`flex-1 py-2.5 rounded-xl text-white font-medium shadow-md transition ${extendModal.isOnboarding ? 'bg-amber-600 hover:bg-amber-700 shadow-amber-500/30' : 'bg-blue-600 hover:bg-blue-700 shadow-blue-500/30'}`}
                >
                  {extendModal.isOnboarding ? 'Onboard Now' : 'Extend Now'}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

const StatCard = ({ title, value, icon: Icon, color, onClick }) => {
  const colorMap = {
    blue: 'bg-blue-50 text-blue-600 border-blue-100',
    amber: 'bg-amber-50 text-amber-600 border-amber-100',
    indigo: 'bg-indigo-50 text-indigo-600 border-indigo-100'
  };

  return (
    <div
      className={`glass p-6 rounded-2xl border transition-all duration-300 ${onClick ? 'cursor-pointer hover:shadow-lg hover:-translate-y-1' : ''}`}
      onClick={onClick}
    >
      <div className="flex justify-between items-start mb-4">
        <div className={`p-3 rounded-xl border flex items-center justify-center ${colorMap[color]}`}>
          <Icon className="w-6 h-6" />
        </div>
      </div>
      <div>
        <h3 className="text-slate-500 font-medium text-sm mb-1">{title}</h3>
        <p className="text-3xl font-bold text-slate-800">{value}</p>
      </div>
    </div>
  );
};

export default OverviewPanel;
