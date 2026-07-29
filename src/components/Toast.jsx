import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import { CheckCircle2, AlertTriangle, Info, XCircle, X } from 'lucide-react';

const ToastContext = createContext(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>');
  return ctx;
}

let toastId = 0;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timersRef = useRef({});

  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)));
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 300);
  }, []);

  const addToast = useCallback(
    (message, type = 'success', duration = 3000) => {
      const id = ++toastId;
      setToasts((prev) => [...prev, { id, message, type, exiting: false }]);

      if (duration > 0) {
        timersRef.current[id] = setTimeout(() => {
          removeToast(id);
          delete timersRef.current[id];
        }, duration);
      }

      return id;
    },
    [removeToast]
  );

  const toast = useCallback(
    (message, type, duration) => addToast(message, type, duration),
    [addToast]
  );

  toast.success = (msg, dur) => addToast(msg, 'success', dur);
  toast.error = (msg, dur) => addToast(msg, 'error', dur || 4000);
  toast.warning = (msg, dur) => addToast(msg, 'warning', dur);
  toast.info = (msg, dur) => addToast(msg, 'info', dur);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={removeToast} />
    </ToastContext.Provider>
  );
}

const iconMap = {
  success: <CheckCircle2 className="w-4.5 h-4.5 text-emerald-400 shrink-0" />,
  error: <XCircle className="w-4.5 h-4.5 text-rose-400 shrink-0" />,
  warning: <AlertTriangle className="w-4.5 h-4.5 text-amber-400 shrink-0" />,
  info: <Info className="w-4.5 h-4.5 text-blue-400 shrink-0" />,
};

const bgMap = {
  success: 'bg-gradient-to-r from-emerald-950/95 to-emerald-900/95 border-emerald-700/50',
  error: 'bg-gradient-to-r from-rose-950/95 to-rose-900/95 border-rose-700/50',
  warning: 'bg-gradient-to-r from-amber-950/95 to-amber-900/95 border-amber-700/50',
  info: 'bg-gradient-to-r from-slate-900/95 to-slate-800/95 border-slate-600/50',
};

function ToastContainer({ toasts, onDismiss }) {
  return (
    <div className="fixed top-4 right-4 left-4 sm:left-auto sm:w-[360px] z-[9999] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-2xl border backdrop-blur-xl shadow-2xl text-white text-xs font-semibold ${
            bgMap[t.type] || bgMap.info
          } ${t.exiting ? 'animate-toast-out' : 'animate-toast-in'}`}
        >
          {iconMap[t.type] || iconMap.info}
          <span className="flex-1 leading-relaxed">{t.message}</span>
          <button
            onClick={() => onDismiss(t.id)}
            className="text-white/50 hover:text-white/90 transition-colors p-0.5 rounded-full hover:bg-white/10 shrink-0 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
