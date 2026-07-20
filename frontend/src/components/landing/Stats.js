import { useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Users, Building2, Repeat, ShieldCheck, Clock, CheckCircle2 } from 'lucide-react';

function useCountUp(target, active) {
  const [value, setValue] = useState(0);
  const ref = useRef();
  useEffect(() => {
    if (!active) return;
    const duration = 1800;
    const start = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - start) / duration);
      setValue(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) ref.current = requestAnimationFrame(step);
    };
    ref.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(ref.current);
  }, [target, active]);
  return value;
}

function fmt(n, suffix = '') {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, '') + 'M' + suffix;
  if (n >= 1_000) return Math.round(n / 1_000) + 'K' + suffix;
  return Math.round(n) + suffix;
}

const AVATARS = [
  { c: 'from-orange-400 to-pink-500', i: '👨🏾' },
  { c: 'from-blue-400 to-indigo-500', i: '👩🏽' },
  { c: 'from-emerald-400 to-teal-500', i: '👨🏽' },
  { c: 'from-violet-400 to-purple-500', i: '👩🏾' },
];

export default function Stats() {
  const { t } = useTranslation();
  const [active, setActive] = useState(false);
  const ref = useRef();

  useEffect(() => {
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { setActive(true); io.disconnect(); }
    }, { threshold: 0.2 });
    if (ref.current) io.observe(ref.current);
    return () => io.disconnect();
  }, []);

  const users = useCountUp(50000, active);
  const partners = useCountUp(5000, active);
  const tx = useCountUp(1000000, active);
  const uptime = useCountUp(99.9, active);

  const stats = [
    { i: Users, v: fmt(users) + '+', l: t('stats.users') },
    { i: Building2, v: fmt(partners) + '+', l: t('stats.partners') },
    { i: Repeat, v: fmt(tx) + '+', l: t('stats.tx') },
    { i: ShieldCheck, v: uptime.toFixed(1) + '%', l: t('stats.uptime') },
  ];

  return (
    <section ref={ref} className="relative py-6 sm:py-10">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="relative rounded-[32px] bg-gradient-to-br from-[#3B82F6] via-[#2563EB] to-[#1E40AF] overflow-hidden p-10 sm:p-14">
          {/* Decorative circles */}
          <div className="absolute -top-24 -right-24 w-96 h-96 rounded-full bg-white/10" />
          <div className="absolute -bottom-32 -left-16 w-96 h-96 rounded-full bg-white/5" />
          <div className="absolute inset-0 bt-worldmap opacity-20" />

          <div className="relative grid md:grid-cols-[1.2fr_1fr] gap-10 items-center">
            <div>
              <div className="inline-flex items-center gap-2 bg-white/10 text-white/90 px-4 py-1.5 rounded-full text-xs font-semibold uppercase tracking-wider backdrop-blur">
                <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse" />
                Trusted worldwide
              </div>
              <h2 className="mt-4 font-cabinet text-4xl sm:text-5xl font-extrabold text-white tracking-tighter">{t('stats.title')}</h2>

              <div className="mt-10 grid grid-cols-2 sm:grid-cols-4 gap-6">
                {stats.map((s, i) => (
                  <div key={i} data-testid={`stat-${i}`}>
                    <div className="w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center mb-3 backdrop-blur">
                      <s.i className="w-5 h-5 text-white" strokeWidth={1.75} />
                    </div>
                    <div className="font-cabinet text-3xl sm:text-4xl font-extrabold text-white">{s.v}</div>
                    <div className="text-xs text-white/70 mt-1 font-medium">{s.l}</div>
                  </div>
                ))}
              </div>

              <div className="mt-8 flex items-center gap-2 text-white/80 text-sm font-semibold">
                <Clock className="w-4 h-4" /> {t('stats.support')}
              </div>
            </div>

            {/* Right decoration: avatars orbiting brand */}
            <div className="relative h-64 hidden md:block">
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-56 h-56 rounded-full border border-white/20 relative">
                  <div className="w-40 h-40 rounded-full border border-white/10 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
                </div>
              </div>
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-24 h-24 rounded-3xl bg-white flex items-center justify-center shadow-2xl">
                  <span className="font-cabinet font-extrabold text-3xl text-[#2563EB]">B</span>
                </div>
              </div>
              {AVATARS.map((a, i) => {
                const positions = [
                  'top-4 right-8', 'top-1/2 -right-2 -translate-y-1/2', 'bottom-4 right-16', 'top-6 left-10',
                ];
                return (
                  <div key={i} className={`absolute ${positions[i]}`}>
                    <div className="relative">
                      <div className={`w-14 h-14 rounded-full bg-gradient-to-br ${a.c} border-4 border-white shadow-xl flex items-center justify-center text-xl`}>
                        {a.i}
                      </div>
                      <CheckCircle2 className="absolute -bottom-1 -right-1 w-5 h-5 text-emerald-400 bg-white rounded-full" strokeWidth={2.5} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
