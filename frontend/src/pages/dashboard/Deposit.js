import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Bitcoin, Smartphone, ShieldCheck, Copy, CheckCircle2, Clock, XCircle, Loader2, ExternalLink } from 'lucide-react';
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
      {step === 2 && method === 'mobile_money' && <MobileMoneyForm onSuccess={(d) => { setDeposit({ ...d, __momo: true }); setStep(3); }} />}
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

function MethodPicker({ onPick }) {
  const methods = [
    { key: 'crypto', I: Bitcoin, c: 'bg-orange-50 text-orange-600', l: 'Crypto', d: 'USDT · USDC · BTC · ETH — Multi-réseaux' },
    { key: 'mobile_money', I: Smartphone, c: 'bg-emerald-50 text-emerald-600', l: 'Mobile Money', d: 'Orange, MTN, Moov, Wave…' },
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
          {deposit.amount_net != null ? (
            <div className="mt-3 mx-auto max-w-xs bg-slate-50 rounded-xl p-3 text-left text-[11px] sm:text-xs space-y-1">
              <div className="flex justify-between"><span className="text-slate-500">Reçu (brut)</span><span className="font-semibold">{Number(deposit.amount_gross ?? deposit.amount).toLocaleString(undefined,{maximumFractionDigits:6})} {deposit.coin}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Frais ({deposit.fee_pct ?? '-'}%)</span><span className="font-semibold text-red-600">−{Number(deposit.fee || 0).toLocaleString(undefined,{maximumFractionDigits:6})} {deposit.coin}</span></div>
              <div className="flex justify-between border-t border-slate-200 pt-1 mt-1"><span className="text-slate-700 font-bold">Crédité (net)</span><span className="font-cabinet font-extrabold text-emerald-600">{Number(deposit.amount_net).toLocaleString(undefined,{maximumFractionDigits:6})} {deposit.coin}</span></div>
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
  const [country, setCountry] = useState('');
  const [operator, setOperator] = useState('');
  const [phone, setPhone] = useState('');
  const [amount, setAmount] = useState('');
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [feeBearer, setFeeBearer] = useState('sender');
  const [loading, setLoading] = useState(false);
  const { user } = useAuth();

  useEffect(() => {
    api.get('/deposits/config').then(({ data }) => {
      setCatalog(data.catalog || []);
    }).catch(() => {});
    if (user?.email) setEmail(user.email);
    if (user?.full_name) setFullName(user.full_name);
  }, [user]);

  const countryEntry = catalog.find((c) => c.country === country);
  const operators = countryEntry?.operators || [];
  const selectedOp = operators.find((o) => o.code === operator);
  const previewFee = selectedOp && amount ? (parseFloat(amount) * (selectedOp.fee_pct || 0) / 100) : 0;
  const previewNet = amount ? Math.max(parseFloat(amount) - previewFee, 0) : 0;

  const submit = async (e) => {
    e.preventDefault();
    if (!country || !operator || !phone.trim() || !amount || !email.trim() || !fullName.trim()) {
      toast.error('Tous les champs sont obligatoires');
      return;
    }
    if (parseInt(amount) < (selectedOp?.min || 100)) {
      toast.error(`Montant minimum : ${selectedOp?.min || 100} ${selectedOp?.currency || 'XOF'}`);
      return;
    }
    if (selectedOp?.max && parseInt(amount) > selectedOp.max) {
      toast.error(`Montant maximum : ${selectedOp.max} ${selectedOp.currency || 'XOF'}`);
      return;
    }
    setLoading(true);
    try {
      const { data } = await api.post('/deposits/mobile-money', {
        amount: parseInt(amount),
        currency: selectedOp?.currency || 'XOF',
        email: email.trim(),
        full_name: fullName.trim(),
        country,
        operator,
        phone_number: phone.trim(),
        fee_bearer: feeBearer,
      });
      toast.success(data.message || 'Vérifiez votre téléphone');
      onSuccess(data);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Erreur lors du dépôt');
    } finally { setLoading(false); }
  };

  return (
    <form onSubmit={submit} className="bg-white border border-slate-100 rounded-2xl p-4 sm:p-6 space-y-4" data-testid="momo-deposit-form">
      <div>
        <label className="block text-xs font-semibold text-slate-700 mb-1.5">Nom complet</label>
        <input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} data-testid="momo-fullname" required
          className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm" />
      </div>
      <div>
        <label className="block text-xs font-semibold text-slate-700 mb-1.5">Adresse e-mail</label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="momo-email" required
          className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1.5">Pays</label>
          <select value={country} onChange={(e) => { setCountry(e.target.value); setOperator(''); }} data-testid="momo-country" required
            className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm bg-white">
            <option value="">— Sélectionnez —</option>
            {catalog.map((c) => <option key={c.country} value={c.country}>{c.country_label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1.5">Opérateur</label>
          <select value={operator} onChange={(e) => setOperator(e.target.value)} data-testid="momo-operator" required disabled={!country}
            className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm bg-white disabled:bg-slate-50">
            <option value="">— Sélectionnez —</option>
            {operators.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
          </select>
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
            <span>Frais {selectedOp.fee_pct}% :</span>
            <span className="font-mono font-semibold text-slate-900">{previewFee.toLocaleString(undefined, { maximumFractionDigits: 2 })} {selectedOp.currency}</span>
            <span className="text-slate-400">•</span>
            <span>Net crédité :</span>
            <span className="font-mono font-bold text-emerald-700">{previewNet.toLocaleString(undefined, { maximumFractionDigits: 2 })} {selectedOp.currency}</span>
          </div>
        )}
      </div>
      <div>
        <label className="block text-xs font-semibold text-slate-700 mb-1.5">Frais supportés par</label>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={() => setFeeBearer('sender')} data-testid="momo-fee-sender"
            className={`px-3 py-2 rounded-xl border text-xs font-semibold transition-colors ${feeBearer === 'sender' ? 'border-[#2563EB] bg-blue-50 text-[#2563EB]' : 'border-slate-200 text-slate-600'}`}>
            Marchand (vous)
          </button>
          <button type="button" onClick={() => setFeeBearer('receiver')} data-testid="momo-fee-receiver"
            className={`px-3 py-2 rounded-xl border text-xs font-semibold transition-colors ${feeBearer === 'receiver' ? 'border-[#2563EB] bg-blue-50 text-[#2563EB]' : 'border-slate-200 text-slate-600'}`}>
            Client
          </button>
        </div>
      </div>
      <button type="submit" disabled={loading} data-testid="momo-submit"
        className="w-full bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold text-sm py-3 rounded-full disabled:opacity-50 flex items-center justify-center gap-2">
        {loading ? <><Loader2 className="w-4 h-4 animate-spin" /> Envoi…</> : <>Payer maintenant <ArrowRight className="w-4 h-4" /></>}
      </button>
    </form>
  );
}

function MobileMoneyTracker({ deposit }) {
  const [d, setD] = useState(deposit);
  useEffect(() => {
    if (d.status !== 'pending') return;
    const iv = setInterval(async () => {
      try {
        const { data } = await api.get(`/deposits/mobile-money/${d.id}`);
        setD(data);
        if (data.status !== 'pending') clearInterval(iv);
      } catch { /* poll silently */ }
    }, 4000);
    return () => clearInterval(iv);
  }, [d.id, d.status]);

  const ok = d.status === 'approved';
  const failed = d.status === 'failed';
  const pending = !ok && !failed;

  return (
    <div className="bg-white border border-slate-100 rounded-2xl p-6 sm:p-8 text-center space-y-4" data-testid="momo-tracker">
      {pending && <div className="mx-auto w-14 h-14 rounded-full bg-amber-50 flex items-center justify-center"><Clock className="w-6 h-6 text-amber-500 animate-pulse" /></div>}
      {ok && <div className="mx-auto w-14 h-14 rounded-full bg-emerald-50 flex items-center justify-center"><CheckCircle2 className="w-6 h-6 text-emerald-500" /></div>}
      {failed && <div className="mx-auto w-14 h-14 rounded-full bg-red-50 flex items-center justify-center"><XCircle className="w-6 h-6 text-red-500" /></div>}
      <h2 className="font-cabinet text-lg sm:text-xl font-extrabold text-slate-900">
        {pending && 'Vérifiez votre téléphone'}
        {ok && 'Paiement effectué avec succès'}
        {failed && 'Paiement échoué'}
      </h2>
      <p className="text-xs sm:text-sm text-slate-500 max-w-md mx-auto leading-relaxed">
        {pending && `Confirmez le paiement de ${d.amount?.toLocaleString?.() || d.amount} ${d.currency || 'XOF'} sur votre téléphone ${d.phone_number}. Cette page se mettra à jour automatiquement.`}
        {ok && `Votre portefeuille a été crédité de ${d.amount_net?.toLocaleString?.() || d.amount_net || d.amount} ${d.currency || 'XOF'} (net après frais).`}
        {failed && `La transaction a été refusée ou annulée. ${d.failed_reason ? '('+d.failed_reason+')' : ''}`}
      </p>
      {d.checkout_url && pending && (
        <a href={d.checkout_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-xs font-bold text-[#2563EB] hover:underline">
          Ouvrir le lien de paiement <ExternalLink className="w-3.5 h-3.5" />
        </a>
      )}
    </div>
  );
}
