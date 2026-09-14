import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  Clock3,
  Globe2,
  Landmark,
  RefreshCw,
  Repeat2,
  ShieldCheck,
  Smartphone,
  WalletCards,
} from 'lucide-react';
import api from '@/api';

const numberFormatter = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });

function formatAmount(value) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  return Number.isFinite(number) ? numberFormatter.format(number) : String(value);
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })} · ${date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
}

function errorCopy(error) {
  const status = error?.response?.status;
  const detail = error?.response?.data?.detail;
  if (status === 409) return typeof detail === 'string'
    ? detail
    : 'Mbiyo est désactivé ou ne possède pas encore de clé API configurée.';
  if (status === 502) return 'Le prestataire de paiement ne répond pas. Vérifiez sa disponibilité puis réessayez.';
  if (status === 503) return 'Le service de soldes est temporairement indisponible. Réessayez dans quelques instants.';
  return typeof detail === 'string' ? detail : 'Impossible de charger les soldes des prestataires.';
}

function Skeleton({ className = '' }) {
  return <div className={`bt-skeleton rounded-lg ${className}`} aria-hidden="true" />;
}

function MetricCard({ icon: Icon, label, value, detail, tone = 'blue', stale = false }) {
  const tones = {
    blue: 'bg-blue-50 text-blue-700 border-blue-100',
    teal: 'bg-teal-50 text-teal-700 border-teal-100',
    slate: 'bg-slate-50 text-slate-700 border-slate-200',
  };
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_12px_30px_-26px_rgba(15,23,42,.35)]">
      <div className="flex items-start justify-between gap-3">
        <div className={`flex h-9 w-9 items-center justify-center rounded-xl border ${tones[tone]}`}><Icon className="h-4 w-4" /></div>
        <span className={`text-[10px] font-bold uppercase tracking-[.16em] ${stale ? 'text-amber-600' : 'text-slate-400'}`}>
          {stale ? 'À actualiser' : 'Temps réel'}
        </span>
      </div>
      <div className="mt-5 text-[11px] font-bold uppercase tracking-[.12em] text-slate-500">{label}</div>
      <div className="mt-1 font-cabinet text-2xl font-extrabold tracking-tight text-slate-900">{value}</div>
      <div className="mt-1 text-[11px] text-slate-500">{detail}</div>
    </div>
  );
}

function PermissionPill({ active, icon: Icon, label }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-1 text-[10px] font-semibold ${active ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-slate-50 text-slate-400'}`}>
      <Icon className="h-3 w-3" /> {label}
    </span>
  );
}

export default function AdminFunds() {
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [stale, setStale] = useState(false);

  const load = useCallback(async (manual = false) => {
    setError(null);
    if (manual) setRefreshing(true);
    else setLoading(true);
    try {
      const { data } = await api.get('/admin/funds');
      setPayload(data);
      setStale(false);
    } catch (err) {
      setError(err);
      setStale(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const wallets = payload?.wallets || [];
  const networks = payload?.network_balances || [];
  const totals = payload?.wallet_totals || [];
  const currencyCount = new Set(wallets.map((wallet) => wallet.currency).filter(Boolean)).size;
  const providerLabel = payload?.provider || 'Prestataire';
  const modeLabel = payload?.mode === 'live' ? 'Production' : payload?.mode === 'test' ? 'Test' : '—';

  return (
    <div className="space-y-6" data-testid="admin-funds">
      <header className="relative overflow-hidden rounded-2xl border border-[#cbdcf2] bg-[#edf5ff] px-5 py-5 sm:px-7 sm:py-6">
        <div className="absolute -right-16 -top-24 h-56 w-56 rounded-full border-[18px] border-blue-100/70" />
        <div className="absolute -bottom-28 right-24 h-40 w-40 rounded-full border border-blue-200/80" />
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="bt-kicker mb-2">Trésorerie prestataire</div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-cabinet text-2xl font-extrabold tracking-tight text-slate-950 sm:text-3xl">Fonds disponibles</h1>
              {payload && <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${payload.mode === 'live' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-700'}`}><span className="h-1.5 w-1.5 rounded-full bg-current" /> {modeLabel}</span>}
            </div>
            <p className="mt-2 max-w-2xl text-xs leading-relaxed text-slate-600">Vue en lecture seule des portefeuilles et des soldes mobile-money. Les totaux de portefeuille et les soldes réseau sont présentés séparément pour éviter tout double comptage.</p>
          </div>
          <button type="button" onClick={() => load(true)} disabled={loading || refreshing} data-testid="admin-funds-refresh" className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-xl bg-slate-950 px-4 text-xs font-bold text-white shadow-lg shadow-slate-900/15 transition hover:-translate-y-0.5 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60">
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} /> Actualiser
          </button>
        </div>
      </header>

      {error && (
        <div role="alert" className="flex flex-col gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-red-800 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" /><div><div className="text-xs font-bold">Lecture des soldes interrompue</div><div className="mt-1 text-xs leading-relaxed text-red-700">{errorCopy(error)}</div></div></div>
          <button type="button" onClick={() => load(true)} className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-2 text-xs font-bold text-red-700 hover:bg-red-100">Réessayer <RefreshCw className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {loading && !payload ? (
        <div className="space-y-5" aria-label="Chargement des fonds">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3"><Skeleton className="h-32" /><Skeleton className="h-32" /><Skeleton className="h-32" /></div>
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.1fr_.9fr]"><Skeleton className="h-80" /><Skeleton className="h-80" /></div>
        </div>
      ) : !payload && !error ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center"><WalletCards className="mx-auto h-8 w-8 text-slate-400" /><h2 className="mt-3 text-sm font-bold text-slate-800">Aucun relevé disponible</h2><p className="mt-1 text-xs text-slate-500">Le prestataire n’a retourné aucune donnée.</p></div>
      ) : payload && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
             <MetricCard stale={stale} icon={Landmark} label="Portefeuilles suivis" value={wallets.length} detail={`${currencyCount} devise${currencyCount > 1 ? 's' : ''} · ${providerLabel}`} tone="blue" />
             <MetricCard stale={stale} icon={Smartphone} label="Réseaux mobile-money" value={networks.length} detail="Soldes par opérateur, indépendants des totaux" tone="teal" />
             <MetricCard stale={stale} icon={Clock3} label="Dernière lecture" value={formatDate(payload.refreshed_at)} detail={`Mode ${modeLabel.toLowerCase()} · lecture seule`} tone="slate" />
          </div>

          <section className="rounded-2xl border border-slate-200 bg-white shadow-[0_14px_36px_-30px_rgba(15,23,42,.4)]">
            <div className="flex flex-col gap-2 border-b border-slate-100 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <div><h2 className="flex items-center gap-2 text-sm font-extrabold text-slate-900"><WalletCards className="h-4 w-4 text-blue-600" /> Totaux des portefeuilles</h2><p className="mt-1 text-[11px] text-slate-500">Source de vérité par devise · ne pas additionner aux soldes réseau.</p></div>
              <span className="inline-flex w-fit items-center gap-1.5 rounded-lg bg-blue-50 px-2.5 py-1.5 text-[10px] font-bold text-blue-700"><ShieldCheck className="h-3.5 w-3.5" /> Relevé contrôlé</span>
            </div>
            <div className="grid grid-cols-1 divide-y divide-slate-100 sm:grid-cols-2 sm:divide-x sm:divide-y-0 lg:grid-cols-3">
              {totals.length === 0 ? <div className="px-5 py-8 text-xs text-slate-500 sm:col-span-2 lg:col-span-3">Aucun total de portefeuille retourné.</div> : totals.map((item) => <div className="flex items-center justify-between gap-3 px-5 py-5" key={item.currency}><div><div className="text-[10px] font-bold uppercase tracking-[.15em] text-slate-400">{item.currency}</div><div className="mt-1 font-cabinet text-xl font-extrabold text-slate-900">{formatAmount(item.balance)}</div></div><Landmark className="h-5 w-5 text-slate-300" /></div>)}
            </div>
          </section>

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.12fr_.88fr]">
            <section className="order-2 min-w-0 rounded-2xl border border-slate-200 bg-white shadow-[0_14px_36px_-30px_rgba(15,23,42,.4)]">
              <div className="border-b border-slate-100 px-4 py-4 sm:px-5"><h2 className="flex items-center gap-2 text-sm font-extrabold text-slate-900"><Landmark className="h-4 w-4 text-blue-600" /> Portefeuilles</h2><p className="mt-1 text-[11px] text-slate-500">Détail des comptes détenus chez {providerLabel}.</p></div>
              <div className="overflow-x-auto"><table className="w-full min-w-[700px] text-left"><thead className="bg-slate-50/80 text-[10px] font-bold uppercase tracking-[.12em] text-slate-500"><tr><th className="px-4 py-3">Portefeuille</th><th className="px-4 py-3">Localisation</th><th className="px-4 py-3 text-right">Solde</th><th className="px-4 py-3">Capacités</th></tr></thead><tbody className="divide-y divide-slate-100">{wallets.length === 0 ? <tr><td colSpan="4" className="px-4 py-10 text-center text-xs text-slate-500">Aucun portefeuille retourné.</td></tr> : wallets.map((wallet) => <tr className="transition hover:bg-blue-50/40" key={wallet.id}><td className="px-4 py-3"><div className="font-mono text-[11px] font-bold text-slate-800">{wallet.id}</div><div className="mt-1 text-[10px] text-slate-500">{wallet.currency} · raw {wallet.raw_amount ?? '—'}</div></td><td className="px-4 py-3"><div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700"><Globe2 className="h-3.5 w-3.5 text-slate-400" /> {wallet.country || '—'}</div><div className="mt-1 pl-5 text-[10px] text-slate-400">{wallet.country_code || '—'}</div></td><td className="px-4 py-3 text-right"><div className="font-mono text-sm font-bold text-slate-900">{formatAmount(wallet.balance)}</div><div className="text-[10px] text-slate-400">{wallet.currency}</div></td><td className="px-4 py-3"><div className="flex flex-wrap gap-1.5"><PermissionPill active={wallet.topup} icon={ArrowDownToLine} label="Topup" /><PermissionPill active={wallet.payout} icon={ArrowUpFromLine} label="Payout" /><PermissionPill active={wallet.local_swap} icon={Repeat2} label="Swap" /></div></td></tr>)}</tbody></table></div>
            </section>

            <section className="order-1 min-w-0 rounded-2xl border border-slate-200 bg-white shadow-[0_14px_36px_-30px_rgba(15,23,42,.4)]">
              <div className="border-b border-slate-100 px-4 py-4 sm:px-5"><h2 className="flex items-center gap-2 text-sm font-extrabold text-slate-900"><Smartphone className="h-4 w-4 text-teal-600" /> Soldes par réseau</h2><p className="mt-1 text-[11px] text-slate-500">Vue opérationnelle par opérateur · hors totaux portefeuille.</p></div>
               <div className="divide-y divide-slate-100">{networks.length === 0 ? <div className="px-5 py-10 text-center text-xs text-slate-500">Aucun solde réseau retourné.</div> : networks.map((network, index) => <div className="px-4 py-4 transition hover:bg-teal-50/40 sm:px-5" key={`${network.country_code}-${network.network}-${network.currency}-${network.wallet_id || index}`}><div className="flex items-start justify-between gap-3"><div><div className="flex items-center gap-2 text-xs font-bold text-slate-800"><span className="flex h-7 w-7 items-center justify-center rounded-lg bg-teal-50 text-teal-700"><Smartphone className="h-3.5 w-3.5" /></span>{network.label || network.network}</div><div className="mt-1 pl-9 text-[10px] text-slate-500">{network.operator || network.network} · {network.country || '—'} ({network.country_code || '—'})</div></div><div className="text-right"><div className="font-mono text-sm font-bold text-slate-900">{formatAmount(network.balance)}</div><div className="text-[10px] text-slate-400">{network.currency || '—'}</div></div></div><div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-2 text-[10px] text-slate-400"><span>Wallet lié</span><span className="font-mono text-slate-600">{network.wallet_id || '—'}</span></div></div>)}</div>
            </section>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-3 text-[10px] text-slate-500"><span className="inline-flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> Données fournies par {providerLabel} · aucune conversion appliquée</span><span>Dernière actualisation : {formatDate(payload.refreshed_at)}</span></div>
        </>
      )}
    </div>
  );
}