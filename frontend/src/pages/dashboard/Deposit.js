import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, CreditCard, ShieldCheck, Bitcoin } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';

export default function Deposit() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const [method, setMethod] = useState('card'); // 'card' | 'crypto'

  return (
    <div className="max-w-2xl mx-auto space-y-4 sm:space-y-6" data-testid="page-deposit">
      <button onClick={() => nav('/dashboard')} className="inline-flex items-center gap-2 text-xs sm:text-sm font-semibold text-slate-600 hover:text-[#2563EB]" data-testid="btn-back-deposit">
        <ArrowLeft className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> {t('common.back')}
      </button>

      <div>
        <h1 className="font-cabinet text-2xl sm:text-3xl font-extrabold tracking-tighter text-slate-900">{t('deposit.title')}</h1>
        <p className="text-slate-500 text-xs sm:text-sm mt-1">{t('deposit.subtitle')}</p>
      </div>

      {/* Method tabs */}
      <div className="grid grid-cols-2 gap-2 sm:gap-3">
        <button type="button" onClick={() => setMethod('card')} data-testid="tab-method-card"
          className={`p-3 sm:p-4 rounded-2xl border-2 text-left transition-colors ${method === 'card' ? 'border-[#2563EB] bg-blue-50/60' : 'border-slate-200 hover:border-slate-300'}`}>
          <div className="flex items-center gap-2.5 sm:gap-3">
            <div className={`w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center ${method === 'card' ? 'bg-[#2563EB] text-white' : 'bg-slate-100 text-slate-500'}`}><CreditCard className="w-4 h-4 sm:w-5 sm:h-5" /></div>
            <div>
              <div className="font-cabinet font-bold text-xs sm:text-sm text-slate-900">{t('deposit.card') || 'Carte bancaire'}</div>
              <div className="text-[10px] sm:text-xs text-slate-500">Visa · Mastercard · Stripe</div>
            </div>
          </div>
        </button>
        <button type="button" onClick={() => setMethod('crypto')} data-testid="tab-method-crypto"
          className={`p-3 sm:p-4 rounded-2xl border-2 text-left transition-colors ${method === 'crypto' ? 'border-orange-500 bg-orange-50/60' : 'border-slate-200 hover:border-slate-300'}`}>
          <div className="flex items-center gap-2.5 sm:gap-3">
            <div className={`w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center ${method === 'crypto' ? 'bg-orange-500 text-white' : 'bg-slate-100 text-slate-500'}`}><Bitcoin className="w-4 h-4 sm:w-5 sm:h-5" /></div>
            <div>
              <div className="font-cabinet font-bold text-xs sm:text-sm text-slate-900">Crypto (USDT)</div>
              <div className="text-[10px] sm:text-xs text-slate-500">TRC20 · BEP20 · ERC20</div>
            </div>
          </div>
        </button>
      </div>

      {method === 'card' && <CardDepositForm />}
      {method === 'crypto' && <CryptoDepositForm />}

      <div className="text-[11px] sm:text-xs text-slate-500 flex items-start gap-2">
        <ShieldCheck className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-emerald-500 mt-0.5 shrink-0" />
        Paiement 100 % sécurisé — vos identifiants ne transitent jamais par nos serveurs.
      </div>
    </div>
  );
}

function CardDepositForm() {
  const { t } = useTranslation();
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('XOF');
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const amt = parseFloat(amount);
    if (!amt || amt < 300) { toast.error((t('deposit.min') || 'Montant minimum') + ' 300 XOF/XAF'); return; }
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
          <label className="text-xs sm:text-sm font-semibold text-slate-700 mb-1 sm:mb-2 block">{t('transfer.amount')}</label>
          <input data-testid="dep-amount" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="10000" min="300" required className="w-full px-3 sm:px-4 py-2.5 sm:py-3 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-xs sm:text-sm" />
        </div>
        <div>
          <label className="text-xs sm:text-sm font-semibold text-slate-700 mb-1 sm:mb-2 block">{t('transfer.currency')}</label>
          <select data-testid="dep-currency" value={currency} onChange={(e) => setCurrency(e.target.value)} className="px-2.5 sm:px-4 py-2.5 sm:py-3 border border-slate-200 rounded-xl font-semibold text-xs sm:text-sm">
            <option value="XOF">XOF</option><option value="XAF">XAF</option>
          </select>
        </div>
      </div>
      <button type="submit" disabled={loading} data-testid="btn-deposit-submit" className="w-full bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold py-3 sm:py-3.5 rounded-xl text-xs sm:text-sm disabled:opacity-60">
        {loading ? 'Redirection…' : 'Continuer avec Stripe'}
      </button>
    </form>
  );
}

function CryptoDepositForm() {
  const [amount, setAmount] = useState('');
  const [networks, setNetworks] = useState({ TRC20: true, BEP20: true, ERC20: false });
  const [loading, setLoading] = useState(false);

  const toggle = (n) => setNetworks({ ...networks, [n]: !networks[n] });
  const accepted = Object.entries(networks).filter(([, v]) => v).map(([k]) => k);

  const submit = async (e) => {
    e.preventDefault();
    const amt = parseFloat(amount);
    if (!amt || amt < 1) { toast.error('Montant minimum : 1 USDT'); return; }
    if (accepted.length === 0) { toast.error('Sélectionnez au moins un réseau'); return; }
    setLoading(true);
    try {
      const { data } = await api.post('/deposits/crypto', {
        amount: amt, coin: 'USDT', accepted_networks: accepted,
        origin_url: window.location.origin,
      });
      // Redirect to hosted checkout
      window.location.href = data.payment_url;
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Erreur');
      setLoading(false);
    }
  };

  return (
    <form onSubmit={submit} className="bg-white border border-slate-100 rounded-2xl p-4 sm:p-6 space-y-3 sm:space-y-4">
      <div className="bg-orange-50 border border-orange-100 rounded-xl p-2.5 sm:p-3 flex items-start gap-2 sm:gap-2.5">
        <Bitcoin className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-orange-600 mt-0.5 shrink-0" />
        <div className="text-[11px] sm:text-xs text-slate-700"><b>USDT via IzichangePay.</b> Le montant sera crédité sur votre portefeuille USDT dès la confirmation on-chain.</div>
      </div>

      <div>
        <label className="text-xs sm:text-sm font-semibold text-slate-700 mb-1 sm:mb-2 block">Montant (USDT)</label>
        <input data-testid="crypto-dep-amount" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="10" min="1" required className="w-full px-3 sm:px-4 py-2.5 sm:py-3 border border-slate-200 rounded-xl outline-none focus:border-orange-500 text-xs sm:text-sm" />
        <div className="mt-1 text-[10px] sm:text-xs text-slate-500">Minimum : 1 USDT</div>
      </div>

      <div>
        <label className="text-xs sm:text-sm font-semibold text-slate-700 mb-1 sm:mb-2 block">Réseaux acceptés</label>
        <div className="grid grid-cols-3 gap-2">
          {Object.keys(networks).map((n) => (
            <button key={n} type="button" onClick={() => toggle(n)} data-testid={`crypto-dep-net-${n}`}
              className={`p-2 sm:p-3 rounded-xl border-2 text-center transition-colors ${networks[n] ? 'border-orange-500 bg-orange-50 text-orange-700' : 'border-slate-200 text-slate-600'}`}>
              <div className="font-cabinet font-bold text-[11px] sm:text-xs">{n}</div>
            </button>
          ))}
        </div>
      </div>

      <button type="submit" disabled={loading} data-testid="btn-crypto-dep-submit" className="w-full bg-orange-500 hover:bg-orange-600 text-white font-bold py-3 sm:py-3.5 rounded-xl text-xs sm:text-sm disabled:opacity-60">
        {loading ? 'Redirection vers IzichangePay…' : 'Payer en crypto →'}
      </button>
    </form>
  );
}
