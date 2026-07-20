import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Rocket } from 'lucide-react';

export default function CTA() {
  const { t } = useTranslation();
  return (
    <section className="py-12 sm:py-16">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="relative rounded-[24px] bg-gradient-to-br from-[#3B82F6] via-[#2563EB] to-[#1D4ED8] p-8 sm:p-10 overflow-hidden">
          <div className="absolute -top-12 -right-12 w-52 h-52 rounded-full bg-white/10 blur-3xl" />
          <div className="absolute bottom-0 left-1/3 w-52 h-52 rounded-full bg-cyan-300/20 blur-3xl" />
          <div className="absolute inset-0 bt-worldmap opacity-20" />

          <div className="relative flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
            <div className="flex items-start gap-4">
              <div className="w-11 h-11 rounded-xl bg-white text-[#2563EB] flex items-center justify-center shrink-0 shadow-xl">
                <Rocket className="w-5 h-5" strokeWidth={1.75} />
              </div>
              <div>
                <h2 className="font-cabinet text-xl sm:text-2xl font-extrabold text-white tracking-tighter leading-tight">
                  {t('cta.title')}
                </h2>
                <p className="mt-1.5 text-white/85 text-sm">{t('cta.subtitle')}</p>
              </div>
            </div>
            <Link
              to="/register"
              data-testid="cta-start"
              className="group inline-flex items-center gap-2 bg-white text-[#2563EB] text-sm font-bold px-6 py-3 rounded-full shadow-[0_8px_24px_rgba(0,0,0,0.12)] hover:-translate-y-0.5 transition-transform whitespace-nowrap"
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
