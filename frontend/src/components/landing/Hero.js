import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Play, ShieldCheck, Link2, BarChart3, Share2, ShoppingBag } from 'lucide-react';

export default function Hero() {
  const { t } = useTranslation();
  return (
    <section className="relative pt-24 pb-12 sm:pt-28 sm:pb-16 overflow-hidden">
      {/* World map bg */}
      <div className="absolute inset-0 bt-worldmap pointer-events-none" />
      {/* Radial glow */}
      <div className="absolute -top-32 -right-32 w-[500px] h-[500px] rounded-full bg-blue-100/50 blur-3xl pointer-events-none" />
      <div className="absolute top-40 -left-20 w-[350px] h-[350px] rounded-full bg-blue-200/30 blur-3xl pointer-events-none" />

      <div className="relative max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 grid lg:grid-cols-[1.05fr_1fr] gap-8 lg:gap-12 items-center">
        {/* LEFT */}
        <div>
          <div className="inline-flex items-center gap-2 bg-blue-50 text-[#2563EB] px-3 py-1.5 rounded-full text-xs font-semibold border border-blue-100 mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-[#2563EB] animate-pulse" />
            {t('hero.badge')}
          </div>

          <h1 className="font-cabinet text-3xl sm:text-4xl lg:text-5xl font-extrabold tracking-tighter text-slate-900 leading-[1.08]">
            {t('hero.title_1')}
            <br />
            {t('hero.title_2')}{' '}
            <span className="bg-gradient-to-r from-[#3B82F6] to-[#1D4ED8] bg-clip-text text-transparent">{t('hero.title_3_a')}</span>
            <br />
            {t('hero.title_3_b')}{' '}
            <span className="bg-gradient-to-r from-[#3B82F6] to-[#1D4ED8] bg-clip-text text-transparent">{t('hero.title_3_c')}</span>
          </h1>

          <p className="mt-5 text-sm sm:text-base text-slate-600 max-w-lg leading-relaxed">{t('hero.subtitle')}</p>

          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Link
              to="/register"
              data-testid="hero-cta-start"
              className="group inline-flex items-center gap-2 bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-sm font-semibold px-6 py-3 rounded-full shadow-[0_8px_20px_-6px_rgba(37,99,235,0.5)] hover:-translate-y-0.5 transition-transform"
            >
              {t('hero.cta_start')}
              <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
            </Link>
            <a
              href="#services"
              data-testid="hero-cta-discover"
              className="inline-flex items-center gap-2.5 text-slate-700 text-sm font-semibold hover:text-[#2563EB] transition-colors"
            >
              <span className="w-9 h-9 rounded-full bg-white border border-slate-200 shadow-sm flex items-center justify-center">
                <Play className="w-3.5 h-3.5 fill-[#2563EB] text-[#2563EB]" />
              </span>
              {t('hero.cta_discover')}
            </a>
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-6 text-xs text-slate-500">
            <div className="flex items-center gap-1.5"><Share2 className="w-4 h-4 text-emerald-500" /> {t('hero.proof_1')}</div>
            <div className="flex items-center gap-1.5"><ShoppingBag className="w-4 h-4 text-emerald-500" /> {t('hero.proof_2')}</div>
            <div className="flex items-center gap-1.5"><BarChart3 className="w-4 h-4 text-emerald-500" /> {t('hero.proof_3')}</div>
          </div>
        </div>

        {/* RIGHT - Phone mockup */}
        <div className="relative h-[480px] sm:h-[520px] flex items-center justify-center">
          {/* Floating product bubble */}
          <div className="absolute left-2 sm:left-6 top-16 animate-float-slow z-20">
            <div className="w-12 h-12 rounded-full bg-white shadow-[0_8px_24px_rgba(37,99,235,0.22)] border border-blue-100 flex items-center justify-center font-cabinet font-extrabold text-[#2563EB] text-sm">PDF</div>
          </div>
          {/* Floating link bubble */}
          <div className="absolute right-2 sm:right-4 top-24 animate-float z-20">
            <div className="w-12 h-12 rounded-full bg-gradient-to-br from-emerald-400 to-emerald-500 shadow-[0_8px_24px_rgba(16,185,129,0.3)] flex items-center justify-center font-cabinet font-extrabold text-white text-sm">URL</div>
          </div>
          {/* Security badge */}
          <div className="absolute right-2 sm:right-0 bottom-16 z-20 animate-float">
            <div className="bg-white rounded-xl px-3 py-2 shadow-[0_16px_32px_rgba(15,23,42,0.08)] border border-slate-100 flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center"><ShieldCheck className="w-4 h-4 text-white" /></div>
              <div>
                <div className="text-[9px] text-slate-500 font-semibold uppercase tracking-wider">Sécurité</div>
                <div className="text-xs font-bold text-slate-900">{t('hero.secure')}</div>
              </div>
            </div>
          </div>

          {/* Pulsing circles */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-[320px] h-[320px] rounded-full border border-blue-200/50 animate-pulse-glow" />
          </div>

          {/* Phone */}
          <div className="relative w-[230px] sm:w-[250px] h-[480px] rounded-[38px] bg-gradient-to-b from-slate-900 to-slate-800 p-1.5 shadow-[0_30px_60px_-20px_rgba(15,23,42,0.35)] animate-float">
            <div className="absolute top-3 left-1/2 -translate-x-1/2 w-20 h-5 bg-slate-900 rounded-b-2xl z-30" />
            <div className="w-full h-full rounded-[32px] bg-white overflow-hidden relative">
              {/* Screen content */}
              <div className="absolute inset-0 bg-gradient-to-b from-blue-50 to-white p-4 pt-8">
                {/* Balance card */}
                <div className="rounded-xl bg-gradient-to-br from-[#3B82F6] via-[#2563EB] to-[#1D4ED8] p-3 text-white relative overflow-hidden">
                  <div className="text-[9px] uppercase tracking-wider text-white/70 font-semibold">{t('hero.balance')}</div>
                  <div className="mt-1 font-cabinet text-lg font-extrabold">2,450,000 <span className="text-[10px] opacity-80">XOF</span></div>
                   <div className="mt-2 text-[9px] font-mono opacity-70">Votre activité en un coup d’œil</div>
                  <div className="absolute -right-4 -bottom-4 w-20 h-20 rounded-full bg-white/10" />
                </div>
                {/* Quick actions */}
                <div className="grid grid-cols-4 gap-1.5 mt-3">
                     {[
                       { i: ShoppingBag, c: 'bg-emerald-50 text-emerald-600', l: t('hero.quick_sell') },
                       { i: Link2, c: 'bg-blue-50 text-blue-600', l: t('hero.quick_link') },
                       { i: BarChart3, c: 'bg-violet-50 text-violet-600', l: t('hero.quick_track') },
                       { i: Share2, c: 'bg-orange-50 text-orange-600', l: t('hero.quick_share') },
                  ].map((a, i) => (
                    <div key={i} className="flex flex-col items-center gap-1">
                      <div className={`w-8 h-8 rounded-lg ${a.c} flex items-center justify-center`}>
                        <a.i className="w-3.5 h-3.5" />
                      </div>
                      <div className="text-[8px] font-semibold text-slate-700">{a.l}</div>
                    </div>
                  ))}
                </div>
                {/* Transactions */}
                <div className="mt-4">
                  <div className="flex items-center justify-between">
                    <div className="text-[10px] font-bold text-slate-800">{t('hero.recent')}</div>
                    <div className="text-[9px] text-[#2563EB] font-semibold">{t('hero.see_all')}</div>
                  </div>
                  <div className="mt-1.5 space-y-1">
                     {[
                       { l: t('hero.sale_received'), a: '+250,000', c: 'text-emerald-600', bg: 'bg-emerald-100' },
                       { l: t('hero.product_order'), a: '+120,000', c: 'text-emerald-600', bg: 'bg-blue-100' },
                       { l: t('hero.shared_link'), a: '+80,000', c: 'text-emerald-600', bg: 'bg-violet-100' },
                       { l: t('hero.subscription'), a: '+200,000', c: 'text-emerald-600', bg: 'bg-orange-100' },
                    ].map((tx, i) => (
                      <div key={i} className="flex items-center gap-1.5 bg-white rounded-lg p-1.5 border border-slate-100">
                        <div className={`w-5 h-5 rounded ${tx.bg}`} />
                        <div className="flex-1 min-w-0">
                          <div className="text-[9px] font-semibold text-slate-800 truncate">{tx.l}</div>
                          <div className="text-[8px] text-slate-400">Aujourd&apos;hui</div>
                        </div>
                        <div className={`text-[9px] font-bold ${tx.c}`}>{tx.a}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Small circles decor */}
          <div className="absolute left-4 bottom-6 w-3 h-3 rounded-full bg-blue-400 animate-float-slow" />
          <div className="absolute right-12 top-2 w-2.5 h-2.5 rounded-full bg-emerald-400 animate-float" />
        </div>
      </div>
    </section>
  );
}
