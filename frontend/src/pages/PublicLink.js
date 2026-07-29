import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Link2, ShieldCheck, Bitcoin } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';
import { Logo } from '@/components/Logo';

export default function PublicLink() {
  const { slug } = useParams();
  const [link, setLink] = useState(null);
  const [err, setErr] = useState(null);
  const [customAmount, setCustomAmount] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [paying, setPaying] = useState(false);

  useEffect(() => {
    api.get(`/links/public/${slug}`).then(({ data }) => {
      setLink(data);
      if (data.amount_type === 'free' && data.min_amount) setCustomAmount(String(data.min_amount));
    }).catch(() => setErr('Lien introuvable ou expiré'));
  }, [slug]);

  if (err) return <div className="min-h-screen flex items-center justify-center text-slate-600">{err}</div>;
  if (!link) return <div className="min-h-screen flex items-center justify-center">Chargement…</div>;

  const isFree = link.amount_type === 'free';
  const amt = isFree ? parseFloat(customAmount) || 0 : link.amount;
  const belowMin = isFree && amt < (link.min_amount || 0);
  const aboveMax = isFree && amt > (link.max_amount || 0);
  const disabled = !link.active || belowMin || aboveMax || amt <= 0 || paying;
  const feePct = 0.015;
  const fee = amt * feePct;
  const customerPays = link.fee_bearer === 'customer' ? amt + fee : amt;

  const payCrypto = async () => {
    if (disabled) return;
    setPaying(true);
    try {
      const { data } = await api.post('/links/pay', {
        slug, amount: isFree ? amt : undefined,
        coin: 'USDT', accepted_networks: ['TRC20', 'BEP20', 'ERC20'],
        origin_url: window.location.origin,
        customer_email: email || undefined, customer_name: name || undefined,
      });
      window.location.href = data.payment_url;
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Erreur lors du paiement');
      setPaying(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-white to-slate-50 flex flex-col" data-testid="public-link-page">
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-4xl mx-auto px-4 h-14 flex items-center"><Logo /></div>
      </header>
      <main className="flex-1 flex items-center justify-center p-4 sm:p-6">
        <div className="max-w-md w-full bg-white rounded-2xl border border-slate-100 shadow-xl p-5 sm:p-8">
          <div className="text-center">
            {link.logo ? (
              <img src={link.logo} alt={link.title} className="mx-auto w-14 h-14 sm:w-16 sm:h-16 rounded-2xl object-cover border border-slate-100" />
            ) : (
              <div className="mx-auto w-12 h-12 sm:w-14 sm:h-14 rounded-2xl bg-blue-50 flex items-center justify-center">
                <Link2 className="w-5 h-5 sm:w-6 sm:h-6 text-[#2563EB]" />
              </div>
            )}
            <div className="mt-3 text-[9px] sm:text-[10px] uppercase tracking-widest text-slate-500 font-bold">Paiement à</div>
            <div className="font-cabinet font-extrabold text-lg sm:text-xl text-slate-900 mt-0.5">{link.merchant?.full_name}</div>
            <div className="text-[11px] sm:text-xs text-slate-500">@{link.merchant?.username}</div>
          </div>

          <div className="mt-4 sm:mt-5 rounded-2xl bg-gradient-to-br from-[#3B82F6] to-[#1D4ED8] p-4 sm:p-5 text-white">
            <div className="text-[9px] sm:text-[10px] uppercase tracking-widest opacity-80">Montant</div>
            {isFree ? (
              <div className="mt-1">
                <input data-testid="pay-amount" type="number" value={customAmount} min={link.min_amount} max={link.max_amount} onChange={(e) => setCustomAmount(e.target.value)} className="w-full bg-white/15 rounded-lg px-3 py-2 text-xl sm:text-2xl font-cabinet font-extrabold outline-none placeholder:text-white/50" />
                <div className="mt-1 text-[9px] sm:text-[10px] opacity-80">Entre {link.min_amount?.toLocaleString()} et {link.max_amount?.toLocaleString()} {link.currency}</div>
              </div>
            ) : (
              <div className="font-cabinet text-2xl sm:text-3xl font-extrabold mt-1">{link.amount.toLocaleString()} <span className="text-sm sm:text-base opacity-80">{link.currency}</span></div>
            )}
            <div className="mt-2 sm:mt-3 text-xs sm:text-sm font-semibold opacity-95">{link.title}</div>
            {link.description && <div className="mt-1 text-[10px] sm:text-xs opacity-80">{link.description}</div>}
          </div>

          {amt > 0 && (
            <div className="mt-3 sm:mt-4 p-2.5 sm:p-3 bg-slate-50 rounded-lg text-[11px] sm:text-xs space-y-1" data-testid="pay-summary">
              <div className="flex justify-between text-slate-500"><span>Montant marchand</span><span>{amt.toLocaleString()} {link.currency}</span></div>
              <div className="flex justify-between text-slate-500"><span>Frais (1.5%) {link.fee_bearer === 'owner' ? '· pris en charge par le marchand' : ''}</span><span>{fee.toLocaleString(undefined, { maximumFractionDigits: 0 })} {link.currency}</span></div>
              <div className="flex justify-between font-bold text-slate-900 pt-1 border-t border-slate-200"><span>À payer</span><span>{customerPays.toLocaleString(undefined, { maximumFractionDigits: 0 })} {link.currency}</span></div>
            </div>
          )}

          {/* Optional customer info */}
          <div className="mt-3 sm:mt-4 grid grid-cols-2 gap-2">
            <input data-testid="pay-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Votre nom" className="px-3 py-2 border border-slate-200 rounded-xl outline-none text-[11px] sm:text-xs" />
            <input data-testid="pay-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Votre email" className="px-3 py-2 border border-slate-200 rounded-xl outline-none text-[11px] sm:text-xs" />
          </div>

          <button data-testid="btn-pay-crypto" onClick={payCrypto} disabled={disabled} className="mt-4 sm:mt-5 w-full bg-orange-500 hover:bg-orange-600 text-white font-bold py-3 sm:py-3.5 rounded-xl disabled:opacity-50 text-xs sm:text-sm inline-flex items-center justify-center gap-2">
            <Bitcoin className="w-4 h-4" />
            {!link.active ? 'Lien désactivé' : (belowMin ? `Min ${link.min_amount?.toLocaleString()}` : (aboveMax ? `Max ${link.max_amount?.toLocaleString()}` : (paying ? 'Redirection…' : 'Payer en crypto (USDT)')))}
          </button>

          <div className="mt-4 sm:mt-5 flex items-center justify-center gap-2 text-[10px] sm:text-[11px] text-slate-500">
            <ShieldCheck className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-emerald-500" /> Paiement sécurisé · IzichangePay + Biz-transPay
          </div>
        </div>
      </main>
    </div>
  );
}
