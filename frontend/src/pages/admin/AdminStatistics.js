import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUpFromLine,
  BarChart3,
  Coins,
  CreditCard,
  Globe2,
  Link2,
  RefreshCw,
  WalletCards,
} from 'lucide-react';
import api from '../../api';
import './AdminStatistics.css';

const REFRESH_INTERVAL = 60_000;

const MARGIN_CATEGORIES = [
  { key: 'deposit_mobile_money', label: 'Dépôts · Mobile Money', icon: ArrowDownToLine, tone: 'green' },
  { key: 'withdrawal_mobile_money', label: 'Retraits · Mobile Money', icon: ArrowUpFromLine, tone: 'orange' },
  { key: 'transfer_mobile_money', label: 'Transferts · Mobile Money', icon: ArrowLeftRight, tone: 'blue' },
  { key: 'link_payment_mobile_money', label: 'Liens de paiement · Mobile Money', icon: Link2, tone: 'purple' },
  { key: 'api_payment_mobile_money', label: 'Paiements API · Mobile Money', icon: CreditCard, tone: 'teal' },
  { key: 'deposit_crypto', label: 'Dépôts · Crypto', icon: Coins, tone: 'green' },
  { key: 'withdrawal_crypto', label: 'Retraits · Crypto', icon: ArrowUpFromLine, tone: 'orange' },
  { key: 'transfer_crypto', label: 'Transferts · Crypto', icon: ArrowLeftRight, tone: 'blue' },
  { key: 'link_payment_crypto', label: 'Liens de paiement · Crypto', icon: Link2, tone: 'purple' },
  { key: 'api_payment_crypto', label: 'Paiements API · Crypto', icon: CreditCard, tone: 'teal' },
  { key: 'conversion', label: 'Conversions', icon: RefreshCw, tone: 'gold' },
];

const numberFormatters = new Map();
function formatAmount(value, currency = '') {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  const precision = currency === 'USDT' || currency.includes('.')
    ? 6
    : 2;
  if (!numberFormatters.has(precision)) {
    numberFormatters.set(
      precision,
      new Intl.NumberFormat('fr-FR', { maximumFractionDigits: precision }),
    );
  }
  return `${numberFormatters.get(precision).format(number)} ${currency}`.trim();
}

function formatCount(value) {
  const number = Number(value);
  return Number.isFinite(number)
    ? new Intl.NumberFormat('fr-FR').format(number)
    : '0';
}

function errorMessage(error, fallback) {
  const detail = error?.response?.data?.detail;
  return typeof detail === 'string' ? detail : fallback;
}

function Panel({ children, className = '' }) {
  return (
    <section className={`bt-statistics__panel ${className}`}>
      {children}
    </section>
  );
}

function SectionHeading({ icon: Icon, title, detail, aside }) {
  return (
    <div className="bt-statistics__section-heading">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-sm font-extrabold text-slate-900">
          <Icon className="h-4 w-4 shrink-0 text-blue-600" />
          {title}
        </h2>
        {detail && <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{detail}</p>}
      </div>
      {aside}
    </div>
  );
}

function LoadingRows({ count = 4 }) {
  return (
    <div className="space-y-4 px-4 py-5 sm:px-5" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex items-center gap-3">
          <div className="h-3 w-16 animate-pulse rounded bg-slate-100" />
          <div className="h-3 flex-1 animate-pulse rounded-full bg-slate-100" />
          <div className="h-3 w-20 animate-pulse rounded bg-slate-100" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ children }) {
  return (
    <div className="flex min-h-32 flex-col items-center justify-center px-5 py-8 text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-50 text-slate-400">
        <BarChart3 className="h-5 w-5" />
      </span>
      <p className="mt-3 text-xs font-bold text-slate-600">{children}</p>
    </div>
  );
}

function TopCountries({ countries, loading, error }) {
  const maxCount = Math.max(
    1,
    ...countries.map((country) => Number(country.transaction_count) || 0),
  );

  return (
    <Panel>
      <SectionHeading
        icon={Globe2}
        title="Top 8 pays — Ce mois"
        detail="Classement par nombre de transactions. Les volumes confirmés sont affichés en équivalent XOF."
        aside={<span className="bt-statistics__period-badge">Ce mois</span>}
      />
      {error && <div className="bt-statistics__error" role="alert">{error}</div>}
      {loading && !countries.length ? (
        <div role="status" aria-label="Chargement du classement des pays">
          <LoadingRows />
        </div>
      ) : countries.length ? (
        <div className="space-y-4 px-4 py-5 sm:px-5">
          {countries.map((country, index) => {
            const count = Number(country.transaction_count) || 0;
            const width = count ? Math.max(3, (count / maxCount) * 100) : 0;
            return (
              <article
                className="bt-statistics__country-row"
                key={`${country.country_code || country.country}-${index}`}
              >
                <div className="bt-statistics__country-name">
                  <span className="bt-statistics__rank">{index + 1}</span>
                  <span className="truncate font-semibold text-slate-700">
                    {country.country || 'Pays non renseigné'}
                  </span>
                </div>
                <div className="bt-statistics__country-bar-wrap">
                  <div
                    className="bt-statistics__country-bar-track"
                    role="progressbar"
                    aria-label={`${country.country || 'Pays'} : ${formatCount(count)} transactions`}
                    aria-valuemin="0"
                    aria-valuemax={maxCount}
                    aria-valuenow={count}
                  >
                    <span
                      className="bt-statistics__country-bar"
                      style={{ width: `${width}%` }}
                    />
                  </div>
                  <span className="bt-statistics__transaction-count">
                    {formatCount(count)} tx
                  </span>
                </div>
                <div className="bt-statistics__country-volume">
                  <strong>{formatAmount(country.volume_xof, 'XOF')}</strong>
                  {country.unconverted_volume_by_currency?.length > 0 && (
                    <span title="Certaines devises sans taux ne sont pas incluses">
                      Conversion partielle
                    </span>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <EmptyState>Aucune transaction enregistrée ce mois-ci.</EmptyState>
      )}
    </Panel>
  );
}

function WalletBalances({ data, loading, error }) {
  const wallets = data?.wallets || [];
  const fiatWallets = wallets.filter((wallet) => wallet.kind === 'fiat');
  const cryptoWallets = wallets.filter((wallet) => wallet.kind === 'crypto');

  return (
    <Panel className="bt-statistics__balance-panel">
      <SectionHeading
        icon={WalletCards}
        title="Solde total disponible — Tous les comptes utilisateurs"
        detail="Somme des wallets XOF, XAF et crypto, convertie en XOF selon les taux configurés."
        aside={<span className="bt-statistics__refresh-note">Mise à jour toutes les 60 s</span>}
      />
      {error && <div className="bt-statistics__error" role="alert">{error}</div>}
      {loading && !data ? (
        <div role="status" aria-label="Chargement des soldes utilisateurs">
          <LoadingRows count={5} />
        </div>
      ) : data ? (
        <div className="bt-statistics__balance-content">
          <div className="bt-statistics__balance-total">
            <span className="bt-statistics__balance-total-label">
              {data.conversion_complete ? 'Équivalent XOF total' : 'Équivalent XOF calculable'}
            </span>
            <strong>{formatAmount(data.total_xof_equivalent, 'XOF')}</strong>
            {!data.conversion_complete && (
              <p role="note">
                Certains wallets ne sont pas inclus, car leur taux de conversion est manquant.
              </p>
            )}
          </div>

          {data.missing_rates?.length > 0 && (
            <div className="bt-statistics__warning" role="note">
              Taux manquant pour : {[...new Set(data.missing_rates.map((item) => (
                item.network ? `${item.coin} (${item.network})` : item.currency
              )))].join(', ')}.
            </div>
          )}

          <div className="bt-statistics__wallet-list">
            {fiatWallets.map((wallet) => (
              <div className="bt-statistics__wallet-row" key={wallet.currency}>
                <span>{wallet.currency} wallet</span>
                <strong>{formatAmount(wallet.balance, wallet.currency)}</strong>
                {wallet.currency !== 'XOF' && (
                  <small>{formatAmount(wallet.xof_equivalent, 'XOF')} équiv.</small>
                )}
              </div>
            ))}
            {cryptoWallets.map((wallet) => (
              <div
                className="bt-statistics__wallet-row"
                key={`${wallet.currency}-${wallet.network || 'legacy'}`}
              >
                <span>
                  {wallet.coin || wallet.currency}
                  {wallet.network ? ` · ${wallet.network}` : ''}
                </span>
                <strong>{formatAmount(wallet.balance, wallet.coin || wallet.currency)}</strong>
                <small>
                  {wallet.xof_equivalent === null
                    ? 'Taux indisponible'
                    : `${formatAmount(wallet.xof_equivalent, 'XOF')} équiv.`}
                </small>
              </div>
            ))}
          </div>
          {!wallets.length && (
            <p className="py-4 text-center text-xs text-slate-500">
              Aucun solde utilisateur disponible.
            </p>
          )}
        </div>
      ) : (
        <EmptyState>Les soldes utilisateurs sont momentanément indisponibles.</EmptyState>
      )}
      {data?.updated_at && (
        <div className="bt-statistics__updated">
          Dernière mise à jour : {new Date(data.updated_at).toLocaleTimeString('fr-FR', {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </div>
      )}
    </Panel>
  );
}

function MarginCard({ category, data }) {
  const Icon = category.icon;
  const rows = data?.amounts || [];
  return (
    <article className="bt-statistics__margin-card">
      <div className={`bt-statistics__margin-icon bt-statistics__margin-icon--${category.tone}`}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <h3>{category.label}</h3>
        {rows.length ? (
          <div className="mt-2 space-y-1.5">
            {rows.map((row) => (
              <div className="bt-statistics__margin-value" key={row.currency}>
                <strong>{formatAmount(row.amount, row.currency)}</strong>
                <span>{formatCount(data?.count)} opération{Number(data?.count) > 1 ? 's' : ''}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-xs text-slate-400">Aucune marge enregistrée</p>
        )}
      </div>
    </article>
  );
}

function Margins({ data, loading, error }) {
  const categoryData = data?.categories || {};
  return (
    <Panel>
      <SectionHeading
        icon={Coins}
        title="Revenus Biz-transPay — Marge uniquement"
        detail="Marge nette de la plateforme ce mois-ci, hors part des prestataires. Les devises sont conservées séparément."
      />
      {error && <div className="bt-statistics__error" role="alert">{error}</div>}
      {loading && !data ? (
        <div role="status" aria-label="Chargement des marges">
          <LoadingRows count={6} />
        </div>
      ) : (
        <>
          <div className="bt-statistics__margin-grid">
            {MARGIN_CATEGORIES.map((category) => (
              <MarginCard
                key={category.key}
                category={category}
                data={categoryData[category.key]}
              />
            ))}
          </div>
          <div className="bt-statistics__margin-total">
            <span>Marge totale du mois</span>
            <div className="flex flex-wrap justify-end gap-2">
              {(data?.total_by_currency || []).length ? (
                data.total_by_currency.map((row) => (
                  <strong key={row.currency}>
                    {formatAmount(row.amount, row.currency)}
                  </strong>
                ))
              ) : (
                <strong>—</strong>
              )}
            </div>
          </div>
        </>
      )}
    </Panel>
  );
}

export default function AdminStatistics() {
  const [dashboard, setDashboard] = useState(null);
  const [walletBalances, setWalletBalances] = useState(null);
  const [dashboardError, setDashboardError] = useState(null);
  const [walletError, setWalletError] = useState(null);
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [walletLoading, setWalletLoading] = useState(true);
  const [refreshToken, setRefreshToken] = useState(0);
  const forceWalletRefreshRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    setDashboardError(null);
    api.get('/admin/statistics/dashboard', { signal: controller.signal })
      .then(({ data }) => setDashboard(data))
      .catch((error) => {
        if (controller.signal.aborted || error?.code === 'ERR_CANCELED') return;
        setDashboardError(errorMessage(
          error,
          'Impossible de charger les statistiques mensuelles. Réessayez.',
        ));
      })
      .finally(() => {
        if (!controller.signal.aborted) setDashboardLoading(false);
      });
    return () => controller.abort();
  }, [refreshToken]);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    const controllers = new Set();
    const forceRefresh = forceWalletRefreshRef.current;
    forceWalletRefreshRef.current = false;

    const refreshWallets = (bypassCache = false) => {
      if (!active || inFlight) return;
      inFlight = true;
      const controller = new AbortController();
      controllers.add(controller);
      setWalletError(null);
      api.get('/admin/statistics/wallet-balances', {
        ...(bypassCache ? { params: { refresh: true } } : {}),
        signal: controller.signal,
      })
        .then(({ data }) => {
          if (active) setWalletBalances(data);
        })
        .catch((error) => {
          if (!active || controller.signal.aborted || error?.code === 'ERR_CANCELED') return;
          setWalletError(errorMessage(
            error,
            'Impossible de charger les soldes. Réessayez.',
          ));
        })
        .finally(() => {
          controllers.delete(controller);
          inFlight = false;
          if (active) setWalletLoading(false);
        });
    };

    refreshWallets(forceRefresh);
    const timer = window.setInterval(() => refreshWallets(false), REFRESH_INTERVAL);
    return () => {
      active = false;
      window.clearInterval(timer);
      controllers.forEach((controller) => controller.abort());
    };
  }, [refreshToken]);

  const generatedAt = useMemo(() => {
    const value = dashboard?.generated_at;
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? null
      : date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }, [dashboard?.generated_at]);

  const refreshAll = () => {
    setDashboardLoading(true);
    setWalletLoading(true);
    forceWalletRefreshRef.current = true;
    setRefreshToken((current) => current + 1);
  };

  return (
    <div className="bt-statistics space-y-5" data-testid="admin-statistics">
      <header className="bt-statistics__hero">
        <div>
          <div className="bt-statistics__kicker">Pilotage financier</div>
          <h1>Statistiques</h1>
          <p>Activité du mois, soldes des wallets utilisateurs et marges Biz-transPay.</p>
        </div>
        <div className="flex items-center gap-3">
          {generatedAt && <span className="bt-statistics__generated">Mis à jour à {generatedAt}</span>}
          <button
            type="button"
            onClick={refreshAll}
            disabled={dashboardLoading && walletLoading}
            className="bt-statistics__refresh"
            data-testid="statistics-refresh"
          >
            <RefreshCw className={`h-4 w-4 ${(dashboardLoading || walletLoading) ? 'animate-spin' : ''}`} />
            Actualiser
          </button>
        </div>
      </header>

      <TopCountries
        countries={dashboard?.top_countries || []}
        loading={dashboardLoading}
        error={dashboardError}
      />
      <WalletBalances
        data={walletBalances}
        loading={walletLoading}
        error={walletError}
      />
      <Margins
        data={dashboard?.margins}
        loading={dashboardLoading}
        error={dashboardError}
      />
      <div className="bt-statistics__footer">
        <Globe2 className="h-3.5 w-3.5 text-blue-600" />
        Données agrégées en lecture seule · soldes recalculés toutes les 60 secondes
      </div>
    </div>
  );
}
