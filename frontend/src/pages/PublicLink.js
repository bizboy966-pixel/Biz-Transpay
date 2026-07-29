import { useEffect, useState, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { Link2, ShieldCheck, Bitcoin, ArrowRight, ArrowLeft, Copy, CheckCircle2, XCircle, Clock, Loader2, CreditCard, Smartphone } from 'lucide-react';
import { QRCodeCanvas } from 'qrcode.react';
import { toast } from 'sonner';
import api from '@/api';
import { Logo } from '@/components/Logo';

export default function PublicLink() {
  const { slug } = useParams();
  const [link, setLink] = useState(null);
  const [err, setErr] = useState(null);
  const [step, setStep] = useState(1);
  const [method, setMethod] = useState(null);
  const [payment, setPayment] = useState(null);

  useEffect(() => {
    api.get(`/links/public/${slug}`).then(({ data }) => setLink(data)).catch(() => setErr('Lien introuvable ou expiré'));
  }, [slug]);

  if (err) return <div className="min-h-screen flex items-center justify-center text-slate-600">{err}</div>;
  if (!link) return <div className="min-h-screen flex items-center justify-center">Chargement…</div>;

  return (
    <div className="min-h-screen bg-gradient-to-b from-white to-slate-50 flex flex-col" data-testid="public-link-page">
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-4xl mx-auto px-4 h-14 flex items-center"><Logo /></div>
      </header>

      <main className="flex-1 flex items-center justify-center p-4 sm:p-6">
        <div className="max-w-md w-full">
          <div className="mb-3 flex items-center justify-between">
            <button onClick={() => step > 1 && setStep(step - 1)} disabled={step === 1} className="inline-flex items-center gap-1.5 text-[11px] sm:text-xs font-semibold text-slate-600 disabled:opacity-40" data-testid="btn-back-pay">
              <ArrowLeft className="w-3.5 h-3.5" /> Retour
            </button>
            <div className="flex items-center gap-1">
              {[1, 2, 3].map((s) => (
                <div key={s} className={`w-6 h-1 rounded-full ${step >= s ? 'bg-[#2563EB]' : 'bg-slate-200'}`} />
              ))}
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-100 shadow-xl p-4 sm:p-6">
            {/* Header - merchant info */}
            <div className="text-center">
              {link.logo ? (
                <img src={link.logo} alt={link.title} className="mx-auto w-12 h-12 sm:w-14 sm:h-14 rounded-2xl object-cover border border-slate-100" />
              ) : (
                <div className="mx-auto w-10 h-10 sm:w-12 sm:h-12 rounded-2xl bg-blue-50 flex items-center justify-center">
                  <Link2 className="w-4 h-4 sm:w-5 sm:h-5 text-[#2563EB]" />
                </div>
              )}
              <div className="mt-2 text-[9px] sm:text-[10px] uppercase tracking-widest text-slate-500 font-bold">Paiement à</div>
              <div className="font-cabinet font-extrabold text-base sm:text-lg text-slate-900 mt-0.5">{link.merchant?.full_name}</div>
              <div className="text-[10px] sm:text-[11px] text-slate-500">@{link.merchant?.username}</div>
            </div>

            {step === 1 && (
              <div className="mt-4 space-y-2">
                <div className="text-xs sm:text-sm font-semibold text-slate-700 mb-2">Choisissez le moyen de paiement</div>
                <MethodBtn testId="pay-method-crypto" I={Bitcoin} c="bg-orange-50 text-orange-600" title="Crypto" sub={link.currency === 'USDT' ? 'USDT · USDC · BTC · ETH' : 'Ce lien n\'accepte pas les paiements crypto'} onClick={() => { setMethod('crypto'); setStep(2); }} disabled={link.currency !== 'USDT'} />
                <MethodBtn testId="pay-method-mm" I={Smartphone} c="bg-emerald-50 text-emerald-500" title="Mobile Money" sub="Bientôt disponible" disabled />
                <MethodBtn testId="pay-method-card" I={CreditCard} c="bg-blue-50 text-[#2563EB]" title="Carte bancaire" sub="Bientôt disponible" disabled />
              </div>
            )}

            {step === 2 && method === 'crypto' && (
              <CryptoLinkForm link={link} onSuccess={(p) => { setPayment(p); setStep(3); }} />
            )}

            {step === 3 && payment && (
              <CryptoLinkTracker payment={payment} link={link} />
            )}
          </div>

          <div className="mt-4 flex items-center justify-center gap-2 text-[10px] sm:text-[11px] text-slate-500">
            <ShieldCheck className="w-3 h-3 text-emerald-500" /> Paiement sécurisé · IzichangePay + Biz-transPay
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

function CryptoLinkForm({ link, onSuccess }) {
  const isFree = link.amount_type === 'free';
  const [assets, setAssets] = useState([]);
  const [assetCode, setAssetCode] = useState('USDT.TRC20');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [refundAddress, setRefundAddress] = useState('');
  const [amount, setAmount] = useState(isFree ? String(link.min_amount || '') : String(link.amount));
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.get('/crypto/assets').then(({ data }) => setAssets(data)).catch(() => {});
  }, []);

  const asset = assets.find((a) => a.asset_code === assetCode);
  const amt = parseFloat(amount) || 0;
  const belowMin = isFree && amt < (link.min_amount || 0);
  const aboveMax = isFree && amt > (link.max_amount || 0);
  const canSubmit = fullName && email && refundAddress && amt > 0 && !belowMin && !aboveMax && !loading;

  const submit = async (e) => {
    e.preventDefault();
    if (!canSubmit) { toast.error('Merci de remplir tous les champs (dont l\'adresse de remboursement).'); return; }
    setLoading(true);
    try {
      const { data } = await api.post('/links/pay', {
        slug: link.slug, amount: isFree ? amt : undefined,
        asset_code: assetCode, full_name: fullName, email,
        refund_address: refundAddress.trim(), origin_url: window.location.origin,
      });
      onSuccess(data);
    } catch (err) {
      const detail = err.response?.data?.detail;
      toast.error(typeof detail === 'string' ? detail : 'Erreur lors du paiement');
    } finally { setLoading(false); }
  };

  const groupedCoins = Array.from(new Set(assets.map((a) => a.coin))).sort();
  const netsFor = (c) => assets.filter((a) => a.coin === c);

  return (
    <form onSubmit={submit} className="mt-4 space-y-3">
      <div className="rounded-xl bg-gradient-to-br from-[#3B82F6] to-[#1D4ED8] p-3 sm:p-4 text-white">
        <div className="text-[9px] sm:text-[10px] uppercase tracking-widest opacity-80">{link.title}</div>
        {isFree ? (
          <>
            <input data-testid="pay-amount" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} min={link.min_amount} max={link.max_amount} className="w-full bg-white/15 rounded-lg px-3 py-2 mt-1 text-lg sm:text-xl font-cabinet font-extrabold outline-none placeholder:text-white/50" />
            <div className="mt-1 text-[9px] sm:text-[10px] opacity-80">{link.min_amount} – {link.max_amount} {link.currency}</div>
          </>
        ) : (
          <div className="font-cabinet text-xl sm:text-2xl font-extrabold mt-1">{Number(link.amount).toLocaleString(undefined, { maximumFractionDigits: link.currency === 'USDT' ? 6 : 0 })} <span className="text-xs sm:text-sm opacity-80">{link.currency}</span></div>
        )}
        {link.description && <div className="mt-1 text-[10px] sm:text-[11px] opacity-80">{link.description}</div>}
      </div>

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
        if (['paid', 'expired', 'failed'].includes(data.status)) stopRef.current = true;
      } catch {/* ignore */}
    };
    poll();
    const iv = setInterval(poll, 4000);
    return () => { clearInterval(iv); stopRef.current = true; };
  }, [payment.id]);

  const isDone = status === 'paid';
  const isFailed = ['expired', 'failed', 'rejected'].includes(status);
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
        ⚠️ Envoyez uniquement <b>{payment.coin}</b> sur <b>{payment.network}</b>. Toute autre crypto ou réseau = fonds perdus.
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
