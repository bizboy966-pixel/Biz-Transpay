import { useTranslation } from 'react-i18next';
import { Users, GraduationCap, ShoppingBag, BookOpen, Code2, Briefcase, Rocket, Globe2 } from 'lucide-react';

const AUDIENCE = [
  { key: 'a1', I: Users },
  { key: 'a2', I: GraduationCap },
  { key: 'a3', I: ShoppingBag },
  { key: 'a4', I: BookOpen },
  { key: 'a5', I: Code2 },
  { key: 'a6', I: Briefcase },
  { key: 'a7', I: Rocket },
  { key: 'a8', I: Globe2 },
];

export default function Audience() {
  const { t } = useTranslation();

  return (
    <section id="audience" className="relative py-16 sm:py-20 bg-white/60">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-2xl mx-auto mb-9">
          <div className="inline-block text-[11px] font-bold uppercase tracking-[0.2em] text-[#2563EB] mb-3">{t('audience.eyebrow')}</div>
          <h2 className="font-cabinet text-2xl sm:text-3xl font-extrabold tracking-tight text-slate-900">{t('audience.title')}</h2>
          <p className="mt-3 text-sm text-slate-600">{t('audience.subtitle')}</p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
          {AUDIENCE.map(({ key, I }) => (
            <div
              key={key}
              data-testid={`audience-card-${key}`}
              className="bt-reference-card group min-h-[132px] rounded-2xl border border-slate-100 bg-white p-5 flex flex-col justify-between shadow-[0_4px_20px_rgb(0,0,0,0.03)] hover:-translate-y-1 hover:border-blue-100 hover:shadow-[0_14px_32px_rgba(37,99,235,0.1)] transition-transform duration-300"
            >
              <div className="w-10 h-10 rounded-xl bg-blue-50 text-[#2563EB] flex items-center justify-center group-hover:bg-[#2563EB] group-hover:text-white transition-colors">
                <I className="w-5 h-5" strokeWidth={1.75} />
              </div>
              <h3 className="mt-5 font-cabinet text-sm font-bold leading-snug text-slate-900">{t(`audience.${key}`)}</h3>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}