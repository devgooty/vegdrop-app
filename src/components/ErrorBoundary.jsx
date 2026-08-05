import React from 'react';
import { AlertTriangle, RefreshCcw } from 'lucide-react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    this.setState({ errorInfo });
    console.error('🚨 VegDrop Error Boundary caught:', error, errorInfo);
  }

  handleReload = () => {
    window.localStorage.clear();
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-gradient-to-br from-[#0D291E] via-[#1B4D3E] to-[#143B2B] flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-white/10 backdrop-blur-xl rounded-3xl p-8 border border-white/15 shadow-2xl text-center space-y-5">
            {/* Error Icon */}
            <div className="w-16 h-16 mx-auto bg-rose-500/20 rounded-2xl flex items-center justify-center border border-rose-400/30">
              <AlertTriangle className="w-8 h-8 text-rose-400" />
            </div>

            {/* Title */}
            <div className="space-y-2">
              <h1 className="font-extrabold text-2xl text-white tracking-tight">
                Something went wrong
              </h1>
              <p className="text-sm text-emerald-100/70 leading-relaxed">
                VegDrop encountered an unexpected error. Your cart and session data has been preserved.
              </p>
            </div>

            {/* Error Details (Collapsible) */}
            <details className="text-left bg-black/20 rounded-xl p-3 border border-white/10">
              <summary className="text-xs font-bold text-emerald-300 cursor-pointer select-none">
                View Error Details
              </summary>
              <pre className="mt-2 text-[10px] text-rose-300/80 font-mono overflow-x-auto whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
                {this.state.error?.toString()}
                {'\n\n'}
                {this.state.errorInfo?.componentStack}
              </pre>
            </details>

            {/* Action Buttons */}
            <div className="space-y-2.5 pt-2">
              <button
                onClick={() => window.location.reload()}
                className="w-full bg-emerald-500 hover:bg-emerald-400 text-white font-extrabold py-3.5 rounded-2xl transition-all shadow-lg hover:shadow-emerald-500/25 flex items-center justify-center gap-2 text-sm cursor-pointer active:scale-98"
              >
                <RefreshCcw className="w-4 h-4" />
                Reload App
              </button>
              <button
                onClick={this.handleReload}
                className="w-full bg-white/10 hover:bg-white/20 text-white/80 font-bold py-3 rounded-2xl transition-all text-xs cursor-pointer border border-white/10"
              >
                Clear Cache & Reload
              </button>
            </div>

            {/* Branding */}
            <p className="text-[10px] text-emerald-400/50 font-mono uppercase tracking-widest pt-2">
              VegDrop Production Error Handler
            </p>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
