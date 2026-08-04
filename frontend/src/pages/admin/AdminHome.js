import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Users, ShieldCheck, Clock, ArrowDownToLine, ArrowUpFromLine,
  CheckCircle2, XCircle, TrendingUp, Smartphone, Bitcoin, ChevronRight,
} from 'lucide-react';
import api from '@/api';

/* --------------------------------- UI ---------------------------------- */
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

function TxCard({ label, count, amount, currency = 'XOF', color, I, testId, toPending }) {
  return (
    <div className={`rounded-2xl p-5 h-[168px] flex flex-col border ${color.border} ${color.bg} shadow-[0_2px_10px_rgba(15,23,42,0.03)] hover:shadow-[0_8px_24px_rgba(15,23,42,0.06)] transition-shadow`} data-testid={testId || `tx-card-${label}`}>
      <div className="flex items-center justify-between mb-3">
        <div className={`w-10 h-10 rounded-xl ${color.iconBg} ${color.iconText} flex items-center justify-center`}><I className="w-4 h-4" strokeWidth={1.75} /></div>
        {toPending && (
          <Link to={toPending} data-testid={`${testId}-cta`} className={`text-[10px] font-bold ${color.label} hover:underline inline-flex items-center gap-0.5`}>
            Traiter <ChevronRight className="w-3 h-3" />
          </Link>
        )}
      </div>
      <div className={`text-[10px] font-bold uppercase tracking-widest ${color.label} mb-1`}>{label}</div>
      <div className={`font-cabinet font-extrabold text-2xl ${color.value}`}>{count.toLocaleString()}</div>
      <div className={`mt-auto pt-1 text-[11px] font-semibold ${color.sub}`}>
        {amount.toLocaleString(undefined, { maximumFractionDigits: currency === 'USDT' ? 2 : 0 })} {currency}
      </div>
    </div>
  );
}

/**
 * Larger card for Crypto (deposits or withdrawals) that stacks 3 sub-rows
 * (Pending / Valid / Rejected) inside a single visual container. Each row is
 * clickable to route to a pre-filtered admin-transactions view.
 */
function CryptoCard({ label, sub, ch, direction }) {
  const items = [
    { key: 'pending', k: 'En attente', bg: 'bg-amber-500', dot: 'bg-amber-500', badge: 'bg-amber-50 text-amber-700 border-amber-200', I: Clock, status: 'pending' },
    { key: 'valid', k: 'Validés', bg: 'bg-emerald-500', dot: 'bg-emerald-500', badge: 'bg-emerald-50 text-emerald-700 border-emerald-200', I: CheckCircle2, status: 'completed' },
    { key: 'rejected', k: 'Rejetés', bg: 'bg-red-500', dot: 'bg-red-500', badge: 'bg-red-50 text-red-700 border-red-200', I: XCircle, status: 'failed' },
  ];
  const total = (ch.pending?.count || 0) + (ch.valid?.count || 0) + (ch.rejected?.count || 0);
  return (
    <div className="rounded-2xl p-5 border border-amber-200 bg-gradient-to-br from-amber-50 to-orange-50 shadow-[0_4px_16px_rgba(245,158,11,0.08)] hover:shadow-[0_8px_28px_rgba(245,158,11,0.14)] transition-shadow"
         data-testid={`crypto-card-${direction}`}>
      <div className="flex items-start justify-between mb-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 text-white flex items-center justify-center">
          <Bitcoin className="w-4 h-4" strokeWidth={1.75} />
        </div>
        <div className="text-right">
          <div className="text-[10px] font-bold uppercase tracking-widest text-amber-800">{label}</div>
          <div className="text-[10px] text-amber-700 mt-0.5">{sub}</div>
        </div>
      </div>
      <div className="font-cabinet font-extrabold text-2xl text-amber-950 mb-0.5">{total.toLocaleString()}</div>
      <div className="text-[11px] font-semibold text-amber-700 mb-3">
        {(ch.amount_usdt || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} USDT validés
      </div>
      <div className="space-y-1.5">
        {items.map((it) => {
          const b = ch[it.key] || { count: 0, amount: 0 };
          return (
            <Link key={it.key}
              to={`/admin/transactions?type=${direction === 'in' ? 'deposit' : 'withdrawal'}&channel=crypto&status=${it.status}`}
              data-testid={`crypto-${direction}-${it.key}`}
              className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-white/70 hover:bg-white transition-colors border ${it.badge.split(' ').pop()} group`}>
              <span className={`w-1.5 h-1.5 rounded-full ${it.dot}`} />
              <it.I className="w-3.5 h-3.5 text-slate-600" />
              <span className="text-[11px] font-semibold text-slate-700">{it.k}</span>
              <span className="ml-auto font-cabinet font-extrabold text-sm text-slate-900">{(b.count || 0).toLocaleString()}</span>
              <span className="text-[10px] text-slate-500 tabular-nums">
                {(b.amount || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} USDT
              </span>
              <ChevronRight className="w-3 h-3 text-slate-300 group-hover:text-slate-600" />
            </Link>
          );
        })}
      </div>
    </div>
  );
}

const COLORS = {
  pending: { border: 'border-amber-200', bg: 'bg-amber-50', iconBg: 'bg-amber-500', iconText: 'text-white', label: 'text-amber-700', value: 'text-amber-900', sub: 'text-amber-700' },
  valid: { border: 'border-emerald-200', bg: 'bg-emerald-50', iconBg: 'bg-emerald-500', iconText: 'text-white', label: 'text-emerald-700', value: 'text-emerald-900', sub: 'text-emerald-700' },
  rejected: { border: 'border-red-200', bg: 'bg-red-50', iconBg: 'bg-red-500', iconText: 'text-white', label: 'text-red-700', value: 'text-red-900', sub: 'text-red-700' },
};

/* -------------------------------- Page --------------------------------- */
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

  // Per-channel breakdowns (safe defaults).
  const emptyCh = { count: 0, amount_xof: 0, amount_usdt: 0, pending: { count: 0, amount: 0 }, valid: { count: 0, amount: 0 }, rejected: { count: 0, amount: 0 } };
  const dch = stats.transactions.deposits_by_channel || {};
  const wch = stats.transactions.withdrawals_by_channel || {};
  const dCrypto = { ...emptyCh, ...(dch.crypto || {}) };
  const dMM = { ...emptyCh, ...(dch.mobile_money || {}) };
  const wCrypto = { ...emptyCh, ...(wch.crypto || {}) };
  const wMM = { ...emptyCh, ...(wch.mobile_money || {}) };

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

      {/* Row 2 - Deposits (Mobile Money FCFA + Crypto) */}
      <div>
        <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500 mb-3 flex items-center gap-2">
          <ArrowDownToLine className="w-3.5 h-3.5" /> Dépôts
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4" data-testid="deposit-cards">
          <TxCard label="Dépôts en attente" count={dMM.pending.count} amount={dMM.pending.amount} color={COLORS.pending} I={Clock} testId="dep-mm-pending" toPending="/admin/transactions?type=deposit&channel=mobile_money&status=pending" />
          <TxCard label="Dépôts validés" count={dMM.valid.count} amount={dMM.valid.amount} color={COLORS.valid} I={CheckCircle2} testId="dep-mm-valid" />
          <TxCard label="Dépôts rejetés" count={dMM.rejected.count} amount={dMM.rejected.amount} color={COLORS.rejected} I={XCircle} testId="dep-mm-rejected" />
          <CryptoCard label="Dépôts Crypto" sub="USDT · USDC · BTC…" ch={dCrypto} direction="in" />
        </div>
      </div>

      {/* Row 3 - Withdrawals (Mobile Money FCFA + Crypto) */}
      <div>
        <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500 mb-3 flex items-center gap-2">
          <ArrowUpFromLine className="w-3.5 h-3.5" /> Retraits
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4" data-testid="withdrawal-cards">
          <TxCard label="Retraits en attente" count={wMM.pending.count} amount={wMM.pending.amount} color={COLORS.pending} I={Clock} testId="wd-mm-pending" toPending="/admin/transactions?type=withdrawal&channel=mobile_money&status=pending" />
          <TxCard label="Retraits validés" count={wMM.valid.count} amount={wMM.valid.amount} color={COLORS.valid} I={CheckCircle2} testId="wd-mm-valid" />
          <TxCard label="Retraits rejetés" count={wMM.rejected.count} amount={wMM.rejected.amount} color={COLORS.rejected} I={XCircle} testId="wd-mm-rejected" />
          <CryptoCard label="Retraits Crypto" sub="USDT · USDC · BTC…" ch={wCrypto} direction="out" />
        </div>
      </div>

      {/* Summary strip — per-channel volumes */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="summary-strip">
        <div className="p-5 h-[168px] flex flex-col rounded-2xl bg-gradient-to-br from-[#3B82F6] to-[#1D4ED8] text-white shadow-[0_8px_24px_-8px_rgba(37,99,235,0.4)]" data-testid="total-deposits-card">
          <div className="w-10 h-10 rounded-xl bg-white/15 backdrop-blur flex items-center justify-center mb-3"><ArrowDownToLine className="w-4 h-4" /></div>
          <div className="text-[10px] font-bold uppercase tracking-widest opacity-90 mb-1">Volume dépôts total</div>
          <div className="space-y-1 mt-1">
            <div className="flex items-center gap-2 text-xs">
              <Smartphone className="w-3.5 h-3.5 opacity-80" />
              <span className="opacity-90">Mobile Money</span>
              <span className="ml-auto font-cabinet font-extrabold text-sm">
                {(dMM.amount_xof || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} <span className="text-[10px] opacity-80">XOF</span>
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <Bitcoin className="w-3.5 h-3.5 opacity-80" />
              <span className="opacity-90">Crypto</span>
              <span className="ml-auto font-cabinet font-extrabold text-sm">
                {(dCrypto.amount_usdt || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} <span className="text-[10px] opacity-80">USDT</span>
              </span>
            </div>
          </div>
          <div className="mt-auto pt-1 text-[10px] opacity-80">
            {(dMM.count + dCrypto.count).toLocaleString()} dépôts validés
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
                {(wMM.amount_xof || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} <span className="text-[10px] opacity-80">XOF</span>
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <Bitcoin className="w-3.5 h-3.5 opacity-80" />
              <span className="opacity-90">Crypto</span>
              <span className="ml-auto font-cabinet font-extrabold text-sm">
                {(wCrypto.amount_usdt || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} <span className="text-[10px] opacity-80">USDT</span>
              </span>
            </div>
          </div>
          <div className="mt-auto pt-1 text-[10px] opacity-80">
            {(wMM.count + wCrypto.count).toLocaleString()} retraits validés
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
