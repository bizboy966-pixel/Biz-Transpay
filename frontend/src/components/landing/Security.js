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
    <section id="about" className="py-16 sm:py-20">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 grid lg:grid-cols-2 gap-12 items-center">
        <div>
          <div className="inline-flex items-center gap-2 bg-emerald-50 text-emerald-700 px-3 py-1.5 rounded-full text-xs font-semibold border border-emerald-100">
            <ShieldCheck className="w-3.5 h-3.5" /> {t('security.badge')}
          </div>
          <h2 className="mt-4 font-cabinet text-2xl sm:text-3xl font-extrabold tracking-tighter text-slate-900">{t('security.title')}</h2>
          <p className="mt-3 text-sm text-slate-600 leading-relaxed">{t('security.subtitle')}</p>

          <div className="mt-7 grid sm:grid-cols-2 gap-3">
            {items.map((it, i) => (
              <div key={i} className="bt-reference-card flex items-center gap-3 p-3 bg-white border border-slate-100 rounded-xl shadow-[0_2px_12px_rgba(15,23,42,0.03)]">
                <div className="w-9 h-9 rounded-lg bg-blue-50 text-[#2563EB] flex items-center justify-center">
                  <it.i className="w-4 h-4" strokeWidth={1.75} />
                </div>
                <div className="font-semibold text-sm text-slate-800">{t(`security.${it.k}`)}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Shield illustration */}
        <div className="relative flex items-center justify-center h-[380px]">
          <div className="absolute w-64 h-64 rounded-full bg-blue-100/50 blur-3xl" />
          <div className="absolute w-56 h-56 rounded-full border border-blue-200/60 animate-pulse-glow" />
          <div className="absolute w-44 h-44 rounded-full border border-blue-200/60" />

          <div className="relative">
            <div className="w-40 h-52 rounded-[32px] bg-gradient-to-br from-[#3B82F6] via-[#2563EB] to-[#1D4ED8] shadow-[0_24px_48px_-16px_rgba(37,99,235,0.55)] flex items-center justify-center relative overflow-hidden animate-float">
              <ShieldCheck className="w-20 h-20 text-white" strokeWidth={1.5} />
              <div className="absolute inset-0 border-4 border-white/20 rounded-[32px]" />
              <div className="absolute -bottom-8 left-0 right-0 h-16 bg-white/10 blur-2xl" />
            </div>
            <div className="absolute -bottom-5 left-1/2 -translate-x-1/2 bg-white rounded-xl px-3 py-1.5 shadow-xl border border-slate-100">
              <div className="font-cabinet font-extrabold text-[#2563EB] text-sm text-center">100%</div>
              <div className="text-[9px] font-semibold text-slate-500 uppercase tracking-wider">Sécurisé</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
