import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';

export default function Policy() {
  const { t } = useTranslation();
  return (
    <section className="py-6 sm:py-8">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="bg-red-50 border border-red-200 rounded-2xl p-5 sm:p-6 flex items-start gap-4 shadow-sm">
          <div className="w-10 h-10 rounded-xl bg-red-500 text-white flex items-center justify-center shrink-0 shadow-lg shadow-red-500/30">
            <AlertTriangle className="w-5 h-5" strokeWidth={2} />
          </div>
          <div>
            <h3 className="font-cabinet text-lg font-bold text-red-700">{t('policy.title')}</h3>
            <p className="mt-1 text-sm text-slate-700 leading-relaxed">{t('policy.body')}</p>
            <p className="mt-2 text-sm font-bold text-red-600">{t('policy.warn')}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
