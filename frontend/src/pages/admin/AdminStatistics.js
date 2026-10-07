import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  BarChart3,
  Check,
  Clock3,
  Globe2,
  Landmark,
  RefreshCw,
  Repeat2,
  ShieldAlert,
  WalletCards,
} from 'lucide-react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import api from '@/api';
import './AdminStatistics.css';

const PERIODS = [
  { value: '24h', label: '24 dernières heures' },
  { value: '7d', label: '7 derniers jours' },
  { value: '30d', label: '30 derniers jours' },
  { value: '1y', label: '1 dernière année' },
];

const numberFormatters = new Map();
function amountText(value, currency) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  const precision = currency === 'USDT' ? 6 : 2;
  if (!numberFormatters.has(precision)) {
    numberFormatters.set(precision, new Intl.NumberFormat('fr-FR', { maximumFractionDigits: precision }));
  }
  return `${numberFormatters.get(precision).format(number)} ${currency || ''}`.trim();
}

function countText(value) {
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat('fr-FR').format(number) : '—';
}

function formatDate(value, withTime = false) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('fr-FR', withTime
    ? { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: 'short', year: 'numeric' });
}

function axisDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value || '').slice(0, 12)
    : date.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
}

function Skeleton({ className = '' }) {
  return <div className={`bt-skeleton rounded-2xl ${className}`} aria-hidden="true" />;
}

function Panel({ children, className = '' }) {
  return <section className={`min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_14px_36px_-30px_rgba(15,23,42,.4)] ${className}`}>{children}</section>;
}

function SectionHeading({ icon: Icon, title, detail, aside }) {
  return (
    <div className="flex flex-col gap-2 border-b border-slate-100 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-extrabold text-slate-900"><Icon className="h-4 w-4 text-blue-600" />{title}</h2>
        {detail && <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{detail}</p>}
      </div>
      {aside}
    </div>
  );
}

function EmptyNotice({ title, detail }) {
  return (
    <div className="flex min-h-36 flex-col items-center justify-center px-5 py-8 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-50 text-slate-400"><BarChart3 className="h-5 w-5" /></div>
      <div className="mt-3 text-xs font-bold text-slate-700">{title}</div>
      {detail && <p className="mt-1 max-w-sm text-[11px] leading-relaxed text-slate-500">{detail}</p>}
    </div>
  );
}

function Metric({ icon: Icon, label, value, detail, tone = 'blue' }) {
  const color = {
    blue: 'bg-blue-50 text-blue-700 border-blue-100',
    teal: 'bg-teal-50 text-teal-700 border-teal-100',
    amber: 'bg-amber-50 text-amber-700 border-amber-100',
    ink: 'bg-slate-100 text-slate-700 border-slate-200',
  }[tone];
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_12px_30px_-26px_rgba(15,23,42,.35)]">
      <div className={`flex h-9 w-9 items-center justify-center rounded-xl border ${color}`}><Icon className="h-4 w-4" /></div>
      <div className="mt-4 text-[10px] font-bold uppercase tracking-[.14em] text-slate-500">{label}</div>
      <div className="mt-1 font-cabinet text-2xl font-extrabold tracking-tight text-slate-900">{value}</div>
      <div className="mt-1 text-[11px] text-slate-500">{detail}</div>
    </div>
  );
}

function ChartTooltip({ active, payload, label, formatter }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bt-statistics__tooltip">
      <p>{formatDate(label, true)}</p>
      {payload.map((entry) => (
        <div key={entry.dataKey}>
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: entry.color }} />{entry.name}</span>
          <strong className="font-mono text-slate-800">{formatter(entry.value)}</strong>
        </div>
      ))}
    </div>
  );
}

function AmountLines({ rows, field = 'volume', className = '' }) {
  if (!rows?.length) return <span className="text-xs text-slate-400">Aucune donnée</span>;
  return (
    <div className={`flex flex-wrap gap-1.5 ${className}`}>
      {rows.map((row) => (
        <span key={row.currency} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-[10px] font-semibold text-slate-700">
          <span className="font-sans text-[9px] font-extrabold tracking-wide text-slate-400">{row.currency}</span>
          {amountText(row[field], row.currency)}
        </span>
      ))}
    </div>
  );
}

function OperationCard({ icon: Icon, title, count, volumes, tone }) {
  const tones = {
    teal: 'bg-teal-50 text-teal-700',
    amber: 'bg-amber-50 text-amber-700',
    blue: 'bg-blue-50 text-blue-700',
  };
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex items-center gap-2">
        <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${tones[tone]}`}><Icon className="h-4 w-4" /></span>
        <span className="text-xs font-bold text-slate-700">{title}</span>
      </div>
      <div className="mt-4 font-cabinet text-2xl font-extrabold text-slate-900">{countText(count)}</div>
      <div className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">opérations</div>
      <div className="mt-3 border-t border-slate-100 pt-3">
        <div className="mb-2 text-[9px] font-bold uppercase tracking-wider text-slate-400">Volumes par devise</div>
        <AmountLines rows={volumes} />
      </div>
    </div>
  );
}

function TimelineChart({ data }) {
  const hasRows = data.length > 0;
  return (
    <Panel>
      <SectionHeading
        icon={BarChart3}
        title="Tendances des opérations"
        detail="Transactions par période · le volume d’opérations n’est pas un montant financier."
      />
      {hasRows ? (
        <div className="bt-statistics__chart px-2 py-4 sm:px-4" aria-label="Tendances des transactions, dépôts, retraits et conversions">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 12, left: -16, bottom: 2 }}>
              <CartesianGrid stroke="#e8eef6" vertical={false} strokeDasharray="3 5" />
              <XAxis dataKey="bucket" tickFormatter={axisDate} tick={{ fontSize: 10, fill: '#8291a4' }} axisLine={false} tickLine={false} minTickGap={24} />
              <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: '#8291a4' }} axisLine={false} tickLine={false} width={38} />
              <Tooltip content={<ChartTooltip formatter={countText} />} />
              <Legend iconType="circle" iconSize={7} wrapperStyle={{ fontSize: 10, paddingTop: 10 }} />
              <Line type="monotone" dataKey="transaction_count" name="Transactions" stroke="#173d66" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
              <Line type="monotone" dataKey="deposits" name="Dépôts" stroke="#168c87" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
              <Line type="monotone" dataKey="withdrawals" name="Retraits" stroke="#cf7f32" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
              <Line type="monotone" dataKey="exchanges" name="Conversions" stroke="#5b77d1" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : <EmptyNotice title="Aucune tendance disponible" detail="Aucun point de mesure n’a été retourné pour cette période." />}
    </Panel>
  );
}

function VolumeCharts({ timeline }) {
  const currencies = [...new Set(timeline.flatMap((point) => (point.volume_by_currency || []).map((item) => item.currency).filter(Boolean)))].sort();
  return (
    <Panel>
      <SectionHeading icon={WalletCards} title="Volumes au fil du temps" detail="Chaque devise est représentée séparément, sans conversion ni total inter-devises." />
      {!currencies.length ? <EmptyNotice title="Aucun volume détaillé" detail="L’API n’a retourné aucun volume par devise pour cette période." /> : (
        <div className="grid grid-cols-1 divide-y divide-slate-100 xl:grid-cols-2 xl:divide-x xl:divide-y-0">
          {currencies.map((currency) => {
            const rows = timeline.map((point) => {
              const entry = (point.volume_by_currency || []).find((item) => item.currency === currency);
              return { bucket: point.bucket, total: entry?.total, deposits: entry?.deposits, withdrawals: entry?.withdrawals, exchanges: entry?.exchanges };
            });
            return (
              <div className="min-w-0 px-3 py-4 sm:px-5" key={currency}>
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-[10px] font-extrabold uppercase tracking-[.16em] text-slate-700">{currency}</div>
                  <span className="rounded-md bg-blue-50 px-2 py-1 text-[9px] font-bold text-blue-700">Devise isolée</span>
                </div>
                <div className="bt-statistics__chart bt-statistics__chart--volume">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={rows} margin={{ top: 8, right: 10, left: -18, bottom: 2 }}>
                      <CartesianGrid stroke="#e8eef6" vertical={false} strokeDasharray="3 5" />
                      <XAxis dataKey="bucket" tickFormatter={axisDate} tick={{ fontSize: 9, fill: '#8291a4' }} axisLine={false} tickLine={false} minTickGap={22} />
                      <YAxis tick={{ fontSize: 9, fill: '#8291a4' }} axisLine={false} tickLine={false} width={48} tickFormatter={(value) => new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 }).format(value)} />
                      <Tooltip content={<ChartTooltip formatter={(value) => amountText(value, currency)} />} />
                      <Legend iconType="circle" iconSize={6} wrapperStyle={{ fontSize: 9, paddingTop: 8 }} />
                      <Line type="monotone" dataKey="total" name="Total" stroke="#173d66" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
                      <Line type="monotone" dataKey="deposits" name="Dépôts" stroke="#168c87" strokeWidth={1.8} dot={false} />
                      <Line type="monotone" dataKey="withdrawals" name="Retraits" stroke="#cf7f32" strokeWidth={1.8} dot={false} />
                      <Line type="monotone" dataKey="exchanges" name="Conversions" stroke="#5b77d1" strokeWidth={1.8} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function CountryActivity({ countries }) {
  return (
    <Panel>
      <SectionHeading icon={Globe2} title="Activité par pays" detail="Nombre de transactions et volumes séparés par devise." />
      {!countries.length ? <EmptyNotice title="Aucune activité par pays" detail="Aucun pays n’a été retourné pour cette période." /> : (
        <div className="divide-y divide-slate-100">
          {countries.map((country) => (
            <article key={`${country.country_code}-${country.country}`} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-9 w-10 shrink-0 items-center justify-center rounded-xl border border-blue-100 bg-blue-50 text-[10px] font-extrabold tracking-wider text-blue-700">{country.country_code || '—'}</span>
                <div className="min-w-0"><div className="truncate text-xs font-bold text-slate-800">{country.country || 'Pays non précisé'}</div><div className="mt-1 text-[10px] text-slate-500">{countText(country.transaction_count)} transactions</div></div>
              </div>
              <AmountLines rows={country.volume_by_currency || []} />
            </article>
          ))}
        </div>
      )}
    </Panel>
  );
}

function ProviderLiquidity({
  countries,
  countryActivity,
  loading,
  error,
  onRetry,
}) {
  const countryRowsByCode = new Map(
    countries
      .filter((country) => country.country_code)
      .map((country) => [country.country_code, country]),
  );
  countryActivity.forEach((activity) => {
    const code = activity.country_code;
    if (!code || code === 'XX' || countryRowsByCode.has(code)) return;
    countryRowsByCode.set(code, {
      country_code: code,
      country: activity.country,
      totals_by_currency: [],
      providers: [],
      missing_providers: ['Aucun prestataire actif'],
      complete: false,
      approximate: false,
      refreshed_at: null,
    });
  });
  const countryRows = [...countryRowsByCode.values()].sort((left, right) => {
    const leftCurrency = (left.totals_by_currency || [])
      .map((item) => item.currency).sort()[0] || 'ZZZ';
    const rightCurrency = (right.totals_by_currency || [])
      .map((item) => item.currency).sort()[0] || 'ZZZ';
    const currencyOrder = leftCurrency.localeCompare(rightCurrency);
    if (currencyOrder !== 0) return currencyOrder;
    const leftAmount = (left.totals_by_currency || [])
      .find((item) => item.currency === leftCurrency)?.balance || 0;
    const rightAmount = (right.totals_by_currency || [])
      .find((item) => item.currency === rightCurrency)?.balance || 0;
    return Number(rightAmount) - Number(leftAmount);
  });

  return (
    <Panel>
      <SectionHeading
        icon={Landmark}
        title="Soldes et activité par pays"
        detail="Soldes classés par montant au sein de chaque devise. Les relevés partiels et les montants estimatifs sont signalés ; aucune conversion n’est appliquée."
      />
      {error && (
        <div role="alert" className="flex flex-col gap-2 border-b border-amber-200 bg-amber-50 px-4 py-3 text-[11px] text-amber-900 sm:flex-row sm:items-center sm:justify-between">
          <span>{countries.length ? 'La dernière mise à jour des relevés prestataires a échoué ; les autres statistiques restent disponibles.' : 'Les relevés des prestataires sont momentanément indisponibles.'}</span>
          <button type="button" onClick={onRetry} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1.5 font-bold text-amber-800 hover:bg-amber-100">Réessayer <RefreshCw className="h-3 w-3" /></button>
        </div>
      )}
      {loading && countryRows.length === 0 ? (
        <div className="flex min-h-36 items-center justify-center gap-2 px-4 py-8 text-xs font-medium text-slate-500" role="status">
          <RefreshCw className="h-4 w-4 animate-spin text-blue-600" />
          Chargement des relevés prestataires en arrière-plan…
        </div>
      ) : !countryRows.length ? <EmptyNotice title="Aucun relevé par pays" detail="Aucun solde prestataire ni aucune activité par pays ne sont disponibles." /> : (
        <div className="divide-y divide-slate-100">
          {countryRows.map((country, index) => {
            const totalRows = country.totals_by_currency || [];
            const providers = country.providers || [];
            const missing = country.missing_providers || [];
            const activity = countryActivity.find((item) => item.country_code === country.country_code);
            return (
              <article key={`${country.country_code}-${index}`} className="p-4 sm:p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex items-center gap-3">
                    <span className="flex h-9 w-10 items-center justify-center rounded-xl bg-slate-100 text-[10px] font-extrabold tracking-wider text-slate-600">{country.country_code || '—'}</span>
                    <div><h3 className="text-xs font-extrabold text-slate-800">{country.country || 'Pays non précisé'}</h3><p className="mt-1 text-[10px] text-slate-500">{activity ? countText(activity.transaction_count) : '—'} transactions sur la période</p></div>
                  </div>
                  {country.complete
                    ? <span className="inline-flex w-fit items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[9px] font-bold text-emerald-700"><Check className="h-3 w-3" />{country.approximate ? 'Couverture complète · montant estimatif' : 'Relevé complet'}</span>
                    : <span className="inline-flex w-fit items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[9px] font-bold text-amber-800"><ShieldAlert className="h-3 w-3" /> Relevé incomplet</span>}
                </div>

                {!country.complete && (
                  <div role="note" className="mt-3 rounded-xl border border-amber-200 bg-amber-50/80 px-3 py-2.5 text-[10px] leading-relaxed text-amber-900">
                    <span className="font-extrabold">Prestataires manquants : </span>
                    {missing.length ? missing.join(', ') : 'non précisés dans la réponse de l’API.'}
                    <span className="block mt-1 text-amber-800">Les sous-totaux affichés ci-dessous ne représentent que les prestataires disponibles.</span>
                  </div>
                )}

                <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
                  <div className="rounded-xl border border-slate-200 bg-[#f8faff] p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="text-[9px] font-extrabold uppercase tracking-[.13em] text-slate-500">{country.complete ? 'Totaux par devise' : 'Sous-totaux disponibles'}</span>
                      {country.refreshed_at && <span className="inline-flex items-center gap-1 text-[9px] text-slate-400"><Clock3 className="h-3 w-3" />{formatDate(country.refreshed_at, true)}</span>}
                    </div>
                    {totalRows.length ? (
                      <div className="space-y-2">
                        {totalRows.map((row) => <div key={row.currency} className="flex items-center justify-between gap-2 border-b border-slate-200/70 pb-2 last:border-0 last:pb-0"><span className="text-[10px] font-extrabold tracking-wider text-slate-500">{row.currency}</span><span className="font-mono text-xs font-bold text-slate-800">{amountText(row.balance, row.currency)}</span></div>)}
                      </div>
                    ) : <p className="text-[10px] text-slate-400">Aucun solde par devise retourné.</p>}
                  </div>

                  <div className="rounded-xl border border-slate-200 p-3">
                    <div className="mb-2 text-[9px] font-extrabold uppercase tracking-[.13em] text-slate-500">Prestataires disponibles par devise</div>
                    {!providers.length ? <p className="text-[10px] text-slate-400">Aucun solde prestataire retourné.</p> : (
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {providers.map((provider, providerIndex) => (
                          <div key={`${provider.provider}-${provider.currency}-${providerIndex}`} className="flex min-w-0 items-center justify-between gap-2 rounded-lg bg-slate-50 px-2.5 py-2">
                            <div className="min-w-0"><div className="truncate text-[10px] font-bold text-slate-700">{provider.provider || 'Prestataire non précisé'}{provider.approximate && <span className="ml-1 font-medium text-amber-700">estimatif</span>}</div><div className="mt-0.5 text-[9px] font-extrabold text-slate-400">{provider.currency || 'Devise non précisée'}</div></div>
                            <span className="shrink-0 font-mono text-[10px] font-bold text-slate-800">{amountText(provider.balance, provider.currency)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                {activity?.volume_by_currency?.length > 0 && (
                  <div className="mt-3 flex flex-col gap-2 rounded-xl border border-slate-100 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                    <span className="text-[9px] font-extrabold uppercase tracking-[.13em] text-slate-400">Volume transactionnel par devise</span>
                    <AmountLines rows={activity.volume_by_currency} />
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

export default function AdminStatistics() {
  const [period, setPeriod] = useState('7d');
  const [reloadToken, setReloadToken] = useState(0);
  const [providerReloadToken, setProviderReloadToken] = useState(0);
  const [payload, setPayload] = useState(null);
  const [providerLiquidity, setProviderLiquidity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [providerLoading, setProviderLoading] = useState(true);
  const [providerError, setProviderError] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setPayload(null);
    api.get('/admin/statistics', { params: { period }, signal: controller.signal })
      .then(({ data }) => setPayload(data))
      .catch((err) => {
        if (controller.signal.aborted || err?.code === 'ERR_CANCELED') return;
        setError(err);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [period, reloadToken]);

  useEffect(() => {
    const controller = new AbortController();
    setProviderLoading(true);
    setProviderError(null);
    api.get('/admin/statistics/provider-liquidity', { signal: controller.signal })
      .then(({ data }) => setProviderLiquidity(data.provider_liquidity || []))
      .catch((err) => {
        if (controller.signal.aborted || err?.code === 'ERR_CANCELED') return;
        setProviderError(err);
      })
      .finally(() => {
        if (!controller.signal.aborted) setProviderLoading(false);
      });
    return () => controller.abort();
  }, [providerReloadToken]);

  const summary = payload?.summary || {};
  const operations = summary.operations || {};
  const timeline = payload?.timeline || [];
  const volumeRows = summary.volume_by_currency || [];
  const countries = payload?.countries || [];
  const liquidity = providerLiquidity ?? payload?.provider_liquidity ?? [];
  const errorDetail = typeof error?.response?.data?.detail === 'string' ? error.response.data.detail : null;
  const isEmpty = payload
    && Number(summary.transaction_count || 0) === 0
    && volumeRows.length === 0
    && countries.every((country) => Number(country.transaction_count || 0) === 0);

  return (
    <div className="bt-statistics space-y-5" data-testid="admin-statistics">
      <header className="bt-statistics__hero relative overflow-hidden rounded-2xl border border-[#cbdcf2] px-5 py-5 sm:px-7 sm:py-6">
        <div className="absolute -right-16 -top-20 h-56 w-56 rounded-full border-[18px] border-blue-100/70" aria-hidden="true" />
        <div className="absolute -bottom-24 right-32 h-36 w-36 rounded-full border border-teal-200/70" aria-hidden="true" />
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="bt-kicker mb-2">Pilotage financier</div>
            <h1 className="font-cabinet text-2xl font-extrabold tracking-tight text-slate-950 sm:text-3xl">Statistiques</h1>
            <p className="mt-2 max-w-2xl text-xs leading-relaxed text-slate-600">Une lecture nette de l’activité, des volumes et des soldes prestataires. Les devises restent distinctes, sans conversion implicite.</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="flex flex-wrap gap-1 rounded-xl border border-white/80 bg-white/70 p-1" role="group" aria-label="Période des statistiques">
              {PERIODS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  aria-pressed={period === item.value}
                  onClick={() => setPeriod(item.value)}
                  className="bt-statistics__range rounded-lg px-3 py-2 text-[10px] font-bold text-slate-600 hover:bg-slate-100 focus-visible:outline-none"
                  data-testid={`statistics-period-${item.value}`}
                >{item.label}</button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setReloadToken((value) => value + 1)}
              disabled={loading}
              className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-xl bg-slate-950 px-4 text-xs font-bold text-white shadow-lg shadow-slate-900/15 transition hover:-translate-y-0.5 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
              data-testid="statistics-refresh"
            ><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />Actualiser</button>
          </div>
        </div>
        {payload && (
          <div className="relative mt-5 flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-blue-200/60 pt-3 text-[10px] text-slate-500">
            <span><strong className="font-bold text-slate-700">Période :</strong> {formatDate(payload.from)} – {formatDate(payload.to)}</span>
            <span className="inline-flex items-center gap-1"><Clock3 className="h-3 w-3" />Généré le {formatDate(payload.generated_at, true)}</span>
          </div>
        )}
      </header>

      {error && (
        <div role="alert" className="flex flex-col gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-red-800 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" /><div><div className="text-xs font-bold">Statistiques indisponibles</div><div className="mt-1 text-xs leading-relaxed text-red-700">{errorDetail || 'Impossible de charger les statistiques pour cette période. Vérifiez votre connexion et réessayez.'}</div></div></div>
          <button type="button" onClick={() => setReloadToken((value) => value + 1)} className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-2 text-xs font-bold text-red-700 hover:bg-red-100">Réessayer <RefreshCw className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {loading && !payload ? (
        <div className="space-y-5" role="status" aria-label="Chargement des statistiques" data-testid="statistics-loading">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"><Skeleton className="h-32" /><Skeleton className="h-32" /><Skeleton className="h-32" /><Skeleton className="h-32" /></div>
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2"><Skeleton className="h-80" /><Skeleton className="h-80" /></div>
          <Skeleton className="h-64" />
        </div>
      ) : error && !payload ? null : payload ? (
        <>
          {isEmpty && (
            <div className="flex items-start gap-3 rounded-2xl border border-blue-200 bg-blue-50/75 p-4 text-blue-900" data-testid="statistics-empty">
              <BarChart3 className="mt-0.5 h-4 w-4 shrink-0 text-blue-700" />
              <div><div className="text-xs font-extrabold">Aucune activité sur cette période</div><p className="mt-1 text-[11px] leading-relaxed text-blue-800">L’API n’a retourné aucune transaction, aucun volume et aucun relevé par pays pour la période sélectionnée.</p></div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric icon={BarChart3} label="Transactions" value={countText(summary.transaction_count)} detail="Dépôts, retraits et conversions" tone="blue" />
            <Metric icon={ArrowDownToLine} label="Dépôts" value={countText(operations.deposits?.count)} detail="Opérations créées" tone="teal" />
            <Metric icon={ArrowUpFromLine} label="Retraits" value={countText(operations.withdrawals?.count)} detail="Opérations créées" tone="amber" />
            <Metric icon={Repeat2} label="Conversions" value={countText(operations.exchanges?.count)} detail="Opérations créées" tone="ink" />
          </div>

          <Panel>
            <SectionHeading icon={WalletCards} title="Volumes par devise" detail="Montants des opérations confirmées, sans additionner les devises entre elles." />
            {!volumeRows.length ? <EmptyNotice title="Aucun volume par devise" detail="Aucun montant n’a été retourné pour cette période." /> : (
              <div className="grid grid-cols-1 divide-y divide-slate-100 sm:grid-cols-2 sm:divide-x sm:divide-y-0 xl:grid-cols-3">
                {volumeRows.map((row) => (
                  <div key={row.currency} className="px-5 py-5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] font-extrabold uppercase tracking-[.16em] text-slate-500">{row.currency}</span>
                      <span className="rounded-md bg-blue-50 px-2 py-1 text-[9px] font-bold text-blue-700">Devise isolée</span>
                    </div>
                    <div className="mt-2 font-cabinet text-2xl font-extrabold tracking-tight text-slate-900">{amountText(row.total, row.currency)}</div>
                    <div className="mt-4 grid grid-cols-3 gap-2 border-t border-slate-100 pt-3">
                      <div><div className="text-[9px] font-bold text-slate-400">DÉPÔTS</div><div className="mt-1 font-mono text-[10px] font-bold text-teal-700">{amountText(row.deposits, row.currency)}</div></div>
                      <div><div className="text-[9px] font-bold text-slate-400">RETRAITS</div><div className="mt-1 font-mono text-[10px] font-bold text-amber-700">{amountText(row.withdrawals, row.currency)}</div></div>
                      <div><div className="text-[9px] font-bold text-slate-400">CONVERSIONS</div><div className="mt-1 font-mono text-[10px] font-bold text-blue-700">{amountText(row.exchanges, row.currency)}</div></div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <OperationCard icon={ArrowDownToLine} title="Dépôts" count={operations.deposits?.count} volumes={operations.deposits?.volume_by_currency || []} tone="teal" />
            <OperationCard icon={ArrowUpFromLine} title="Retraits" count={operations.withdrawals?.count} volumes={operations.withdrawals?.volume_by_currency || []} tone="amber" />
            <OperationCard icon={Repeat2} title="Conversions" count={operations.exchanges?.count} volumes={operations.exchanges?.volume_by_currency || []} tone="blue" />
          </div>

          <div className="grid grid-cols-1 gap-5 2xl:grid-cols-2">
            <TimelineChart data={timeline} />
            <VolumeCharts timeline={timeline} />
          </div>

          <CountryActivity countries={countries} />
          <ProviderLiquidity
            countries={liquidity}
            countryActivity={countries}
            loading={providerLoading}
            error={providerError}
            onRetry={() => setProviderReloadToken((value) => value + 1)}
          />

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-3 text-[10px] text-slate-500">
            <span className="inline-flex items-center gap-1.5"><Landmark className="h-3.5 w-3.5 text-blue-600" />Données de lecture seule fournies par Biz-transPay · aucune conversion appliquée</span>
            {payload.generated_at && <span>Dernière génération : {formatDate(payload.generated_at, true)}</span>}
          </div>
        </>
      ) : null}
    </div>
  );
}
