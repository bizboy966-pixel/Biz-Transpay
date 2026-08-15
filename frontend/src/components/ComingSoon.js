import { Sparkles, Clock, Rocket } from 'lucide-react';

/**
 * Displayed on user-facing pages when the admin has turned a wallet off.
 * A friendly "Coming soon" state, not an error.
 */
export default function ComingSoon({
  title = 'Bientôt disponible',
  message,
  icon: Icon = Rocket,
  accent = 'blue',
}) {
  const tones = {
    blue: { bg: 'from-blue-50 to-indigo-50', ring: 'ring-blue-200', chip: 'bg-blue-100 text-blue-700', icon: 'from-[#3B82F6] to-[#1D4ED8]', txt: 'text-blue-900' },
    amber: { bg: 'from-amber-50 to-orange-50', ring: 'ring-amber-200', chip: 'bg-amber-100 text-amber-700', icon: 'from-amber-500 to-orange-600', txt: 'text-amber-900' },
  };
  const t = tones[accent] || tones.blue;
  return (
    <div className={`relative overflow-hidden rounded-3xl bg-gradient-to-br ${t.bg} ring-1 ${t.ring} p-8 sm:p-12 text-center`}
         data-testid="coming-soon">
      <div className="absolute -top-16 -right-16 w-48 h-48 rounded-full bg-white/40 blur-3xl" />
      <div className="absolute -bottom-16 -left-16 w-48 h-48 rounded-full bg-white/40 blur-3xl" />

      <div className="relative">
        <div className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full ${t.chip} text-[11px] font-bold uppercase tracking-widest`}>
          <Clock className="w-3 h-3" /> Coming soon
        </div>
        <div className={`mx-auto mt-5 w-16 h-16 rounded-2xl bg-gradient-to-br ${t.icon} text-white flex items-center justify-center shadow-[0_10px_30px_-8px_rgba(37,99,235,0.55)]`}>
          <Icon className="w-7 h-7" strokeWidth={1.75} />
        </div>
        <h1 className={`mt-5 font-cabinet font-extrabold text-2xl sm:text-3xl ${t.txt}`}>{title}</h1>
        <p className="mt-3 text-sm sm:text-base text-slate-600 max-w-lg mx-auto leading-relaxed">
          {message || 'Cette fonctionnalité est en cours de finalisation. Elle sera disponible très prochainement — merci de votre patience.'}
        </p>
        <div className="mt-6 inline-flex items-center gap-2 text-[11px] font-semibold text-slate-500">
          <Sparkles className="w-3.5 h-3.5" /> Nous vous notifierons dès son activation.
        </div>
      </div>
    </div>
  );
}
