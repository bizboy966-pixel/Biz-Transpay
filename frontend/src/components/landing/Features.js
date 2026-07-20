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
    <section id="services" className="relative py-24 sm:py-32">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-2xl mx-auto mb-16">
          <div className="inline-block text-xs font-bold uppercase tracking-[0.2em] text-[#2563EB] mb-4">Services</div>
          <h2 className="font-cabinet text-4xl sm:text-5xl font-extrabold tracking-tighter text-slate-900">{t('features.title')}</h2>
          <p className="mt-4 text-slate-600 text-lg">{t('features.subtitle')}</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {feats.map((f) => {
            const { I, bg, color } = iconMap[f];
            return (
              <div
                key={f}
                data-testid={`feature-card-${f}`}
                className="group bg-white p-8 rounded-[24px] border border-slate-100 shadow-[0_8px_30px_rgb(0,0,0,0.04)] hover:shadow-[0_20px_50px_rgba(37,99,235,0.15)] hover:-translate-y-1.5 hover:border-blue-100 transition-transform duration-300"
              >
                <div className={`w-14 h-14 ${bg} ${color} rounded-2xl flex items-center justify-center group-hover:scale-110 transition-transform`}>
                  <I className="w-6 h-6" strokeWidth={1.75} />
                </div>
                <h3 className="mt-6 font-cabinet text-xl font-bold text-slate-900">{t(`features.${f}_t`)}</h3>
                <p className="mt-2 text-slate-600 leading-relaxed">{t(`features.${f}_d`)}</p>
                <div className="mt-6 inline-flex items-center gap-1.5 text-sm font-semibold text-[#2563EB] opacity-0 group-hover:opacity-100 transition-opacity">
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
