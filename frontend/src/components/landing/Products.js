import { useTranslation } from 'react-i18next';
import { BookOpen, GraduationCap, MonitorPlay, Code2, Repeat, FileText, Briefcase, Layers, Download } from 'lucide-react';

const PRODUCTS = [
  { key: 'p1', I: BookOpen, tone: 'bg-blue-50 text-[#2563EB]' },
  { key: 'p2', I: GraduationCap, tone: 'bg-violet-50 text-violet-600' },
  { key: 'p3', I: MonitorPlay, tone: 'bg-pink-50 text-pink-600' },
  { key: 'p4', I: Code2, tone: 'bg-indigo-50 text-indigo-600' },
  { key: 'p5', I: Repeat, tone: 'bg-emerald-50 text-emerald-600' },
  { key: 'p6', I: FileText, tone: 'bg-orange-50 text-orange-600' },
  { key: 'p7', I: Briefcase, tone: 'bg-cyan-50 text-cyan-600' },
  { key: 'p8', I: Layers, tone: 'bg-amber-50 text-amber-600' },
  { key: 'p9', I: Download, tone: 'bg-slate-100 text-slate-700' },
];

export default function Products() {
  const { t } = useTranslation();

  return (
    <section id="products" className="relative py-16 sm:py-20">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="max-w-2xl mb-9">
          <div className="inline-block text-[11px] font-bold uppercase tracking-[0.2em] text-[#2563EB] mb-3">{t('products.eyebrow')}</div>
          <h2 className="font-cabinet text-2xl sm:text-3xl font-extrabold tracking-tight text-slate-900">{t('products.title')}</h2>
          <p className="mt-3 text-sm text-slate-600 max-w-xl">{t('products.subtitle')}</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {PRODUCTS.map(({ key, I, tone }) => (
            <div
              key={key}
              data-testid={`product-card-${key}`}
              className="group flex items-center gap-4 min-h-[112px] rounded-2xl border border-slate-100 bg-white px-5 py-4 shadow-[0_4px_20px_rgb(0,0,0,0.03)] hover:-translate-y-1 hover:border-blue-100 hover:shadow-[0_14px_32px_rgba(37,99,235,0.1)] transition-transform duration-300"
            >
              <div className={`w-11 h-11 shrink-0 rounded-xl ${tone} flex items-center justify-center group-hover:scale-105 transition-transform`}>
                <I className="w-5 h-5" strokeWidth={1.75} />
              </div>
              <h3 className="font-cabinet text-sm font-bold leading-snug text-slate-900">{t(`products.${key}`)}</h3>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}