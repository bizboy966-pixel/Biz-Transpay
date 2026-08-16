import { useEffect, useState } from 'react';
import { Repeat, ArrowRight, TrendingUp, CheckCircle2, XCircle, Clock } from 'lucide-react';
import api from '@/api';

const StatCard = ({ label, value, sub, color, I }) => (
  <div className={`p-5 rounded-2xl border ${color.border} ${color.bg}`} data-testid={`stat-${label.toLowerCase().replace(/\s/g, '-')}`}>
    <div className="flex items-center justify-between mb-2">
      <div className={`w-9 h-9 rounded-lg ${color.iconBg} ${color.iconText} flex items-center justify-center`}><I className="w-4 h-4" /></div>
    </div>
    <div className={`text-[10px] font-bold uppercase tracking-widest ${color.label}`}>{label}</div>
    <div className={`font-cabinet font-extrabold text-2xl ${color.value} mt-1`}>{value}</div>
    {sub && <div className={`text-[11px] mt-1 ${color.sub}`}>{sub}</div>}
  </div>
);

const COL = {
  blue: { border: 'border-blue-200', bg: 'bg-blue-50', iconBg: 'bg-blue-500', iconText: 'text-white', label: 'text-blue-700', value: 'text-blue-900', sub: 'text-blue-700' },
  amber: { border: 'border-amber-200', bg: 'bg-amber-50', iconBg: 'bg-amber-500', iconText: 'text-white', label: 'text-amber-700', value: 'text-amber-900', sub: 'text-amber-700' },
  green: { border: 'border-emerald-200', bg: 'bg-emerald-50', iconBg: 'bg-emerald-500', iconText: 'text-white', label: 'text-emerald-700', value: 'text-emerald-900', sub: 'text-emerald-700' },
  red: { border: 'border-red-200', bg: 'bg-red-50', iconBg: 'bg-red-500', iconText: 'text-white', label: 'text-red-700', value: 'text-red-900', sub: 'text-red-700' },
};

export default function AdminConversions() {
  const [data, setData] = useState(null);
  const [period, setPeriod] = useState('month');
  const load = () => api.get('/admin/conversions', { params: { period } }).then(({ data }) => setData(data));
  useEffect(() => { load(); const iv = setInterval(load, 15000); return () => clearInterval(iv); }, [period]);

  if (!data) return <div className="text-slate-500 text-sm">Chargement…</div>;
  const { totals, volume_by_currency, data: rows } = data;

  return (
    <div className="space-y-6" data-testid="admin-conversions-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-cabinet font-extrabold text-slate-900 text-xl">Suivi des conversions</h1>
          <p className="text-xs text-slate-500 mt-0.5">Toutes les conversions USDT ↔ FCFA effectuées sur la plateforme.</p>
        </div>
        <select value={period} onChange={(e) => setPeriod(e.target.value)} data-testid="period-filter"
          className="px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-semibold">
          <option value="day">Aujourd'hui</option>
          <option value="week">7 derniers jours</option>
          <option value="month">30 derniers jours</option>
        </select>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Toutes conversions" value={totals.all.toLocaleString()} sub={`${totals.today} aujourd'hui`} color={COL.blue} I={Repeat} />
        <StatCard label="Validées" value={totals.validated.toLocaleString()} color={COL.green} I={CheckCircle2} />
        <StatCard label="Rejetées" value={totals.rejected.toLocaleString()} color={COL.red} I={XCircle} />
        <StatCard label="En attente" value={(totals.all - totals.validated - totals.rejected).toLocaleString()} color={COL.amber} I={Clock} />
      </div>

      {/* Volume by currency */}
      <div className="p-5 rounded-2xl bg-white border border-slate-100">
        <div className="flex items-center gap-3 mb-3">
          <TrendingUp className="w-4 h-4 text-slate-500" />
          <h2 className="font-cabinet font-bold text-slate-900 text-sm">Volume total converti (par devise source)</h2>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {Object.entries(volume_by_currency).map(([cur, val]) => (
            <div key={cur} className="p-4 rounded-xl bg-gradient-to-br from-slate-50 to-slate-100 border border-slate-200">
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{cur}</div>
              <div className="font-cabinet font-extrabold text-2xl text-slate-900 mt-1">
                {val.toLocaleString(undefined, { maximumFractionDigits: cur === 'USDT' ? 2 : 0 })}
              </div>
              <div className="text-[10px] text-slate-500 mt-0.5">envoyés depuis {cur}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-white border border-slate-100 rounded-2xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
          <h2 className="font-cabinet font-bold text-slate-900 text-sm">Historique complet</h2>
          <span className="text-[11px] text-slate-500">{rows.length} lignes</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              <tr>
                <th className="text-left px-5 py-2.5">ID</th>
                <th className="text-left px-5 py-2.5">Utilisateur</th>
                <th className="text-left px-5 py-2.5">Paire</th>
                <th className="text-right px-5 py-2.5">Envoyé</th>
                <th className="text-right px-5 py-2.5">Taux</th>
                <th className="text-right px-5 py-2.5">Frais</th>
                <th className="text-right px-5 py-2.5">Reçu</th>
                <th className="text-center px-5 py-2.5">Statut</th>
                <th className="text-left px-5 py-2.5">Date</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={9} className="p-10 text-center text-slate-400" data-testid="conversions-empty">Aucune conversion sur cette période.</td></tr>
              )}
              {rows.map((tx) => {
                const meta = tx.metadata || {};
                const from = meta.from_currency || tx.currency;
                const to = meta.to_currency;
                const rate = Number(meta.rate || 0);
                const fee = Number(meta.fee || 0);
                const received = Number(meta.received || 0);
                const d = new Date(tx.created_at);
                return (
                  <tr key={tx.id} className="border-t border-slate-50 hover:bg-slate-50/60" data-testid={`conv-row-${tx.id}`}>
                    <td className="px-5 py-2 font-mono text-[11px] text-slate-500">{tx.id.slice(0, 10)}…</td>
                    <td className="px-5 py-2 text-xs">
                      <div className="font-semibold text-slate-900">{tx.user?.full_name || '—'}</div>
                      <div className="text-[10px] text-slate-500">@{tx.user?.username}</div>
                    </td>
                    <td className="px-5 py-2 text-xs">
                      <span className="inline-flex items-center gap-1 font-semibold text-slate-800">
                        {from} <ArrowRight className="w-3 h-3 text-slate-400" /> {to}
                      </span>
                    </td>
                    <td className="px-5 py-2 text-right text-xs font-semibold">{Number(tx.amount).toLocaleString(undefined, { maximumFractionDigits: from === 'USDT' ? 2 : 0 })} {from}</td>
                    <td className="px-5 py-2 text-right font-mono text-[11px] text-slate-700">{rate.toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
                    <td className="px-5 py-2 text-right text-xs text-red-600">{fee.toLocaleString(undefined, { maximumFractionDigits: from === 'USDT' ? 3 : 0 })} {from}</td>
                    <td className="px-5 py-2 text-right text-xs font-bold text-emerald-600">+{received.toLocaleString(undefined, { maximumFractionDigits: to === 'USDT' ? 2 : 0 })} {to}</td>
                    <td className="px-5 py-2 text-center">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${tx.status === 'completed' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : tx.status === 'failed' ? 'bg-red-50 text-red-700 border-red-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
                        {tx.status === 'completed' ? 'Validée' : tx.status === 'failed' ? 'Rejetée' : 'En attente'}
                      </span>
                    </td>
                    <td className="px-5 py-2 text-[10px] text-slate-500">
                      {d.toLocaleDateString('fr-FR')} · {d.toLocaleTimeString('fr-FR')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
