import { Link } from 'react-router-dom';

const LOGO_URL = 'https://customer-assets-agu9un31.emergentagent.net/job_secure-pay-preview/artifacts/dqsrigbq_IMG-20260717-WA0050.jpg';

export function Logo({ compact = false, dark = false }) {
  return (
    <Link to="/" className="flex items-center gap-2.5 group" data-testid="brand-logo">
      <div className="relative w-11 h-11 rounded-2xl overflow-hidden bg-white shadow-[0_6px_16px_-6px_rgba(37,99,235,0.35)] ring-1 ring-blue-100 group-hover:scale-105 transition-transform">
        <img src={LOGO_URL} alt="Biz-trans" className="w-full h-full object-cover" />
      </div>
      {!compact && (
        <div className="leading-tight">
          <div className={`font-cabinet font-extrabold text-[18px] ${dark ? 'text-white' : 'text-slate-900'}`}>
            Biz<span className="text-[#2563EB]">-</span>transPay
          </div>
          <div className={`text-[10px] font-semibold tracking-[0.18em] uppercase ${dark ? 'text-white/60' : 'text-slate-400'}`}>Passerelle de paiement</div>
        </div>
      )}
    </Link>
  );
}
