import { useTranslation } from 'react-i18next';
import { CreditCard, Send, Repeat, Link2, ShoppingBag, Code2 } from 'lucide-react';

const iconMap = {
  f1: { I: CreditCard, bg: 'bg-blue-50', color: 'text-[#2563EB]' },
  f2: { I: Send, bg: 'bg-emerald-50', color: 'text-emerald-600' },
  f3: { I: Repeat, bg: 'bg-violet-50', color: 'text-violet-600' },
  f4: { I: Link2, bg: 'bg-orange-50', color: 'text-orange-600' },
  f5: { I: ShoppingBag, bg: 'bg-pink-50', color: 'text-pink-600' },
  f6: { I: Code2, bg: 'bg-indigo-50', color: 'text-indigo-600' },
};

export default function Features() {
  const { t } = useTranslation();
  const feats = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'];
  return (
    <section id="services" className="relative py-16 sm:py-20">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-xl mx-auto mb-10">
          <div className="inline-block text-[11px] font-bold uppercase tracking-[0.2em] text-[#2563EB] mb-3">Services</div>
          <h2 className="font-cabinet text-2xl sm:text-3xl font-extrabold tracking-tight text-slate-900">{t('features.heading')}</h2>
          <p className="mt-3 text-sm text-slate-600">{t('features.subtitle')}</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {feats.map((f) => {
            const { I, bg, color } = iconMap[f];
            return (
              <div
                key={f}
                data-testid={`feature-card-${f}`}
                className="group bg-white p-6 rounded-2xl border border-slate-100 shadow-[0_4px_20px_rgb(0,0,0,0.03)] hover:shadow-[0_12px_32px_rgba(37,99,235,0.12)] hover:-translate-y-1 hover:border-blue-100 transition-transform duration-300"
              >
                <div className={`w-11 h-11 ${bg} ${color} rounded-xl flex items-center justify-center group-hover:scale-110 transition-transform`}>
                  <I className="w-5 h-5" strokeWidth={1.75} />
                </div>
                <h3 className="mt-4 font-cabinet text-base font-bold text-slate-900">{t(`features.${f}_t`)}</h3>
                <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">{t(`features.${f}_d`)}</p>
                <div className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-[#2563EB] opacity-0 group-hover:opacity-100 transition-opacity">
                  En savoir plus →
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
