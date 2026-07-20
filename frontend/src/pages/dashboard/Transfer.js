import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Users, Smartphone, Landmark, ArrowLeft, CheckCircle2, Clock, ShieldCheck, AtSign, Phone, Info } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';
import { useAuth } from '@/context/AuthContext';
import { COUNTRIES } from '@/constants/countries';

export default function Transfer() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { refresh, user } = useAuth();
  const [step, setStep] = useState(1);
  const [type, setType] = useState(null);
  const [config, setConfig] = useState(null);
  const [done, setDone] = useState(null);

  useEffect(() => {
    api.get('/transfer/config').then(({ data }) => setConfig(data)).catch(() => {});
  }, []);

  const opts = [
    { v: 'biz_to_biz', I: Users, c: 'bg-blue-50 text-[#2563EB]', l: 'Biz-trans → Biz-trans', d: 'Instantané · Sans frais · Immédiat' },
    { v: 'biz_to_mobile', I: Smartphone, c: 'bg-emerald-50 text-emerald-600', l: 'Biz-trans → Mobile Money', d: 'Vers un numéro Mobile Money' },
    { v: 'biz_to_bank', I: Landmark, c: 'bg-violet-50 text-violet-600', l: 'Biz-trans → Compte bancaire', d: 'Vers un compte bancaire' },
  ];

  const onDone = (data, meta) => {
    setDone({ ...data, meta });
    setStep(3);
    refresh();
  };

  return (
    <div className="max-w-2xl mx-auto space-y-5" data-testid="page-transfer">
      <button onClick={() => step > 1 ? setStep(step - 1) : nav('/dashboard')} className="inline-flex items-center gap-2 text-xs font-semibold text-slate-600 hover:text-[#2563EB]" data-testid="btn-back">
        <ArrowLeft className="w-4 h-4" /> {t('common.back')}
      </button>

      <div>
        <h1 className="font-cabinet text-2xl sm:text-3xl font-extrabold tracking-tighter text-slate-900">Nouveau transfert</h1>
        <p className="text-slate-500 text-sm mt-1">Choisissez le type de transfert que vous souhaitez effectuer.</p>
      </div>

      <div className="flex items-center gap-2">
        {[1, 2, 3].map((s) => (
          <div key={s} className={`flex-1 h-1 rounded-full ${step >= s ? 'bg-[#2563EB]' : 'bg-slate-200'}`} />
        ))}
      </div>

      {step === 1 && (
        <div className="space-y-3">
          {opts.map((o) => (
            <button key={o.v} onClick={() => { setType(o.v); setStep(2); }} data-testid={`transfer-type-${o.v}`} className="w-full bg-white border border-slate-100 rounded-2xl p-4 flex items-center gap-3 hover:border-[#2563EB] hover:-translate-y-0.5 transition-transform text-left">
              <div className={`w-11 h-11 rounded-xl ${o.c} flex items-center justify-center`}><o.I className="w-5 h-5" strokeWidth={1.75} /></div>
              <div className="flex-1">
                <div className="font-cabinet font-bold text-sm text-slate-900">{o.l}</div>
                <div className="text-xs text-slate-500">{o.d}</div>
              </div>
              <ArrowRight className="w-4 h-4 text-slate-400" />
            </button>
          ))}
        </div>
      )}

      {step === 2 && type === 'biz_to_biz' && <BizToBizForm onDone={onDone} onBack={() => setStep(1)} balance={user} />}
      {step === 2 && type === 'biz_to_mobile' && <BizToMobileForm config={config} onDone={onDone} onBack={() => setStep(1)} balance={user} />}
      {step === 2 && type === 'biz_to_bank' && <BizToBankForm config={config} />}

      {step === 3 && done && (
        <div className="bg-white border border-slate-100 rounded-2xl p-8 text-center" data-testid="transfer-success">
          <div className="mx-auto w-14 h-14 rounded-full bg-emerald-50 flex items-center justify-center"><CheckCircle2 className="w-7 h-7 text-emerald-500" /></div>
          <h2 className="mt-4 font-cabinet text-xl font-extrabold text-slate-900">Transfert effectué !</h2>
          <div className="mt-3 font-cabinet text-3xl font-extrabold text-[#2563EB]">
            {done.transaction.amount.toLocaleString()} <span className="text-base text-slate-500">{done.transaction.currency}</span>
          </div>
          <div className="mt-1 text-sm text-slate-500">→ {done.recipient?.full_name || done.transaction.counterparty}</div>
          <div className="mt-1 text-[11px] text-slate-400 font-mono">{done.transaction.reference}</div>
          {done.fee > 0 && (
            <div className="mt-3 text-xs text-slate-500 space-y-0.5">
              <div>Frais : <b>{done.fee.toLocaleString(undefined, { maximumFractionDigits: 0 })} {done.transaction.currency}</b></div>
              {done.recipient_gets != null && <div>Le bénéficiaire reçoit : <b>{done.recipient_gets.toLocaleString(undefined, { maximumFractionDigits: 0 })} {done.transaction.currency}</b></div>}
            </div>
          )}
          <div className="mt-5 flex gap-2 justify-center">
            <button onClick={() => { setStep(1); setDone(null); }} className="px-5 py-2.5 rounded-full border border-slate-200 text-xs font-semibold" data-testid="btn-new-transfer">Nouveau transfert</button>
            <button onClick={() => nav('/dashboard')} data-testid="btn-tr-done" className="bg-[#2563EB] text-white font-bold px-5 py-2.5 rounded-full text-xs">Terminer</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ------- BIZ TO BIZ -------
function BizToBizForm({ onDone, onBack, balance }) {
  const [username, setUsername] = useState('');
  const [phone, setPhone] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('XOF');
  const [description, setDescription] = useState('');
  const [recipient, setRecipient] = useState(null);
  const [lookupErr, setLookupErr] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);

  const lookup = async () => {
    setLookupErr(null); setRecipient(null);
    const q = username.trim() || phone.trim();
    if (!q) return;
    try {
      const { data } = await api.get('/users/lookup', { params: { q } });
      setRecipient(data);
    } catch { setLookupErr('Bénéficiaire Biz-transPay introuvable'); }
  };

  const amt = parseFloat(amount) || 0;
  const bal = currency === 'XOF' ? (balance?.balance_xof || 0) : (balance?.balance_xaf || 0);
  const canSubmit = recipient && amt > 0 && amt <= bal;

  const submit = async () => {
    setPending(true);
    try {
      const { data } = await api.post('/transfers', {
        transfer_type: 'biz_to_biz', recipient: username || phone,
        recipient_phone: phone, amount: amt, currency, description,
      });
      onDone(data, { type: 'biz_to_biz' });
    } catch (err) { toast.error(err.response?.data?.detail || 'Erreur'); }
    finally { setPending(false); }
  };

  return (
    <div className="bg-white border border-slate-100 rounded-2xl p-6 space-y-4">
      <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 flex items-start gap-2.5">
        <ShieldCheck className="w-4 h-4 text-[#2563EB] mt-0.5 shrink-0" />
        <div className="text-xs text-slate-700"><b>Instantané · Sans frais.</b> Le bénéficiaire reçoit immédiatement le montant.</div>
      </div>

      <div>
        <label className="text-xs font-semibold text-slate-700 mb-1.5 block">Nom d'utilisateur du bénéficiaire</label>
        <div className="relative">
          <AtSign className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input data-testid="b2b-username" value={username} onChange={(e) => { setUsername(e.target.value); setRecipient(null); }} onBlur={lookup} placeholder="bizboy" className="w-full pl-9 pr-4 py-3 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm" />
        </div>
      </div>

      <div>
        <label className="text-xs font-semibold text-slate-700 mb-1.5 block">Numéro de téléphone (optionnel)</label>
        <div className="relative">
          <Phone className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input data-testid="b2b-phone" value={phone} onChange={(e) => { setPhone(e.target.value); setRecipient(null); }} onBlur={lookup} placeholder="+228 …" className="w-full pl-9 pr-4 py-3 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm" />
        </div>
      </div>

      {recipient && (
        <div className="p-3 bg-emerald-50 border border-emerald-100 rounded-xl flex items-center gap-3" data-testid="b2b-recipient-preview">
          <div className="w-9 h-9 rounded-full bg-emerald-500 text-white flex items-center justify-center font-bold text-xs">{recipient.full_name?.[0]?.toUpperCase() || 'U'}</div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-slate-900 truncate">{recipient.full_name}</div>
            <div className="text-xs text-emerald-700">Bénéficiaire vérifié · @{recipient.username}</div>
          </div>
          <CheckCircle2 className="w-4 h-4 text-emerald-500" />
        </div>
      )}
      {lookupErr && <div className="text-xs text-red-600">{lookupErr}</div>}

      <div className="grid grid-cols-[1fr_auto] gap-3">
        <div>
          <label className="text-xs font-semibold text-slate-700 mb-1.5 block">Montant</label>
          <input data-testid="b2b-amount" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="10000" min="1" className="w-full px-4 py-3 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm" />
          <div className="mt-1 text-[10px] text-slate-500">Solde : {bal.toLocaleString()} {currency}</div>
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-700 mb-1.5 block">Devise</label>
          <select data-testid="b2b-currency" value={currency} onChange={(e) => setCurrency(e.target.value)} className="px-4 py-3 border border-slate-200 rounded-xl font-semibold text-sm">
            <option value="XOF">XOF</option><option value="XAF">XAF</option>
          </select>
        </div>
      </div>

      <div>
        <label className="text-xs font-semibold text-slate-700 mb-1.5 block">Description (optionnel)</label>
        <input data-testid="b2b-desc" value={description} onChange={(e) => setDescription(e.target.value)} className="w-full px-4 py-3 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm" />
      </div>

      <button disabled={!canSubmit} onClick={() => setConfirmOpen(true)} data-testid="btn-b2b-continue" className="w-full bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold py-3.5 rounded-xl disabled:opacity-50">
        Continuer
      </button>

      {confirmOpen && recipient && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setConfirmOpen(false)}>
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl p-6 max-w-md w-full" data-testid="b2b-confirm-modal">
            <h3 className="font-cabinet font-bold text-lg mb-3">Récapitulatif</h3>
            <div className="space-y-2 text-sm">
              <Row l="Bénéficiaire" v={`${recipient.full_name} (@${recipient.username})`} />
              <Row l="Montant" v={`${amt.toLocaleString()} ${currency}`} strong />
              <Row l="Frais" v="0 (gratuit)" green />
              <Row l="Total débité" v={`${amt.toLocaleString()} ${currency}`} strong />
              <Row l="Le bénéficiaire reçoit" v={`${amt.toLocaleString()} ${currency}`} green />
            </div>
            <div className="mt-5 flex gap-2 justify-end">
              <button onClick={() => setConfirmOpen(false)} className="px-4 py-2 rounded-full border border-slate-200 font-semibold text-xs">Annuler</button>
              <button onClick={submit} disabled={pending} data-testid="btn-b2b-confirm" className="px-5 py-2 rounded-full bg-[#2563EB] text-white font-bold text-xs disabled:opacity-60">{pending ? '…' : 'Transférer'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ------- BIZ TO MOBILE -------
function BizToMobileForm({ config, onDone, onBack, balance }) {
  const mmEnabled = config?.mobile_money?.enabled;
  const operators = config?.mobile_money?.operators || [];
  const [country, setCountry] = useState('TG');
  const [operator, setOperator] = useState('');
  const [phone, setPhone] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('XOF');
  const [feeBearer, setFeeBearer] = useState('sender');
  const [description, setDescription] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);

  const countryOps = operators.filter((o) => o.country === country && o.active);
  useEffect(() => { setOperator(countryOps[0]?.code || ''); /* eslint-disable-next-line */ }, [country]);
  const op = countryOps.find((o) => o.code === operator);

  const amt = parseFloat(amount) || 0;
  const feePct = op?.fee_pct || 0;
  const fee = amt * feePct / 100;
  const totalDebit = feeBearer === 'sender' ? amt + fee : amt;
  const recipientGets = feeBearer === 'sender' ? amt : amt - fee;
  const bal = currency === 'XOF' ? (balance?.balance_xof || 0) : (balance?.balance_xaf || 0);
  const canSubmit = op && phone && amt >= (op?.min || 100) && amt <= (op?.max || 10 ** 12) && totalDebit <= bal;

  const submit = async () => {
    setPending(true);
    try {
      const { data } = await api.post('/transfers', {
        transfer_type: 'biz_to_mobile', recipient: phone, country, operator,
        fee_bearer: feeBearer, amount: amt, currency, description,
      });
      onDone(data, { type: 'biz_to_mobile' });
    } catch (err) { toast.error(err.response?.data?.detail || 'Erreur'); }
    finally { setPending(false); }
  };

  if (!mmEnabled) return <SoonBanner text="Cette fonctionnalité sera activée prochainement." />;

  return (
    <div className="bg-white border border-slate-100 rounded-2xl p-6 space-y-4">
      <div>
        <label className="text-xs font-semibold text-slate-700 mb-1.5 block">Pays</label>
        <select data-testid="mm-country" value={country} onChange={(e) => setCountry(e.target.value)} className="w-full px-4 py-3 border border-slate-200 rounded-xl font-semibold text-sm">
          {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.flag} {c.name}</option>)}
        </select>
      </div>

      <div>
        <label className="text-xs font-semibold text-slate-700 mb-1.5 block">Opérateur Mobile Money</label>
        {countryOps.length === 0 ? (
          <div className="p-3 bg-amber-50 border border-amber-100 rounded-xl text-xs text-amber-800">Aucun opérateur disponible pour ce pays pour l'instant.</div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {countryOps.map((o) => (
              <button key={o.code} type="button" onClick={() => setOperator(o.code)} data-testid={`mm-op-${o.code}`}
                className={`p-3 rounded-xl border text-left transition-colors ${operator === o.code ? 'border-[#2563EB] bg-blue-50' : 'border-slate-200 hover:border-slate-300'}`}>
                <div className="font-cabinet font-bold text-xs text-slate-900">{o.name}</div>
                <div className="text-[10px] text-slate-500 mt-0.5">{o.fee_pct}% de frais</div>
              </button>
            ))}
          </div>
        )}
      </div>

      <div>
        <label className="text-xs font-semibold text-slate-700 mb-1.5 block">Numéro Mobile Money du bénéficiaire</label>
        <input data-testid="mm-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={COUNTRIES.find((c) => c.code === country)?.dial + ' 90 00 00 00'} className="w-full px-4 py-3 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm" />
      </div>

      <div className="grid grid-cols-[1fr_auto] gap-3">
        <div>
          <label className="text-xs font-semibold text-slate-700 mb-1.5 block">Montant</label>
          <input data-testid="mm-amount" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="5000" min={op?.min || 100} max={op?.max || 1000000} className="w-full px-4 py-3 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm" />
          {op && <div className="mt-1 text-[10px] text-slate-500">Min {op.min.toLocaleString()} · Max {op.max.toLocaleString()} · Solde : {bal.toLocaleString()} {currency}</div>}
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-700 mb-1.5 block">Devise</label>
          <select data-testid="mm-currency" value={currency} onChange={(e) => setCurrency(e.target.value)} className="px-4 py-3 border border-slate-200 rounded-xl font-semibold text-sm">
            <option value="XOF">XOF</option><option value="XAF">XAF</option>
          </select>
        </div>
      </div>

      <div>
        <label className="text-xs font-semibold text-slate-700 mb-1.5 block">Qui supporte les frais ?</label>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={() => setFeeBearer('sender')} data-testid="fee-sender" className={`p-3 rounded-xl border-2 text-left transition-colors ${feeBearer === 'sender' ? 'border-[#2563EB] bg-blue-50' : 'border-slate-200'}`}>
            <div className="font-cabinet font-bold text-xs text-slate-900">L'expéditeur paie</div>
            <div className="text-[10px] text-slate-500">Vous payez les frais en plus</div>
          </button>
          <button type="button" onClick={() => setFeeBearer('receiver')} data-testid="fee-receiver" className={`p-3 rounded-xl border-2 text-left transition-colors ${feeBearer === 'receiver' ? 'border-[#2563EB] bg-blue-50' : 'border-slate-200'}`}>
            <div className="font-cabinet font-bold text-xs text-slate-900">Le bénéficiaire paie</div>
            <div className="text-[10px] text-slate-500">Frais déduits du montant reçu</div>
          </button>
        </div>
      </div>

      {/* Live summary */}
      {op && amt > 0 && (
        <div className="p-4 bg-slate-50 rounded-xl space-y-1.5 text-sm" data-testid="mm-summary">
          <Row l="Frais" v={`${fee.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${currency} (${feePct}%)`} />
          <Row l="Total débité" v={`${totalDebit.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${currency}`} strong />
          <Row l="Le bénéficiaire reçoit" v={`${recipientGets.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${currency}`} green />
        </div>
      )}

      <button disabled={!canSubmit} onClick={() => setConfirmOpen(true)} data-testid="btn-mm-continue" className="w-full bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold py-3.5 rounded-xl disabled:opacity-50">
        Continuer
      </button>

      {confirmOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setConfirmOpen(false)}>
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl p-6 max-w-md w-full" data-testid="mm-confirm-modal">
            <h3 className="font-cabinet font-bold text-lg mb-3">Récapitulatif</h3>
            <div className="space-y-2 text-sm">
              <Row l="Opérateur" v={op?.name} />
              <Row l="Numéro" v={phone} />
              <Row l="Montant envoyé" v={`${amt.toLocaleString()} ${currency}`} strong />
              <Row l="Frais" v={`${fee.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${currency}`} />
              <Row l="Frais payés par" v={feeBearer === 'sender' ? 'Vous' : 'Le bénéficiaire'} />
              <Row l="Total débité" v={`${totalDebit.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${currency}`} strong />
              <Row l="Le bénéficiaire reçoit" v={`${recipientGets.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${currency}`} green />
            </div>
            <div className="mt-5 flex gap-2 justify-end">
              <button onClick={() => setConfirmOpen(false)} className="px-4 py-2 rounded-full border border-slate-200 font-semibold text-xs">Annuler</button>
              <button onClick={submit} disabled={pending} data-testid="btn-mm-confirm" className="px-5 py-2 rounded-full bg-[#2563EB] text-white font-bold text-xs disabled:opacity-60">{pending ? '…' : 'Transférer'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ------- BIZ TO BANK -------
function BizToBankForm({ config }) {
  if (!config?.bank?.enabled) return <SoonBanner text="Les transferts bancaires seront disponibles prochainement." />;
  return <SoonBanner text="Configuration bancaire en cours." />;
}

function SoonBanner({ text }) {
  return (
    <div className="bg-white border border-slate-100 rounded-2xl p-10 text-center" data-testid="soon-banner">
      <div className="mx-auto w-14 h-14 rounded-full bg-amber-50 flex items-center justify-center"><Clock className="w-7 h-7 text-amber-500" /></div>
      <h2 className="mt-4 font-cabinet text-xl font-extrabold text-slate-900">Bientôt disponible</h2>
      <p className="mt-2 text-sm text-slate-500">{text}</p>
      <div className="mt-4 inline-flex items-center gap-2 text-[11px] text-slate-500 bg-slate-50 border border-slate-100 rounded-full px-3 py-1">
        <Info className="w-3.5 h-3.5" /> Cette fonctionnalité sera activée par un administrateur.
      </div>
    </div>
  );
}

function Row({ l, v, strong, green }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-slate-500 text-xs">{l}</span>
      <span className={`${strong ? 'font-bold text-slate-900' : ''} ${green ? 'text-emerald-600 font-bold' : ''} text-xs`}>{v}</span>
    </div>
  );
}
