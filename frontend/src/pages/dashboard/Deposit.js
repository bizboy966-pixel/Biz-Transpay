import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, CreditCard, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';

export default function Deposit() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('XOF');
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const amt = parseFloat(amount);
    if (!amt || amt < 300) { toast.error(t('deposit.min') + ' XOF/XAF'); return; }
    setLoading(true);
    try {
      const { data } = await api.post('/deposits/checkout', {
        amount: amt, currency, origin_url: window.location.origin,
      });
      window.location.href = data.checkout_url;
    } catch (err) { toast.error(err.response?.data?.detail || 'Erreur'); setLoading(false); }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6" data-testid="page-deposit">
      <button onClick={() => nav('/dashboard')} className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600" data-testid="btn-back-deposit">
        <ArrowLeft className="w-4 h-4" /> {t('common.back')}
      </button>

      <div>
        <h1 className="font-cabinet text-3xl font-extrabold tracking-tighter text-slate-900">{t('deposit.title')}</h1>
        <p className="text-slate-500 text-sm mt-1">{t('deposit.subtitle')}</p>
      </div>

      <form onSubmit={submit} className="bg-white border border-slate-100 rounded-[24px] p-6 sm:p-8 space-y-5">
        <div className="grid grid-cols-[1fr_auto] gap-3">
          <div>
            <label className="text-sm font-semibold text-slate-700 mb-2 block">{t('transfer.amount')}</label>
            <input data-testid="dep-amount" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="10000" min="300" required className="w-full px-4 py-3.5 border border-slate-200 rounded-xl focus:border-[#2563EB] focus:ring-2 focus:ring-blue-100 outline-none" />
          </div>
          <div>
            <label className="text-sm font-semibold text-slate-700 mb-2 block">{t('transfer.currency')}</label>
            <select data-testid="dep-currency" value={currency} onChange={(e) => setCurrency(e.target.value)} className="px-4 py-3.5 border border-slate-200 rounded-xl font-semibold">
              <option value="XOF">XOF</option><option value="XAF">XAF</option>
            </select>
          </div>
        </div>

        <div>
          <label className="text-sm font-semibold text-slate-700 mb-2 block">{t('deposit.method')}</label>
          <div className="border-2 border-[#2563EB] bg-blue-50/50 rounded-2xl p-5 flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-white text-[#2563EB] flex items-center justify-center"><CreditCard className="w-5 h-5" /></div>
            <div>
              <div className="font-bold text-slate-900">{t('deposit.card')}</div>
              <div className="text-xs text-slate-500">{t('deposit.card_d')}</div>
            </div>
          </div>
        </div>

        <div className="bg-slate-50 rounded-xl p-4 text-xs text-slate-500 flex items-start gap-3">
          <ShieldCheck className="w-4 h-4 text-emerald-500 mt-0.5" />
          Paiement sécurisé propulsé par Stripe. Utilisez la carte test <b>4242 4242 4242 4242</b> · exp future · CVC quelconque.
        </div>

        <button type="submit" disabled={loading} data-testid="btn-proceed-deposit" className="w-full bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold py-4 rounded-xl disabled:opacity-70">
          {loading ? '…' : t('deposit.proceed')}
        </button>
      </form>
    </div>
  );
}
