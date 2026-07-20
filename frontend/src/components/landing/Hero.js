import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Play, ShieldCheck, Lock, TrendingUp, ArrowUpRight, ArrowDownLeft, Repeat, Link2 } from 'lucide-react';

export default function Hero() {
  const { t } = useTranslation();
  return (
    <section className="relative pt-32 pb-16 sm:pt-40 sm:pb-24 overflow-hidden">
      {/* World map bg */}
      <div className="absolute inset-0 bt-worldmap pointer-events-none" />
      {/* Radial glow */}
      <div className="absolute -top-32 -right-32 w-[600px] h-[600px] rounded-full bg-blue-100/50 blur-3xl pointer-events-none" />
      <div className="absolute top-40 -left-20 w-[400px] h-[400px] rounded-full bg-blue-200/30 blur-3xl pointer-events-none" />

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 grid lg:grid-cols-[1.05fr_1fr] gap-12 lg:gap-16 items-center">
        {/* LEFT */}
        <div>
          <div className="inline-flex items-center gap-2 bg-blue-50 text-[#2563EB] px-4 py-2 rounded-full text-sm font-semibold border border-blue-100 mb-8">
            <span className="w-2 h-2 rounded-full bg-[#2563EB] animate-pulse" />
            {t('hero.badge')}
          </div>

          <h1 className="font-cabinet text-5xl sm:text-6xl lg:text-7xl font-extrabold tracking-tighter text-slate-900 leading-[1.02]">
            {t('hero.title_1')}
            <br />
            {t('hero.title_2')}{' '}
            <span className="bg-gradient-to-r from-[#3B82F6] to-[#1D4ED8] bg-clip-text text-transparent">{t('hero.title_3_a')}</span>
            <br />
            {t('hero.title_3_b')}{' '}
            <span className="bg-gradient-to-r from-[#3B82F6] to-[#1D4ED8] bg-clip-text text-transparent">{t('hero.title_3_c')}</span>
          </h1>

          <p className="mt-6 text-lg text-slate-600 max-w-xl leading-relaxed">{t('hero.subtitle')}</p>

          <div className="mt-10 flex flex-wrap items-center gap-4">
            <Link
              to="/register"
              data-testid="hero-cta-start"
              className="group inline-flex items-center gap-2 bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-semibold px-8 py-4 rounded-full shadow-[0_10px_30px_-8px_rgba(37,99,235,0.6)] hover:-translate-y-0.5 transition-transform"
            >
              {t('hero.cta_start')}
              <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
            </Link>
            <a
              href="#services"
              data-testid="hero-cta-discover"
              className="inline-flex items-center gap-3 text-slate-700 font-semibold hover:text-[#2563EB] transition-colors"
            >
              <span className="w-10 h-10 rounded-full bg-white border border-slate-200 shadow-sm flex items-center justify-center">
                <Play className="w-4 h-4 fill-[#2563EB] text-[#2563EB]" />
              </span>
              {t('hero.cta_discover')}
            </a>
          </div>

          <div className="mt-12 flex flex-wrap items-center gap-8 text-sm text-slate-500">
            <div className="flex items-center gap-2"><ShieldCheck className="w-5 h-5 text-emerald-500" /> PCI-DSS</div>
            <div className="flex items-center gap-2"><Lock className="w-5 h-5 text-emerald-500" /> SSL 256-bit</div>
            <div className="flex items-center gap-2"><TrendingUp className="w-5 h-5 text-emerald-500" /> 99.9% uptime</div>
          </div>
        </div>

        {/* RIGHT - Phone mockup */}
        <div className="relative h-[600px] sm:h-[640px] flex items-center justify-center">
          {/* Floating XOF bubble */}
          <div className="absolute left-2 sm:left-10 top-24 animate-float-slow z-20">
            <div className="w-16 h-16 rounded-full bg-white shadow-[0_10px_30px_rgba(37,99,235,0.25)] border border-blue-100 flex items-center justify-center font-cabinet font-extrabold text-[#2563EB] text-lg">XOF</div>
          </div>
          {/* Floating XAF bubble */}
          <div className="absolute right-2 sm:right-6 top-32 animate-float z-20">
            <div className="w-16 h-16 rounded-full bg-gradient-to-br from-emerald-400 to-emerald-500 shadow-[0_10px_30px_rgba(16,185,129,0.35)] flex items-center justify-center font-cabinet font-extrabold text-white text-lg">XAF</div>
          </div>
          {/* Security badge */}
          <div className="absolute right-4 sm:right-0 bottom-24 z-20 animate-float">
            <div className="bg-white rounded-2xl px-4 py-3 shadow-[0_20px_40px_rgba(15,23,42,0.08)] border border-slate-100 flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-blue-600 flex items-center justify-center"><ShieldCheck className="w-5 h-5 text-white" /></div>
              <div>
                <div className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider">Sécurité</div>
                <div className="text-sm font-bold text-slate-900">100% Sécurisé</div>
              </div>
            </div>
          </div>

          {/* Pulsing circles */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-[380px] h-[380px] rounded-full border border-blue-200/50 animate-pulse-glow" />
          </div>

          {/* Phone */}
          <div className="relative w-[280px] sm:w-[300px] h-[580px] rounded-[46px] bg-gradient-to-b from-slate-900 to-slate-800 p-2 shadow-[0_40px_80px_-20px_rgba(15,23,42,0.35)] animate-float">
            <div className="absolute top-4 left-1/2 -translate-x-1/2 w-24 h-6 bg-slate-900 rounded-b-2xl z-30" />
            <div className="w-full h-full rounded-[38px] bg-white overflow-hidden relative">
              {/* Screen content */}
              <div className="absolute inset-0 bg-gradient-to-b from-blue-50 to-white p-5 pt-10">
                {/* Balance card */}
                <div className="rounded-2xl bg-gradient-to-br from-[#3B82F6] via-[#2563EB] to-[#1D4ED8] p-4 text-white relative overflow-hidden">
                  <div className="text-[10px] uppercase tracking-wider text-white/70 font-semibold">{t('hero.balance')}</div>
                  <div className="mt-1 font-cabinet text-2xl font-extrabold">2,450,000 <span className="text-sm opacity-80">XOF</span></div>
                  <div className="mt-3 text-[10px] font-mono opacity-70">•••• •••• •••• 4242</div>
                  <div className="absolute -right-6 -bottom-6 w-24 h-24 rounded-full bg-white/10" />
                </div>
                {/* Quick actions */}
                <div className="grid grid-cols-4 gap-2 mt-4">
                  {[
                    { i: ArrowUpRight, c: 'bg-emerald-50 text-emerald-600', l: 'Transfer' },
                    { i: ArrowDownLeft, c: 'bg-blue-50 text-blue-600', l: 'Dépôt' },
                    { i: Link2, c: 'bg-violet-50 text-violet-600', l: 'Lien' },
                    { i: Repeat, c: 'bg-orange-50 text-orange-600', l: 'Échange' },
                  ].map((a, i) => (
                    <div key={i} className="flex flex-col items-center gap-1">
                      <div className={`w-10 h-10 rounded-xl ${a.c} flex items-center justify-center`}>
                        <a.i className="w-4 h-4" />
                      </div>
                      <div className="text-[9px] font-semibold text-slate-700">{a.l}</div>
                    </div>
                  ))}
                </div>
                {/* Transactions */}
                <div className="mt-5">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-bold text-slate-800">{t('hero.recent')}</div>
                    <div className="text-[10px] text-[#2563EB] font-semibold">{t('hero.see_all')}</div>
                  </div>
                  <div className="mt-2 space-y-1.5">
                    {[
                      { l: 'Paiement reçu', a: '+250,000', c: 'text-emerald-600', bg: 'bg-emerald-100' },
                      { l: 'Transfert', a: '-120,000', c: 'text-slate-900', bg: 'bg-blue-100' },
                      { l: 'Échange XOF→XAF', a: '-80,000', c: 'text-slate-900', bg: 'bg-violet-100' },
                      { l: 'Retrait vers compte', a: '-200,000', c: 'text-slate-900', bg: 'bg-orange-100' },
                    ].map((tx, i) => (
                      <div key={i} className="flex items-center gap-2 bg-white rounded-xl p-2 border border-slate-100">
                        <div className={`w-7 h-7 rounded-lg ${tx.bg}`} />
                        <div className="flex-1 min-w-0">
                          <div className="text-[10px] font-semibold text-slate-800 truncate">{tx.l}</div>
                          <div className="text-[9px] text-slate-400">Aujourd&apos;hui</div>
                        </div>
                        <div className={`text-[10px] font-bold ${tx.c}`}>{tx.a} XOF</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Small circles decor */}
          <div className="absolute left-6 bottom-10 w-4 h-4 rounded-full bg-blue-400 animate-float-slow" />
          <div className="absolute right-16 top-4 w-3 h-3 rounded-full bg-emerald-400 animate-float" />
        </div>
      </div>
    </section>
  );
}
