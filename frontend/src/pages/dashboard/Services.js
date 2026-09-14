import { Link2, ArrowRight, ShieldCheck } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export default function Services() {
  const navigate = useNavigate();

  return (
    <div data-testid="page-services" className="space-y-5" aria-label="Services">
      <div>
        <h1 className="font-cabinet text-2xl font-extrabold tracking-tighter text-slate-900">Services</h1>
        <p className="text-slate-500 text-xs mt-1">Choisissez un service pour développer votre activité numérique.</p>
      </div>

      <div className="space-y-3">
        <button
          type="button"
          data-testid="service-payment-link"
          onClick={() => navigate('/dashboard/links')}
          className="group flex w-full items-center gap-4 text-left bg-white border border-slate-100 rounded-2xl p-4 shadow-[0_2px_10px_rgba(15,23,42,0.03)] hover:border-blue-200 hover:shadow-[0_8px_24px_rgba(37,99,235,0.08)] transition-all"
        >
          <div className="w-11 h-11 shrink-0 rounded-xl bg-violet-50 text-violet-600 flex items-center justify-center">
            <Link2 className="w-5 h-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="font-cabinet font-bold text-sm text-slate-900">Liens de paiement</h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">Créez, partagez et gérez des pages de paiement personnalisées pour vos produits et services.</p>
            <div className="mt-2 inline-flex items-center gap-1.5 text-[10px] font-bold text-[#2563EB]">
              <ShieldCheck className="w-3.5 h-3.5" /> Paiement sécurisé
            </div>
          </div>
          <ArrowRight className="w-4 h-4 shrink-0 text-slate-300 group-hover:text-[#2563EB] group-hover:translate-x-0.5 transition-all" />
        </button>
      </div>
    </div>
  );
}