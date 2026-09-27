import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Bitcoin, Smartphone, ShieldCheck, Copy, CheckCircle2, Clock, XCircle, Loader2, Rocket } from 'lucide-react';
import { QRCodeCanvas } from 'qrcode.react';
import { toast } from 'sonner';
import api from '@/api';
import { useAuth } from '@/context/AuthContext';
import { useFeatures } from '@/hooks/useFeatures';
import ComingSoon from '@/components/ComingSoon';
import { OperatorLogo } from '@/components/PaymentBrand';
import SelectionMenu from '@/components/SelectionMenu';
import DashboardPageLogo from '@/components/DashboardPageLogo';
import { COUNTRIES } from '@/constants/countries';
import { ACTIVE_MOMO_DEPOSIT_KEY, MOMO_PENDING_SECONDS } from '@/constants/payment';
import { mobileMoneyFeePreview } from '@/lib/mobileMoneyFees';

const PSR_ASSET_IDS = {
  css: 'paydunya-psr-css',
  jquery: 'paydunya-psr-jquery',
  script: 'paydunya-psr-script',
};
let psrAssetsPromise;

function loadExternalAsset({ id, tag, url, attributes = {} }) {
    if (typeof document === 'undefined') return Promise.reject(new Error('Le paiement est indisponible dans ce navigateur.'));
  if ((id === PSR_ASSET_IDS.jquery && window.jQuery)
      || (id === PSR_ASSET_IDS.script && window.PayDunya?.setup)) {
    const ready = document.getElementById(id);
    if (ready) ready.dataset.loaded = 'true';
    return Promise.resolve();
  }
  const existing = document.getElementById(id);
  if (existing?.dataset.loaded === 'true') return Promise.resolve();
  const element = existing || document.createElement(tag);
  element.id = id;
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
  if (!existing) document.head.appendChild(element);
  return new Promise((resolve, reject) => {
    element.addEventListener('load', () => {
      element.dataset.loaded = 'true';
      resolve();
    }, { once: true });
    element.addEventListener('error', () => reject(new Error('Le paiement sécurisé est temporairement indisponible.')), { once: true });
    if (tag === 'link' && !existing) element.href = url;
    if (tag === 'script' && !existing) element.src = url;
  });
}

function ensurePaydunyaPsrAssets() {
  if (psrAssetsPromise) return psrAssetsPromise;
  psrAssetsPromise = (async () => {
    await loadExternalAsset({
      id: PSR_ASSET_IDS.css,
      tag: 'link',
      url: 'https://paydunya.com/assets/psr/css/psr.paydunya.min.css',
      attributes: { rel: 'stylesheet' },
    });
    if (!window.jQuery) {
      await loadExternalAsset({
        id: PSR_ASSET_IDS.jquery,
        tag: 'script',
        url: 'https://code.jquery.com/jquery-3.6.0.min.js',
        attributes: { defer: 'true' },
      });
    }
    await loadExternalAsset({
      id: PSR_ASSET_IDS.script,
      tag: 'script',
      url: 'https://paydunya.com/assets/psr/js/psr.paydunya.min.js',
      attributes: { defer: 'true' },
    });
    if (!window.PayDunya || typeof window.PayDunya.setup !== 'function') {
      throw new Error('Le paiement sécurisé est temporairement indisponible.');
    }
  })().catch((error) => {
    psrAssetsPromise = null;
    throw error;
  });
  return psrAssetsPromise;
}

function startPaydunyaPsr({ deposit, onTerminate }) {
  const PayDunya = window.PayDunya;
  if (!PayDunya || typeof PayDunya.setup !== 'function') {
    throw new Error('Le paiement sécurisé est temporairement indisponible.');
  }
  if (!deposit?.psr_token_url) {
    throw new Error('Le paiement sécurisé n’a pas pu être préparé.');
  }
  const tokenUrl = deposit.psr_token_url;
  let terminated = false;
  const terminate = (...args) => {
    if (terminated) return;
    terminated = true;
    onTerminate(...args);
  };
  const options = {
    selector: window.jQuery('#paydunya-psr'),
    url: tokenUrl,
    method: 'GET',
    displayMode: PayDunya.DISPLAY_IN_POPUP || 'DISPLAY_IN_POPUP',
    onTerminate: terminate,
    onError: (error) => {
      console.error('PayDunya PSR error', error);
      toast.error('Le paiement a rencontré une erreur. Veuillez réessayer.');
    },
    onUnsuccessfulResponse: (response) => {
      console.error('PayDunya PSR unsuccessful response', response);
      toast.error('La demande de paiement a été refusée. Veuillez réessayer.');
    },
  };
  const client = PayDunya.setup(options);
  if (!client || typeof client.requestToken !== 'function') {
    throw new Error('La fenêtre de paiement n’a pas pu être ouverte.');
  }
  const requested = client.requestToken();
  if (requested === false) throw new Error('La demande de paiement a été refusée.');
}

export default function Deposit() {
  const nav = useNavigate();
  const features = useFeatures();
  const [step, setStep] = useState(1);
  const [method, setMethod] = useState(null);
  const [deposit, setDeposit] = useState(null);

  useEffect(() => {
    if (step !== 1 || deposit) return undefined;
    const activeDepositId = sessionStorage.getItem(ACTIVE_MOMO_DEPOSIT_KEY);
    if (!activeDepositId) return undefined;
    let active = true;
    api.get(`/deposits/mobile-money/${activeDepositId}`)
      .then(({ data }) => {
        if (active && data?.id && data.status === 'pending') {
          setDeposit({ ...data, __momo: true });
          setStep(3);
        } else {
          sessionStorage.removeItem(ACTIVE_MOMO_DEPOSIT_KEY);
        }
      })
      .catch(() => sessionStorage.removeItem(ACTIVE_MOMO_DEPOSIT_KEY));
    return () => { active = false; };
  }, [deposit, step]);

  // Guard: if the customer somehow lands on a step for a disabled wallet
  // (e.g. via browser back button), send them back to picker.
  useEffect(() => {
    if (!features) return;
    if (method === 'crypto' && !features.crypto_enabled) { setMethod(null); setStep(1); }
    if (method === 'mobile_money' && !features.mobile_money_enabled) { setMethod(null); setStep(1); }
  }, [features, method]);

  return (
    <div className="max-w-2xl mx-auto space-y-4 sm:space-y-5" data-testid="page-deposit">
      <button onClick={() => step > 1 ? setStep(step - 1) : nav('/dashboard')} className="inline-flex items-center gap-2 text-[11px] sm:text-xs font-semibold text-slate-600 hover:text-[#2563EB]" data-testid="btn-back-deposit">
        <ArrowLeft className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> Retour
      </button>

      <div>
        <h1 className="font-cabinet text-xl sm:text-2xl md:text-3xl font-extrabold tracking-tighter text-slate-900">Nouveau dépôt</h1>
        <p className="text-slate-500 text-xs sm:text-sm mt-1">Choisissez votre méthode de paiement.</p>
      </div>

      {step === 1 && (
        <DashboardPageLogo
          src="/images/deposit-dashboard-icon.webp"
          alt="Dépôt"
          className="py-1"
        />
      )}

      <div className="flex items-center gap-1.5 sm:gap-2">
        {[1, 2, 3].map((s) => (
          <div key={s} className={`flex-1 h-1 rounded-full ${step >= s ? 'bg-[#2563EB]' : 'bg-slate-200'}`} />
        ))}
      </div>

      {step === 1 && features && (() => {
        const cryptoOn = features.wallet_crypto_enabled !== false && features.deposit_crypto_enabled !== false;
        const mmOn = (features.wallet_xof_enabled !== false && features.deposit_xof_enabled !== false)
                    || (features.wallet_xaf_enabled !== false && features.deposit_xaf_enabled !== false)
                    || features.wallet_gnf_enabled !== false || features.wallet_cdf_enabled !== false
                    || features.wallet_usd_enabled !== false;
        if (!cryptoOn && !mmOn) {
          return (
            <ComingSoon
              title="Dépôts temporairement indisponibles"
              message={features.mobile_money_coming_soon_message || features.crypto_coming_soon_message}
              icon={Rocket}
            />
          );
        }
        return <MethodPicker features={features} onPick={(m) => { setMethod(m); setStep(2); }} />;
      })()}
      {step === 2 && method === 'crypto' && features?.wallet_crypto_enabled !== false && features?.deposit_crypto_enabled !== false && <CryptoDepositForm onSuccess={(d) => { setDeposit(d); setStep(3); }} />}
      {step === 2 && method === 'mobile_money' && (
        (features?.wallet_xof_enabled !== false && features?.deposit_xof_enabled !== false)
        || (features?.wallet_xaf_enabled !== false && features?.deposit_xaf_enabled !== false)
        || features?.wallet_gnf_enabled !== false || features?.wallet_cdf_enabled !== false
        || features?.wallet_usd_enabled !== false
      ) && <MobileMoneyForm onSuccess={(d) => {
        sessionStorage.setItem(ACTIVE_MOMO_DEPOSIT_KEY, d.id);
        setDeposit({ ...d, __momo: true });
        setStep(3);
      }} />}
      {step === 3 && deposit?.__momo && <MobileMoneyTracker deposit={deposit} />}
      {step === 3 && deposit && !deposit.__momo && <CryptoDepositTracker deposit={deposit} />}
      {step === 3 && !deposit && (
        <div className="bg-white border border-slate-100 rounded-2xl p-8 text-center text-sm text-slate-500">
          Session perdue. <button onClick={() => setStep(1)} className="text-[#2563EB] font-semibold underline">Recommencer</button>
        </div>
      )}

      <div className="text-[11px] sm:text-xs text-slate-500 flex items-start gap-2">
        <ShieldCheck className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-emerald-500 mt-0.5 shrink-0" />
        Paiement 100 % sécurisé — vos informations sensibles ne transitent jamais par nos serveurs.
      </div>
    </div>
  );
}

function MethodPicker({ features, onPick }) {
  // A wallet method is offered only when BOTH the parent wallet AND the
  // deposit toggle for its underlying currency are enabled. For Mobile Money
  // we need at least one of XOF/XAF to be depositable.
  const cryptoOn = features?.wallet_crypto_enabled !== false && features?.deposit_crypto_enabled !== false;
  const mmOn = (
    (features?.wallet_xof_enabled !== false && features?.deposit_xof_enabled !== false)
    || (features?.wallet_xaf_enabled !== false && features?.deposit_xaf_enabled !== false)
    || features?.wallet_gnf_enabled !== false || features?.wallet_cdf_enabled !== false
    || features?.wallet_usd_enabled !== false
  );
  const [providerAvailable, setProviderAvailable] = useState(false);
  useEffect(() => {
    api.get('/deposits/config').then(({ data }) => {
      setProviderAvailable(data.mobile_money_enabled === true);
    }).catch(() => setProviderAvailable(false));
  }, []);
  const methods = [
    { key: 'crypto', I: Bitcoin, c: 'bg-orange-50 text-orange-600', l: 'Crypto', d: 'USDT · USDC · BTC · ETH — Multi-réseaux', enabled: cryptoOn },
    { key: 'mobile_money', I: Smartphone, c: 'bg-emerald-50 text-emerald-600', l: 'Mobile Money', d: 'Orange, MTN, Moov, Wave…', enabled: mmOn && providerAvailable },
  ];
  const available = methods.filter((m) => m.enabled);
  return (
    <div className="space-y-2.5 sm:space-y-3">
      {available.map((m) => (
        <button key={m.key} onClick={() => onPick(m.key)} data-testid={`method-${m.key}`}
          className="w-full bg-white border border-slate-100 rounded-2xl p-3 sm:p-4 flex items-center gap-2.5 sm:gap-3 hover:border-[#2563EB] hover:-translate-y-0.5 transition-all text-left">
          <div className={`w-9 h-9 sm:w-11 sm:h-11 rounded-xl ${m.c} flex items-center justify-center shrink-0`}><m.I className="w-4 h-4 sm:w-5 sm:h-5" strokeWidth={1.75} /></div>
          <div className="flex-1 min-w-0">
            <div className="font-cabinet font-bold text-xs sm:text-sm text-slate-900">{m.l}</div>
            <div className="text-[10px] sm:text-xs text-slate-500 truncate">{m.d}</div>
          </div>
          <ArrowRight className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-slate-400 shrink-0" />
        </button>
      ))}
    </div>
  );
}

function CryptoDepositForm({ onSuccess }) {
  const { user } = useAuth();
  const [assets, setAssets] = useState([]);
  const [assetsError, setAssetsError] = useState('');
  const [fullName, setFullName] = useState(user?.full_name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [refundAddress, setRefundAddress] = useState('');
  const [assetCode, setAssetCode] = useState('USDT.TRC20');
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const idempotencyRef = useRef({ fingerprint: '', key: '' });

  useEffect(() => {
    api.get('/crypto/assets').then(({ data }) => {
      setAssets(data);
      const usdtTrc = data.find((a) => a.asset_code === 'USDT.TRC20') || data[0];
      if (usdtTrc) setAssetCode(usdtTrc.asset_code);
      if (!data.length) setAssetsError('Aucun actif crypto avec un taux USDT configuré n’est disponible.');
    }).catch(() => setAssetsError('Impossible de charger les actifs crypto.'));
  }, []);

  const asset = assets.find((a) => a.asset_code === assetCode);
  const amt = parseFloat(amount) || 0;
  const min = Number(asset?.minimum ?? 0);
  const max = Number(asset?.maximum ?? 10 ** 12);
  const feePct = Number(asset?.fee_pct || 0);
  const feeFixed = Number(asset?.fee_fixed || 0);
  const rate = Number(asset?.usdt_rate || 0);
  const estimatedFeeAsset = amt * feePct / 100 + feeFixed;
  const estimatedCreditAsset = Math.max(0, amt - estimatedFeeAsset);
  const canSubmit = fullName && email && refundAddress && asset && rate > 0
    && amt > 0 && amt >= min && amt <= max && estimatedCreditAsset > 0 && !loading;

  const submit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    const fingerprint = JSON.stringify([
      amt, assetCode, fullName.trim(), email.trim().toLowerCase(),
      refundAddress.trim(),
    ]);
    if (!idempotencyRef.current.key
        || idempotencyRef.current.fingerprint !== fingerprint) {
      idempotencyRef.current = {
        fingerprint,
        key: window.crypto?.randomUUID?.()
          || `deposit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      };
    }
    setLoading(true);
    try {
      const { data } = await api.post('/deposits/crypto', {
        amount: amt, asset_code: assetCode, full_name: fullName, email,
        refund_address: refundAddress.trim(), origin_url: window.location.origin,
        idempotency_key: idempotencyRef.current.key,
      });
      onSuccess(data);
    } catch (err) {
      const detail = err.response?.data?.detail;
      toast.error(typeof detail === 'string' ? detail : 'Erreur lors de la création du dépôt');
      if (err.response?.status && err.response.status < 500
          && err.response.status !== 409) {
        idempotencyRef.current = { fingerprint: '', key: '' };
      }
    } finally {
      setLoading(false);
    }
  };

  // Group assets by coin
  const groupedCoins = Array.from(new Set(assets.map((a) => a.coin))).sort();
  const networksForCoin = (coin) => assets.filter((a) => a.coin === coin);

  return (
    <form onSubmit={submit} className="bg-white border border-slate-100 rounded-2xl p-4 sm:p-6 space-y-3 sm:space-y-4">
      <div className="bg-orange-50 border border-orange-100 rounded-xl p-2.5 sm:p-3 flex items-start gap-2 sm:gap-2.5">
        <Bitcoin className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-orange-600 mt-0.5 shrink-0" />
        <div className="text-[11px] sm:text-xs text-slate-700"><b>Dépôt crypto instantané.</b> Les actifs autres que USDT sont convertis au taux affiché; votre portefeuille est crédité en USDT après confirmation.</div>
      </div>
      {assetsError && (
        <div className="bg-amber-50 border border-amber-100 rounded-xl p-3 text-[11px] text-amber-800">
          {assetsError}
        </div>
      )}

      <Field label="Nom complet">
        <input data-testid="dep-name" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Awa Diallo" required className="w-full px-3 sm:px-4 py-2.5 sm:py-3 border border-slate-200 rounded-xl outline-none focus:border-orange-500 text-xs sm:text-sm" />
      </Field>

      <Field label="Adresse e-mail">
        <input data-testid="dep-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="votre@email.com" required className="w-full px-3 sm:px-4 py-2.5 sm:py-3 border border-slate-200 rounded-xl outline-none focus:border-orange-500 text-xs sm:text-sm" />
      </Field>

      <Field label="Cryptomonnaie">
        <select data-testid="dep-coin" value={assetCode.split('.')[0]} onChange={(e) => {
          const nets = networksForCoin(e.target.value);
          setAssetCode(nets[0]?.asset_code || e.target.value);
        }} className="w-full px-3 sm:px-4 py-2.5 sm:py-3 border border-slate-200 rounded-xl font-semibold text-xs sm:text-sm">
          {groupedCoins.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </Field>

      {asset && networksForCoin(asset.coin).length > 1 && (
        <Field label="Réseau">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {networksForCoin(asset.coin).map((n) => (
              <button key={n.asset_code} type="button" onClick={() => setAssetCode(n.asset_code)} data-testid={`dep-net-${n.network}`}
                className={`p-2 sm:p-2.5 rounded-xl border-2 text-center text-[11px] sm:text-xs transition-colors ${assetCode === n.asset_code ? 'border-orange-500 bg-orange-50 text-orange-700 font-bold' : 'border-slate-200 text-slate-600'}`}>
                {n.network}
              </button>
            ))}
          </div>
        </Field>
      )}

      <Field label={`Adresse ${asset?.coin || ''} de remboursement (en cas de problème)`}>
        <input data-testid="dep-refund-address" value={refundAddress} onChange={(e) => setRefundAddress(e.target.value)}
          placeholder={asset?.network === 'TRC20' ? 'T…' : (asset?.network?.startsWith('BEP') || asset?.network === 'ERC20' ? '0x…' : 'Votre adresse')}
          required className="w-full px-3 sm:px-4 py-2.5 sm:py-3 border border-slate-200 rounded-xl outline-none focus:border-orange-500 font-mono text-xs sm:text-sm" />
        <div className="mt-1 text-[9px] sm:text-[10px] text-slate-500">Utilisée uniquement si le paiement échoue et doit être remboursé.</div>
      </Field>

      <Field label={`Montant à envoyer (${asset?.coin || 'USDT'})`}>
        <input data-testid="dep-amount" type="number" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="10" min={min} max={max} required className="w-full px-3 sm:px-4 py-2.5 sm:py-3 border border-slate-200 rounded-xl outline-none focus:border-orange-500 text-xs sm:text-sm" />
        <div className="mt-1 text-[10px] sm:text-xs text-slate-500">
          Limites : {min}–{max.toLocaleString()} {asset?.coin || ''}
        </div>
        {amt > 0 && asset && (
          <div className="mt-2 rounded-lg bg-slate-50 p-2.5 text-[10px] sm:text-xs space-y-1">
            <div className="flex justify-between text-slate-600">
              <span>Taux appliqué</span>
              <span>1 {asset.coin} = {rate.toLocaleString(undefined, { maximumFractionDigits: 8 })} USDT</span>
            </div>
            <div className="flex justify-between text-slate-600">
              <span>Frais estimés ({feePct}%)</span>
              <span>{estimatedFeeAsset.toLocaleString(undefined, { maximumFractionDigits: 8 })} {asset.coin}</span>
            </div>
            <div className="flex justify-between border-t border-slate-200 pt-1 font-bold text-emerald-700">
              <span>Crédit estimé</span>
              <span>{estimatedCreditAsset.toLocaleString(undefined, { maximumFractionDigits: 8 })} {asset.coin} · {asset.network}</span>
            </div>
          </div>
        )}
      </Field>

      <button type="submit" disabled={!canSubmit} data-testid="btn-dep-submit" className="w-full bg-orange-500 hover:bg-orange-600 text-white font-bold py-3 sm:py-3.5 rounded-xl text-xs sm:text-sm disabled:opacity-50 inline-flex items-center justify-center gap-2">
        {loading ? <><Loader2 className="w-4 h-4 animate-spin" /> Génération…</> : <>Payer maintenant <ArrowRight className="w-4 h-4" /></>}
      </button>
    </form>
  );
}

function CryptoDepositTracker({ deposit: initial }) {
  const nav = useNavigate();
  const { refresh } = useAuth();
  const [deposit, setDeposit] = useState(initial);
  const [status, setStatus] = useState(initial?.status || 'pending');
  const [tick, setTick] = useState(0);
  const stopRef = useRef(false);

  useEffect(() => {
    if (!deposit) return;
    const poll = async () => {
      if (stopRef.current) return;
      try {
        const { data } = await api.get(`/deposits/crypto/${deposit.id}`);
        setDeposit(data);
        setStatus(data.status);
        if (['confirmed', 'expired', 'failed'].includes(data.status)) {
          stopRef.current = true;
          if (data.status === 'confirmed') {
            await refresh();
            window.dispatchEvent(new Event('btp-wallet-updated'));
          }
          return;
        }
      } catch {/* ignore */}
      setTick((t) => t + 1);
    };
    poll();
    const iv = setInterval(poll, 4000);
    return () => { clearInterval(iv); stopRef.current = true; };
    // eslint-disable-next-line
  }, [deposit?.id]);

  if (!deposit) return <div className="text-center text-slate-500 py-8 text-sm">Aucune information de dépôt.</div>;

  const copy = (v, label) => { navigator.clipboard.writeText(v); toast.success(`${label} copié`); };
  const isDone = status === 'confirmed';
  const isFailed = ['expired', 'failed', 'rejected'].includes(status);

  const timeLeft = deposit.expires_at ? Math.max(0, Math.floor((new Date(deposit.expires_at).getTime() - Date.now()) / 1000)) : null;
  const mm = timeLeft ? String(Math.floor(timeLeft / 60)).padStart(2, '0') : null;
  const ss = timeLeft ? String(timeLeft % 60).padStart(2, '0') : null;

  return (
    <div className="bg-white border border-slate-100 rounded-2xl p-4 sm:p-6 space-y-4" data-testid="dep-tracker">
      {isDone && (
        <div className="text-center py-6" data-testid="dep-confirmed">
          <div className="mx-auto w-14 h-14 sm:w-16 sm:h-16 rounded-full bg-emerald-50 flex items-center justify-center"><CheckCircle2 className="w-7 h-7 sm:w-8 sm:h-8 text-emerald-500" /></div>
          <h2 className="mt-3 font-cabinet text-xl sm:text-2xl font-extrabold text-slate-900">Paiement confirmé avec succès !</h2>
          {deposit.amount_net != null ? (
            <div className="mt-3 mx-auto max-w-xs bg-slate-50 rounded-xl p-3 text-left text-[11px] sm:text-xs space-y-1">
              <div className="flex justify-between"><span className="text-slate-500">Reçu (brut)</span><span className="font-semibold">{Number(deposit.amount_crypto ?? deposit.amount).toLocaleString(undefined,{maximumFractionDigits:6})} {deposit.amount_crypto_currency || deposit.coin}</span></div>
              {deposit.usdt_rate != null && (
                <div className="flex justify-between"><span className="text-slate-500">Taux appliqué</span><span>1 {deposit.coin} = {Number(deposit.usdt_rate).toLocaleString(undefined,{maximumFractionDigits:8})} USDT</span></div>
              )}
              <div className="flex justify-between"><span className="text-slate-500">Équivalent brut</span><span>{Number(deposit.amount_gross_usdt ?? deposit.amount_gross ?? deposit.amount).toLocaleString(undefined,{maximumFractionDigits:6})} USDT</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Frais ({deposit.fee_pct ?? '-'}%)</span><span className="font-semibold text-red-600">−{Number(deposit.fee || 0).toLocaleString(undefined,{maximumFractionDigits:8})} {(deposit.fee_currency || deposit.credit_currency || 'USDT').replace('.', ' · ')}</span></div>
              <div className="flex justify-between border-t border-slate-200 pt-1 mt-1"><span className="text-slate-700 font-bold">Crédité (net)</span><span className="font-cabinet font-extrabold text-emerald-600">{Number(deposit.amount_net).toLocaleString(undefined,{maximumFractionDigits:8})} {(deposit.credit_currency || 'USDT').replace('.', ' · ')}</span></div>
            </div>
          ) : (
            <p className="mt-1 text-xs sm:text-sm text-slate-500">{deposit.amount} {deposit.coin} ont été crédités sur votre portefeuille.</p>
          )}
          <div className="mt-5 flex gap-2 justify-center">
            <button onClick={() => nav('/dashboard')} data-testid="btn-dep-back-dash" className="px-5 py-2.5 rounded-full bg-[#2563EB] text-white font-bold text-xs">Retour au dashboard</button>
          </div>
        </div>
      )}

      {isFailed && (
        <div className="text-center py-6" data-testid="dep-failed">
          <div className="mx-auto w-14 h-14 rounded-full bg-red-50 flex items-center justify-center"><XCircle className="w-7 h-7 text-red-500" /></div>
          <h2 className="mt-3 font-cabinet text-lg sm:text-xl font-extrabold text-slate-900">{status === 'expired' ? 'Session expirée' : 'Paiement échoué'}</h2>
          <p className="mt-1 text-xs sm:text-sm text-slate-500">Créez un nouveau dépôt pour réessayer.</p>
          <button onClick={() => nav(0)} className="mt-4 px-5 py-2.5 rounded-full bg-slate-900 text-white font-bold text-xs">Nouveau dépôt</button>
        </div>
      )}

      {!isDone && !isFailed && (
        <>
          <div className="text-center">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-orange-50 text-orange-700 font-semibold text-[11px] sm:text-xs">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> En attente de votre paiement…
            </div>
            {timeLeft > 0 && (
              <div className="mt-2 text-[11px] sm:text-xs text-slate-500 flex items-center justify-center gap-1.5"><Clock className="w-3 h-3" /> Session expire dans <b>{mm}:{ss}</b></div>
            )}
          </div>

          {/* QR Code */}
          <div className="flex justify-center py-2">
            <div className="p-3 bg-white border border-slate-100 rounded-xl shadow-sm">
              <QRCodeCanvas
                data-testid="dep-qr"
                value={deposit.deposit_address || ''}
                size={180}
                bgColor="#ffffff"
                fgColor="#0f172a"
                level="M"
              />
            </div>
          </div>

          {/* Info rows */}
          <div className="space-y-2 sm:space-y-2.5">
            <InfoRow label="Réseau" value={`${deposit.coin} · ${deposit.network}`} highlight />
            <InfoRow label="Montant exact à envoyer" value={`${deposit.amount_to_send || deposit.amount} ${deposit.coin}`} testId="dep-amount-to-send" onCopy={() => copy(String(deposit.amount_to_send || deposit.amount), 'Montant')} />
            <InfoRow label="Adresse de dépôt" value={deposit.deposit_address} mono testId="dep-address" onCopy={() => copy(deposit.deposit_address, 'Adresse')} />
            {deposit.memo && <InfoRow label={`Memo (${deposit.memo_type || 'tag'}) — REQUIS`} value={deposit.memo} mono testId="dep-memo" onCopy={() => copy(deposit.memo, 'Memo')} warn />}
          </div>

          <div className="p-3 bg-amber-50 border border-amber-100 rounded-xl text-[11px] sm:text-xs text-amber-800">
             Envoyez uniquement <b>{deposit.coin}</b> sur le réseau <b>{deposit.network}</b>. Envoyer une autre cryptomonnaie ou un autre réseau entraîne la perte définitive des fonds.
          </div>

          <div className="text-[10px] sm:text-[11px] text-slate-500 text-center">
            Vérification automatique du paiement en cours… Cette page se mettra à jour dès la confirmation on-chain.
          </div>
        </>
      )}
    </div>
  );
}

function InfoRow({ label, value, mono, highlight, warn, onCopy, testId }) {
  return (
    <div className={`flex items-start gap-2 p-2.5 sm:p-3 rounded-xl border ${warn ? 'bg-amber-50 border-amber-100' : highlight ? 'bg-orange-50 border-orange-100' : 'bg-slate-50 border-slate-100'}`}>
      <div className="flex-1 min-w-0">
        <div className={`text-[9px] sm:text-[10px] uppercase tracking-widest font-bold ${warn ? 'text-amber-700' : 'text-slate-500'}`}>{label}</div>
        <div data-testid={testId} className={`mt-0.5 text-xs sm:text-sm font-semibold ${mono ? 'font-mono break-all' : ''} text-slate-900`}>{value}</div>
      </div>
      {onCopy && (
        <button type="button" onClick={onCopy} className="w-8 h-8 rounded-lg hover:bg-white flex items-center justify-center shrink-0" title="Copier">
          <Copy className="w-3.5 h-3.5 text-slate-600" />
        </button>
      )}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="text-[11px] sm:text-xs font-semibold text-slate-700 mb-1 sm:mb-1.5 block">{label}</label>
      {children}
    </div>
  );
}

function SoonMobileMoney() {
  return (
    <div className="bg-white border border-slate-100 rounded-2xl p-6 sm:p-10 text-center">
      <div className="mx-auto w-14 h-14 rounded-full bg-emerald-50 flex items-center justify-center"><Smartphone className="w-6 h-6 text-emerald-500" /></div>
      <h2 className="mt-3 font-cabinet text-lg sm:text-xl font-extrabold text-slate-900">Bientôt disponible</h2>
      <p className="mt-2 text-xs sm:text-sm text-slate-500">Les dépôts Mobile Money (Orange, MTN, Moov, Wave) seront activés prochainement.</p>
    </div>
  );
}

function MobileMoneyForm({ onSuccess }) {
  const [catalog, setCatalog] = useState([]);
  const [provider, setProvider] = useState(null);
  const [country, setCountry] = useState('');
  const [operator, setOperator] = useState('');
  const [phone, setPhone] = useState('');
  const [amount, setAmount] = useState('');
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [otp, setOtp] = useState('');
  const [feeBearer, setFeeBearer] = useState('merchant');
  const [modeLoading, setModeLoading] = useState(true);
  const [psrAssetError, setPsrAssetError] = useState('');
  const [loading, setLoading] = useState(false);
  const psrPollRef = useRef(null);
  const depositIdempotencyRef = useRef(null);
  const { user } = useAuth();

  useEffect(() => () => {
    if (psrPollRef.current) clearInterval(psrPollRef.current);
  }, []);

  useEffect(() => {
    api.get('/deposits/config').then(({ data }) => {
      const rows = data.catalog || [];
      const grouped = rows.length && rows[0]?.operators
        ? rows
        : Object.values(rows.reduce((acc, row) => {
          const key = row.country;
          if (!acc[key]) acc[key] = { country: key, country_label: row.country_label || key, operators: [] };
          acc[key].operators.push(row);
          return acc;
        }, {}));
      setCatalog(grouped);
      setProvider({
        enabled: data.mobile_money_enabled === true,
        mobile_money_enabled: data.mobile_money_enabled === true,
      });
      return null;
    }).catch(() => {
      setProvider({ enabled: false, mobile_money_enabled: false });
    }).finally(() => setModeLoading(false));
    if (user?.email) setEmail(user.email);
    if (user?.full_name) setFullName(user.full_name);
  }, [user]);

  const countryEntry = catalog.find((c) => c.country === country);
  const operators = countryEntry?.operators || [];
  const selectedOp = operators.find((o) => o.code === operator);
  const paymentFlow = selectedOp?.payment_flow || {};
  const flowNeedsOtp = Boolean(paymentFlow.before_submit && paymentFlow.otp_required);
  const baseAmount = Number(amount) || 0;
  const currency = selectedOp?.currency || 'XOF';
  const {
    totalFee,
    totalToPay,
    creditedAmount,
  } = mobileMoneyFeePreview(baseAmount, selectedOp, feeBearer);
  const beginPaymentStatusPolling = (trackedDeposit) => {
    if (psrPollRef.current) clearInterval(psrPollRef.current);
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
      const { data } = await api.get(`/deposits/mobile-money/${trackedDeposit.id}`);
        if (data.status !== 'pending') {
          clearInterval(psrPollRef.current);
          psrPollRef.current = null;
          onSuccess({ ...trackedDeposit, ...data });
        }
      } catch {
        // A transient status failure is retried without changing the payment.
      } finally {
        checking = false;
      }
    };
    check();
    psrPollRef.current = setInterval(check, 4000);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!country || !operator || !phone.trim() || !amount || !email.trim() || !fullName.trim()) {
      toast.error('Tous les champs sont obligatoires');
      return;
    }
    if (baseAmount < (selectedOp?.min || 100)) {
      toast.error(`Montant minimum : ${selectedOp?.min || 100} ${selectedOp?.currency || 'XOF'}`);
      return;
    }
    if (selectedOp?.max && baseAmount > selectedOp.max) {
      toast.error(`Montant maximum : ${selectedOp.max} ${selectedOp.currency || 'XOF'}`);
      return;
    }
    if (flowNeedsOtp && !otp.trim()) {
      toast.error(`Saisissez ${paymentFlow.otp_label || 'le code de paiement'} avant de continuer.`);
      return;
    }
    setLoading(true);
    try {
      if (!depositIdempotencyRef.current) {
        depositIdempotencyRef.current = window.crypto?.randomUUID?.()
          || `deposit-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      }
      const request = {
        amount: baseAmount,
        currency: selectedOp?.currency || 'XOF',
        email: email.trim(),
        full_name: fullName.trim(),
        country,
        operator,
        phone_number: phone.trim(),
        fee_bearer: feeBearer,
        idempotency_key: depositIdempotencyRef.current,
        ...(otp.trim() ? { otp: otp.trim() } : {}),
      };
      const { data } = await api.post('/deposits/mobile-money/start', request);
      const redirectUrl = data.redirect_url || data.checkout_url;
      if (data.payment_kind === 'redirect' || data.payment_flow?.kind === 'redirect' || redirectUrl) {
        if (!redirectUrl) throw new Error('Le lien de paiement n’a pas pu être préparé. Veuillez réessayer.');
        window.location.assign(redirectUrl);
        return;
      }
      if (data.payment_kind === 'popup') {
        if (!data?.id) throw new Error('Le paiement n’a pas pu être initialisé. Veuillez réessayer.');
        const trackedDeposit = {
          ...data,
          __popup: true,
          operator_name: selectedOp?.name || selectedOp?.label || operator,
          fee_bearer: feeBearer,
        };
        try {
          await ensurePaydunyaPsrAssets();
        } catch (error) {
          setPsrAssetError(error.message || 'Le paiement sécurisé est temporairement indisponible.');
          throw error;
        }
        startPaydunyaPsr({
          deposit: data,
          onTerminate: () => onSuccess(trackedDeposit),
        });
        beginPaymentStatusPolling(trackedDeposit);
        toast.success('Fenêtre de paiement ouverte');
        return;
      }
      toast.success(data.message || 'Vérifiez votre téléphone');
      onSuccess({
        ...data,
        operator_name: selectedOp?.name || selectedOp?.label || operator,
        total_fee: data.total_fee ?? totalFee,
        amount_to_pay: data.charged_amount ?? data.amount_to_pay ?? data.amount,
        amount_credited: data.wallet_credit_amount ?? data.amount_net ?? data.amount_credited,
        fee_bearer: feeBearer,
      });
    } catch (err) {
      if (err.response?.status && err.response.status < 500) {
        depositIdempotencyRef.current = null;
      }
      toast.error(err.response?.data?.detail || 'Erreur lors du dépôt');
    } finally { setLoading(false); }
  };

  if (!modeLoading && (!provider?.enabled || !provider?.mobile_money_enabled)) {
    return (
      <div className="bg-white border border-slate-100 rounded-2xl p-6 text-center" data-testid="momo-disabled">
        <h2 className="font-cabinet text-lg font-extrabold text-slate-900">Mobile Money indisponible</h2>
        <p className="mt-2 text-xs text-slate-500">Ce moyen de paiement est temporairement indisponible. Réessayez plus tard.</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="bg-white border border-slate-100 rounded-2xl p-4 sm:p-6 space-y-4" data-testid="momo-deposit-form">
      <div id="paydunya-psr" className="sr-only" aria-hidden="true" />
      {psrAssetError && (
        <div className="rounded-xl border border-amber-100 bg-amber-50 p-3 text-[11px] text-amber-800" data-testid="momo-psr-unavailable">
          Le paiement sécurisé est temporairement indisponible. Veuillez réessayer.
        </div>
      )}
      <div>
        <label className="block text-xs font-semibold text-slate-700 mb-1.5">Nom complet</label>
        <input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} data-testid="momo-fullname" required
          className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm" />
      </div>
      <PaymentFlowCard flow={paymentFlow} amount={baseAmount} currency={currency} />
      {flowNeedsOtp && (
        <Field label={paymentFlow.otp_label || 'Code de paiement'}>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={otp}
            onChange={(e) => setOtp(e.target.value)}
            placeholder="Saisissez le code généré sur votre téléphone"
            required
            data-testid="momo-otp"
            className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm font-mono tracking-widest"
          />
          <p className="mt-1 text-[10px] text-slate-500">Collez ou tapez exactement le code affiché par votre opérateur.</p>
        </Field>
      )}
      <div>
        <label className="block text-xs font-semibold text-slate-700 mb-1.5">Adresse e-mail</label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="momo-email" required
          className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1.5">Pays</label>
          <select
            data-testid="momo-country"
            value={country}
            onChange={(e) => { setCountry(e.target.value); setOperator(''); setOtp(''); }}
            tabIndex="-1"
            aria-hidden="true"
            className="sr-only"
          >
            <option value="">Sélectionnez un pays</option>
            {catalog.map((c) => <option key={c.country} value={c.country}>{c.country_label}</option>)}
          </select>
          <SelectionMenu
            label="Sélectionner le pays"
            value={country}
            onChange={(value) => { setCountry(value); setOperator(''); setOtp(''); }}
            placeholder="Sélectionner"
            testId="momo-country-picker"
            options={catalog.map((c) => {
              const known = COUNTRIES.find((item) => item.code === c.country);
              return {
                value: c.country,
                label: c.country_label || known?.name || c.country,
                flag: known?.flag || '',
              };
            })}
            renderValue={(option) => <span className="inline-flex items-center gap-2"><span>{option.flag}</span>{option.label}</span>}
            renderOption={(option) => <span className="inline-flex items-center gap-2"><span className="text-base">{option.flag}</span><span className="truncate">{option.label}</span></span>}
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1.5">Opérateur</label>
          <select
            data-testid="momo-operator"
            value={operator}
            onChange={(e) => { setOperator(e.target.value); setOtp(''); }}
            required
            disabled={!country}
            aria-label="Opérateur Mobile Money"
            className="sr-only"
          >
            <option value="">Sélectionnez un opérateur</option>
            {operators.map((o) => <option key={o.code} value={o.code}>{o.name || o.label}</option>)}
          </select>
          {!country ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-400">
              Sélectionnez d’abord un pays
            </div>
          ) : operators.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-400">
              Aucun opérateur disponible pour ce pays
            </div>
          ) : (
            <SelectionMenu
              label="Sélectionner l’opérateur"
              value={operator}
               onChange={(value) => { setOperator(value); setOtp(''); }}
              placeholder="Sélectionner"
              testId="momo-operator-picker"
              options={operators.map((o) => ({
                value: o.code,
                label: o.name || o.label || o.code,
                operator: o,
                testId: `momo-operator-${o.code}`,
              }))}
              renderValue={(option) => (
                <span className="inline-flex min-w-0 items-center gap-2">
                  <OperatorLogo operator={option.operator.code} name={option.label} country={country} size="sm" />
                  <span className="truncate">{option.label}</span>
                </span>
              )}
              renderOption={(option) => (
                <span className="inline-flex min-w-0 items-center gap-2">
                  <OperatorLogo operator={option.operator.code} name={option.label} country={country} size="sm" />
                  <span className="truncate">{option.label}</span>
                </span>
              )}
            />
          )}
        </div>
      </div>
      <div>
        <label className="block text-xs font-semibold text-slate-700 mb-1.5">Numéro Mobile Money</label>
        <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} data-testid="momo-phone"
          placeholder="ex: 97000001" required
          className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm" />
      </div>
      <div>
        <label className="block text-xs font-semibold text-slate-700 mb-1.5">Montant ({selectedOp?.currency || 'XOF'})</label>
        <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="momo-amount"
          placeholder={selectedOp ? `Min ${selectedOp.min}${selectedOp.max ? ' — Max ' + selectedOp.max : ''}` : '1000'}
          min={selectedOp?.min || 100}
          max={selectedOp?.max || undefined}
          required
          className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm" />
        {selectedOp && amount && (
          <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-600">
             <div className="w-full grid grid-cols-2 gap-x-3 gap-y-1">
                <span>Frais de paiement</span>
                <span className="font-mono font-semibold text-slate-900 text-right">{totalFee.toLocaleString(undefined, { maximumFractionDigits: 2 })} {selectedOp.currency}</span>
               <span className="font-bold text-slate-700 border-t border-slate-200 pt-1">Total des frais</span>
               <span className="font-mono font-bold text-red-600 text-right border-t border-slate-200 pt-1">{totalFee.toLocaleString(undefined, { maximumFractionDigits: 2 })} {selectedOp.currency}</span>
               <span className="font-semibold text-slate-700">Total à payer</span>
               <span className="font-mono font-bold text-slate-900 text-right">{totalToPay.toLocaleString(undefined, { maximumFractionDigits: 2 })} {selectedOp.currency}</span>
               <span className="font-semibold text-slate-700">Montant crédité</span>
               <span className="font-mono font-bold text-emerald-700 text-right">{creditedAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} {selectedOp.currency}</span>
             </div>
          </div>
        )}
      </div>
      <div>
        <label className="block text-xs font-semibold text-slate-700 mb-1.5">Frais supportés par</label>
        <div className="grid grid-cols-2 gap-2">
             <button type="button" onClick={() => setFeeBearer('merchant')} data-testid="momo-fee-merchant"
             className={`px-3 py-2 rounded-xl border text-xs font-semibold transition-colors ${feeBearer === 'merchant' ? 'border-[#2563EB] bg-blue-50 text-[#2563EB]' : 'border-slate-200 text-slate-600'}`}>
             Biz-transPay
          </button>
           <button type="button" onClick={() => setFeeBearer('client')} data-testid="momo-fee-client"
             className={`px-3 py-2 rounded-xl border text-xs font-semibold transition-colors ${feeBearer === 'client' ? 'border-[#2563EB] bg-blue-50 text-[#2563EB]' : 'border-slate-200 text-slate-600'}`}>
            Client
          </button>
        </div>
         {selectedOp && amount && (
           <p className="mt-2 text-[11px] text-slate-500">
             {feeBearer === 'client'
               ? 'Le client paie le montant du dépôt et les frais. Le portefeuille est crédité du montant de base.'
                : 'Les frais sont déduits du dépôt. Le portefeuille reçoit le montant net.'}
           </p>
         )}
      </div>
      <button type="submit" disabled={loading || (flowNeedsOtp && !otp.trim())} data-testid="momo-submit"
        className="w-full bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold text-sm py-3 rounded-full disabled:opacity-50 flex items-center justify-center gap-2">
        {loading ? <><Loader2 className="w-4 h-4 animate-spin" /> Envoi…</> : <>Payer maintenant <ArrowRight className="w-4 h-4" /></>}
      </button>
    </form>
  );
}

function MobileMoneyTracker({ deposit }) {
  const { refresh } = useAuth();
  const [d, setD] = useState(deposit);
  const [otp, setOtp] = useState('');
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState('');
  const expiryCheckRef = useRef(null);
  const [remainingSeconds, setRemainingSeconds] = useState(() => {
    if (Number.isFinite(Number(deposit.pending_remaining_seconds))) {
      return Math.max(0, Math.ceil(Number(deposit.pending_remaining_seconds)));
    }
    const expiry = new Date(deposit.pending_expires_at || (
      new Date(new Date(deposit.created_at || Date.now()).getTime() + MOMO_PENDING_SECONDS * 1000)
    )).getTime();
    return Math.max(0, Math.ceil((expiry - Date.now()) / 1000));
  });

  useEffect(() => {
    if (d.status !== 'approved') return;
    refresh();
    window.dispatchEvent(new Event('btp-wallet-updated'));
    // The status is terminal, so this side effect is intentionally run once
    // for each tracker instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.status]);

  useEffect(() => {
    if (d.status !== 'pending') return;
    const iv = setInterval(async () => {
      try {
        const { data } = await api.get(`/deposits/mobile-money/${d.id}`);
        setD((current) => ({
          ...current,
          ...data,
          ...(data.finalize_capability === undefined && current.finalize_capability
            ? { finalize_capability: current.finalize_capability }
            : {}),
        }));
        if (data.status !== 'pending') clearInterval(iv);
      } catch { /* poll silently */ }
    }, 4000);
    return () => clearInterval(iv);
  }, [d.id, d.status]);

  useEffect(() => {
    if (d.status !== 'pending') return undefined;
    const serverRemaining = Number(d.pending_remaining_seconds);
    if (Number.isFinite(serverRemaining)) {
      const observedAt = Date.now();
      const tick = () => setRemainingSeconds(Math.max(
        0,
        Math.ceil(serverRemaining - ((Date.now() - observedAt) / 1000)),
      ));
      tick();
      const timer = setInterval(tick, 1000);
      return () => clearInterval(timer);
    }
    const expiry = new Date(d.pending_expires_at || (
      new Date(new Date(d.created_at || Date.now()).getTime() + MOMO_PENDING_SECONDS * 1000)
    )).getTime();
    const tick = () => setRemainingSeconds(Math.max(0, Math.ceil((expiry - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [d.created_at, d.pending_expires_at, d.pending_remaining_seconds, d.status]);

  useEffect(() => {
    if (d.status !== 'pending' || remainingSeconds > 0) return undefined;
    if (expiryCheckRef.current === d.id) return undefined;
    expiryCheckRef.current = d.id;
    let active = true;
    api.get(`/deposits/mobile-money/${d.id}`)
      .then(({ data }) => {
        if (active) {
          setD(data);
        }
      })
      .catch(() => {});
    return () => { active = false; };
  }, [d.id, d.status, remainingSeconds]);

  const ok = d.status === 'approved';
  const failed = d.status === 'failed';
  const pending = !ok && !failed;
  useEffect(() => {
    if (!pending) sessionStorage.removeItem(ACTIVE_MOMO_DEPOSIT_KEY);
  }, [pending]);
  const operatorValue = typeof d.operator === 'object' ? (d.operator?.label || d.operator?.name || d.operator?.code) : d.operator;
  const operatorName = d.operator_name || d.operator_label || operatorValue || 'Mobile Money';
  const fallbackCheckoutUrl = d.payment_fallback === 'hosted_checkout'
    ? (d.redirect_url || d.checkout_url)
    : '';
  const instructionValue = d.instructions || d.payment_instructions || d.pending_instructions || d.message;
  const instructions = Array.isArray(instructionValue)
    ? instructionValue.join(' ')
    : (typeof instructionValue === 'string' && instructionValue.trim()
      ? instructionValue
      : `Une demande de ${d.amount_to_pay?.toLocaleString?.() || d.amount_to_pay || d.charged_amount || d.amount} ${d.currency || 'XOF'} via ${operatorName} a été envoyée au ${d.phone_number || 'numéro indiqué'}. Ouvrez la notification ou l’application Mobile Money et confirmez le paiement.`);
  const flow = d.payment_flow || {};
  const needsPostInitOtp = pending && (d.auth_mode === 'pin' || (d.otp_required && !flow.before_submit));
  const afribapayWaveRedirect = pending && d.provider === 'afribapay' && d.redirect_url;
  const finalize = async () => {
    if (!otp.trim()) {
      setFinalizeError('Saisissez le code demandé pour continuer.');
      return;
    }
    setFinalizing(true);
    setFinalizeError('');
    try {
      const { data } = await api.post(`/deposits/mobile-money/${d.id}/finalize`, {
        otp: otp.trim(),
        ...(d.finalize_capability ? { finalize_capability: d.finalize_capability } : {}),
      });
      setD((current) => {
        const next = { ...current, ...data };
        delete next.finalize_capability;
        return next;
      });
      setOtp('');
    } catch (err) {
      setFinalizeError(err.response?.data?.detail || 'Le code n’a pas pu être validé. Vérifiez-le puis réessayez.');
    } finally {
      setFinalizing(false);
    }
  };

  return (
    <div className="bg-white border border-slate-100 rounded-2xl p-6 sm:p-8 text-center space-y-4" data-testid="momo-tracker">
      {pending && <div className="mx-auto w-14 h-14 rounded-full bg-amber-50 flex items-center justify-center"><Clock className="w-6 h-6 text-amber-500 animate-pulse" /></div>}
      {ok && <div className="mx-auto w-14 h-14 rounded-full bg-emerald-50 flex items-center justify-center"><CheckCircle2 className="w-6 h-6 text-emerald-500" /></div>}
      {failed && <div className="mx-auto w-14 h-14 rounded-full bg-red-50 flex items-center justify-center"><XCircle className="w-6 h-6 text-red-500" /></div>}
      <h2 className="font-cabinet text-lg sm:text-xl font-extrabold text-slate-900">
        {pending && (fallbackCheckoutUrl ? 'Terminez le paiement sécurisé' : 'Vérifiez votre téléphone')}
        {ok && 'Paiement effectué avec succès'}
        {failed && 'Paiement échoué'}
      </h2>
      <p className="text-xs sm:text-sm text-slate-500 max-w-md mx-auto leading-relaxed">
         {pending && (fallbackCheckoutUrl
           ? 'La demande directe a pris trop de temps. Utilisez le lien sécurisé PayDunya pour terminer ce même dépôt, sans en créer un second.'
           : instructions)}
        {ok && `Votre portefeuille a été crédité de ${d.amount_net?.toLocaleString?.() || d.amount_net || d.amount} ${d.currency || 'XOF'} (net après frais).`}
        {failed && `La transaction a été refusée ou annulée. ${d.failed_reason ? '('+d.failed_reason+')' : ''}`}
      </p>
       {pending && <PaymentFlowCard flow={flow} amount={d.amount_to_pay || d.charged_amount || d.amount} currency={d.currency} />}
       {pending && fallbackCheckoutUrl && (
         <button
           type="button"
           onClick={() => window.location.assign(fallbackCheckoutUrl)}
           data-testid="momo-hosted-checkout"
           className="inline-flex items-center justify-center gap-2 rounded-full bg-[#2563EB] px-5 py-3 text-xs font-bold text-white hover:bg-[#1D4ED8]"
         >
           Continuer sur PayDunya <ArrowRight className="h-4 w-4" />
         </button>
       )}
       {afribapayWaveRedirect && (
         <button
           type="button"
           onClick={() => window.location.assign(d.redirect_url)}
           data-testid="afribapay-wave-redirect"
           className="inline-flex items-center justify-center gap-2 rounded-full bg-[#2563EB] px-5 py-3 text-xs font-bold text-white hover:bg-[#1D4ED8]"
         >
           Ouvrir le paiement Wave <ArrowRight className="h-4 w-4" />
         </button>
       )}
       {needsPostInitOtp && (
         <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-left space-y-2">
           <label className="block text-[11px] font-bold text-blue-900">Code de validation</label>
           <p className="text-[11px] text-blue-800">Saisissez ou collez le code reçu ou généré sur votre téléphone, puis validez.</p>
           <div className="flex gap-2">
             <input
               value={otp}
               onChange={(e) => setOtp(e.target.value)}
               inputMode="numeric"
               autoComplete="one-time-code"
               placeholder="Code OTP / PIN"
               data-testid="momo-tracker-otp"
               className="min-w-0 flex-1 rounded-lg border border-blue-200 bg-white px-3 py-2 text-xs font-mono tracking-widest outline-none focus:border-blue-500"
             />
             <button type="button" onClick={finalize} disabled={finalizing || !otp.trim()} data-testid="momo-finalize"
               className="shrink-0 rounded-lg bg-[#2563EB] px-3 py-2 text-xs font-bold text-white disabled:opacity-50">
               {finalizing ? 'Validation…' : 'Valider'}
             </button>
           </div>
           {finalizeError && <p className="text-[11px] font-semibold text-red-700">{finalizeError}</p>}
         </div>
       )}
        {pending && (
          <div className="rounded-xl bg-blue-50 border border-blue-100 p-3 text-[11px] text-blue-800">
            <strong className="block text-blue-950">
              {remainingSeconds > 0
                ? `Vérification en cours — ${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, '0')}`
                : 'Le délai initial est écoulé — vérification toujours en cours'}
            </strong>
            <span>Restez sur cette page : le statut est vérifié automatiquement.</span>
          </div>
        )}
    </div>
  );
}

function PaymentFlowCard({ flow, amount, currency }) {
  const steps = Array.isArray(flow?.steps) ? flow.steps.filter(Boolean) : [];
  const roundedAmount = ['XOF', 'XAF', 'GNF'].includes(String(currency || '').toUpperCase())
    ? Math.round(Number(amount) || 0)
    : Math.round((Number(amount) || 0) * 100) / 100;
  const amountText = Number.isFinite(roundedAmount) ? String(roundedAmount) : '';
  const replaceAmount = (value) => String(value || '').replace(/\{amount\}|MONTANT/gi, amountText);
  const ussd = replaceAmount(flow?.ussd_template || flow?.ussd_code);
  if (!steps.length && !ussd) return null;
  const copyUssd = () => {
    if (navigator.clipboard && ussd) {
      navigator.clipboard.writeText(String(ussd));
      toast.success('Code USSD copié');
    }
  };
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-left space-y-2" data-testid="momo-payment-flow">
      <div className="text-xs font-bold text-amber-900">Comment confirmer votre paiement</div>
      {steps.length > 0 && (
        <ol className="list-decimal space-y-1 pl-5 text-[11px] leading-relaxed text-amber-900">
          {steps.map((step, index) => <li key={`${step}-${index}`}>{replaceAmount(step)}</li>)}
        </ol>
      )}
      {ussd && (
        <div className="rounded-lg border border-amber-200 bg-white p-2">
          <div className="text-[10px] font-semibold text-amber-800">Code à composer sur le même téléphone</div>
          <div className="mt-1 flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all font-mono text-sm font-bold tracking-wide text-slate-900">{ussd}</code>
            <button type="button" onClick={copyUssd} className="shrink-0 rounded-lg p-2 hover:bg-amber-50" title="Copier le code USSD" aria-label="Copier le code USSD">
              <Copy className="h-4 w-4 text-amber-700" />
            </button>
          </div>
          <p className="mt-1 text-[10px] text-slate-600">Composez ce code sur le téléphone associé au numéro indiqué, puis revenez ici.</p>
        </div>
      )}
    </div>
  );
}
