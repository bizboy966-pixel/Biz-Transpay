import { Link } from 'react-router-dom';

export function Logo({ compact = false, dark = false }) {
  return (
    <Link to="/" className="flex items-center gap-3 group" data-testid="brand-logo">
      <div className="relative">
        <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-[#3B82F6] via-[#2563EB] to-[#1D4ED8] flex items-center justify-center shadow-[0_6px_16px_-6px_rgba(37,99,235,0.6)] group-hover:scale-105 transition-transform">
          <span className="text-white font-cabinet font-extrabold text-xl leading-none">B</span>
          <span className="absolute right-1.5 bottom-1.5 w-2 h-2 rounded-full bg-white/90" />
        </div>
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
