import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, ArrowDownLeft, Link2, Repeat, Search, Filter, ShieldAlert, X, Eye, EyeOff } from 'lucide-react';
import api from '@/api';
import { useAuth } from '@/context/AuthContext';
import { useFeatures } from '@/hooks/useFeatures';
import TransactionDetailModal from './TransactionDetailModal';
import TransactionListItem from './TransactionListItem';

const RECENT_TRANSACTIONS_LIMIT = 5;

export default function DashboardHome() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { user, refresh } = useAuth();
  const features = useFeatures();
  const [txs, setTxs] = useState([]);
  const [selectedTx, setSelectedTx] = useState(null);
  const [query, setQuery] = useState('');
  const [showKycBanner, setShowKycBanner] = useState(true);
  const [hidden, setHidden] = useState(() => localStorage.getItem('btp_balance_hidden') === '1');

  useEffect(() => {
    api.get('/transactions', { params: { limit: RECENT_TRANSACTIONS_LIMIT } })
      .then(({ data }) => setTxs(Array.isArray(data) ? data.slice(0, RECENT_TRANSACTIONS_LIMIT) : []))
      .catch(() => setTxs([]));
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
  const balanceFontSize = (wallet) => {
    const characterCount = `${mask(wallet.bal)} ${wallet.curr}`.length;
    return `clamp(0.9rem, ${Math.min(28, 180 / characterCount)}cqw, 2.75rem)`;
  };

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
        className="relative isolate overflow-hidden rounded-[1.45rem] border border-[#43C5FF]/70 bg-[#0754C9] text-white shadow-[0_22px_48px_-20px_rgba(4,64,173,.7)] sm:rounded-[1.7rem]"
      >
        <div className="relative aspect-[876/345] w-full border-b border-[#39C4FF]/60">
          <img
            src="/wallet-reference-top.webp"
            alt="Mon portefeuille Biz-transPay"
            className="absolute inset-0 h-full w-full object-cover"
          />
          <h2 className="sr-only">Mon portefeuille</h2>
          <p className="sr-only">Gérez tous vos soldes en un seul endroit</p>
          <button
            onClick={toggleHidden}
            data-testid="btn-toggle-balance"
            aria-label={hidden ? 'Afficher les soldes' : 'Masquer les soldes'}
            className="absolute right-[2.8%] top-[5%] z-20 flex h-9 w-9 items-center justify-center rounded-full bg-[#1683EE]/95 text-white ring-1 ring-white/30 shadow-md transition-transform hover:scale-105 sm:h-12 sm:w-12"
          >
            {hidden ? <Eye className="h-[17px] w-[17px] sm:h-5 sm:w-5" /> : <EyeOff className="h-[17px] w-[17px] sm:h-5 sm:w-5" />}
          </button>
        </div>

        <div className="relative grid min-h-[6.2rem] grid-cols-3 gap-0 bg-gradient-to-b from-[#0759D2] to-[#0844B5] shadow-[inset_0_1px_0_rgba(255,255,255,.13)] sm:min-h-[8.2rem]">
          {wallets.map((b, index) => (
            <div
              key={b.curr}
              data-testid={`balance-card-${b.curr.toLowerCase()}`}
              className={`relative flex min-w-0 items-center justify-center px-1 py-4 sm:px-4 sm:py-5 ${
                index > 0
                  ? 'before:absolute before:bottom-0 before:left-0 before:top-0 before:w-px before:bg-white/25'
                  : ''
              }`}
              style={{ containerType: 'inline-size' }}
            >
              <span className={`absolute left-0 top-1/2 z-10 m-1 flex h-6 w-6 -translate-y-1/2 shrink-0 items-center justify-center rounded-full text-[6px] font-extrabold uppercase tracking-[-.04em] shadow-inner ring-1 ring-white/25 sm:m-2 sm:h-10 sm:w-10 sm:text-[8px] ${
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
                className="min-w-0 max-w-full overflow-hidden whitespace-nowrap pl-8 text-center font-extrabold leading-none tracking-[-.055em] text-white sm:pl-16"
                style={{ fontSize: balanceFontSize(b) }}
                title={`${mask(b.bal)} ${b.curr}`}
              >
                {mask(b.bal)} <span className="text-[.58em] font-semibold tracking-[-.02em] text-white/80">{b.curr}</span>
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
            <TransactionListItem
              key={tx.id}
              tx={tx}
              hidden={hidden}
              onClick={() => setSelectedTx(tx)}
              testId={`home-tx-row-${tx.id}`}
            />
          ))}
        </div>
      </div>
      {selectedTx && <TransactionDetailModal tx={selectedTx} onClose={() => setSelectedTx(null)} />}
    </div>
  );
}
