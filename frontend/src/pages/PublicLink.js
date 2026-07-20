import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Link2, ShieldCheck } from 'lucide-react';
import api from '@/api';
import { Logo } from '@/components/Logo';

export default function PublicLink() {
  const { slug } = useParams();
  const [link, setLink] = useState(null);
  const [err, setErr] = useState(null);
  const [customAmount, setCustomAmount] = useState('');

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
  const disabled = !link.active || belowMin || aboveMax || amt <= 0;
  const feePct = 0.015;
  const fee = amt * feePct;
  const customerPays = link.fee_bearer === 'customer' ? amt + fee : amt;

  return (
    <div className="min-h-screen bg-gradient-to-b from-white to-slate-50 flex flex-col" data-testid="public-link-page">
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-4xl mx-auto px-4 h-14 flex items-center"><Logo /></div>
      </header>
      <main className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white rounded-2xl border border-slate-100 shadow-xl p-8">
          <div className="text-center">
            {link.logo ? (
              <img src={link.logo} alt={link.title} className="mx-auto w-16 h-16 rounded-2xl object-cover border border-slate-100" />
            ) : (
              <div className="mx-auto w-14 h-14 rounded-2xl bg-blue-50 flex items-center justify-center">
                <Link2 className="w-6 h-6 text-[#2563EB]" />
              </div>
            )}
            <div className="mt-3 text-[10px] uppercase tracking-widest text-slate-500 font-bold">Paiement à</div>
            <div className="font-cabinet font-extrabold text-xl text-slate-900 mt-0.5">{link.merchant?.full_name}</div>
            <div className="text-xs text-slate-500">@{link.merchant?.username}</div>
          </div>

          <div className="mt-5 rounded-2xl bg-gradient-to-br from-[#3B82F6] to-[#1D4ED8] p-5 text-white">
            <div className="text-[10px] uppercase tracking-widest opacity-80">Montant</div>
            {isFree ? (
              <div className="mt-1">
                <input data-testid="pay-amount" type="number" value={customAmount} min={link.min_amount} max={link.max_amount} onChange={(e) => setCustomAmount(e.target.value)} className="w-full bg-white/15 rounded-lg px-3 py-2 text-2xl font-cabinet font-extrabold outline-none placeholder:text-white/50" />
                <div className="mt-1 text-[10px] opacity-80">Entre {link.min_amount?.toLocaleString()} et {link.max_amount?.toLocaleString()} {link.currency}</div>
              </div>
            ) : (
              <div className="font-cabinet text-3xl font-extrabold mt-1">{link.amount.toLocaleString()} <span className="text-base opacity-80">{link.currency}</span></div>
            )}
            <div className="mt-3 text-sm font-semibold opacity-95">{link.title}</div>
            {link.description && <div className="mt-1 text-xs opacity-80">{link.description}</div>}
          </div>

          {amt > 0 && (
            <div className="mt-4 p-3 bg-slate-50 rounded-lg text-xs space-y-1" data-testid="pay-summary">
              <div className="flex justify-between text-slate-500"><span>Montant marchand</span><span>{amt.toLocaleString()} {link.currency}</span></div>
              <div className="flex justify-between text-slate-500"><span>Frais (1.5%) {link.fee_bearer === 'owner' ? '· pris en charge par le marchand' : ''}</span><span>{fee.toLocaleString(undefined, { maximumFractionDigits: 0 })} {link.currency}</span></div>
              <div className="flex justify-between font-bold text-slate-900 pt-1 border-t border-slate-200"><span>À payer</span><span>{customerPays.toLocaleString(undefined, { maximumFractionDigits: 0 })} {link.currency}</span></div>
            </div>
          )}

          <button data-testid="btn-pay-link" disabled={disabled} className="mt-5 w-full bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold py-3.5 rounded-xl disabled:opacity-50 text-sm">
            {!link.active ? 'Lien désactivé' : (belowMin ? `Montant minimum ${link.min_amount?.toLocaleString()}` : (aboveMax ? `Montant maximum ${link.max_amount?.toLocaleString()}` : 'Payer maintenant'))}
          </button>

          <div className="mt-5 flex items-center justify-center gap-2 text-[10px] text-slate-500">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" /> Paiement sécurisé par Biz-transPay
          </div>
        </div>
      </main>
    </div>
  );
}
