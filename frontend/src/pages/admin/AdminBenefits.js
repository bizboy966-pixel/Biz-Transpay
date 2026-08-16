import { useEffect, useState } from 'react';
import { TrendingUp, Wallet, Bitcoin, RefreshCw } from 'lucide-react';
import api from '@/api';

const PERIODS = [
  { key: 'all', label: 'Depuis toujours' },
  { key: '30d', label: '30 derniers jours' },
  { key: '7d', label: '7 derniers jours' },
];

function fmt(n, currency) {
  const num = Number(n || 0);
  if (currency === 'USDT') return num.toFixed(2);
  return Math.round(num).toLocaleString('fr-FR');
}

export default function AdminBenefits() {
  const [data, setData] = useState(null);
  const [period, setPeriod] = useState('all');
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    api.get('/admin/benefits', { params: { period } })
      .then(({ data }) => setData(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [period]);

  const xof = data?.xof || { total: 0, count: 0 };
  const xaf = data?.xaf || { total: 0, count: 0 };
  const usdt = data?.usdt || { total: 0, count: 0 };

  return (
    <div className="space-y-6" data-testid="admin-benefits">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-9 h-9 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center">
              <TrendingUp className="w-4 h-4" />
            </div>
            <h1 className="font-cabinet font-bold text-slate-900 text-lg sm:text-xl">Bénéfice</h1>
          </div>
          <p className="text-[11px] sm:text-xs text-slate-500 max-w-2xl">
            Marge <b>Biz-transPay</b> collectée (frais plateforme uniquement — la part passerelle n&apos;est pas incluse).
            3 portefeuilles indépendants : XOF, XAF, USDT.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select value={period} onChange={(e) => setPeriod(e.target.value)}
            data-testid="benefits-period"
            className="px-3 py-2 rounded-lg border border-slate-200 text-[11px] sm:text-xs font-semibold text-slate-700 bg-white">
            {PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
          <button onClick={load} disabled={loading} data-testid="benefits-refresh"
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 text-[11px] sm:text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Actualiser
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <BenefitCard
          testId="benefit-card-xof"
          currency="XOF"
          label="Portefeuille XOF"
          total={xof.total}
          count={xof.count}
          gradient="from-[#3B82F6] to-[#1D4ED8]"
          Icon={Wallet}
        />
        <BenefitCard
          testId="benefit-card-xaf"
          currency="XAF"
          label="Portefeuille XAF"
          total={xaf.total}
          count={xaf.count}
          gradient="from-[#8B5CF6] to-[#6D28D9]"
          Icon={Wallet}
        />
        <BenefitCard
          testId="benefit-card-usdt"
          currency="USDT"
          label="Portefeuille Crypto"
          total={usdt.total}
          count={usdt.count}
          gradient="from-[#F97316] to-[#C2410C]"
          Icon={Bitcoin}
        />
      </div>

      <div className="rounded-2xl border border-slate-100 bg-white p-4 sm:p-5">
        <div className="text-[12px] font-bold text-slate-900 mb-2 flex items-center gap-1.5">
          <TrendingUp className="w-3.5 h-3.5 text-emerald-600" /> Comment ce chiffre est-il calculé ?
        </div>
        <ul className="text-[11px] sm:text-xs text-slate-600 space-y-1 list-disc list-inside leading-relaxed">
          <li>À chaque transaction (dépôt ou retrait, MoMo ou crypto), les frais sont ventilés en deux parts : <b>Passerelle</b> (reversée au fournisseur : FedaPay, IziChange…) et <b>Plateforme</b> (votre marge nette).</li>
          <li>Cette page ne comptabilise <b>QUE la part Plateforme</b>, exactement comme elle est configurée dans <span className="font-mono text-[10px] bg-slate-100 rounded px-1">Admin &gt; Config. dépôts / transferts</span>.</li>
          <li>Les 3 portefeuilles restent séparés — aucune conversion USDT↔XOF n&apos;est appliquée pour préserver la lisibilité par devise.</li>
          <li>Seules les transactions <b>confirmées</b> (statut <span className="font-mono">completed</span> / <span className="font-mono">paid</span>) sont comptées.</li>
        </ul>
      </div>
    </div>
  );
}

function BenefitCard({ testId, currency, label, total, count, gradient, Icon }) {
  return (
    <div data-testid={testId}
      className={`relative overflow-hidden rounded-2xl bg-gradient-to-br ${gradient} text-white p-5 sm:p-6 shadow-lg`}>
      <div className="absolute -top-8 -right-8 w-32 h-32 rounded-full bg-white/10" />
      <div className="absolute top-16 -right-4 w-20 h-20 rounded-full bg-white/5" />
      <div className="relative">
        <div className="flex items-start justify-between mb-4">
          <div className="w-10 h-10 rounded-xl bg-white/20 backdrop-blur flex items-center justify-center">
            <Icon className="w-5 h-5" />
          </div>
          <div className="text-[10px] font-bold uppercase tracking-widest bg-white/20 backdrop-blur rounded-full px-2 py-0.5">
            {currency}
          </div>
        </div>
        <div className="text-[10px] sm:text-[11px] uppercase tracking-widest font-bold text-white/70 mb-1">
          {label}
        </div>
        <div className="font-cabinet font-extrabold text-2xl sm:text-3xl mb-1 leading-tight" data-testid={`${testId}-total`}>
          {fmt(total, currency)} <span className="text-sm sm:text-base opacity-80">{currency}</span>
        </div>
        <div className="text-[11px] sm:text-xs text-white/80" data-testid={`${testId}-count`}>
          {count} transaction{count > 1 ? 's' : ''} comptée{count > 1 ? 's' : ''}
        </div>
      </div>
    </div>
  );
}
