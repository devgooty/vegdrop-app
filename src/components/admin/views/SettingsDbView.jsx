import React, { useState, useEffect } from 'react';
import { 
  Database, Server, Cpu, HardDrive, RefreshCw, 
  Copy, Check, Download, Layers, ShieldCheck, Activity
} from 'lucide-react';
import { fetchDatabaseStatus, fetchSystemDump } from '../../../services/developer';

export default function SettingsDbView() {
  const [dbData, setDbData] = useState(null);
  const [dumpData, setDumpData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [dumpLoading, setDumpLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  const loadDbStatus = async () => {
    try {
      setLoading(true);
      setError('');
      const res = await fetchDatabaseStatus();
      setDbData(res);
    } catch (err) {
      setError(err?.message || 'Failed to query MongoDB server diagnostics.');
    } finally {
      setLoading(false);
    }
  };

  const loadDump = async () => {
    try {
      setDumpLoading(true);
      const res = await fetchSystemDump();
      setDumpData(res);
    } catch (err) {
      setError(err?.message || 'Failed to create database dump.');
    } finally {
      setDumpLoading(false);
    }
  };

  useEffect(() => {
    loadDbStatus();
    loadDump();
  }, []);

  const handleCopyJSON = () => {
    if (!dumpData) return;
    navigator.clipboard.writeText(JSON.stringify(dumpData, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadJSON = () => {
    if (!dumpData) return;
    const blob = new Blob([JSON.stringify(dumpData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bazzar-db-dump-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const db = dbData?.database || {};
  const server = dbData?.server || {};
  const collections = dbData?.collections || [];

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-extrabold text-slate-800 tracking-tight">Database & System Diagnostics</h2>
          <p className="text-sm text-slate-500 mt-1 font-medium">Real-time MongoDB server metrics, collections summary, and state dump.</p>
        </div>
        <button 
          onClick={() => { loadDbStatus(); loadDump(); }}
          className="flex items-center gap-2 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 px-3 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer shadow-sm"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh Diagnostics
        </button>
      </div>

      {error && (
        <div className="bg-rose-50 border border-rose-200 p-4 rounded-xl text-rose-800 text-xs font-bold">
          {error}
        </div>
      )}

      {/* Grid of Diagnostics Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        
        <div className="bg-white rounded-2xl p-5 border border-slate-100 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-400 uppercase">Database Status</span>
            <div className="p-2 bg-emerald-50 text-emerald-600 rounded-xl">
              <Database className="w-4 h-4" />
            </div>
          </div>
          <div className="flex items-center gap-2 mt-2">
            <span className={`w-2.5 h-2.5 rounded-full ${db.connected ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'}`} />
            <p className="text-lg font-black text-slate-900">{db.connected ? 'Connected' : 'Disconnected'}</p>
          </div>
          <p className="text-[12.5px] font-mono text-slate-500 mt-1">DB: {db.dbName || 'bazzar'}</p>
        </div>

        <div className="bg-white rounded-2xl p-5 border border-slate-100 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-400 uppercase">Total Collections</span>
            <div className="p-2 bg-blue-50 text-blue-600 rounded-xl">
              <Layers className="w-4 h-4" />
            </div>
          </div>
          <p className="text-2xl font-black text-slate-900 mt-2">{db.collectionsCount || 0}</p>
          <p className="text-[12.5px] text-slate-500 mt-1">{db.totalDocuments || 0} total documents</p>
        </div>

        <div className="bg-white rounded-2xl p-5 border border-slate-100 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-400 uppercase">Server Memory</span>
            <div className="p-2 bg-purple-50 text-purple-600 rounded-xl">
              <Cpu className="w-4 h-4" />
            </div>
          </div>
          <p className="text-2xl font-black text-slate-900 mt-2">{server.memory?.heapUsedMB || 0} MB</p>
          <p className="text-[12.5px] text-slate-500 mt-1">Heap Total: {server.memory?.heapTotalMB || 0} MB</p>
        </div>

        <div className="bg-white rounded-2xl p-5 border border-slate-100 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-400 uppercase">Server Uptime</span>
            <div className="p-2 bg-amber-50 text-amber-600 rounded-xl">
              <Activity className="w-4 h-4" />
            </div>
          </div>
          <p className="text-2xl font-black text-slate-900 mt-2">
            {Math.floor((server.uptimeSeconds || 0) / 60)}m {(server.uptimeSeconds || 0) % 60}s
          </p>
          <p className="text-[12.5px] text-slate-500 mt-1">Node: {server.nodeVersion || 'v20'}</p>
        </div>

      </div>

      {/* Collections Document Counts Grid */}
      <div className="bg-white rounded-2xl p-6 border border-slate-100 shadow-[0_4px_20px_rgb(0,0,0,0.03)]">
        <h3 className="text-base font-bold text-slate-800 mb-4">MongoDB Collections & Document Counts</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {collections.map((c) => (
            <div key={c.name} className="p-4 bg-slate-50 rounded-xl border border-slate-100 flex items-center justify-between">
              <div>
                <p className="text-xs font-bold text-slate-700">{c.name}</p>
                <p className="text-[11.5px] font-mono text-slate-400">Model: {c.model}</p>
              </div>
              <span className="text-lg font-black text-slate-900 bg-white px-2.5 py-1 rounded-lg border border-slate-200">
                {c.count}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Raw Application State & Snapshot Dump */}
      <div className="bg-white rounded-2xl p-6 border border-slate-100 shadow-[0_4px_20px_rgb(0,0,0,0.03)] space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-slate-800">Database JSON State Inspector</h3>
            <p className="text-xs text-slate-400">Live snapshot of core collections for inspection and backup</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopyJSON}
              disabled={!dumpData}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold transition-colors cursor-pointer"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? 'Copied!' : 'Copy JSON'}</span>
            </button>
            <button
              onClick={handleDownloadJSON}
              disabled={!dumpData}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold transition-colors cursor-pointer shadow-sm"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download JSON</span>
            </button>
          </div>
        </div>

        <div className="bg-slate-950 p-4 rounded-xl font-mono text-[12.5px] text-emerald-400 overflow-x-auto max-h-[350px] shadow-inner">
          {dumpLoading && !dumpData ? (
            <p className="text-slate-500 italic">Generating snapshot from database…</p>
          ) : (
            <pre>{JSON.stringify(dumpData || {}, null, 2)}</pre>
          )}
        </div>
      </div>

    </div>
  );
}
