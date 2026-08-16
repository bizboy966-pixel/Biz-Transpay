import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowLeftRight, Loader2, CheckCircle2, ShieldCheck, Info } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';
import { useAuth } from '@/context/AuthContext';
import { useFeatures } from '@/hooks/useFeatures';
import ComingSoon from '@/components/ComingSoon';

/* Currency descriptor (also used to map to balance field on the user object). */
const CUR = {
  USDT: { code: 'USDT', label: 'USDT', balanceKey: 'balance_usdt', maxFrac: 2, walletFlag: 'wallet_crypto_enabled', tint: 'from-amber-400 to-orange-600' },
  XOF: { code: 'XOF', label: 'XOF', balanceKey: 'balance_xof', maxFrac: 0, walletFlag: 'wallet_xof_enabled', tint: 'from-blue-400 to-blue-700' },
  XAF: { code: 'XAF', label: 'XAF', balanceKey: 'balance_xaf', maxFrac: 0, walletFlag: 'wallet_xaf_enabled', tint: 'from-emerald-400 to-emerald-700' },
};

export default function Exchange() {
  const { user, refresh } = useAuth();
  const features = useFeatures();
  const [cfg, setCfg] = useState(null);
  const [fromCur, setFromCur] = useState('USDT');
  const [toCur, setToCur] = useState('XOF');
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  useEffect(() => { api.get('/conversion/config').then(({ data }) => setCfg(data)).catch(() => {}); }, []);

  // Available "from" currencies: wallet must be visible.
  const availableCurrencies = useMemo(() => {
    if (!features) return [];
    return Object.values(CUR).filter((c) => features[c.walletFlag] !== false).map((c) => c.code);
  }, [features]);

  // Only pairs enabled by the admin AND where both wallets are visible.
  const availablePairs = useMemo(() => {
    if (!cfg) return {};
    const acc = {};
    Object.entries(cfg.pairs_enabled || {}).forEach(([k, on]) => {
      if (!on) return;
      const [f, t] = k.split('_');
      if (!availableCurrencies.includes(f) || !availableCurrencies.includes(t)) return;
      acc[f] = acc[f] || new Set();
      acc[f].add(t);
    });
    return acc;
  }, [cfg, availableCurrencies]);

  // Reset destination whenever the source changes.
  useEffect(() => {
    const options = Array.from(availablePairs[fromCur] || []);
    if (options.length && !options.includes(toCur)) setToCur(options[0]);
  }, [fromCur, availablePairs]);  // eslint-disable-line

  // Live quote (debounced) — recomputed whenever inputs change.
  useEffect(() => {
    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) { setQuote(null); return; }
    const id = setTimeout(async () => {
      try {
        const { data } = await api.get('/conversion/quote', {
          params: { from_currency: fromCur, to_currency: toCur, amount: parseFloat(amount) },
        });
        setQuote(data);
      } catch (e) { setQuote({ error: e.response?.data?.detail || 'Erreur' }); }
    }, 220);
    return () => clearTimeout(id);
  }, [amount, fromCur, toCur]);

  const balance = Number(user?.[CUR[fromCur].balanceKey] || 0);
  const hasAnyPair = Object.keys(availablePairs).length > 0;

  if (!features || !cfg) return <div className="text-slate-500 text-sm">Chargement…</div>;
  if (!hasAnyPair) return <ComingSoon title="Conversion temporairement indisponible" message="Aucune paire de conversion n'est actuellement active. Revenez plus tard." />;

  const submit = async () => {
    if (!quote || quote.error) return;
    if (parseFloat(amount) > balance) { toast.error('Solde insuffisant'); return; }
    setBusy(true);
    try {
      const { data } = await api.post('/exchange', { from_currency: fromCur, to_currency: toCur, amount: parseFloat(amount) });
      setDone(data);
      await refresh?.();
      toast.success('Conversion effectuée');
    } catch (e) { toast.error(e.response?.data?.detail || 'Erreur'); }
    finally { setBusy(false); }
  };

  const swap = () => {
    if ((availablePairs[toCur] || new Set()).has(fromCur)) { setFromCur(toCur); setToCur(fromCur); setAmount(''); setQuote(null); }
    else toast.info('Cette paire inversée est désactivée par l\'administrateur.');
  };

  if (done) {
    return (
      <div className="max-w-lg mx-auto p-6 rounded-2xl bg-emerald-50 border border-emerald-200 text-center" data-testid="exchange-success">
        <div className="mx-auto w-14 h-14 rounded-full bg-emerald-500 text-white flex items-center justify-center"><CheckCircle2 className="w-7 h-7" /></div>
        <h2 className="mt-4 font-cabinet font-extrabold text-emerald-900 text-xl">Conversion réussie</h2>
        <div className="mt-3 font-mono text-sm text-slate-700">
          {parseFloat(amount).toLocaleString(undefined, { maximumFractionDigits: CUR[fromCur].maxFrac })} {fromCur}
          <span className="text-slate-400 mx-2">→</span>
          <span className="font-bold text-emerald-700">+{Number(done.received).toLocaleString(undefined, { maximumFractionDigits: CUR[toCur].maxFrac })} {toCur}</span>
        </div>
        <div className="mt-1 text-[11px] text-slate-500">Taux : 1 {fromCur} = {done.rate} {toCur} · Frais : {Number(done.fee).toLocaleString(undefined, { maximumFractionDigits: CUR[fromCur].maxFrac })} {fromCur}</div>
        <button onClick={() => { setDone(null); setAmount(''); setQuote(null); }} data-testid="btn-new-conversion" className="mt-4 px-4 py-2 rounded-xl bg-slate-900 text-white text-sm font-semibold">Nouvelle conversion</button>
      </div>
    );
  }

  const destOptions = Array.from(availablePairs[fromCur] || []);
  const canSubmit = quote && !quote.error && parseFloat(amount) <= balance && !busy;

  return (
    <div className="max-w-lg mx-auto space-y-4" data-testid="user-exchange-page">
      <div className="bg-white border border-slate-100 rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-9 h-9 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center"><ArrowLeftRight className="w-4 h-4" /></div>
          <div>
            <h1 className="font-cabinet font-extrabold text-slate-900">Conversion</h1>
            <p className="text-[11px] text-slate-500">Convertissez librement entre USDT, XOF et XAF</p>
          </div>
        </div>

        {/* FROM */}
        <div className="p-3 rounded-xl bg-slate-50 border border-slate-100">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">De</span>
            <span className="text-[10px] text-slate-500">Solde : <b className="text-slate-800">{balance.toLocaleString(undefined, { maximumFractionDigits: CUR[fromCur].maxFrac })} {fromCur}</b></span>
          </div>
          <div className="flex items-center gap-2">
            <input type="number" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)}
              data-testid="input-amount"
              className="flex-1 bg-transparent focus:outline-none text-2xl font-cabinet font-extrabold text-slate-900" />
            <select value={fromCur} onChange={(e) => setFromCur(e.target.value)} data-testid="select-from"
              className="bg-white px-3 py-2 rounded-lg border border-slate-200 font-bold text-sm">
              {availableCurrencies.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
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
          <div className="flex items-center gap-2">
            <div className="flex-1 text-2xl font-cabinet font-extrabold text-emerald-700" data-testid="output-received">
              {quote && !quote.error ? `+${Number(quote.received).toLocaleString(undefined, { maximumFractionDigits: CUR[toCur].maxFrac })}` : '0'}
            </div>
            <select value={toCur} onChange={(e) => setToCur(e.target.value)} data-testid="select-to"
              className="bg-white px-3 py-2 rounded-lg border border-slate-200 font-bold text-sm">
              {destOptions.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>

        {/* Recap */}
        {quote && !quote.error && (
          <div className="mt-4 p-3 rounded-xl bg-blue-50 border border-blue-200 space-y-1 text-[12px]" data-testid="quote-recap">
            <Row label="Taux appliqué" value={`1 ${fromCur} = ${Number(quote.rate).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${toCur}`} />
            <Row label="Montant envoyé" value={`${parseFloat(amount).toLocaleString(undefined, { maximumFractionDigits: CUR[fromCur].maxFrac })} ${fromCur}`} />
            <Row label="Frais appliqués" value={`${Number(quote.fee).toLocaleString(undefined, { maximumFractionDigits: CUR[fromCur].maxFrac })} ${fromCur}`} tone="red" />
            <Row label="Vous recevez" value={`${Number(quote.received).toLocaleString(undefined, { maximumFractionDigits: CUR[toCur].maxFrac })} ${toCur}`} tone="green" bold />
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

function Row({ label, value, tone, bold }) {
  const c = tone === 'red' ? 'text-red-700' : tone === 'green' ? 'text-emerald-700' : 'text-slate-800';
  return (
    <div className="flex items-center justify-between">
      <span className="text-slate-600">{label}</span>
      <span className={`${bold ? 'font-cabinet font-extrabold' : 'font-semibold'} ${c}`}>{value}</span>
    </div>
  );
}
