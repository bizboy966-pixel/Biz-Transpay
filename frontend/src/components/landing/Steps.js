import { useTranslation } from 'react-i18next';
import { UserPlus, PackagePlus, Share2, BarChart3 } from 'lucide-react';

const STEPS = [
  { key: 's1', I: UserPlus },
  { key: 's2', I: PackagePlus },
  { key: 's3', I: Share2 },
  { key: 's4', I: BarChart3 },
];

export default function Steps() {
  const { t } = useTranslation();

  return (
    <section id="steps" className="relative py-16 sm:py-20">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-2xl mx-auto mb-10">
          <div className="inline-block text-[11px] font-bold uppercase tracking-[0.2em] text-[#2563EB] mb-3">{t('steps.eyebrow')}</div>
          <h2 className="font-cabinet text-2xl sm:text-3xl font-extrabold tracking-tight text-slate-900">{t('steps.title')}</h2>
          <p className="mt-3 text-sm text-slate-600">{t('steps.subtitle')}</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {STEPS.map(({ key, I }, index) => (
            <div key={key} data-testid={`step-card-${key}`} className="relative rounded-2xl border border-slate-100 bg-white p-6 shadow-[0_4px_20px_rgb(0,0,0,0.03)]">
              <div className="flex items-center justify-between">
                <div className="w-11 h-11 rounded-xl bg-[#2563EB] text-white flex items-center justify-center shadow-[0_8px_18px_rgba(37,99,235,0.22)]">
                  <I className="w-5 h-5" strokeWidth={1.75} />
                </div>
                <span className="font-cabinet text-3xl font-extrabold text-blue-100">0{index + 1}</span>
              </div>
              <h3 className="mt-6 font-cabinet text-base font-bold text-slate-900">{t(`steps.${key}_t`)}</h3>
              <p className="mt-2 text-sm text-slate-600 leading-relaxed">{t(`steps.${key}_d`)}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}