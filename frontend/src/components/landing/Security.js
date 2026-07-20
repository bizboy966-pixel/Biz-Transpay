import { useTranslation } from 'react-i18next';
import { Lock, IdCard, KeyRound, Shield, Activity, ShieldCheck } from 'lucide-react';

export default function Security() {
  const { t } = useTranslation();
  const items = [
    { i: Lock, k: 's1' },
    { i: IdCard, k: 's2' },
    { i: KeyRound, k: 's3' },
    { i: Shield, k: 's4' },
    { i: Activity, k: 's5' },
  ];
  return (
    <section id="about" className="py-24 sm:py-32">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 grid lg:grid-cols-2 gap-16 items-center">
        <div>
          <div className="inline-flex items-center gap-2 bg-emerald-50 text-emerald-700 px-4 py-2 rounded-full text-sm font-semibold border border-emerald-100">
            <ShieldCheck className="w-4 h-4" /> {t('security.badge')}
          </div>
          <h2 className="mt-6 font-cabinet text-4xl sm:text-5xl font-extrabold tracking-tighter text-slate-900">{t('security.title')}</h2>
          <p className="mt-4 text-slate-600 text-lg leading-relaxed">{t('security.subtitle')}</p>

          <div className="mt-10 grid sm:grid-cols-2 gap-4">
            {items.map((it, i) => (
              <div key={i} className="flex items-center gap-4 p-4 bg-white border border-slate-100 rounded-2xl shadow-[0_4px_16px_rgba(15,23,42,0.04)]">
                <div className="w-11 h-11 rounded-xl bg-blue-50 text-[#2563EB] flex items-center justify-center">
                  <it.i className="w-5 h-5" strokeWidth={1.75} />
                </div>
                <div className="font-semibold text-slate-800">{t(`security.${it.k}`)}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Shield illustration */}
        <div className="relative flex items-center justify-center h-[500px]">
          <div className="absolute w-80 h-80 rounded-full bg-blue-100/50 blur-3xl" />
          <div className="absolute w-72 h-72 rounded-full border border-blue-200/60 animate-pulse-glow" />
          <div className="absolute w-56 h-56 rounded-full border border-blue-200/60" />

          <div className="relative">
            <div className="w-52 h-64 rounded-[40px] bg-gradient-to-br from-[#3B82F6] via-[#2563EB] to-[#1D4ED8] shadow-[0_30px_60px_-15px_rgba(37,99,235,0.6)] flex items-center justify-center relative overflow-hidden animate-float">
              <ShieldCheck className="w-28 h-28 text-white" strokeWidth={1.5} />
              <div className="absolute inset-0 border-4 border-white/20 rounded-[40px]" />
              <div className="absolute -bottom-8 left-0 right-0 h-16 bg-white/10 blur-2xl" />
            </div>
            <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 bg-white rounded-2xl px-4 py-2 shadow-xl border border-slate-100">
              <div className="font-cabinet font-extrabold text-[#2563EB]">100%</div>
              <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Sécurisé</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
