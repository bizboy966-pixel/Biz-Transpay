import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, CreditCard, Bitcoin, Smartphone, ShieldCheck, Copy, CheckCircle2, Clock, XCircle, Loader2, ExternalLink } from 'lucide-react';
import { QRCodeCanvas } from 'qrcode.react';
import { toast } from 'sonner';
import api from '@/api';
import { useAuth } from '@/context/AuthContext';

export default function Deposit() {
  const nav = useNavigate();
  const [step, setStep] = useState(1);
  const [method, setMethod] = useState(null);
  const [deposit, setDeposit] = useState(null);

  return (
    <div className="max-w-2xl mx-auto space-y-4 sm:space-y-5" data-testid="page-deposit">
      <button onClick={() => step > 1 ? setStep(step - 1) : nav('/dashboard')} className="inline-flex items-center gap-2 text-[11px] sm:text-xs font-semibold text-slate-600 hover:text-[#2563EB]" data-testid="btn-back-deposit">
        <ArrowLeft className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> Retour
      </button>

      <div>
        <h1 className="font-cabinet text-xl sm:text-2xl md:text-3xl font-extrabold tracking-tighter text-slate-900">Nouveau dépôt</h1>
        <p className="text-slate-500 text-xs sm:text-sm mt-1">Choisissez votre méthode de paiement.</p>
      </div>

      <div className="flex items-center gap-1.5 sm:gap-2">
        {[1, 2, 3].map((s) => (
          <div key={s} className={`flex-1 h-1 rounded-full ${step >= s ? 'bg-[#2563EB]' : 'bg-slate-200'}`} />
        ))}
      </div>

      {step === 1 && (
        <MethodPicker onPick={(m) => { setMethod(m); setStep(2); }} />
      )}
      {step === 2 && method === 'crypto' && <CryptoDepositForm onSuccess={(d) => { setDeposit(d); setStep(3); }} />}
      {step === 2 && method === 'card' && <CardDepositForm />}
      {step === 2 && method === 'mobile_money' && <SoonMobileMoney />}
      {step === 3 && deposit && <CryptoDepositTracker deposit={deposit} />}
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

function MethodPicker({ onPick }) {
  const methods = [
    { key: 'crypto', I: Bitcoin, c: 'bg-orange-50 text-orange-600', l: 'Crypto', d: 'USDT · USDC · BTC · ETH — Multi-réseaux' },
    { key: 'mobile_money', I: Smartphone, c: 'bg-emerald-50 text-emerald-600', l: 'Mobile Money', d: 'Orange, MTN, Moov, Wave…' },
    { key: 'card', I: CreditCard, c: 'bg-blue-50 text-[#2563EB]', l: 'Carte bancaire', d: 'Visa · Mastercard' },
  ];
  return (
    <div className="space-y-2.5 sm:space-y-3">
      {methods.map((m) => (
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
  const [fullName, setFullName] = useState(user?.full_name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [refundAddress, setRefundAddress] = useState('');
  const [assetCode, setAssetCode] = useState('USDT.TRC20');
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.get('/crypto/assets').then(({ data }) => {
      setAssets(data);
      const usdtTrc = data.find((a) => a.asset_code === 'USDT.TRC20') || data[0];
      if (usdtTrc) setAssetCode(usdtTrc.asset_code);
    }).catch(() => {});
  }, []);

  const asset = assets.find((a) => a.asset_code === assetCode);
  const amt = parseFloat(amount) || 0;
  const canSubmit = fullName && email && refundAddress && asset && amt >= 1 && !loading;

  const submit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    try {
      const { data } = await api.post('/deposits/crypto', {
        amount: amt, asset_code: assetCode, full_name: fullName, email,
        refund_address: refundAddress.trim(), origin_url: window.location.origin,
      });
      onSuccess(data);
    } catch (err) {
      const detail = err.response?.data?.detail;
      toast.error(typeof detail === 'string' ? detail : 'Erreur lors de la création du dépôt');
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
        <div className="text-[11px] sm:text-xs text-slate-700"><b>Dépôt crypto instantané.</b> Votre solde USDT est crédité dès la confirmation on-chain (généralement quelques minutes).</div>
      </div>

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

      <Field label={`Montant (${asset?.coin || 'USDT'})`}>
        <input data-testid="dep-amount" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="10" min="1" required className="w-full px-3 sm:px-4 py-2.5 sm:py-3 border border-slate-200 rounded-xl outline-none focus:border-orange-500 text-xs sm:text-sm" />
        <div className="mt-1 text-[10px] sm:text-xs text-slate-500">Minimum : 1 {asset?.coin || 'USDT'}</div>
      </Field>

      <button type="submit" disabled={!canSubmit} data-testid="btn-dep-submit" className="w-full bg-orange-500 hover:bg-orange-600 text-white font-bold py-3 sm:py-3.5 rounded-xl text-xs sm:text-sm disabled:opacity-50 inline-flex items-center justify-center gap-2">
        {loading ? <><Loader2 className="w-4 h-4 animate-spin" /> Génération…</> : <>Payer maintenant <ArrowRight className="w-4 h-4" /></>}
      </button>
    </form>
  );
}

function CryptoDepositTracker({ deposit }) {
  const nav = useNavigate();
  const { refresh } = useAuth();
  const [status, setStatus] = useState(deposit?.status || 'pending');
  const [tick, setTick] = useState(0);
  const stopRef = useRef(false);

  useEffect(() => {
    if (!deposit) return;
    const poll = async () => {
      if (stopRef.current) return;
      try {
        const { data } = await api.get(`/deposits/crypto/${deposit.id}`);
        setStatus(data.status);
        if (['confirmed', 'expired', 'failed'].includes(data.status)) {
          stopRef.current = true;
          if (data.status === 'confirmed') { refresh(); }
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
          <p className="mt-1 text-xs sm:text-sm text-slate-500">{deposit.amount} {deposit.coin} ont été crédités sur votre portefeuille.</p>
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
            ⚠️ Envoyez uniquement <b>{deposit.coin}</b> sur le réseau <b>{deposit.network}</b>. Envoyer une autre cryptomonnaie ou un autre réseau entraîne la perte définitive des fonds.
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

function CardDepositForm() {
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('XOF');
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const amt = parseFloat(amount);
    if (!amt || amt < 300) { toast.error('Montant minimum 300 XOF/XAF'); return; }
    setLoading(true);
    try {
      const { data } = await api.post('/deposits/checkout', {
        amount: amt, currency, origin_url: window.location.origin,
      });
      window.location.href = data.checkout_url;
    } catch (err) { toast.error(err.response?.data?.detail || 'Erreur'); setLoading(false); }
  };

  return (
    <form onSubmit={submit} className="bg-white border border-slate-100 rounded-2xl p-4 sm:p-6 space-y-3 sm:space-y-4">
      <div className="grid grid-cols-[1fr_auto] gap-2 sm:gap-3">
        <div>
          <label className="text-xs font-semibold text-slate-700 mb-1 block">Montant</label>
          <input data-testid="card-amount" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="10000" min="300" required className="w-full px-3 sm:px-4 py-2.5 sm:py-3 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-xs sm:text-sm" />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-700 mb-1 block">Devise</label>
          <select value={currency} onChange={(e) => setCurrency(e.target.value)} className="px-3 py-2.5 sm:py-3 border border-slate-200 rounded-xl font-semibold text-xs sm:text-sm">
            <option value="XOF">XOF</option><option value="XAF">XAF</option>
          </select>
        </div>
      </div>
      <button type="submit" disabled={loading} data-testid="btn-card-submit" className="w-full bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold py-3 sm:py-3.5 rounded-xl text-xs sm:text-sm disabled:opacity-60 inline-flex items-center justify-center gap-2">
        {loading ? 'Redirection…' : <>Continuer avec Stripe <ExternalLink className="w-4 h-4" /></>}
      </button>
    </form>
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
