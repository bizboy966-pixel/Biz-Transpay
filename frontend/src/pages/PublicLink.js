import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Link2, ShieldCheck } from 'lucide-react';
import api from '@/api';
import { Logo } from '@/components/Logo';

export default function PublicLink() {
  const { slug } = useParams();
  const [link, setLink] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api.get(`/links/public/${slug}`).then(({ data }) => setLink(data)).catch(() => setErr('Lien introuvable ou expiré'));
  }, [slug]);

  if (err) return <div className="min-h-screen flex items-center justify-center text-slate-600">{err}</div>;
  if (!link) return <div className="min-h-screen flex items-center justify-center">Chargement…</div>;

  return (
    <div className="min-h-screen bg-gradient-to-b from-white to-slate-50 flex flex-col" data-testid="public-link-page">
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-4xl mx-auto px-4 h-16 flex items-center"><Logo /></div>
      </header>
      <main className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white rounded-[24px] border border-slate-100 shadow-xl p-10">
          <div className="text-center">
            <div className="mx-auto w-14 h-14 rounded-2xl bg-blue-50 flex items-center justify-center">
              <Link2 className="w-6 h-6 text-[#2563EB]" />
            </div>
            <div className="mt-3 text-xs uppercase tracking-widest text-slate-500 font-bold">Paiement à</div>
            <div className="font-cabinet font-extrabold text-2xl text-slate-900 mt-1">{link.merchant?.full_name}</div>
            <div className="text-sm text-slate-500">@{link.merchant?.username}</div>
          </div>
          <div className="mt-6 rounded-2xl bg-gradient-to-br from-[#3B82F6] to-[#1D4ED8] p-6 text-white">
            <div className="text-xs uppercase tracking-widest opacity-80">Montant</div>
            <div className="font-cabinet text-4xl font-extrabold mt-1">{link.amount.toLocaleString()} <span className="text-lg opacity-80">{link.currency}</span></div>
            <div className="mt-2 text-sm opacity-90">{link.title}</div>
            {link.description && <div className="mt-1 text-xs opacity-80">{link.description}</div>}
          </div>
          <button data-testid="btn-pay-link" className="mt-6 w-full bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold py-4 rounded-xl">
            Payer maintenant
          </button>
          <div className="mt-6 flex items-center justify-center gap-2 text-xs text-slate-500">
            <ShieldCheck className="w-4 h-4 text-emerald-500" /> Paiement sécurisé par Biz-transPay
          </div>
        </div>
      </main>
    </div>
  );
}
