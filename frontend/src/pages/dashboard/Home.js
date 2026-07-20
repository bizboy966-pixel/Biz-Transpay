import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Wallet, ArrowUpRight, ArrowDownLeft, Link2, Repeat, Search, Filter, ShieldAlert, X } from 'lucide-react';
import api from '@/api';
import { useAuth } from '@/context/AuthContext';

export default function DashboardHome() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { user, refresh } = useAuth();
  const [txs, setTxs] = useState([]);
  const [query, setQuery] = useState('');
  const [showKycBanner, setShowKycBanner] = useState(true);

  useEffect(() => {
    api.get('/transactions', { params: { limit: 5 } }).then(({ data }) => setTxs(data)).catch(() => {});
    refresh();
    // eslint-disable-next-line
  }, []);

  const actions = [
    { to: '/dashboard/transfer', I: ArrowUpRight, bg: 'bg-emerald-50', color: 'text-emerald-600', ring: 'group-hover:bg-emerald-500', label: t('dashboard.transfer'), key: 'transfer' },
    { to: '/dashboard/deposit', I: ArrowDownLeft, bg: 'bg-blue-50', color: 'text-[#2563EB]', ring: 'group-hover:bg-[#2563EB]', label: t('dashboard.deposit'), key: 'deposit' },
    { to: '/dashboard/links', I: Link2, bg: 'bg-violet-50', color: 'text-violet-600', ring: 'group-hover:bg-violet-500', label: t('dashboard.link'), key: 'link' },
    { to: '/dashboard/exchange', I: Repeat, bg: 'bg-orange-50', color: 'text-orange-600', ring: 'group-hover:bg-orange-500', label: t('dashboard.exchange'), key: 'exchange' },
  ];

  const needsKyc = user?.kyc_status !== 'verified' && showKycBanner;

  return (
    <div className="space-y-8" data-testid="dashboard-home">
      {needsKyc && (
        <div className="relative rounded-[20px] border border-orange-200 bg-gradient-to-r from-orange-50 to-amber-50 p-5 sm:p-6 flex items-start gap-4" data-testid="kyc-banner">
          <div className="w-12 h-12 rounded-2xl bg-orange-500 text-white flex items-center justify-center shrink-0"><ShieldAlert className="w-6 h-6" /></div>
          <div className="flex-1">
            <div className="font-cabinet font-bold text-slate-900 text-lg">{t('dashboard.kyc_banner_title')}</div>
            <p className="mt-1 text-sm text-slate-700">{t('dashboard.kyc_banner_body')}</p>
            <Link to="/dashboard/kyc" data-testid="btn-kyc-cta" className="mt-3 inline-flex items-center gap-2 bg-orange-500 hover:bg-orange-600 text-white font-semibold px-5 py-2.5 rounded-full text-sm">
              {t('dashboard.kyc_banner_cta')}
            </Link>
          </div>
          <button onClick={() => setShowKycBanner(false)} className="w-8 h-8 rounded-lg hover:bg-white/70 flex items-center justify-center" data-testid="btn-close-kyc-banner"><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Balance cards */}
      <div className="grid md:grid-cols-2 gap-6">
        {[
          { curr: 'XOF', bal: user?.balance_xof ?? 0 },
          { curr: 'XAF', bal: user?.balance_xaf ?? 0 },
        ].map((b) => (
          <div key={b.curr} data-testid={`balance-card-${b.curr.toLowerCase()}`} className="relative overflow-hidden rounded-[24px] p-7 text-white bg-gradient-to-br from-[#3B82F6] via-[#2563EB] to-[#1D4ED8] shadow-[0_20px_50px_-15px_rgba(37,99,235,0.5)]">
            <div className="absolute -top-16 -right-16 w-56 h-56 rounded-full bg-white/10" />
            <div className="absolute -bottom-24 -left-16 w-56 h-56 rounded-full bg-white/5" />
            <div className="relative flex items-start justify-between">
              <div>
                <div className="text-xs uppercase tracking-widest text-white/80 font-semibold">{t('dashboard.available')}</div>
                <div className="mt-2 font-cabinet font-extrabold text-4xl sm:text-5xl">{b.curr}</div>
                <div className="mt-3 font-mono text-white/80 text-sm">{b.bal.toLocaleString()} <span className="text-xs">{b.curr}</span></div>
              </div>
              <div className="w-12 h-12 rounded-2xl bg-white/15 backdrop-blur flex items-center justify-center">
                <Wallet className="w-6 h-6 text-white" strokeWidth={1.75} />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Quick actions */}
      <div className="bg-white border border-slate-100 rounded-[24px] p-6 sm:p-8 shadow-[0_4px_20px_rgba(15,23,42,0.04)]">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {actions.map((a) => (
            <button
              key={a.key}
              onClick={() => nav(a.to)}
              data-testid={`quick-action-${a.key}`}
              className="group flex flex-col items-center gap-3 py-4 rounded-2xl hover:bg-slate-50 transition-colors active:scale-95"
            >
              <div className={`w-16 h-16 rounded-full ${a.bg} ${a.color} flex items-center justify-center transition-colors ${a.ring} group-hover:text-white`}>
                <a.I className="w-6 h-6" strokeWidth={1.75} />
              </div>
              <div className="font-cabinet font-bold text-slate-900 text-sm">{a.label}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Search */}
      <div className="bg-white border border-slate-100 rounded-[24px] p-3 flex items-center gap-3 shadow-[0_4px_20px_rgba(15,23,42,0.04)]">
        <Search className="w-5 h-5 text-slate-400 ml-3" />
        <input
          data-testid="dashboard-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && nav(`/dashboard/transactions?q=${query}`)}
          placeholder={t('dashboard.search_ph')}
          className="flex-1 py-2.5 outline-none text-sm bg-transparent"
        />
        <button data-testid="btn-filter" className="w-10 h-10 rounded-xl hover:bg-slate-100 flex items-center justify-center">
          <Filter className="w-4 h-4 text-slate-600" />
        </button>
      </div>

      {/* Recent transactions */}
      <div className="bg-white border border-slate-100 rounded-[24px] shadow-[0_4px_20px_rgba(15,23,42,0.04)]">
        <div className="p-6 flex items-center justify-between border-b border-slate-100">
          <h3 className="font-cabinet font-bold text-slate-900 text-lg">{t('dashboard.recent_activity')}</h3>
          <Link to="/dashboard/transactions" className="text-sm font-semibold text-[#2563EB] hover:text-[#1D4ED8]" data-testid="link-all-tx">Voir tout →</Link>
        </div>
        <div className="divide-y divide-slate-50">
          {txs.length === 0 && <div className="p-10 text-center text-slate-400 text-sm">{t('dashboard.no_tx')}</div>}
          {txs.map((tx) => (
            <div key={tx.id} className="p-5 flex items-center gap-4">
              <div className={`w-11 h-11 rounded-xl flex items-center justify-center ${tx.direction === 'in' ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-50 text-slate-700'}`}>
                {tx.direction === 'in' ? <ArrowDownLeft className="w-5 h-5" /> : <ArrowUpRight className="w-5 h-5" />}
              </div>
              <div className="flex-1">
                <div className="font-semibold text-slate-900 text-sm">{tx.type} {tx.counterparty && `→ ${tx.counterparty}`}</div>
                <div className="text-xs text-slate-500">{new Date(tx.created_at).toLocaleString()}</div>
              </div>
              <div className={`font-bold ${tx.direction === 'in' ? 'text-emerald-600' : 'text-slate-900'}`}>
                {tx.direction === 'in' ? '+' : '-'}{tx.amount.toLocaleString()} <span className="text-xs opacity-70">{tx.currency}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
