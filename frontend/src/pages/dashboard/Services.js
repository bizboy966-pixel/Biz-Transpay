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

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <button
          type="button"
          data-testid="service-payment-link"
          onClick={() => navigate('/dashboard/links')}
          className="group text-left bg-white border border-slate-100 rounded-2xl p-5 shadow-[0_2px_10px_rgba(15,23,42,0.03)] hover:border-blue-200 hover:shadow-[0_8px_24px_rgba(37,99,235,0.08)] transition-all"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="w-11 h-11 rounded-xl bg-violet-50 text-violet-600 flex items-center justify-center">
              <Link2 className="w-5 h-5" />
            </div>
            <ArrowRight className="w-4 h-4 text-slate-300 group-hover:text-[#2563EB] group-hover:translate-x-0.5 transition-all" />
          </div>
          <h2 className="mt-4 font-cabinet font-bold text-sm text-slate-900">Lien de paiement</h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">Créez une page de paiement personnalisée pour vos produits et services.</p>
          <div className="mt-4 inline-flex items-center gap-1.5 text-[10px] font-bold text-[#2563EB]">
            <ShieldCheck className="w-3.5 h-3.5" /> Paiement sécurisé
          </div>
        </button>
      </div>
    </div>
  );
}