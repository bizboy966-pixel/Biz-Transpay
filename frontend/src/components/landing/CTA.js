import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Rocket } from 'lucide-react';

export default function CTA() {
  const { t } = useTranslation();
  return (
    <section className="py-16 sm:py-24">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="relative rounded-[32px] bg-gradient-to-br from-[#3B82F6] via-[#2563EB] to-[#1D4ED8] p-10 sm:p-14 overflow-hidden">
          <div className="absolute -top-16 -right-16 w-64 h-64 rounded-full bg-white/10 blur-3xl" />
          <div className="absolute bottom-0 left-1/3 w-64 h-64 rounded-full bg-cyan-300/20 blur-3xl" />
          <div className="absolute inset-0 bt-worldmap opacity-20" />

          <div className="relative flex flex-col md:flex-row items-start md:items-center justify-between gap-8">
            <div className="flex items-start gap-5">
              <div className="w-14 h-14 rounded-2xl bg-white text-[#2563EB] flex items-center justify-center shrink-0 shadow-xl">
                <Rocket className="w-7 h-7" strokeWidth={1.75} />
              </div>
              <div>
                <h2 className="font-cabinet text-3xl sm:text-4xl font-extrabold text-white tracking-tighter leading-tight">
                  {t('cta.title')}
                </h2>
                <p className="mt-2 text-white/85 text-base sm:text-lg">{t('cta.subtitle')}</p>
              </div>
            </div>
            <Link
              to="/register"
              data-testid="cta-start"
              className="group inline-flex items-center gap-2 bg-white text-[#2563EB] font-bold px-8 py-4 rounded-full shadow-[0_10px_30px_rgba(0,0,0,0.15)] hover:-translate-y-0.5 transition-transform whitespace-nowrap"
            >
              {t('cta.button')}
              <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
