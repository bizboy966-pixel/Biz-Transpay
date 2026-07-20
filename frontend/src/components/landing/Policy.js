import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';

export default function Policy() {
  const { t } = useTranslation();
  return (
    <section className="py-8 sm:py-12">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="bg-red-50 border border-red-200 rounded-[24px] p-6 sm:p-8 flex items-start gap-5 shadow-sm">
          <div className="w-12 h-12 rounded-2xl bg-red-500 text-white flex items-center justify-center shrink-0 shadow-lg shadow-red-500/30">
            <AlertTriangle className="w-6 h-6" strokeWidth={2} />
          </div>
          <div>
            <h3 className="font-cabinet text-xl sm:text-2xl font-bold text-red-700">{t('policy.title')}</h3>
            <p className="mt-2 text-slate-700 leading-relaxed">{t('policy.body')}</p>
            <p className="mt-3 font-bold text-red-600">{t('policy.warn')}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
