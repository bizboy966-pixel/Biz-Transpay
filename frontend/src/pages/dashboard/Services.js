import { Link2, ArrowRight, ShieldCheck, Code2, Smartphone, Send } from 'lucide-react';
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
          data-testid="service-api"
          onClick={() => navigate('/dashboard/api')}
          className="group flex w-full items-center gap-4 text-left bg-slate-950 text-white border border-slate-800 rounded-2xl p-5 shadow-[0_12px_30px_rgba(15,23,42,0.16)] hover:-translate-y-0.5 hover:shadow-[0_18px_36px_rgba(15,23,42,0.22)] transition-all"
        >
          <div className="w-12 h-12 shrink-0 rounded-xl bg-blue-500/15 text-blue-300 flex items-center justify-center">
            <Code2 className="w-5 h-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-cabinet font-bold text-sm">Espace développeur API</h2>
              <span className="rounded-full border border-blue-400/25 bg-blue-400/10 px-2 py-0.5 text-[10px] font-bold text-blue-200">API v1</span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-slate-300">Clés test et live, guides d'intégration et webhooks signés pour vos paiements Mobile Money.</p>
            <div className="mt-3 flex flex-wrap gap-2 text-[10px] font-semibold text-slate-300">
              <span className="rounded-md bg-white/10 px-2 py-1">Checkout</span>
              <span className="rounded-md bg-white/10 px-2 py-1">Direct</span>
              <span className="rounded-md bg-white/10 px-2 py-1">BizPUSH</span>
            </div>
          </div>
          <ArrowRight className="w-4 h-4 shrink-0 text-slate-500 group-hover:text-blue-300 group-hover:translate-x-0.5 transition-all" />
        </button>
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
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[
            { icon: Link2, title: 'BizPay Checkout', text: 'Redirigez vers une page de paiement hébergée.' },
            { icon: Smartphone, title: 'BizPay Direct', text: 'Déclenchez Mobile Money sans redirection.' },
            { icon: Send, title: 'BizPUSH', text: 'Automatisez les envois vers vos bénéficiaires.' },
          ].map(({ icon: Icon, title, text }) => (
            <div key={title} className="rounded-xl border border-slate-200 bg-white p-4">
              <Icon className="h-4 w-4 text-blue-600" />
              <div className="mt-3 text-sm font-bold text-slate-900">{title}</div>
              <p className="mt-1 text-xs leading-relaxed text-slate-500">{text}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}