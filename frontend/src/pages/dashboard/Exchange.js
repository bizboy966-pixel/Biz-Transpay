import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ArrowUpDown, Repeat, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';
import { useAuth } from '@/context/AuthContext';

export default function Exchange() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { refresh } = useAuth();
  const [from, setFrom] = useState('XOF');
  const [to, setTo] = useState('XAF');
  const [amount, setAmount] = useState('');
  const [rate, setRate] = useState(1);
  const [feePct, setFeePct] = useState(0.005);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(null);

  useEffect(() => {
    api.get('/exchange/rate', { params: { from_currency: from, to_currency: to } })
      .then(({ data }) => { setRate(data.rate); setFeePct(data.fee_pct); }).catch(() => {});
  }, [from, to]);

  const swap = () => { setFrom(to); setTo(from); };

  const amt = parseFloat(amount) || 0;
  const fee = amt * feePct;
  const receive = (amt - fee) * rate;

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { data } = await api.post('/exchange', { from_currency: from, to_currency: to, amount: amt });
      setDone(data);
      refresh();
    } catch (err) { toast.error(err.response?.data?.detail || 'Erreur'); }
    finally { setLoading(false); }
  };

  if (done) {
    return (
      <div className="max-w-md mx-auto bg-white border border-slate-100 rounded-[24px] p-10 text-center" data-testid="exchange-success">
        <div className="mx-auto w-16 h-16 rounded-full bg-emerald-50 flex items-center justify-center"><CheckCircle2 className="w-8 h-8 text-emerald-500" /></div>
        <h2 className="mt-5 font-cabinet text-2xl font-extrabold text-slate-900">{t('exchange.success')}</h2>
        <div className="mt-4 font-cabinet text-4xl font-extrabold text-[#2563EB]">{done.received.toLocaleString(undefined, { maximumFractionDigits: 2 })} <span className="text-lg text-slate-500">{to}</span></div>
        <div className="mt-2 text-sm text-slate-500">{t('exchange.fee')}: {done.fee.toLocaleString(undefined, { maximumFractionDigits: 2 })} {from}</div>
        <button onClick={() => nav('/dashboard')} data-testid="btn-ex-done" className="mt-6 bg-[#2563EB] text-white font-bold px-6 py-3 rounded-full">Terminer</button>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6" data-testid="page-exchange">
      <button onClick={() => nav('/dashboard')} className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600" data-testid="btn-back-exchange">
        <ArrowLeft className="w-4 h-4" /> {t('common.back')}
      </button>

      <div>
        <h1 className="font-cabinet text-3xl font-extrabold tracking-tighter text-slate-900">{t('exchange.title')}</h1>
        <p className="text-slate-500 text-sm mt-1">{t('exchange.subtitle')}</p>
      </div>

      <form onSubmit={submit} className="bg-white border border-slate-100 rounded-[24px] p-6 sm:p-8 space-y-4">
        {/* From */}
        <div className="p-5 bg-slate-50 rounded-2xl">
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs font-bold uppercase tracking-widest text-slate-500">{t('exchange.from')}</div>
            <select value={from} onChange={(e) => setFrom(e.target.value)} data-testid="ex-from" className="px-3 py-1.5 bg-white border border-slate-200 rounded-lg font-semibold text-sm">
              <option value="XOF">XOF</option><option value="XAF">XAF</option>
            </select>
          </div>
          <input data-testid="ex-amount" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" required min="1" className="w-full bg-transparent text-3xl font-cabinet font-extrabold outline-none" />
        </div>

        <div className="flex justify-center">
          <button type="button" onClick={swap} data-testid="btn-swap" className="w-11 h-11 rounded-full bg-white border-2 border-blue-100 hover:border-[#2563EB] flex items-center justify-center transition-colors">
            <ArrowUpDown className="w-4 h-4 text-[#2563EB]" />
          </button>
        </div>

        {/* To */}
        <div className="p-5 bg-blue-50 rounded-2xl">
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs font-bold uppercase tracking-widest text-[#2563EB]">{t('exchange.to')}</div>
            <select value={to} onChange={(e) => setTo(e.target.value)} data-testid="ex-to" className="px-3 py-1.5 bg-white border border-slate-200 rounded-lg font-semibold text-sm">
              <option value="XAF">XAF</option><option value="XOF">XOF</option>
            </select>
          </div>
          <div className="text-3xl font-cabinet font-extrabold text-[#2563EB]">{receive.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
        </div>

        <div className="text-sm text-slate-600 space-y-1.5 pt-2">
          <div className="flex justify-between"><span>{t('exchange.rate')}</span><span className="font-semibold">1 {from} = {rate} {to}</span></div>
          <div className="flex justify-between"><span>{t('exchange.fee')} ({(feePct * 100).toFixed(1)}%)</span><span className="font-semibold">{fee.toLocaleString(undefined, { maximumFractionDigits: 2 })} {from}</span></div>
        </div>

        <button type="submit" disabled={loading || from === to || !amt} data-testid="btn-confirm-exchange" className="w-full bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold py-4 rounded-xl inline-flex items-center justify-center gap-2 disabled:opacity-50">
          <Repeat className="w-4 h-4" /> {loading ? '…' : t('exchange.confirm')}
        </button>
      </form>
    </div>
  );
}
