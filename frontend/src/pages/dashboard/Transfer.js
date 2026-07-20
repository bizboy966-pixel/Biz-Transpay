import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Users, Smartphone, Landmark, ArrowLeft, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';
import { useAuth } from '@/context/AuthContext';

export default function Transfer() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { refresh } = useAuth();
  const [step, setStep] = useState(1);
  const [type, setType] = useState(null);
  const [form, setForm] = useState({ recipient: '', recipient_name: '', amount: '', currency: 'XOF', description: '' });
  const [loading, setLoading] = useState(false);
  const [tx, setTx] = useState(null);

  const opts = [
    { v: 'biz_to_biz', I: Users, c: 'bg-blue-50 text-[#2563EB]', l: t('transfer.biz_to_biz'), d: t('transfer.biz_to_biz_d') },
    { v: 'biz_to_mobile', I: Smartphone, c: 'bg-emerald-50 text-emerald-600', l: t('transfer.biz_to_mobile'), d: t('transfer.biz_to_mobile_d') },
    { v: 'biz_to_bank', I: Landmark, c: 'bg-violet-50 text-violet-600', l: t('transfer.biz_to_bank'), d: t('transfer.biz_to_bank_d') },
  ];

  const recPh = { biz_to_biz: t('transfer.recipient_ph_biz'), biz_to_mobile: t('transfer.recipient_ph_mobile'), biz_to_bank: t('transfer.recipient_ph_bank') }[type];

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { data } = await api.post('/transfers', {
        transfer_type: type, recipient: form.recipient, recipient_name: form.recipient_name,
        amount: parseFloat(form.amount), currency: form.currency, description: form.description,
      });
      setTx(data);
      setStep(3);
      refresh();
    } catch (err) { toast.error(err.response?.data?.detail || 'Erreur'); }
    finally { setLoading(false); }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6" data-testid="page-transfer">
      <button onClick={() => step > 1 ? setStep(step - 1) : nav('/dashboard')} className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600 hover:text-[#2563EB]" data-testid="btn-back">
        <ArrowLeft className="w-4 h-4" /> {t('common.back')}
      </button>

      <div>
        <h1 className="font-cabinet text-3xl font-extrabold tracking-tighter text-slate-900">{t('transfer.title')}</h1>
        <p className="text-slate-500 text-sm mt-1">{t('transfer.subtitle')}</p>
      </div>

      {/* Steps */}
      <div className="flex items-center gap-2">
        {[1, 2, 3].map((s) => (
          <div key={s} className={`flex-1 h-1.5 rounded-full ${step >= s ? 'bg-[#2563EB]' : 'bg-slate-200'}`} />
        ))}
      </div>

      {step === 1 && (
        <div className="space-y-3">
          {opts.map((o) => (
            <button key={o.v} onClick={() => { setType(o.v); setStep(2); }} data-testid={`transfer-type-${o.v}`} className="w-full bg-white border border-slate-100 rounded-[20px] p-5 flex items-center gap-4 hover:border-[#2563EB] hover:-translate-y-0.5 transition-transform text-left">
              <div className={`w-14 h-14 rounded-2xl ${o.c} flex items-center justify-center`}><o.I className="w-6 h-6" strokeWidth={1.75} /></div>
              <div className="flex-1">
                <div className="font-cabinet font-bold text-slate-900">{o.l}</div>
                <div className="text-sm text-slate-500">{o.d}</div>
              </div>
              <ArrowRight className="w-5 h-5 text-slate-400" />
            </button>
          ))}
        </div>
      )}

      {step === 2 && (
        <form onSubmit={submit} className="bg-white border border-slate-100 rounded-[24px] p-6 sm:p-8 space-y-4">
          <Input label={t('transfer.recipient')} value={form.recipient} onChange={(v) => setForm({ ...form, recipient: v })} placeholder={recPh} required tid="tr-recipient" />
          {type !== 'biz_to_biz' && <Input label={t('transfer.recipient_name')} value={form.recipient_name} onChange={(v) => setForm({ ...form, recipient_name: v })} tid="tr-recipient-name" />}
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <Input label={t('transfer.amount')} type="number" value={form.amount} onChange={(v) => setForm({ ...form, amount: v })} required tid="tr-amount" />
            <div>
              <label className="text-sm font-semibold text-slate-700 mb-2 block">{t('transfer.currency')}</label>
              <select data-testid="tr-currency" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} className="px-4 py-3.5 border border-slate-200 rounded-xl font-semibold">
                <option value="XOF">XOF</option><option value="XAF">XAF</option>
              </select>
            </div>
          </div>
          <Input label={t('transfer.description')} value={form.description} onChange={(v) => setForm({ ...form, description: v })} tid="tr-desc" />
          <button type="submit" disabled={loading} data-testid="btn-confirm-transfer" className="w-full bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold py-4 rounded-xl disabled:opacity-70">
            {loading ? '…' : t('transfer.confirm')}
          </button>
        </form>
      )}

      {step === 3 && tx && (
        <div className="bg-white border border-slate-100 rounded-[24px] p-10 text-center" data-testid="transfer-success">
          <div className="mx-auto w-16 h-16 rounded-full bg-emerald-50 flex items-center justify-center"><CheckCircle2 className="w-8 h-8 text-emerald-500" /></div>
          <h2 className="mt-5 font-cabinet text-2xl font-extrabold text-slate-900">{t('transfer.success')}</h2>
          <div className="mt-4 font-cabinet text-4xl font-extrabold text-[#2563EB]">
            {tx.transaction.amount.toLocaleString()} <span className="text-lg text-slate-500">{tx.transaction.currency}</span>
          </div>
          <div className="mt-1 text-sm text-slate-500">→ {tx.transaction.counterparty}</div>
          <div className="mt-2 text-xs text-slate-400 font-mono">{tx.transaction.reference}</div>
          {tx.fee > 0 && <div className="mt-2 text-xs text-slate-500">{t('transfer.fee')}: {tx.fee.toLocaleString()} {tx.transaction.currency}</div>}
          <button onClick={() => nav('/dashboard')} data-testid="btn-tr-done" className="mt-6 bg-[#2563EB] text-white font-bold px-6 py-3 rounded-full">Terminer</button>
        </div>
      )}
    </div>
  );
}

function Input({ label, value, onChange, placeholder, type = 'text', required, tid }) {
  return (
    <div>
      <label className="text-sm font-semibold text-slate-700 mb-2 block">{label}</label>
      <input data-testid={tid} type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} required={required} className="w-full px-4 py-3.5 border border-slate-200 rounded-xl focus:border-[#2563EB] focus:ring-2 focus:ring-blue-100 outline-none" />
    </div>
  );
}
