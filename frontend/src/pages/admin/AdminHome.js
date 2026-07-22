import { useEffect, useState } from 'react';
import { Users, ShieldCheck, Clock, ArrowDownToLine, ArrowUpFromLine, CheckCircle2, XCircle, TrendingUp } from 'lucide-react';
import api from '@/api';

function Card({ icon: I, iconBg, iconColor, label, value, sub, trend }) {
  return (
    <div className="bg-white border border-slate-100 rounded-2xl p-5 shadow-[0_2px_10px_rgba(15,23,42,0.03)] hover:shadow-[0_8px_24px_rgba(37,99,235,0.08)] transition-shadow">
      <div className="flex items-start justify-between mb-3">
        <div className={`w-11 h-11 rounded-2xl ${iconBg} ${iconColor} flex items-center justify-center`}><I className="w-5 h-5" strokeWidth={1.75} /></div>
        {trend && <div className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded-full"><TrendingUp className="w-3 h-3" />{trend}</div>}
      </div>
      <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">{label}</div>
      <div className="font-cabinet font-extrabold text-2xl text-slate-900">{value}</div>
      {sub && <div className="mt-1 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

function TxCard({ label, count, amount, color, I }) {
  return (
    <div className={`rounded-2xl p-4 border ${color.border} ${color.bg} shadow-[0_2px_10px_rgba(15,23,42,0.03)]`} data-testid={`tx-card-${label}`}>
      <div className="flex items-center gap-2 mb-2">
        <div className={`w-8 h-8 rounded-xl ${color.iconBg} ${color.iconText} flex items-center justify-center`}><I className="w-4 h-4" /></div>
        <div className={`text-[10px] font-bold uppercase tracking-widest ${color.label}`}>{label}</div>
      </div>
      <div className={`font-cabinet font-extrabold text-2xl ${color.value}`}>{count.toLocaleString()}</div>
      <div className={`text-[11px] font-semibold ${color.sub} mt-0.5`}>{amount.toLocaleString(undefined, { maximumFractionDigits: 0 })} XOF</div>
    </div>
  );
}

const COLORS = {
  pending: { border: 'border-amber-200', bg: 'bg-amber-50', iconBg: 'bg-amber-500', iconText: 'text-white', label: 'text-amber-700', value: 'text-amber-900', sub: 'text-amber-700' },
  valid: { border: 'border-emerald-200', bg: 'bg-emerald-50', iconBg: 'bg-emerald-500', iconText: 'text-white', label: 'text-emerald-700', value: 'text-emerald-900', sub: 'text-emerald-700' },
  rejected: { border: 'border-red-200', bg: 'bg-red-50', iconBg: 'bg-red-500', iconText: 'text-white', label: 'text-red-700', value: 'text-red-900', sub: 'text-red-700' },
};

export default function AdminHome() {
  const [stats, setStats] = useState(null);
  const [period, setPeriod] = useState('month');

  useEffect(() => {
    const load = () => api.get('/admin/stats', { params: { period } }).then(({ data }) => setStats(data)).catch(() => {});
    load();
    const iv = setInterval(load, 15000);
    return () => clearInterval(iv);
  }, [period]);

  if (!stats) return <div className="text-slate-500 text-sm">Chargement…</div>;
  const d = stats.transactions.deposits;
  const w = stats.transactions.withdrawals;

  return (
    <div className="space-y-6" data-testid="admin-home">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-cabinet font-extrabold text-slate-900 text-xl">Vue d'ensemble</h1>
          <p className="text-xs text-slate-500 mt-0.5">Statistiques en temps réel — mis à jour toutes les 15s</p>
        </div>
        <select value={period} onChange={(e) => setPeriod(e.target.value)} data-testid="period-filter" className="px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-semibold bg-white">
          <option value="day">Aujourd'hui</option>
          <option value="week">Cette semaine</option>
          <option value="month">Ce mois</option>
          <option value="year">Cette année</option>
        </select>
      </div>

      {/* Row 1 - Users */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4" data-testid="user-cards">
        <Card icon={Users} iconBg="bg-blue-50" iconColor="text-[#2563EB]" label="Utilisateurs inscrits" value={stats.users.total.toLocaleString()} sub={`${stats.users.active} actifs`} trend="+12.5%" />
        <Card icon={ShieldCheck} iconBg="bg-emerald-50" iconColor="text-emerald-600" label="KYC validés" value={stats.users.verified.toLocaleString()} sub={`${((stats.users.verified / Math.max(stats.users.total, 1)) * 100).toFixed(0)}% des utilisateurs`} trend="+15.3%" />
        <Card icon={Clock} iconBg="bg-amber-50" iconColor="text-amber-600" label="KYC en attente" value={stats.users.kyc_pending.toLocaleString()} sub="À traiter par l'admin" />
      </div>

      {/* Row 2 - Transactions */}
      <div>
        <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500 mb-3">Transactions</div>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-3">
          <TxCard label="Dépôts en attente" count={d.pending.count} amount={d.pending.amount} color={COLORS.pending} I={Clock} />
          <TxCard label="Dépôts validés" count={d.valid.count} amount={d.valid.amount} color={COLORS.valid} I={CheckCircle2} />
          <TxCard label="Dépôts rejetés" count={d.rejected.count} amount={d.rejected.amount} color={COLORS.rejected} I={XCircle} />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          <TxCard label="Retraits en attente" count={w.pending.count} amount={w.pending.amount} color={COLORS.pending} I={Clock} />
          <TxCard label="Retraits validés" count={w.valid.count} amount={w.valid.amount} color={COLORS.valid} I={CheckCircle2} />
          <TxCard label="Retraits rejetés" count={w.rejected.count} amount={w.rejected.amount} color={COLORS.rejected} I={XCircle} />
        </div>
      </div>

      {/* Summary strip */}
      <div className="grid sm:grid-cols-3 gap-3">
        <div className="p-4 rounded-2xl bg-gradient-to-br from-[#3B82F6] to-[#1D4ED8] text-white">
          <div className="flex items-center gap-2 mb-1"><ArrowDownToLine className="w-4 h-4" /><span className="text-[10px] font-bold uppercase tracking-widest opacity-90">Volume dépôts total</span></div>
          <div className="font-cabinet font-extrabold text-2xl">{stats.transactions.total_deposits.toLocaleString(undefined, { maximumFractionDigits: 0 })} <span className="text-sm opacity-80">XOF</span></div>
        </div>
        <div className="p-4 rounded-2xl bg-gradient-to-br from-emerald-500 to-emerald-700 text-white">
          <div className="flex items-center gap-2 mb-1"><ArrowUpFromLine className="w-4 h-4" /><span className="text-[10px] font-bold uppercase tracking-widest opacity-90">Volume retraits total</span></div>
          <div className="font-cabinet font-extrabold text-2xl">{stats.transactions.total_withdrawals.toLocaleString(undefined, { maximumFractionDigits: 0 })} <span className="text-sm opacity-80">XOF</span></div>
        </div>
        <div className="p-4 rounded-2xl bg-gradient-to-br from-violet-500 to-purple-700 text-white">
          <div className="flex items-center gap-2 mb-1"><TrendingUp className="w-4 h-4" /><span className="text-[10px] font-bold uppercase tracking-widest opacity-90">Transactions totales</span></div>
          <div className="font-cabinet font-extrabold text-2xl">{stats.transactions.count.toLocaleString()}</div>
          <div className="text-[10px] opacity-80 mt-0.5">{stats.transactions.succeeded} réussies · {stats.transactions.pending} en attente · {stats.transactions.failed} échouées</div>
        </div>
      </div>
    </div>
  );
}
