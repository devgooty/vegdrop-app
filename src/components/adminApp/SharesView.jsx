import React from 'react';

export default function SharesView() {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-600">
        Shares
      </p>
      <h2 className="mt-2 text-2xl font-black tracking-tight text-slate-900">
        Settlement share policies
      </h2>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
        Loading policies...
      </p>
    </section>
  );
}
