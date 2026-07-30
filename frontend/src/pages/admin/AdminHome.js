import { useEffect, useState } from 'react';
import {
  Users, ShieldCheck, Clock, ArrowDownToLine, ArrowUpFromLine,
  CheckCircle2, XCircle, TrendingUp, Smartphone, Bitcoin,
} from 'lucide-react';
import api from '@/api';

function Card({ icon: I, iconBg, iconColor, label, value, sub, trend }) {
  return (
    <div className="bg-white border border-slate-100 rounded-2xl p-5 h-[168px] flex flex-col shadow-[0_2px_10px_rgba(15,23,42,0.03)] hover:shadow-[0_8px_24px_rgba(37,99,235,0.08)] transition-shadow">
      <div className="flex items-start justify-between mb-3">
        <div className={`w-10 h-10 rounded-xl ${iconBg} ${iconColor} flex items-center justify-center`}><I className="w-4 h-4" strokeWidth={1.75} /></div>
        {trend && <div className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded-full"><TrendingUp className="w-3 h-3" />{trend}</div>}
      </div>
      <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">{label}</div>
      <div className="font-cabinet font-extrabold text-2xl text-slate-900">{value}</div>
      {sub && <div className="mt-auto pt-1 text-[11px] text-slate-500">{sub}</div>}
    </div>
  );
}

function TxCard({ label, count, amount, currency = 'XOF', color, I, testId }) {
  return (
    <div className={`rounded-2xl p-5 h-[168px] flex flex-col border ${color.border} ${color.bg} shadow-[0_2px_10px_rgba(15,23,42,0.03)] hover:shadow-[0_8px_24px_rgba(15,23,42,0.06)] transition-shadow`} data-testid={testId || `tx-card-${label}`}>
      <div className="flex items-center justify-between mb-3">
        <div className={`w-10 h-10 rounded-xl ${color.iconBg} ${color.iconText} flex items-center justify-center`}><I className="w-4 h-4" strokeWidth={1.75} /></div>
      </div>
      <div className={`text-[10px] font-bold uppercase tracking-widest ${color.label} mb-1`}>{label}</div>
      <div className={`font-cabinet font-extrabold text-2xl ${color.value}`}>{count.toLocaleString()}</div>
      <div className={`mt-auto pt-1 text-[11px] font-semibold ${color.sub}`}>
        {amount.toLocaleString(undefined, { maximumFractionDigits: currency === 'USDT' ? 2 : 0 })} {currency}
      </div>
    </div>
  );
}

const COLORS = {
  pending: { border: 'border-amber-200', bg: 'bg-amber-50', iconBg: 'bg-amber-500', iconText: 'text-white', label: 'text-amber-700', value: 'text-amber-900', sub: 'text-amber-700' },
  valid: { border: 'border-emerald-200', bg: 'bg-emerald-50', iconBg: 'bg-emerald-500', iconText: 'text-white', label: 'text-emerald-700', value: 'text-emerald-900', sub: 'text-emerald-700' },
  rejected: { border: 'border-red-200', bg: 'bg-red-50', iconBg: 'bg-red-500', iconText: 'text-white', label: 'text-red-700', value: 'text-red-900', sub: 'text-red-700' },
  mobile: { border: 'border-blue-200', bg: 'bg-blue-50', iconBg: 'bg-blue-600', iconText: 'text-white', label: 'text-blue-700', value: 'text-blue-900', sub: 'text-blue-700' },
  crypto: { border: 'border-amber-200', bg: 'bg-gradient-to-br from-amber-50 to-orange-50', iconBg: 'bg-gradient-to-br from-amber-500 to-orange-600', iconText: 'text-white', label: 'text-amber-800', value: 'text-amber-950', sub: 'text-amber-700' },
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
  // New per-channel breakdowns (with safe defaults for legacy responses).
  const dch = stats.transactions.deposits_by_channel || { mobile_money: { count: 0, amount_xof: 0 }, crypto: { count: 0, amount_usdt: 0 } };
  const wch = stats.transactions.withdrawals_by_channel || { mobile_money: { count: 0, amount_xof: 0 }, crypto: { count: 0, amount_usdt: 0 } };
  const ops = stats.transactions.operations || { link_payments: { count: 0 }, api_payments: { count: 0 }, biz_to_biz: { count: 0 }, exchanges: { count: 0 } };

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
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="user-cards">
        <Card icon={Users} iconBg="bg-blue-50" iconColor="text-[#2563EB]" label="Utilisateurs inscrits" value={stats.users.total.toLocaleString()} sub={`${stats.users.active} actifs`} trend="+12.5%" />
        <Card icon={ShieldCheck} iconBg="bg-emerald-50" iconColor="text-emerald-600" label="KYC validés" value={stats.users.verified.toLocaleString()} sub={`${((stats.users.verified / Math.max(stats.users.total, 1)) * 100).toFixed(0)}% des utilisateurs`} trend="+15.3%" />
        <Card icon={Clock} iconBg="bg-amber-50" iconColor="text-amber-600" label="KYC en attente" value={stats.users.kyc_pending.toLocaleString()} sub="À traiter par l'admin" />
      </div>

      {/* Row 2 - Deposits (4 cards) */}
      <div>
        <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500 mb-3 flex items-center gap-2">
          <ArrowDownToLine className="w-3.5 h-3.5" /> Dépôts
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4" data-testid="deposit-cards">
          <TxCard label="Dépôts en attente" count={d.pending.count} amount={d.pending.amount} color={COLORS.pending} I={Clock} testId="dep-card-pending" />
          <TxCard label="Dépôts validés" count={d.valid.count} amount={d.valid.amount} color={COLORS.valid} I={CheckCircle2} testId="dep-card-valid" />
          <TxCard label="Dépôts rejetés" count={d.rejected.count} amount={d.rejected.amount} color={COLORS.rejected} I={XCircle} testId="dep-card-rejected" />
          <TxCard label="Dépôts Crypto" count={dch.crypto.count} amount={dch.crypto.amount_usdt} currency="USDT" color={COLORS.crypto} I={Bitcoin} testId="dep-card-crypto" />
        </div>
      </div>

      {/* Row 3 - Withdrawals (4 cards) */}
      <div>
        <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500 mb-3 flex items-center gap-2">
          <ArrowUpFromLine className="w-3.5 h-3.5" /> Retraits
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4" data-testid="withdrawal-cards">
          <TxCard label="Retraits en attente" count={w.pending.count} amount={w.pending.amount} color={COLORS.pending} I={Clock} testId="wd-card-pending" />
          <TxCard label="Retraits validés" count={w.valid.count} amount={w.valid.amount} color={COLORS.valid} I={CheckCircle2} testId="wd-card-valid" />
          <TxCard label="Retraits rejetés" count={w.rejected.count} amount={w.rejected.amount} color={COLORS.rejected} I={XCircle} testId="wd-card-rejected" />
          <TxCard label="Retraits Crypto" count={wch.crypto.count} amount={wch.crypto.amount_usdt} currency="USDT" color={COLORS.crypto} I={Bitcoin} testId="wd-card-crypto" />
        </div>
      </div>

      {/* Summary strip — per-channel breakdown */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="summary-strip">
        <div className="p-5 h-[168px] flex flex-col rounded-2xl bg-gradient-to-br from-[#3B82F6] to-[#1D4ED8] text-white shadow-[0_8px_24px_-8px_rgba(37,99,235,0.4)]" data-testid="total-deposits-card">
          <div className="w-10 h-10 rounded-xl bg-white/15 backdrop-blur flex items-center justify-center mb-3"><ArrowDownToLine className="w-4 h-4" /></div>
          <div className="text-[10px] font-bold uppercase tracking-widest opacity-90 mb-1">Volume dépôts total</div>
          <div className="space-y-1 mt-1">
            <div className="flex items-center gap-2 text-xs">
              <Smartphone className="w-3.5 h-3.5 opacity-80" />
              <span className="opacity-90">Mobile Money</span>
              <span className="ml-auto font-cabinet font-extrabold text-sm">
                {(dch.mobile_money.amount_xof || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} <span className="text-[10px] opacity-80">XOF</span>
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <Bitcoin className="w-3.5 h-3.5 opacity-80" />
              <span className="opacity-90">Crypto</span>
              <span className="ml-auto font-cabinet font-extrabold text-sm">
                {(dch.crypto.amount_usdt || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} <span className="text-[10px] opacity-80">USDT</span>
              </span>
            </div>
          </div>
          <div className="mt-auto pt-1 text-[10px] opacity-80">
            {(dch.mobile_money.count + dch.crypto.count).toLocaleString()} dépôts validés
          </div>
        </div>

        <div className="p-5 h-[168px] flex flex-col rounded-2xl bg-gradient-to-br from-emerald-500 to-emerald-700 text-white shadow-[0_8px_24px_-8px_rgba(16,185,129,0.4)]" data-testid="total-withdrawals-card">
          <div className="w-10 h-10 rounded-xl bg-white/15 backdrop-blur flex items-center justify-center mb-3"><ArrowUpFromLine className="w-4 h-4" /></div>
          <div className="text-[10px] font-bold uppercase tracking-widest opacity-90 mb-1">Volume retraits total</div>
          <div className="space-y-1 mt-1">
            <div className="flex items-center gap-2 text-xs">
              <Smartphone className="w-3.5 h-3.5 opacity-80" />
              <span className="opacity-90">Mobile Money</span>
              <span className="ml-auto font-cabinet font-extrabold text-sm">
                {(wch.mobile_money.amount_xof || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} <span className="text-[10px] opacity-80">XOF</span>
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <Bitcoin className="w-3.5 h-3.5 opacity-80" />
              <span className="opacity-90">Crypto</span>
              <span className="ml-auto font-cabinet font-extrabold text-sm">
                {(wch.crypto.amount_usdt || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} <span className="text-[10px] opacity-80">USDT</span>
              </span>
            </div>
          </div>
          <div className="mt-auto pt-1 text-[10px] opacity-80">
            {(wch.mobile_money.count + wch.crypto.count).toLocaleString()} retraits validés
          </div>
        </div>

        <div className="p-5 h-[168px] flex flex-col rounded-2xl bg-gradient-to-br from-violet-500 to-purple-700 text-white shadow-[0_8px_24px_-8px_rgba(139,92,246,0.4)]" data-testid="total-transactions-card">
          <div className="w-10 h-10 rounded-xl bg-white/15 backdrop-blur flex items-center justify-center mb-3"><TrendingUp className="w-4 h-4" /></div>
          <div className="text-[10px] font-bold uppercase tracking-widest opacity-90 mb-1">Transactions totales</div>
          <div className="font-cabinet font-extrabold text-2xl">{stats.transactions.count.toLocaleString()}</div>
          <div className="mt-auto pt-1 text-[10px] opacity-80 leading-relaxed">
            {stats.transactions.succeeded} réussies · {stats.transactions.pending} en attente · {stats.transactions.failed} échouées
            <br />
            <span className="opacity-90">Dépôts · Retraits · Liens · API · Biz→Biz · Échange</span>
          </div>
        </div>
      </div>
    </div>
  );
}
