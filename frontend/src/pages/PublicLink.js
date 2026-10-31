import { useEffect, useState, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { ShieldCheck, Bitcoin, ArrowRight, ArrowLeft, Copy, CheckCircle2, XCircle, Clock, Loader2, Smartphone } from 'lucide-react';
import { QRCodeCanvas } from 'qrcode.react';
import { toast } from 'sonner';
import api from '@/api';
import { Logo } from '@/components/Logo';
import LinkLogo from '@/components/LinkLogo';
import TurnstileWidget, { useTurnstileConfig } from '@/components/TurnstileWidget';
import { mobileMoneyFeePreview } from '@/lib/mobileMoneyFees';
import SelectionMenu from '@/components/SelectionMenu';
import { OperatorLogo } from '@/components/PaymentBrand';
import { COUNTRIES } from '@/constants/countries';
import { MOMO_PENDING_SECONDS } from '@/constants/payment';
import PublicLinkPaymentErrorBoundary from '@/components/PublicLinkPaymentErrorBoundary';

function formatPrice(value, maximumFractionDigits = 0) {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits });
}

function linkPrice(link, crypto = false) {
  const amount = crypto ? (link.crypto_amount ?? link.amount) : link.amount;
  const minimum = crypto
    ? (link.crypto_min_amount ?? link.min_amount)
    : link.min_amount;
  const maximum = crypto
    ? (link.crypto_max_amount ?? link.max_amount)
    : link.max_amount;
  const currency = crypto ? 'USDT' : 'FCFA';
  if (link.amount_type === 'free') {
    return `${formatPrice(minimum, crypto ? 6 : 0)} – ${formatPrice(maximum, crypto ? 6 : 0)} ${currency}`;
  }
  return `${formatPrice(amount, crypto ? 6 : 0)} ${currency}`;
}

export default function PublicLink() {
  const { slug } = useParams();
  const [link, setLink] = useState(null);
  const [err, setErr] = useState(null);
  const [step, setStep] = useState(1);
  const [method, setMethod] = useState(null);
  const [payment, setPayment] = useState(null);
  const [features, setFeatures] = useState(null);
  const turnstile = useTurnstileConfig();

  useEffect(() => {
    api.get(`/links/public/${slug}`).then(({ data }) => setLink(data)).catch(() => setErr('Lien introuvable ou expiré'));
    api.get('/settings/features').then(({ data }) => setFeatures(data))
      .catch(() => setFeatures({ mobile_money_enabled: true, crypto_enabled: true }));
  }, [slug]);

  if (err) return <div className="bt-page min-h-screen flex items-center justify-center p-6 text-slate-600"><div className="bt-panel p-8 text-center">{err}</div></div>;
  if (!link) return (
    <div className="bt-page min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md bt-panel p-6">
        <div className="bt-skeleton h-12 w-12 rounded-2xl mx-auto" />
        <div className="bt-skeleton h-4 w-36 rounded mx-auto mt-5" />
        <div className="bt-skeleton h-3 w-52 rounded mx-auto mt-3" />
        <div className="bt-skeleton h-12 w-full rounded-xl mt-8" />
        <div className="bt-skeleton h-12 w-full rounded-xl mt-3" />
      </div>
    </div>
  );
  const activePrice = method === 'crypto'
    ? linkPrice(link, true)
    : method === 'mm' ? linkPrice(link) : null;

  return (
    <div className="bt-page min-h-screen flex flex-col" data-testid="public-link-page">
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-4xl mx-auto px-4 h-14 flex items-center"><Logo /></div>
      </header>

      <main className="flex-1 flex items-center justify-center p-4 sm:p-6">
        <div className="max-w-md w-full">
          <div className="mb-3 flex items-center justify-between">
            <button onClick={() => {
              if (step === 2) {
                setMethod(null);
                setStep(1);
              } else if (step > 1) {
                setStep(step - 1);
              }
            }} disabled={step === 1} className="inline-flex items-center gap-1.5 text-[11px] sm:text-xs font-semibold text-slate-600 disabled:opacity-40" data-testid="btn-back-pay">
              <ArrowLeft className="w-3.5 h-3.5" /> Retour
            </button>
            <div className="flex items-center gap-1">
              {[1, 2, 3].map((s) => (
                <div key={s} className={`w-6 h-1 rounded-full ${step >= s ? 'bg-[#2563EB]' : 'bg-slate-200'}`} />
              ))}
            </div>
          </div>

           <div className="bt-public-card bt-panel p-4 sm:p-6">
             {/* Header - link information. The owner's identity is intentionally
                 not exposed on the public checkout page. */}
            <div className="text-center">
              <LinkLogo src={link.logo} alt={link.title} size="lg" className="mx-auto" />
              <h1 className="font-cabinet font-extrabold text-base sm:text-lg text-slate-900 mt-3">{link.title}</h1>
              {link.description && <p className="text-[11px] sm:text-xs text-slate-500 mt-1 leading-relaxed">{link.description}</p>}
              <div className="mt-3 rounded-xl bg-blue-50 px-3 py-2 text-[#2563EB] text-xs font-bold" data-testid="public-link-price">
                {activePrice ? (
                  <div data-testid={method === 'crypto' ? 'public-price-crypto' : 'public-price-mm'}>
                    {method === 'crypto' ? 'Crypto · ' : 'Mobile Money · '}{activePrice}
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    <div data-testid="public-price-mm">
                      <div className="text-[9px] uppercase tracking-wide text-slate-500">Mobile Money</div>
                      <div className="mt-0.5">{linkPrice(link)}</div>
                    </div>
                    <div data-testid="public-price-crypto">
                      <div className="text-[9px] uppercase tracking-wide text-slate-500">Crypto</div>
                      <div className="mt-0.5">{linkPrice(link, true)}</div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {step === 1 && (() => {
              const cryptoCurrency = link.currency === 'USDT' || link.currency === 'UNIVERSAL';
              const cryptoOn = cryptoCurrency
                && features?.wallet_crypto_enabled !== false
                && features?.deposit_crypto_enabled !== false;
              const mmOn = (features?.wallet_xof_enabled !== false && features?.deposit_xof_enabled !== false)
                          || (features?.wallet_xaf_enabled !== false && features?.deposit_xaf_enabled !== false);
              if (!features) return null;
              if (!cryptoOn && !mmOn) {
                return (
                  <div className="mt-4 p-6 rounded-2xl bg-amber-50 border border-amber-200 text-center">
                    <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-100 text-amber-700 text-[11px] font-bold uppercase tracking-widest mb-3">Bientôt disponible</div>
                    <div className="font-cabinet font-bold text-slate-900">Les paiements sont temporairement suspendus</div>
                    <div className="text-xs text-slate-600 mt-1">{features.crypto_coming_soon_message || features.mobile_money_coming_soon_message || 'Merci de revenir plus tard.'}</div>
                  </div>
                );
              }
              return (
                <div className="mt-4 space-y-2">
                  <div className="text-xs sm:text-sm font-semibold text-slate-700 mb-2">Choisissez le moyen de paiement</div>
                  {cryptoOn && (
                    <MethodBtn testId="pay-method-crypto" I={Bitcoin} c="bg-orange-50 text-orange-600" title="Crypto" sub={(link.currency === 'USDT' || link.currency === 'UNIVERSAL') ? 'USDT · USDC · BTC · ETH' : "Ce lien n'accepte pas les paiements crypto"} onClick={() => { setMethod('crypto'); setStep(2); }} disabled={link.currency !== 'USDT' && link.currency !== 'UNIVERSAL'} />
                  )}
                  {mmOn && (
                    <MethodBtn testId="pay-method-mm" I={Smartphone} c="bg-emerald-50 text-emerald-500" title="Mobile Money" sub="MTN · Moov · Orange · Wave · T-Money" onClick={() => { setMethod('mm'); setStep(2); }} />
                  )}
                </div>
              );
            })()}

            {step === 2 && method === 'crypto' && (
              <CryptoLinkForm link={link} turnstile={turnstile} onSuccess={(p) => { setPayment(p); setStep(3); }} />
            )}

            {step === 2 && method === 'mm' && (
              <MoMoLinkForm link={link} turnstile={turnstile} onSuccess={(p) => { setPayment(p); setStep(3); }} />
            )}

            {step === 3 && payment && payment.method !== 'mobile_money' && (
              <CryptoLinkTracker payment={payment} link={link} />
            )}
            {step === 3 && payment && payment.method === 'mobile_money' && (
              <PublicLinkPaymentErrorBoundary key={payment.id} payment={payment}>
                <MoMoLinkTracker payment={payment} />
              </PublicLinkPaymentErrorBoundary>
            )}
          </div>

          <div className="mt-4 flex items-center justify-center gap-2 text-[10px] sm:text-[11px] text-slate-500">
            <ShieldCheck className="w-3 h-3 text-emerald-500" /> Paiement sécurisé · Biz-transPay
          </div>
        </div>
      </main>
    </div>
  );
}

function MethodBtn({ I, c, title, sub, onClick, testId, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled} data-testid={testId} className={`w-full flex items-center gap-2.5 p-2.5 sm:p-3 rounded-xl border transition-colors text-left ${disabled ? 'border-slate-200 opacity-50 cursor-not-allowed' : 'border-slate-200 hover:border-[#2563EB] hover:bg-slate-50'}`}>
      <div className={`w-9 h-9 rounded-xl ${c} flex items-center justify-center shrink-0`}><I className="w-4 h-4" /></div>
      <div className="flex-1 min-w-0">
        <div className="font-cabinet font-bold text-xs sm:text-sm text-slate-900">{title}</div>
        <div className="text-[10px] sm:text-[11px] text-slate-500 truncate">{sub}</div>
      </div>
      {!disabled && <ArrowRight className="w-3.5 h-3.5 text-slate-400" />}
    </button>
  );
}

function CryptoLinkForm({ link, turnstile, onSuccess }) {
  const isFree = link.amount_type === 'free';
  const displayCurrency = 'USDT';
  const cryptoAmount = link.crypto_amount ?? link.amount;
  const cryptoMin = link.crypto_min_amount ?? link.min_amount;
  const cryptoMax = link.crypto_max_amount ?? link.max_amount;
  const [assets, setAssets] = useState([]);
  const [assetsError, setAssetsError] = useState('');
  const [assetCode, setAssetCode] = useState('USDT.TRC20');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [refundAddress, setRefundAddress] = useState('');
  const [amount, setAmount] = useState(isFree ? String(cryptoMin || '') : String(cryptoAmount || ''));
  const [loading, setLoading] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState('');
  const turnstileRef = useRef(null);
  const idempotencyRef = useRef({ fingerprint: '', key: '' });

  useEffect(() => {
    api.get('/crypto/assets')
      .then(({ data }) => {
        setAssets(data);
        if (!data.length) setAssetsError('Aucun actif crypto avec un taux USDT configuré n’est disponible.');
      })
      .catch(() => setAssetsError('Impossible de charger les actifs crypto.'));
  }, []);

  const asset = assets.find((a) => a.asset_code === assetCode);
  const amt = parseFloat(amount) || 0;
  const rate = Number(asset?.usdt_rate || 0);
  const feePct = Number(asset?.fee_pct || 0);
  const feeFixed = Number(asset?.fee_fixed || 0);
  const feeBearer = link.fee_bearer || 'customer';
  const feeCoin = rate > 0 ? (amt / rate) * feePct / 100 + feeFixed : 0;
  const feeUsdt = feeCoin * rate;
  const customerPaysFee = !['owner', 'merchant'].includes(
    String(feeBearer).toLowerCase(),
  );
  const chargedCoin = rate > 0 ? (amt + (customerPaysFee ? feeUsdt : 0)) / rate : 0;
  const belowMin = isFree && amt < (cryptoMin || 0);
  const aboveMax = isFree && amt > (cryptoMax || 0);
  const canSubmit = fullName && email && refundAddress && amt > 0 && !belowMin
    && !aboveMax && rate > 0 && chargedCoin >= Number(asset?.minimum ?? 0)
    && chargedCoin <= Number(asset?.maximum ?? 10 ** 12)
    && turnstile.enabled && turnstileToken && !loading;

  const submit = async (e) => {
    e.preventDefault();
    if (!canSubmit) {
      toast.error(turnstileToken
        ? 'Merci de remplir tous les champs (dont l\'adresse de remboursement).'
        : 'Veuillez terminer la vérification anti-bot.');
      return;
    }
    const fingerprint = JSON.stringify([
      link.id, isFree ? amt : Number(cryptoAmount), assetCode,
      fullName.trim(), email.trim().toLowerCase(), refundAddress.trim(),
    ]);
    if (!idempotencyRef.current.key
        || idempotencyRef.current.fingerprint !== fingerprint) {
      idempotencyRef.current = {
        fingerprint,
        key: window.crypto?.randomUUID?.()
          || `link-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      };
    }
    setLoading(true);
    try {
      const { data } = await api.post('/links/pay', {
        slug: link.slug, amount: isFree ? amt : undefined,
        asset_code: assetCode, full_name: fullName, email,
        refund_address: refundAddress.trim(), origin_url: window.location.origin,
        idempotency_key: idempotencyRef.current.key,
        turnstile_token: turnstileToken,
      });
      onSuccess(data);
    } catch (err) {
      setTurnstileToken('');
      turnstileRef.current?.reset();
      const detail = err.response?.data?.detail;
      toast.error(typeof detail === 'string' ? detail : 'Erreur lors du paiement');
      if (err.response?.status && err.response.status < 500
          && err.response.status !== 409) {
        idempotencyRef.current = { fingerprint: '', key: '' };
      }
    } finally { setLoading(false); }
  };

  const groupedCoins = Array.from(new Set(assets.map((a) => a.coin))).sort();
  const netsFor = (c) => assets.filter((a) => a.coin === c);

  return (
    <form onSubmit={submit} className="mt-4 space-y-3">
      {assetsError && (
        <div className="rounded-lg bg-amber-50 border border-amber-100 p-2.5 text-[10px] text-amber-800">
          {assetsError}
        </div>
      )}
      <div className="rounded-xl bg-gradient-to-br from-[#3B82F6] to-[#1D4ED8] p-3 sm:p-4 text-white">
        <div className="text-[9px] sm:text-[10px] uppercase tracking-widest opacity-80">{link.title}</div>
        {isFree ? (
          <>
            <input data-testid="pay-amount" type="number" step="0.000001" value={amount} onChange={(e) => setAmount(e.target.value)} min={cryptoMin} max={cryptoMax} className="w-full bg-white/15 rounded-lg px-3 py-2 mt-1 text-lg sm:text-xl font-cabinet font-extrabold text-blue-900 outline-none placeholder:text-white/50" />
            <div className="mt-1 text-[9px] sm:text-[10px] opacity-80">{formatPrice(cryptoMin, 6)} – {formatPrice(cryptoMax, 6)} {displayCurrency}</div>
          </>
        ) : (
          <div className="font-cabinet text-xl sm:text-2xl font-extrabold mt-1">{formatPrice(cryptoAmount, 6)} <span className="text-xs sm:text-sm opacity-80">{displayCurrency}</span></div>
        )}
        {link.description && <div className="mt-1 text-[10px] sm:text-[11px] opacity-80">{link.description}</div>}
      </div>
      {asset && amt > 0 && rate > 0 && (
        <div className="rounded-xl bg-slate-50 p-3 text-[10px] sm:text-xs space-y-1">
          <div className="flex justify-between text-slate-600">
            <span>Taux appliqué</span>
            <span>1 {asset.coin} = {rate.toLocaleString(undefined, { maximumFractionDigits: 8 })} USDT</span>
          </div>
          <div className="flex justify-between text-slate-600">
            <span>Frais estimés ({feePct}%)</span>
            <span>{feeUsdt.toLocaleString(undefined, { maximumFractionDigits: 6 })} USDT</span>
          </div>
          <div className="flex justify-between border-t border-slate-200 pt-1 font-bold text-slate-800">
            <span>{customerPaysFee ? 'Montant crypto à envoyer' : 'Montant crypto de base'}</span>
            <span>{chargedCoin.toLocaleString(undefined, { maximumFractionDigits: 6 })} {asset.coin}</span>
          </div>
        </div>
      )}

      <Field label="Nom complet">
        <input data-testid="pay-name" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Votre nom" required className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none text-xs sm:text-sm" />
      </Field>
      <Field label="Adresse e-mail">
        <input data-testid="pay-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="vous@email.com" required className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none text-xs sm:text-sm" />
      </Field>

      <Field label="Cryptomonnaie">
        <select data-testid="pay-coin" value={assetCode.split('.')[0]} onChange={(e) => {
          const nets = netsFor(e.target.value);
          setAssetCode(nets[0]?.asset_code || e.target.value);
        }} className="w-full px-3 py-2.5 border border-slate-200 rounded-xl font-semibold text-xs sm:text-sm">
          {groupedCoins.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </Field>

      {asset && netsFor(asset.coin).length > 1 && (
        <Field label="Réseau">
          <div className="grid grid-cols-3 gap-2">
            {netsFor(asset.coin).map((n) => (
              <button key={n.asset_code} type="button" onClick={() => setAssetCode(n.asset_code)} data-testid={`pay-net-${n.network}`}
                className={`p-2 rounded-lg border-2 text-center text-[10px] sm:text-xs transition-colors ${assetCode === n.asset_code ? 'border-orange-500 bg-orange-50 text-orange-700 font-bold' : 'border-slate-200 text-slate-600'}`}>
                {n.network}
              </button>
            ))}
          </div>
        </Field>
      )}

      <Field label={`Votre adresse ${asset?.coin || ''} (${asset?.network || ''}) — obligatoire`}>
        <input data-testid="pay-refund-address" value={refundAddress} onChange={(e) => setRefundAddress(e.target.value)} placeholder={asset?.network === 'TRC20' ? 'T… (votre wallet)' : asset?.network?.startsWith('BEP') || asset?.network === 'ERC20' ? '0x… (votre wallet)' : 'Votre adresse'} required className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-orange-500 font-mono text-[10px] sm:text-xs" />
        <div className="mt-1 text-[9px] sm:text-[10px] text-slate-500">Nécessaire pour la conformité on-chain : en cas de refund, les fonds y seront envoyés.</div>
      </Field>

      <TurnstileWidget
        ref={turnstileRef}
        siteKey={turnstile.siteKey}
        action="payment"
        disabled={turnstile.loading || !turnstile.enabled}
        onToken={setTurnstileToken}
      />
      <button type="submit" disabled={!canSubmit} data-testid="btn-pay-submit" className="w-full bg-orange-500 hover:bg-orange-600 text-white font-bold py-3 rounded-xl disabled:bg-slate-300 disabled:text-slate-500 text-xs sm:text-sm inline-flex items-center justify-center gap-2">
        {loading ? <><Loader2 className="w-4 h-4 animate-spin" /> Génération…</> : <>Payer maintenant <ArrowRight className="w-4 h-4" /></>}
      </button>
    </form>
  );
}

function CryptoLinkTracker({ payment, link }) {
  const [status, setStatus] = useState(payment.status || 'pending');
  const stopRef = useRef(false);

  useEffect(() => {
    const poll = async () => {
      if (stopRef.current) return;
      try {
        const { data } = await api.get(`/links/payments/${payment.id}`);
        setStatus(data.status);
        if (['paid', 'expired', 'failed', 'canceled'].includes(data.status)) stopRef.current = true;
      } catch {/* ignore */}
    };
    poll();
    const iv = setInterval(poll, 4000);
    return () => { clearInterval(iv); stopRef.current = true; };
  }, [payment.id]);

  const isDone = status === 'paid';
  const isFailed = ['expired', 'failed', 'rejected', 'canceled'].includes(status);
  const copy = (v, label) => { navigator.clipboard.writeText(v); toast.success(`${label} copié`); };
  const _link = link;

  if (isDone) return (
    <div className="mt-4 text-center py-6" data-testid="pay-confirmed">
      <div className="mx-auto w-14 h-14 rounded-full bg-emerald-50 flex items-center justify-center"><CheckCircle2 className="w-7 h-7 text-emerald-500" /></div>
      <h2 className="mt-3 font-cabinet text-xl font-extrabold text-slate-900">Paiement confirmé !</h2>
      <p className="mt-1 text-xs text-slate-500">Merci {payment.customer_name || ''}. Le marchand a été notifié.</p>
    </div>
  );
  if (isFailed) return (
    <div className="mt-4 text-center py-6" data-testid="pay-failed">
      <div className="mx-auto w-14 h-14 rounded-full bg-red-50 flex items-center justify-center"><XCircle className="w-7 h-7 text-red-500" /></div>
      <h2 className="mt-3 font-cabinet text-lg font-extrabold text-slate-900">{status === 'expired' ? 'Session expirée' : 'Paiement échoué'}</h2>
      <button onClick={() => window.location.reload()} className="mt-3 px-4 py-2 rounded-full bg-slate-900 text-white font-bold text-xs">Recommencer</button>
    </div>
  );

  return (
    <div className="mt-4 space-y-3" data-testid="pay-tracker">
      <div className="text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-orange-50 text-orange-700 font-semibold text-[11px]">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> En attente de votre paiement…
        </div>
      </div>
      <div className="flex justify-center">
        <div className="p-3 bg-white border border-slate-100 rounded-xl">
          <QRCodeCanvas value={payment.deposit_address || ''} size={160} bgColor="#ffffff" fgColor="#0f172a" level="M" />
        </div>
      </div>
      <InfoRow label="Réseau" value={`${payment.coin} · ${payment.network}`} highlight />
      <InfoRow label="Montant exact" value={`${payment.amount_to_send || payment.amount} ${payment.coin}`} testId="pay-amount-to-send" onCopy={() => copy(String(payment.amount_to_send || payment.amount), 'Montant')} />
      <InfoRow label="Adresse de dépôt" value={payment.deposit_address} mono testId="pay-address" onCopy={() => copy(payment.deposit_address, 'Adresse')} />
      {payment.memo && <InfoRow label={`Memo (${payment.memo_type || 'tag'}) — REQUIS`} value={payment.memo} mono testId="pay-memo" onCopy={() => copy(payment.memo, 'Memo')} warn />}
      <div className="p-2.5 bg-amber-50 border border-amber-100 rounded-lg text-[10px] sm:text-[11px] text-amber-800">
         Envoyez uniquement <b>{payment.coin}</b> sur <b>{payment.network}</b>. Toute autre crypto ou réseau = fonds perdus.
      </div>
      <div className="text-[10px] text-slate-500 text-center">Vérification automatique du paiement en cours…</div>
    </div>
  );
}

function InfoRow({ label, value, mono, highlight, warn, onCopy, testId }) {
  return (
    <div className={`flex items-start gap-2 p-2.5 rounded-xl border ${warn ? 'bg-amber-50 border-amber-100' : highlight ? 'bg-orange-50 border-orange-100' : 'bg-slate-50 border-slate-100'}`}>
      <div className="flex-1 min-w-0">
        <div className={`text-[9px] uppercase tracking-widest font-bold ${warn ? 'text-amber-700' : 'text-slate-500'}`}>{label}</div>
        <div data-testid={testId} className={`mt-0.5 text-xs sm:text-sm font-semibold ${mono ? 'font-mono break-all' : ''} text-slate-900`}>{value}</div>
      </div>
      {onCopy && (
        <button type="button" onClick={onCopy} className="w-7 h-7 rounded-lg hover:bg-white flex items-center justify-center shrink-0" title="Copier">
          <Copy className="w-3 h-3 text-slate-600" />
        </button>
      )}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="text-[10px] sm:text-[11px] font-semibold text-slate-700 mb-1 block">{label}</label>
      {children}
    </div>
  );
}

export function MoMoLinkForm({ link, turnstile, onSuccess }) {
  const isFree = link.amount_type === 'free';
  const [catalog, setCatalog] = useState([]);
  const [country, setCountry] = useState('');
  const [operator, setOperator] = useState('');
  const [phone, setPhone] = useState('');
  const [amount, setAmount] = useState(isFree ? '' : String(link.amount || ''));
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [otp, setOtp] = useState('');
  const [address, setAddress] = useState('');
  // Keep the business meaning independent from the legacy transport values:
  // client pays vs Biz-transPay/merchant pays.
  const feeBearer = link.fee_bearer === 'owner' ? 'merchant' : 'client';
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');
  const turnstileRef = useRef(null);
  const idempotencyRef = useRef({ fingerprint: '', key: '' });

  useEffect(() => {
    fetch(`${process.env.REACT_APP_BACKEND_URL || ''}/api/deposits/config?surface=public_link`).then(r => r.json())
      .then(d => {
        const wanted = String(link.currency || 'XOF').toUpperCase();
        const groups = (d.catalog || [])
          .map((entry) => ({
            ...entry,
            operators: (entry.operators || []).filter((op) => (
              wanted === 'UNIVERSAL'
              || String(op.currency || '').toUpperCase() === wanted
            )),
          }))
          .filter((entry) => entry.operators.length > 0);
        setCatalog(groups);
      }).catch(() => {});
  }, [link.currency]);
  const countryEntry = catalog.find((c) => c.country === country);
  const operators = countryEntry?.operators || [];
  const selectedOp = operators.find((o) => o.code === operator);
  const paymentFlow = selectedOp?.payment_flow || {};
  const flowNeedsOtp = Boolean(paymentFlow.before_submit && paymentFlow.otp_required);
  const addressRequired = Boolean(paymentFlow.address_required);
  const baseAmount = Number(amount) || 0;
  const currency = selectedOp?.currency || 'XOF';
  const {
    totalFee,
    totalToPay,
    creditedAmount,
  } = mobileMoneyFeePreview(baseAmount, selectedOp, feeBearer);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!country || !operator || !phone.trim() || !email.trim() || !fullName.trim()
        || (addressRequired && !address.trim()) || (isFree && !amount)) {
      setError('Tous les champs sont obligatoires'); return;
    }
    if (!turnstile.enabled || !turnstileToken) {
      setError('Veuillez terminer la vérification anti-bot'); return;
    }
    if (flowNeedsOtp && !otp.trim()) {
      setError(`Saisissez ${paymentFlow.otp_label || 'le code de paiement'} avant de continuer.`);
      return;
    }
    const fingerprint = JSON.stringify([
      link.id, isFree ? Number(amount) : Number(link.amount),
      country, operator, phone.trim(), email.trim().toLowerCase(), fullName.trim(),
      addressRequired ? address.trim() : '',
    ]);
    if (!idempotencyRef.current.key || idempotencyRef.current.fingerprint !== fingerprint) {
      idempotencyRef.current = {
        fingerprint,
        key: window.crypto?.randomUUID?.()
          || `link-momo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      };
    }
    setLoading(true);
    try {
      const endpoint = `${process.env.REACT_APP_BACKEND_URL || ''}/api/links/pay/mobile-money`;
      const makeBody = (bearer) => ({
          slug: link.slug,
          amount: isFree ? parseFloat(amount) : undefined,
          full_name: fullName.trim(), email: email.trim(),
           country, operator, phone_number: phone.trim(), fee_bearer: bearer,
           ...(addressRequired ? { address: address.trim() } : {}),
           turnstile_token: turnstileToken,
            idempotency_key: idempotencyRef.current.key,
           ...(otp.trim() ? { otp: otp.trim() } : {}),
         });
      // Newer backends accept client|merchant. Retry the pre-validation
      // request with the historical sender|receiver values when an older
      // schema rejects those literals (no invoice is created on 422).
      let res = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody(feeBearer)),
      });
      let data = await res.json();
      if (!res.ok && res.status === 422) {
        const legacyBearer = feeBearer === 'client' ? 'sender' : 'receiver';
        res = await fetch(endpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(makeBody(legacyBearer)),
        });
        data = await res.json();
      }
       if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Erreur');
      const redirectUrl = data.redirect_url || data.checkout_url;
      if (data.payment_kind === 'redirect' || redirectUrl) {
        if (!redirectUrl) throw new Error('Le lien de paiement n’a pas pu être préparé. Veuillez réessayer.');
        window.location.assign(redirectUrl);
        return;
      }
      onSuccess({ ...data, fee_bearer: feeBearer });
    } catch (err) {
      setTurnstileToken('');
       turnstileRef.current?.reset();
      setError(err.message || 'Erreur');
    }
    finally { setLoading(false); }
  };

  return (
    <form onSubmit={submit} className="mt-4 space-y-3" data-testid="momo-link-form">
      <Field label="Nom complet">
        <input value={fullName} onChange={(e) => setFullName(e.target.value)} required
          className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm outline-none focus:border-[#2563EB]" />
      </Field>
      <Field label="Email">
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required
          className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm outline-none focus:border-[#2563EB]" />
      </Field>
      {addressRequired && (
        <Field label={paymentFlow.address_label || 'Ville ou adresse du client'}>
          <input type="text" value={address} onChange={(e) => setAddress(e.target.value)}
            required maxLength={180} data-testid="pay-momo-address"
            className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm outline-none focus:border-[#2563EB]" />
        </Field>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Field label="Pays">
          <select value={country} onChange={(e) => { setCountry(e.target.value); setOperator(''); setOtp(''); setAddress(''); }}
            required tabIndex="-1" aria-hidden="true" className="sr-only">
            <option value="">Sélectionnez un pays</option>
            {catalog.map((c) => <option key={c.country} value={c.country}>{c.country_label}</option>)}
          </select>
          <SelectionMenu
            label="Sélectionner le pays"
            value={country}
            onChange={(value) => { setCountry(value); setOperator(''); setOtp(''); setAddress(''); }}
            placeholder="Sélectionner"
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
        </Field>
        <Field label="Opérateur">
          <select value={operator} onChange={(e) => { setOperator(e.target.value); setOtp(''); setAddress(''); }}
            disabled={!country} required tabIndex="-1" aria-hidden="true" className="sr-only">
            <option value="">Sélectionnez un opérateur</option>
            {operators.map((o) => <option key={o.code} value={o.code}>{o.name}</option>)}
          </select>
          <SelectionMenu
            label="Sélectionner l’opérateur"
            value={operator}
            onChange={(value) => { setOperator(value); setOtp(''); setAddress(''); }}
            placeholder={country ? 'Sélectionner' : 'Choisissez un pays'}
            disabled={!country}
            options={operators.map((o) => ({
              value: o.code,
              label: o.name || o.label || o.code,
              operator: o,
            }))}
            renderValue={(option) => (
              <span className="inline-flex min-w-0 items-center gap-2">
                <OperatorLogo operator={option.operator.code} name={option.label} country={country} size="sm" />
                <span className="truncate">{option.label}</span>
              </span>
            )}
            renderOption={(option) => (
              <span className="inline-flex min-w-0 items-center gap-2.5">
                <OperatorLogo operator={option.operator.code} name={option.label} country={country} size="sm" />
                <span className="truncate">{option.label}</span>
              </span>
            )}
          />
        </Field>
      </div>
      <Field label="Numéro Mobile Money">
        <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="ex: 97000001" required
          className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm outline-none focus:border-[#2563EB]" />
      </Field>
      {isFree && (
        <Field label={`Montant (${selectedOp?.currency || 'XOF'})`}>
          <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} required
            min={Math.max(Number(link.min_amount || 0), Number(selectedOp?.min || 100))}
            max={Math.min(
              Number(link.max_amount || Number.MAX_SAFE_INTEGER),
              Number(selectedOp?.max || Number.MAX_SAFE_INTEGER),
            )}
            className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm outline-none focus:border-[#2563EB]" />
        </Field>
      )}
      {selectedOp && amount && (
        <div className="rounded-xl bg-slate-50 border border-slate-100 p-2.5 text-[11px] text-slate-600">
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
             <span>Frais de paiement</span>
             <b className="text-right">{totalFee.toLocaleString(undefined, { maximumFractionDigits: 2 })} {currency}</b>
            <span className="border-t border-slate-200 pt-1 font-bold">Total des frais</span>
            <b className="border-t border-slate-200 pt-1 text-right text-red-600">{totalFee.toLocaleString(undefined, { maximumFractionDigits: 2 })} {currency}</b>
            <span className="font-semibold">Total à payer</span>
            <b className="text-right text-slate-900">{totalToPay.toLocaleString(undefined, { maximumFractionDigits: 2 })} {currency}</b>
            <span className="font-semibold">Montant crédité</span>
            <b className="text-right text-emerald-700">{creditedAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} {currency}</b>
          </div>
        </div>
      )}
      <div className="p-2.5 rounded-xl bg-blue-50 border border-blue-100 text-[11px] text-blue-800">
        {feeBearer === 'client'
          ? 'Les frais sont ajoutés au montant payé. Le marchand reçoit le montant demandé.'
          : 'Les frais sont déduits du paiement. Le marchand reçoit le montant net.'}
      </div>
      <PaymentFlowCard flow={paymentFlow} amount={totalToPay} currency={currency} />
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
            data-testid="pay-momo-otp"
            className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm font-mono tracking-widest"
          />
          <p className="mt-1 text-[10px] text-slate-500">Collez ou tapez exactement le code affiché par votre opérateur.</p>
        </Field>
      )}
      <TurnstileWidget
        ref={turnstileRef}
        siteKey={turnstile.siteKey}
        action="payment"
        disabled={turnstile.loading || !turnstile.enabled}
        onToken={setTurnstileToken}
      />
      {error && <div className="p-2 rounded-lg bg-red-50 text-red-700 text-[11px]">{error}</div>}
      <button type="submit"
        disabled={loading || !turnstile.enabled || !turnstileToken || (flowNeedsOtp && !otp.trim())}
        data-testid="momo-link-submit"
        className="w-full bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold text-sm py-2.5 rounded-full disabled:opacity-50 flex items-center justify-center gap-2">
        {loading ? <><Loader2 className="w-4 h-4 animate-spin" /> Envoi…</> : <>Payer maintenant <ArrowRight className="w-4 h-4" /></>}
      </button>
    </form>
  );
}

export function MoMoLinkTracker({ payment }) {
  const [p, setP] = useState(payment);
  const [otp, setOtp] = useState('');
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState('');
  const expiryCheckRef = useRef(null);
  const [remainingSeconds, setRemainingSeconds] = useState(() => {
    const expiry = new Date(payment.pending_expires_at || (
      new Date(new Date(payment.created_at || Date.now()).getTime() + MOMO_PENDING_SECONDS * 1000)
    )).getTime();
    return Math.max(0, Math.ceil((expiry - Date.now()) / 1000));
  });
  useEffect(() => {
    if (p.status !== 'pending') return;
    const iv = setInterval(async () => {
      try {
        const res = await fetch(`${process.env.REACT_APP_BACKEND_URL || ''}/api/links/payments/${p.id}`);
        const d = await res.json();
        setP((current) => ({
          ...current,
          ...d,
          ...(d.finalize_capability === undefined && current.finalize_capability
            ? { finalize_capability: current.finalize_capability }
            : {}),
        }));
        if (d.status !== 'pending') clearInterval(iv);
      } catch { /* poll silently */ }
    }, 4000);
    return () => clearInterval(iv);
  }, [p.id, p.status]);

  useEffect(() => {
    if (p.status !== 'pending') return undefined;
    const expiry = new Date(p.pending_expires_at || (
      new Date(new Date(p.created_at || Date.now()).getTime() + MOMO_PENDING_SECONDS * 1000)
    )).getTime();
    const tick = () => setRemainingSeconds(Math.max(0, Math.ceil((expiry - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [p.created_at, p.pending_expires_at, p.status]);

  useEffect(() => {
    if (p.status !== 'pending' || remainingSeconds > 0) return undefined;
    if (expiryCheckRef.current === p.id) return undefined;
    expiryCheckRef.current = p.id;
    let active = true;
    fetch(`${process.env.REACT_APP_BACKEND_URL || ''}/api/links/payments/${p.id}`)
      .then((res) => res.json())
      .then((data) => {
        if (active) {
          setP((current) => ({
            ...current,
            ...data,
            ...(data.status === 'pending'
              ? { status: 'failed', failed_reason: 'expired' }
              : {}),
          }));
        }
      })
      .catch(() => {
        if (active) {
          setP((current) => current.status === 'pending'
            ? { ...current, status: 'failed' }
            : current);
        }
      });
    return () => { active = false; };
  }, [p.id, p.status, remainingSeconds]);

  const ok = p.status === 'paid';
  const failed = p.status === 'failed' || p.status === 'expired';
  const pending = !ok && !failed;
  const flow = p.payment_flow || {};
  const checkoutRedirectUrl = pending && p.redirect_url ? p.redirect_url : '';
  const needsPostInitOtp = pending && (p.auth_mode === 'pin' || (p.otp_required && !flow.before_submit));
  const instructionValue = (!p.submission_unknown && flow.instructions)
    || p.instructions || p.payment_instructions || p.pending_instructions;
  const instructions = Array.isArray(instructionValue)
    ? instructionValue.join(' ')
    : (typeof instructionValue === 'string' && instructionValue.trim()
      ? instructionValue
      : `Ouvrez la notification ou l’application Mobile Money sur ${p.customer_phone || 'votre téléphone'} et confirmez le paiement.`);
  const finalize = async () => {
    if (!otp.trim()) {
      setFinalizeError('Saisissez le code demandé pour continuer.');
      return;
    }
    setFinalizing(true);
    setFinalizeError('');
    try {
      const res = await fetch(`${process.env.REACT_APP_BACKEND_URL || ''}/api/links/payments/${p.id}/mobile-money/finalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          otp: otp.trim(),
          ...(p.finalize_capability ? { finalize_capability: p.finalize_capability } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Le code n’a pas pu être validé.');
      setP((current) => {
        const next = { ...current, ...data };
        delete next.finalize_capability;
        return next;
      });
      setOtp('');
    } catch (error) {
      setFinalizeError(error.message || 'Le code n’a pas pu être validé. Vérifiez-le puis réessayez.');
    } finally {
      setFinalizing(false);
    }
  };
  return (
    <div className="mt-4 text-center space-y-3" data-testid="momo-link-tracker">
      {pending && <div className="mx-auto w-14 h-14 rounded-full bg-amber-50 flex items-center justify-center"><Clock className="w-6 h-6 text-amber-500 animate-pulse" /></div>}
      {ok && <div className="mx-auto w-14 h-14 rounded-full bg-emerald-50 flex items-center justify-center"><CheckCircle2 className="w-6 h-6 text-emerald-500" /></div>}
      {failed && <div className="mx-auto w-14 h-14 rounded-full bg-red-50 flex items-center justify-center"><XCircle className="w-6 h-6 text-red-500" /></div>}
      <h2 className="font-cabinet text-base font-extrabold text-slate-900">
        {pending && (flow.kind === 'ussd_confirmation' && !p.submission_unknown
          ? 'Confirmez avec le code USSD' : 'Vérifiez votre téléphone')}
        {ok && 'Paiement effectué avec succès'}
        {failed && 'Paiement échoué'}
      </h2>
      <p className="text-xs text-slate-500 leading-relaxed">
         {pending && instructions}
        {ok && `Merci ! Le paiement a été confirmé.`}
        {failed && `La transaction a été refusée ou a expiré.`}
      </p>
      {pending && <PaymentFlowCard flow={flow} amount={p.amount_to_pay || p.charged_amount || p.amount} currency={p.currency} />}
      {checkoutRedirectUrl && (
        <button
          type="button"
          onClick={() => window.location.assign(checkoutRedirectUrl)}
          data-testid="momo-link-provider-redirect"
          className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#2563EB] px-3 py-2 text-xs font-bold text-white"
        >
          Continuer le paiement sécurisé <ArrowRight className="h-3 w-3" />
        </button>
      )}
      {pending && (
        <div className="rounded-xl border border-blue-100 bg-blue-50 p-3 text-left text-[11px] text-blue-800">
          <strong className="block text-blue-950">
            {remainingSeconds > 0
              ? `Vérification en cours — ${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, '0')}`
              : 'Le délai initial est écoulé — vérification toujours en cours'}
          </strong>
          <span>Le statut est vérifié automatiquement. Ne fermez pas cette page.</span>
        </div>
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
              data-testid="pay-tracker-otp"
              className="min-w-0 flex-1 rounded-lg border border-blue-200 bg-white px-3 py-2 text-xs font-mono tracking-widest outline-none focus:border-blue-500"
            />
            <button type="button" onClick={finalize} disabled={finalizing || !otp.trim()} data-testid="pay-finalize"
              className="shrink-0 inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#2563EB] px-3 py-2 text-xs font-bold text-white disabled:opacity-50">
              {finalizing
                ? <><span aria-hidden="true" className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />Vérification…</>
                : 'Valider'}
            </button>
          </div>
          {finalizing && (
            <p role="status" className="text-[10px] text-blue-700">
              Vérification sécurisée auprès du prestataire…
            </p>
          )}
          {finalizeError && <p className="text-[11px] font-semibold text-red-700">{finalizeError}</p>}
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
  if (!steps.length && !ussd && !flow?.otp_required) return null;
  const copyUssd = () => {
    if (navigator.clipboard && ussd) {
      navigator.clipboard.writeText(String(ussd));
      toast.success('Code USSD copié');
    }
  };
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-left space-y-2" data-testid="pay-payment-flow">
      <div className="text-xs font-bold text-amber-900">Comment confirmer votre paiement</div>
      {steps.length > 0 && (
        <ol className="list-decimal space-y-1 pl-5 text-[11px] leading-relaxed text-amber-900">
          {steps.map((step, index) => <li key={`${step}-${index}`}>{replaceAmount(step)}</li>)}
        </ol>
      )}
      {flow?.otp_required && (
        <div className="rounded-lg border border-amber-200 bg-white px-3 py-2 text-[11px]" data-testid="pay-otp-amount">
          <span className="text-slate-600">Montant à confirmer avec le code</span>
          <strong className="ml-2 text-slate-900">{amountText} {currency}</strong>
          <p className="mt-1 text-[10px] text-slate-500">Le montant tient compte des frais selon le choix indiqué ci-dessus.</p>
        </div>
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
