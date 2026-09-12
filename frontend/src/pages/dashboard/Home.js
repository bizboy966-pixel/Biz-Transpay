import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Wallet, ArrowUpRight, ArrowDownLeft, Link2, Repeat, Search, Filter, ShieldAlert, X, Eye, EyeOff } from 'lucide-react';
import api from '@/api';
import { useAuth } from '@/context/AuthContext';
import { useFeatures } from '@/hooks/useFeatures';

export default function DashboardHome() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { user, refresh } = useAuth();
  const features = useFeatures();
  const [txs, setTxs] = useState([]);
  const [query, setQuery] = useState('');
  const [showKycBanner, setShowKycBanner] = useState(true);
  const [hidden, setHidden] = useState(() => localStorage.getItem('btp_balance_hidden') === '1');

  useEffect(() => {
    api.get('/transactions', { params: { limit: 5 } }).then(({ data }) => setTxs(data)).catch(() => {});
    refresh();
    // eslint-disable-next-line
  }, []);

  const toggleHidden = () => {
    const nv = !hidden;
    setHidden(nv);
    localStorage.setItem('btp_balance_hidden', nv ? '1' : '0');
  };

  const actions = [
    { to: '/dashboard/transfer', I: ArrowUpRight, bg: 'bg-emerald-50', color: 'text-emerald-600', ring: 'group-hover:bg-emerald-500', label: t('dashboard.transfer'), key: 'transfer' },
    { to: '/dashboard/deposit', I: ArrowDownLeft, bg: 'bg-blue-50', color: 'text-[#2563EB]', ring: 'group-hover:bg-[#2563EB]', label: t('dashboard.deposit'), key: 'deposit' },
    ...(features?.links_enabled !== false
      ? [{ to: '/dashboard/links', I: Link2, bg: 'bg-violet-50', color: 'text-violet-600', ring: 'group-hover:bg-violet-500', label: t('dashboard.link'), key: 'link' }]
      : []),
    { to: '/dashboard/exchange', I: Repeat, bg: 'bg-orange-50', color: 'text-orange-600', ring: 'group-hover:bg-orange-500', label: t('dashboard.exchange'), key: 'exchange' },
  ];

  const needsKyc = user?.kyc_status !== 'verified' && showKycBanner;

  const wallets = [
    { key: 'xof', curr: 'XOF', bal: user?.balance_xof ?? 0, gradient: 'from-[#3B82F6] via-[#2563EB] to-[#1D4ED8]', shadow: 'shadow-[0_12px_32px_-12px_rgba(37,99,235,0.45)]' },
    { key: 'xaf', curr: 'XAF', bal: user?.balance_xaf ?? 0, gradient: 'from-[#3B82F6] via-[#2563EB] to-[#1D4ED8]', shadow: 'shadow-[0_12px_32px_-12px_rgba(37,99,235,0.45)]' },
    { key: 'crypto', curr: 'USDT', bal: user?.balance_usdt ?? 0, gradient: 'from-emerald-500 via-emerald-600 to-teal-700', shadow: 'shadow-[0_12px_32px_-12px_rgba(16,185,129,0.45)]' },
  ].filter((w) => !features || features[`wallet_${w.key}_enabled`] !== false);

  const mask = (v) => hidden ? '••••••' : v.toLocaleString(undefined, { maximumFractionDigits: 2 });

  return (
    <div className="space-y-4 sm:space-y-6" data-testid="dashboard-home">
      {needsKyc && (
        <div className="relative rounded-xl border border-orange-200 bg-gradient-to-r from-orange-50 to-amber-50 p-3 sm:p-4 flex items-start gap-2.5 sm:gap-3" data-testid="kyc-banner">
          <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-xl bg-orange-500 text-white flex items-center justify-center shrink-0"><ShieldAlert className="w-4 h-4 sm:w-5 sm:h-5" /></div>
          <div className="flex-1 min-w-0">
            <div className="font-cabinet font-bold text-slate-900 text-xs sm:text-sm">{t('dashboard.kyc_banner_title')}</div>
            <p className="mt-0.5 text-[11px] sm:text-xs text-slate-700">{t('dashboard.kyc_banner_body')}</p>
            <Link to="/dashboard/kyc" data-testid="btn-kyc-cta" className="mt-2 inline-flex items-center gap-1.5 bg-orange-500 hover:bg-orange-600 text-white font-semibold px-3 sm:px-4 py-1.5 sm:py-2 rounded-full text-[11px] sm:text-xs">
              {t('dashboard.kyc_banner_cta')}
            </Link>
          </div>
          <button onClick={() => setShowKycBanner(false)} className="w-7 h-7 rounded-lg hover:bg-white/70 flex items-center justify-center" data-testid="btn-close-kyc-banner"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {/* Unified wallet card: composition follows the supplied wallet reference. */}
      <section
        data-testid="wallet-balance-card"
        className="relative isolate overflow-hidden rounded-[1.45rem] border border-[#4B9BFF]/35 bg-gradient-to-br from-[#1874E8] via-[#0754C9] to-[#123A9E] text-white shadow-[0_20px_42px_-22px_rgba(13,57,143,.72)] sm:rounded-[1.7rem]"
      >
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,.12),transparent_30%),linear-gradient(180deg,rgba(11,80,191,.05),rgba(4,40,123,.2))]" />
        <div className="pointer-events-none absolute right-[-9%] top-[-32%] h-[22rem] w-[22rem] rounded-full border border-white/[.08]" />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-0 bg-[length:auto_112%] bg-[position:96%_54%] bg-no-repeat opacity-[.82] drop-shadow-[0_14px_18px_rgba(2,28,91,.3)] sm:bg-[length:auto_138%] sm:bg-[position:93%_54%] sm:opacity-[.9]"
          style={{ backgroundImage: "url('/wallet-card-illustration-cfa-transparent.png')" }}
        />
        <div className="relative min-h-[12rem] border-b border-white/25 px-4 pt-4 sm:min-h-[15rem] sm:px-7 sm:pt-6">
          <div className="relative z-10 flex max-w-[58%] items-start gap-2.5 sm:max-w-[56%] sm:gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/15 shadow-inner ring-1 ring-white/15 sm:h-12 sm:w-12">
              <Wallet className="h-5 w-5 sm:h-6 sm:w-6" strokeWidth={1.8} />
            </div>
            <div className="min-w-0 pt-0.5">
              <h2 className="whitespace-nowrap font-cabinet text-[1.05rem] font-extrabold leading-tight tracking-[-.035em] sm:text-[1.8rem]">Mon portefeuille</h2>
              <p className="mt-1 max-w-[19rem] text-[10px] leading-snug text-white/78 sm:text-sm">Gérez tous vos soldes en un seul endroit</p>
            </div>
          </div>
          <button
            onClick={toggleHidden}
            data-testid="btn-toggle-balance"
            aria-label={hidden ? 'Afficher les soldes' : 'Masquer les soldes'}
            className="absolute right-3 top-3 z-20 flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-white ring-1 ring-white/15 backdrop-blur-sm transition-colors hover:bg-white/25 sm:right-6 sm:top-5 sm:h-11 sm:w-11"
          >
            {hidden ? <Eye className="h-[17px] w-[17px] sm:h-5 sm:w-5" /> : <EyeOff className="h-[17px] w-[17px] sm:h-5 sm:w-5" />}
          </button>
        </div>

        <div className="relative grid min-h-[5.8rem] grid-cols-3 gap-0 border-t border-white/10 bg-[#063EAA]/80 px-2.5 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,.08)] backdrop-blur-[2px] sm:min-h-[7rem] sm:px-6 sm:py-5">
          {wallets.map((b, index) => (
            <div
              key={b.curr}
              data-testid={`balance-card-${b.curr.toLowerCase()}`}
              className={`flex min-w-0 items-center px-1 py-0.5 sm:px-4 ${index > 0 ? 'border-l border-white/25' : ''}`}
            >
              <div className="flex min-w-0 items-center gap-2 sm:gap-3">
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[8px] font-extrabold uppercase tracking-[-.04em] shadow-inner ring-1 ring-white/25 sm:h-14 sm:w-14 sm:text-[11px] ${
                  b.curr === 'XOF'
                    ? 'bg-gradient-to-br from-[#36C1FF] to-[#1470ED]'
                    : b.curr === 'XAF'
                      ? 'bg-gradient-to-br from-[#B15CFF] to-[#7138E8]'
                      : 'bg-gradient-to-br from-[#32D6A0] to-[#07966F]'
                }`}>
                  {b.curr === 'XOF' ? 'FCFA' : b.curr === 'XAF' ? 'CFA' : 'USDT'}
                </span>
                <div
                  data-testid={`balance-value-${b.curr.toLowerCase()}`}
                  className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-[clamp(.65rem,2.8vw,1.2rem)] font-extrabold tracking-[-.045em] text-white sm:text-[clamp(1rem,2vw,1.5rem)]"
                  title={`${mask(b.bal)} ${b.curr}`}
                >
                  {mask(b.bal)} <span className="text-[.72em] font-semibold text-white/80">{b.curr}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Quick actions */}
      <div className="bg-white border border-slate-100 rounded-2xl p-3 sm:p-5 shadow-[0_2px_12px_rgba(15,23,42,0.03)]">
        <div className="grid grid-cols-4 gap-2 sm:gap-3">
          {actions.map((a) => (
            <button
              key={a.key}
              onClick={() => nav(a.to)}
              data-testid={`quick-action-${a.key}`}
              className="group flex flex-col items-center gap-1.5 sm:gap-2 py-2.5 sm:py-3 rounded-xl hover:bg-slate-50 transition-colors active:scale-95"
            >
              <div className={`w-10 h-10 sm:w-12 sm:h-12 rounded-full ${a.bg} ${a.color} flex items-center justify-center transition-colors ${a.ring} group-hover:text-white`}>
                <a.I className="w-4 h-4 sm:w-5 sm:h-5" strokeWidth={1.75} />
              </div>
              <div className="font-cabinet font-bold text-slate-900 text-[10px] sm:text-xs">{a.label}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Search */}
      <div className="bg-white border border-slate-100 rounded-2xl p-2.5 sm:p-3 flex items-center gap-2 sm:gap-3 shadow-[0_4px_20px_rgba(15,23,42,0.04)]">
        <Search className="w-4 h-4 sm:w-5 sm:h-5 text-slate-400 ml-2 sm:ml-3" />
        <input
          data-testid="dashboard-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && nav(`/dashboard/transactions?q=${query}`)}
          placeholder={t('dashboard.search_ph')}
          className="flex-1 py-2 sm:py-2.5 outline-none text-xs sm:text-sm bg-transparent"
        />
        <button data-testid="btn-filter" className="w-8 h-8 sm:w-10 sm:h-10 rounded-xl hover:bg-slate-100 flex items-center justify-center">
          <Filter className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-slate-600" />
        </button>
      </div>

      {/* Recent transactions */}
      <div className="bg-white border border-slate-100 rounded-2xl shadow-[0_4px_20px_rgba(15,23,42,0.04)]">
        <div className="p-4 sm:p-6 flex items-center justify-between border-b border-slate-100">
          <h3 className="font-cabinet font-bold text-slate-900 text-sm sm:text-lg">{t('dashboard.recent_activity')}</h3>
          <Link to="/dashboard/transactions" className="text-xs sm:text-sm font-semibold text-[#2563EB] hover:text-[#1D4ED8]" data-testid="link-all-tx">{t('hero.see_all')} →</Link>
        </div>
        <div className="divide-y divide-slate-50">
          {txs.length === 0 && <div className="p-8 sm:p-10 text-center text-slate-400 text-xs sm:text-sm">{t('dashboard.no_tx')}</div>}
          {txs.map((tx) => (
            <div key={tx.id} className="p-3 sm:p-5 flex items-center gap-3 sm:gap-4">
              <div className={`w-9 h-9 sm:w-11 sm:h-11 rounded-xl flex items-center justify-center shrink-0 ${tx.direction === 'in' ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-50 text-slate-700'}`}>
                {tx.direction === 'in' ? <ArrowDownLeft className="w-4 h-4 sm:w-5 sm:h-5" /> : <ArrowUpRight className="w-4 h-4 sm:w-5 sm:h-5" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-slate-900 text-xs sm:text-sm truncate">{tx.type} {tx.counterparty && `→ ${tx.counterparty}`}</div>
                <div className="text-[10px] sm:text-xs text-slate-500">{new Date(tx.created_at).toLocaleString()}</div>
              </div>
              <div className={`font-bold text-xs sm:text-sm whitespace-nowrap ${tx.direction === 'in' ? 'text-emerald-600' : 'text-slate-900'}`}>
                {tx.direction === 'in' ? '+' : '-'}{hidden ? '•••' : tx.amount.toLocaleString()} <span className="text-[10px] sm:text-xs opacity-70">{tx.currency}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
