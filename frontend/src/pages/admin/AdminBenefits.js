import { useEffect, useState } from 'react';
import { TrendingUp, Wallet, Bitcoin, RefreshCw, ListChecks, Search, X, ArrowDownToLine, ArrowUpFromLine, Repeat, Link2, Code2 } from 'lucide-react';
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
  const [detailsOpen, setDetailsOpen] = useState(false);

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
        <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
          <div className="text-[12px] font-bold text-slate-900 flex items-center gap-1.5">
            <TrendingUp className="w-3.5 h-3.5 text-emerald-600" /> Comment ce chiffre est-il calculé ?
          </div>
          <button onClick={() => setDetailsOpen(true)} data-testid="btn-benefits-details"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-[11px] font-bold">
            <ListChecks className="w-3.5 h-3.5" /> Voir les détails des bénéfices
          </button>
        </div>
        <ul className="text-[11px] sm:text-xs text-slate-600 space-y-1 list-disc list-inside leading-relaxed">
          <li>À chaque transaction (dépôt ou retrait, MoMo ou crypto), les frais sont ventilés en deux parts : <b>Passerelle</b> (reversée au fournisseur : FedaPay, IziChange…) et <b>Plateforme</b> (votre marge nette).</li>
          <li>Cette page ne comptabilise <b>QUE la part Plateforme</b>, exactement comme elle est configurée dans <span className="font-mono text-[10px] bg-slate-100 rounded px-1">Admin &gt; Config. dépôts / transferts</span>.</li>
          <li>Les 3 portefeuilles restent séparés — aucune conversion USDT↔XOF n&apos;est appliquée pour préserver la lisibilité par devise.</li>
          <li>Seules les transactions <b>confirmées</b> (statut <span className="font-mono">completed</span> / <span className="font-mono">paid</span>) sont comptées.</li>
        </ul>
      </div>

      {detailsOpen && <BenefitsDetailsDrawer onClose={() => setDetailsOpen(false)} period={period} />}
    </div>
  );
}

function BenefitsDetailsDrawer({ onClose, period }) {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [currency, setCurrency] = useState('');
  const [type, setType] = useState('');

  const load = () => {
    setLoading(true);
    setItems([]);
    const params = { period, limit: 200 };
    if (q) params.q = q;
    if (currency) params.currency = currency;
    if (type) params.type = type;
    api.get('/admin/benefits/details', { params })
      .then(({ data }) => { setItems(data.items || []); setTotal(data.total || 0); })
      .catch(() => {})
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [currency, type, period]);
  useEffect(() => {
    const id = setTimeout(() => load(), 250);
    return () => clearTimeout(id);
    /* eslint-disable-next-line */
  }, [q]);

  const typeIcon = {
    deposit: <ArrowDownToLine className="w-3 h-3 text-emerald-600" />,
    withdrawal: <ArrowUpFromLine className="w-3 h-3 text-red-500" />,
    transfer: <ArrowUpFromLine className="w-3 h-3 text-red-500" />,
    link_payment: <Link2 className="w-3 h-3 text-violet-600" />,
    payment: <Code2 className="w-3 h-3 text-blue-600" />,
    exchange: <Repeat className="w-3 h-3 text-orange-600" />,
  };

  const fmtDate = (iso) => {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      return d.toLocaleDateString('fr-FR') + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    } catch { return iso; }
  };
  const fmtAmt = (n, cur) => {
    const num = Number(n || 0);
    if (cur === 'USDT') return num.toFixed(4);
    return Math.round(num).toLocaleString('fr-FR');
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-3" data-testid="benefits-details-modal">
      <div className="w-full max-w-5xl max-h-[92vh] bg-white rounded-2xl shadow-2xl border border-slate-200 flex flex-col overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-slate-100 flex items-center justify-between">
          <div>
            <div className="font-cabinet font-extrabold text-slate-900 text-base sm:text-lg flex items-center gap-2">
              <ListChecks className="w-4 h-4 text-emerald-600" /> Détails des bénéfices
            </div>
            <div className="text-[11px] text-slate-500">Toutes les transactions ayant généré une marge plateforme · {total} entrée{total > 1 ? 's' : ''}</div>
          </div>
          <button onClick={onClose} data-testid="btn-close-benefits-details" className="w-8 h-8 rounded-lg hover:bg-slate-100 text-slate-500">
            <X className="w-4 h-4 mx-auto" />
          </button>
        </div>

        <div className="p-3 sm:p-4 bg-slate-50 border-b border-slate-100 flex flex-wrap gap-2 items-center">
          <div className="flex-1 min-w-[220px] flex items-center gap-2 px-3 border border-slate-200 rounded-xl bg-white">
            <Search className="w-4 h-4 text-slate-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)}
              data-testid="benefits-search"
              placeholder="Référence, utilisateur, description…"
              className="flex-1 py-2 outline-none text-xs sm:text-sm bg-transparent" />
          </div>
          <select value={currency} onChange={(e) => setCurrency(e.target.value)}
            data-testid="benefits-currency"
            className="px-3 py-2 border border-slate-200 rounded-xl text-[11px] sm:text-xs font-semibold bg-white">
            <option value="">Toutes devises</option>
            <option value="XOF">XOF</option>
            <option value="XAF">XAF</option>
            <option value="USDT">USDT</option>
          </select>
          <select value={type} onChange={(e) => setType(e.target.value)}
            data-testid="benefits-type"
            className="px-3 py-2 border border-slate-200 rounded-xl text-[11px] sm:text-xs font-semibold bg-white">
            <option value="">Tous types</option>
            <option value="deposit">Frais dépôt</option>
            <option value="withdrawal">Frais retrait</option>
            <option value="transfer">Frais retrait (transfer)</option>
            <option value="link_payment">Frais lien</option>
            <option value="payment">Frais API</option>
            <option value="exchange">Frais conversion</option>
          </select>
        </div>

        <div className="flex-1 overflow-auto">
          <table className="w-full text-xs">
            <thead className="bg-white sticky top-0 border-b border-slate-100 text-[9px] sm:text-[10px] font-bold uppercase tracking-wider text-slate-500">
              <tr>
                <th className="text-left px-3 py-2">Date</th>
                <th className="text-left px-3 py-2">Type</th>
                <th className="text-left px-3 py-2">Référence</th>
                <th className="text-left px-3 py-2">Utilisateur</th>
                <th className="text-right px-3 py-2">Montant tx</th>
                <th className="text-right px-3 py-2">Bénéfice</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={6} className="p-10 text-center text-slate-500">
                  <span className="inline-flex items-center gap-2"><RefreshCw className="w-4 h-4 animate-spin" /> Chargement…</span>
                </td></tr>
              )}
              {!loading && items.length === 0 && (
                <tr><td colSpan={6} className="p-10 text-center text-slate-400">Aucun bénéfice sur cette période / filtre.</td></tr>
              )}
              {!loading && items.map((it) => (
                <tr key={it.tx_id} className="border-t border-slate-50 hover:bg-slate-50/50" data-testid={`benefit-row-${it.tx_id}`}>
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-600">{fmtDate(it.date)}</td>
                  <td className="px-3 py-2">
                    <div className="inline-flex items-center gap-1.5">
                      {typeIcon[it.type] || <Wallet className="w-3 h-3 text-slate-500" />}
                      <span className="font-semibold text-slate-800 text-[11px]">{it.type_label}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-700">{it.reference || '—'}</td>
                  <td className="px-3 py-2">
                    <div className="text-[11px] font-semibold text-slate-900 truncate max-w-[180px]">{it.user?.name || it.user?.email || it.user?.id || '—'}</div>
                    {it.user?.email && <div className="text-[10px] text-slate-500 truncate max-w-[180px]">{it.user.email}</div>}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-[11px] text-slate-700">
                    {fmtAmt(it.amount, it.currency)} <span className="text-[9px] text-slate-400">{it.currency}</span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200 text-[11px] font-mono font-bold">
                      +{fmtAmt(it.platform_fee, it.currency)} {it.currency}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
