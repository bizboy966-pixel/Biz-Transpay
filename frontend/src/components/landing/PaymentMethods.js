import { useTranslation } from 'react-i18next';
import Marquee from 'react-fast-marquee';

const METHODS = [
  { name: 'Wave', bg: '#1DC8CD', text: '#fff' },
  { name: 'MTN Mobile Money', bg: '#FFCC00', text: '#00394F', short: 'MTN' },
  { name: 'Moov Money', bg: '#0068B7', text: '#fff', short: 'Moov' },
  { name: 'TMoney', bg: '#0B3D91', text: '#F9C300' },
  { name: 'Airtel Money', bg: '#ED1C24', text: '#fff', short: 'airtel' },
  { name: 'Flooz', bg: '#FFD400', text: '#0B0B0B' },
  { name: 'Orange Money', bg: '#FF6600', text: '#fff', short: 'Orange' },
  { name: 'M-Pesa', bg: '#00A651', text: '#fff' },
  { name: 'Visa', bg: '#1A1F71', text: '#fff' },
  { name: 'Mastercard', bg: '#fff', text: '#EB001B' },
];

function LogoChip({ m }) {
  return (
    <div
      className="mx-2 flex items-center justify-center min-w-[140px] h-[56px] rounded-xl border border-slate-100 bg-white shadow-[0_2px_12px_rgba(15,23,42,0.04)] hover:shadow-[0_6px_20px_rgba(37,99,235,0.12)] hover:-translate-y-0.5 transition-transform"
      data-testid={`method-${m.name.toLowerCase().replace(/\s+/g,'-')}`}
    >
      <div
        className="px-3.5 py-1.5 rounded-lg font-cabinet font-extrabold text-sm"
        style={{ background: m.bg, color: m.text }}
      >
        {m.short || m.name}
      </div>
    </div>
  );
}

export default function PaymentMethods() {
  const { t } = useTranslation();
  return (
    <section className="relative py-14 sm:py-16 bg-gradient-to-b from-white to-slate-50">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-xl mx-auto mb-8">
          <div className="inline-block text-[11px] font-bold uppercase tracking-[0.2em] text-[#2563EB] mb-2">Partenaires</div>
          <h2 className="font-cabinet text-xl sm:text-2xl font-extrabold tracking-tight text-slate-900">{t('methods.title')}</h2>
          <p className="mt-2 text-sm text-slate-600">{t('methods.subtitle')}</p>
        </div>

        <div className="relative">
          <div className="absolute left-0 top-0 bottom-0 w-24 bg-gradient-to-r from-slate-50 to-transparent z-10 pointer-events-none" />
          <div className="absolute right-0 top-0 bottom-0 w-24 bg-gradient-to-l from-slate-50 to-transparent z-10 pointer-events-none" />
          <Marquee gradient={false} speed={40} pauseOnHover>
            {METHODS.map((m) => <LogoChip key={m.name} m={m} />)}
          </Marquee>
        </div>
      </div>
    </section>
  );
}
