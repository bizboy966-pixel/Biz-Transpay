import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowLeftRight, Loader2, CheckCircle2, ShieldCheck, Info } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';
import { useAuth } from '@/context/AuthContext';
import { useFeatures } from '@/hooks/useFeatures';
import SelectionMenu from '@/components/SelectionMenu';
import ComingSoon from '@/components/ComingSoon';
import DashboardPageLogo from '@/components/DashboardPageLogo';

/* Currency descriptor (also used to map to balance field on the user object). */
const BASE_CUR = {
  XOF: { code: 'XOF', label: 'XOF', balanceKey: 'balance_xof', maxFrac: 0, walletFlag: 'wallet_xof_enabled', tint: 'from-blue-400 to-blue-700' },
  XAF: { code: 'XAF', label: 'XAF', balanceKey: 'balance_xaf', maxFrac: 0, walletFlag: 'wallet_xaf_enabled', tint: 'from-emerald-400 to-emerald-700' },
};

export default function Exchange() {
  const { user, refresh } = useAuth();
  const features = useFeatures();
  const [cfg, setCfg] = useState(null);
  const [cryptoWallets, setCryptoWallets] = useState([]);
  const [cryptoCatalogError, setCryptoCatalogError] = useState('');
  const [fromCur, setFromCur] = useState('');
  const [toCur, setToCur] = useState('');
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  const loadCryptoWallets = async () => {
    try {
      const { data } = await api.get('/conversion/crypto-wallets');
      setCryptoWallets(Array.isArray(data) ? data : []);
      setCryptoCatalogError('');
    } catch (error) {
      const detail = error.response?.data?.detail;
      setCryptoCatalogError(
        typeof detail === 'string'
          ? detail
          : 'Impossible de charger les portefeuilles crypto disponibles.',
      );
      setCryptoWallets([]);
    }
  };

  useEffect(() => {
    api.get('/conversion/config').then(({ data }) => setCfg(data)).catch(() => {});
    loadCryptoWallets();
    // eslint-disable-next-line
  }, []);

  const CUR = useMemo(() => {
    const cryptoCurrencies = cryptoWallets.map((wallet) => ({
      code: wallet.code || wallet.id,
      label: `${wallet.coin} · ${wallet.network_name || wallet.network}`,
      coin: wallet.coin,
      network: wallet.network,
      balance: Number(wallet.balance || 0),
      maxFrac: 8,
      walletFlag: 'wallet_crypto_enabled',
      tint: 'from-amber-400 to-orange-600',
      kind: 'crypto',
    })).filter((wallet) => wallet.code);
    return {
      ...BASE_CUR,
      ...Object.fromEntries(cryptoCurrencies.map((wallet) => [wallet.code, wallet])),
    };
  }, [cryptoWallets]);

  // Available "from" currencies: wallet must be visible.
  const availableCurrencies = useMemo(() => {
    if (!features) return [];
    return Object.values(CUR)
      .filter((c) => features[c.walletFlag] !== false)
      .map((c) => c.code);
  }, [features, CUR]);

  // Use existing USDT/fiat switches for crypto/fiat pairs; crypto crosses
  // use the administrator's per-coin USDT rates.
  const availablePairs = useMemo(() => {
    if (!cfg) return {};
    const acc = {};
    const isFiat = (code) => code === 'XOF' || code === 'XAF';
    availableCurrencies.forEach((from) => {
      availableCurrencies.forEach((to) => {
        if (from === to) return;
        let toggle = null;
        if (isFiat(from) && isFiat(to)) toggle = `${from}_${to}`;
        else if (isFiat(from)) toggle = `${from}_USDT`;
        else if (isFiat(to)) toggle = `USDT_${to}`;
        if (toggle && cfg.pairs_enabled?.[toggle] === false) return;
        acc[from] = acc[from] || new Set();
        acc[from].add(to);
      });
    });
    return acc;
  }, [cfg, availableCurrencies]);

  // Start with an active crypto wallet when available; never fall back to
  // the historical, unassigned USDT balance.
  const preferredFromCur = availableCurrencies.find(
    (code) => CUR[code]?.kind === 'crypto',
  ) || availableCurrencies[0] || '';
  const effectiveFromCur = availableCurrencies.includes(fromCur)
    ? fromCur
    : preferredFromCur;
  const destinationOptions = Array.from(availablePairs[effectiveFromCur] || []);
  const effectiveToCur = destinationOptions.includes(toCur)
    ? toCur
    : destinationOptions[0] || '';

  useEffect(() => {
    if (fromCur !== effectiveFromCur) setFromCur(effectiveFromCur);
  }, [fromCur, effectiveFromCur]);

  useEffect(() => {
    if (toCur !== effectiveToCur) setToCur(effectiveToCur);
  }, [toCur, effectiveToCur]);

  // Live quote (debounced) — recomputed whenever inputs change.
  useEffect(() => {
    if (!amount || !effectiveFromCur || !effectiveToCur
        || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      setQuote(null);
      return;
    }
    const id = setTimeout(async () => {
      try {
        const { data } = await api.get('/conversion/quote', {
          params: {
            from_currency: effectiveFromCur,
            to_currency: effectiveToCur,
            amount: parseFloat(amount),
          },
        });
        setQuote(data);
      } catch (e) { setQuote({ error: e.response?.data?.detail || 'Erreur' }); }
    }, 220);
    return () => clearTimeout(id);
  }, [amount, effectiveFromCur, effectiveToCur]);

  const sourceCurrency = CUR[effectiveFromCur] || BASE_CUR.XOF;
  const targetCurrency = CUR[effectiveToCur] || BASE_CUR.XOF;
  const balance = Number(sourceCurrency.balance ?? user?.[sourceCurrency.balanceKey] ?? 0);
  const hasAnyPair = Object.keys(availablePairs).length > 0;

  if (!features || !cfg) return <div className="text-slate-500 text-sm">Chargement…</div>;
  if (!availableCurrencies.length) {
    return <ComingSoon title="Aucun portefeuille disponible" message="Aucun portefeuille activé pour la conversion n’est disponible actuellement." />;
  }
  if (!hasAnyPair) return <ComingSoon title="Conversion temporairement indisponible" message="Aucune paire de conversion n'est actuellement active. Revenez plus tard." />;

  const submit = async () => {
    if (!quote || quote.error) return;
    if (parseFloat(amount) > balance) { toast.error('Solde insuffisant'); return; }
    setBusy(true);
    try {
      const { data } = await api.post('/exchange', {
        from_currency: effectiveFromCur,
        to_currency: effectiveToCur,
        amount: parseFloat(amount),
      });
      setDone(data);
      await refresh?.();
      await loadCryptoWallets();
      toast.success('Conversion effectuée');
    } catch (e) { toast.error(e.response?.data?.detail || 'Erreur'); }
    finally { setBusy(false); }
  };

  const swap = () => {
    if ((availablePairs[effectiveToCur] || new Set()).has(effectiveFromCur)) {
      setFromCur(effectiveToCur);
      setToCur(effectiveFromCur);
      setAmount('');
      setQuote(null);
    }
    else toast.info('Cette paire inversée est désactivée par l\'administrateur.');
  };

  if (done) {
    return (
       <div className="w-full min-w-0 max-w-lg mx-auto p-6 rounded-2xl bg-emerald-50 border border-emerald-200 text-center overflow-hidden" data-testid="exchange-success">
        <div className="mx-auto w-14 h-14 rounded-full bg-emerald-500 text-white flex items-center justify-center"><CheckCircle2 className="w-7 h-7" /></div>
        <h2 className="mt-4 font-cabinet font-extrabold text-emerald-900 text-xl">Conversion réussie</h2>
        <div className="mt-3 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 font-mono text-sm text-slate-700 break-words">
          {parseFloat(amount).toLocaleString(undefined, { maximumFractionDigits: sourceCurrency.maxFrac })} {sourceCurrency.label}
          <span className="text-slate-400">→</span>
          <span className="font-bold text-emerald-700 break-words">+{Number(done.received).toLocaleString(undefined, { maximumFractionDigits: targetCurrency.maxFrac })} {targetCurrency.label}</span>
        </div>
        <div className="mt-1 text-[11px] text-slate-500 break-words">Taux : 1 {sourceCurrency.label} = {done.rate} {targetCurrency.label} · Frais : {Number(done.fee).toLocaleString(undefined, { maximumFractionDigits: sourceCurrency.maxFrac })} {sourceCurrency.label}</div>
        <button onClick={() => { setDone(null); setAmount(''); setQuote(null); }} data-testid="btn-new-conversion" className="mt-4 px-4 py-2 rounded-xl bg-slate-900 text-white text-sm font-semibold">Nouvelle conversion</button>
      </div>
    );
  }

  const sourceOptions = availableCurrencies.map((code) => ({
    value: code, label: CUR[code].label, currency: CUR[code],
  }));
  const targetOptions = destinationOptions.map((code) => ({
    value: code, label: CUR[code].label, currency: CUR[code],
  }));
  const canSubmit = quote && !quote.error && effectiveFromCur && effectiveToCur
    && parseFloat(amount) <= balance && !busy;

  return (
    <div className="w-full min-w-0 max-w-lg mx-auto space-y-4 overflow-x-clip" data-testid="user-exchange-page">
      <div className="w-full min-w-0 bg-white border border-slate-100 rounded-2xl p-5">
        <div className="flex min-w-0 items-center gap-2 mb-4">
          <div className="w-9 h-9 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center"><ArrowLeftRight className="w-4 h-4" /></div>
          <div>
            <h1 className="font-cabinet font-extrabold text-slate-900">Conversion</h1>
            <p className="text-[11px] text-slate-500">Convertissez XOF, XAF et les portefeuilles crypto disponibles.</p>
          </div>
        </div>
        <DashboardPageLogo
          src="/images/exchange-dashboard-icon.webp"
          alt="Échange"
          className="mb-4"
        />
        {user && user.kyc_status !== 'verified' && (
          <div role="note" className="mb-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-semibold">Vérification KYC requise</p>
              <p className="mt-0.5 leading-relaxed">
                Votre KYC doit être approuvé avant une conversion. Les dépôts et encaissements restent disponibles.
              </p>
              <Link to="/dashboard/kyc" className="mt-1 inline-block font-bold underline underline-offset-2">
                Compléter la vérification
              </Link>
            </div>
          </div>
        )}
        {cryptoCatalogError ? (
          <div role="alert" className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
            {cryptoCatalogError}
          </div>
        ) : cryptoWallets.length === 0 ? (
          <div className="mb-3 rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-[11px] text-slate-500">
            Aucun portefeuille crypto n’est actuellement activé pour la conversion.
          </div>
        ) : null}

        {/* FROM */}
        <div className="p-3 rounded-xl bg-slate-50 border border-slate-100">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">De</span>
            <span className="text-[10px] text-slate-500">Solde : <b className="text-slate-800">{balance.toLocaleString(undefined, { maximumFractionDigits: sourceCurrency.maxFrac })} {sourceCurrency.label}</b></span>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <input type="number" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)}
              data-testid="input-amount"
              className="min-w-0 w-full flex-1 bg-transparent focus:outline-none text-2xl font-cabinet font-extrabold text-slate-900" />
            <div className="w-[48%] min-w-0 shrink-0 sm:w-[46%]">
              <SelectionMenu
                value={effectiveFromCur}
                onChange={(code) => { setFromCur(code); setQuote(null); }}
                label="Actif source"
                placeholder="Sélectionner"
                testId="select-from"
                options={sourceOptions}
                renderValue={(option) => <CurrencyChoice currency={option.currency} compact />}
                renderOption={(option) => <CurrencyChoice currency={option.currency} />}
              />
            </div>
          </div>
          {amount && parseFloat(amount) > balance && <div className="mt-1 text-[11px] text-red-600">Solde insuffisant</div>}
        </div>

        {/* Swap */}
        <div className="flex justify-center -my-1.5">
          <button onClick={swap} data-testid="btn-swap" className="w-9 h-9 rounded-full bg-slate-900 text-white flex items-center justify-center shadow hover:scale-110 transition-transform">
            <ArrowDown className="w-4 h-4" />
          </button>
        </div>

        {/* TO */}
        <div className="p-3 rounded-xl bg-slate-50 border border-slate-100">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Vers</span>
            <span className="text-[10px] text-slate-500">Vous recevez</span>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0 w-full flex-1 break-words text-2xl font-cabinet font-extrabold text-emerald-700" data-testid="output-received">
              {quote && !quote.error ? `+${Number(quote.received).toLocaleString(undefined, { maximumFractionDigits: targetCurrency.maxFrac })}` : '0'}
            </div>
            <div className="w-[48%] min-w-0 shrink-0 sm:w-[46%]">
              <SelectionMenu
                value={effectiveToCur}
                onChange={(code) => { setToCur(code); setQuote(null); }}
                label="Actif de destination"
                placeholder="Sélectionner"
                testId="select-to"
                options={targetOptions}
                renderValue={(option) => <CurrencyChoice currency={option.currency} compact />}
                renderOption={(option) => <CurrencyChoice currency={option.currency} />}
              />
            </div>
          </div>
        </div>

        {/* Recap */}
        {quote && !quote.error && (
          <div className="mt-4 p-3 rounded-xl bg-blue-50 border border-blue-200 space-y-1 text-[12px]" data-testid="quote-recap">
            <Row label="Taux appliqué" value={`1 ${sourceCurrency.label} = ${Number(quote.rate).toLocaleString(undefined, { maximumFractionDigits: 8 })} ${targetCurrency.label}`} />
            <Row label="Montant envoyé" value={`${parseFloat(amount).toLocaleString(undefined, { maximumFractionDigits: sourceCurrency.maxFrac })} ${sourceCurrency.label}`} />
            <Row label="Frais appliqués" value={`${Number(quote.fee).toLocaleString(undefined, { maximumFractionDigits: sourceCurrency.maxFrac })} ${sourceCurrency.label}`} tone="red" />
            <Row label="Vous recevez" value={`${Number(quote.received).toLocaleString(undefined, { maximumFractionDigits: targetCurrency.maxFrac })} ${targetCurrency.label}`} tone="green" bold />
          </div>
        )}
        {quote?.error && <div className="mt-3 p-2 rounded-lg bg-red-50 border border-red-200 text-[11px] text-red-800 flex items-center gap-1.5"><Info className="w-3 h-3" />{quote.error}</div>}

        <button onClick={submit} disabled={!canSubmit} data-testid="btn-submit-conversion"
          className="mt-4 w-full py-3 rounded-xl bg-gradient-to-r from-[#3B82F6] to-[#1D4ED8] text-white font-cabinet font-extrabold shadow-lg disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2">
          {busy ? <><Loader2 className="w-4 h-4 animate-spin" />Conversion…</> : <><ShieldCheck className="w-4 h-4" />Confirmer la conversion</>}
        </button>
      </div>
    </div>
  );
}

function CurrencyChoice({ currency, compact = false }) {
  if (!currency) return <span>Sélectionner</span>;
  const badgeColor = currency.kind === 'crypto'
    ? 'bg-amber-100 text-amber-800'
    : currency.code === 'XAF'
      ? 'bg-emerald-100 text-emerald-800'
      : 'bg-blue-100 text-blue-800';
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[9px] font-extrabold ${badgeColor}`}>
        {currency.kind === 'crypto' ? currency.coin : currency.code}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-bold text-slate-900">{currency.label}</span>
        {!compact && (
          <span className="mt-0.5 block truncate text-[10px] font-medium text-slate-500">
            {currency.kind === 'crypto'
              ? `Solde : ${Number(currency.balance || 0).toLocaleString(undefined, { maximumFractionDigits: 8 })} ${currency.coin}`
              : 'Portefeuille fiat'}
          </span>
        )}
      </span>
    </span>
  );
}

function Row({ label, value, tone, bold }) {
  const c = tone === 'red' ? 'text-red-700' : tone === 'green' ? 'text-emerald-700' : 'text-slate-800';
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3">
      <span className="min-w-0 text-slate-600">{label}</span>
      <span className={`min-w-0 max-w-full break-words text-right ${bold ? 'font-cabinet font-extrabold' : 'font-semibold'} ${c}`}>{value}</span>
    </div>
  );
}
