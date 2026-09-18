import { Link } from 'react-router-dom';
import { SafeImage } from './SafeImage';

const LOGO_URL = '/logo-mark.png';

function LogoFallback() {
  return (
    <span className="flex h-full w-full items-center justify-center bg-gradient-to-br from-[#3B82F6] via-[#2563EB] to-[#1D4ED8] text-white">
      <span className="text-[13px] font-black tracking-[-0.12em]">BT</span>
    </span>
  );
}

export function Logo({ compact = false, dark = false }) {
  return (
    <Link to="/" className="flex items-center gap-2.5 group" data-testid="brand-logo">
      <div className="relative w-11 h-11 shrink-0 rounded-2xl overflow-hidden bg-white shadow-[0_6px_16px_-6px_rgba(37,99,235,0.35)] ring-1 ring-blue-100 group-hover:scale-105 transition-transform">
        <SafeImage
          src={LOGO_URL}
          alt="Biz-transPay"
          className="w-full h-full object-contain p-0.5"
          fallback={<LogoFallback />}
        />
      </div>
      {!compact && (
        <div className="leading-tight shrink-0 whitespace-nowrap">
          <div className={`font-cabinet font-extrabold text-[18px] whitespace-nowrap ${dark ? 'text-white' : 'text-slate-900'}`}>
            Biz<span className="text-[#2563EB]">-</span>transPay
          </div>
          <div className={`whitespace-nowrap text-[10px] font-semibold tracking-[0.14em] uppercase ${dark ? 'text-white/60' : 'text-slate-400'}`}>Vendre en ligne</div>
        </div>
      )}
    </Link>
  );
}
