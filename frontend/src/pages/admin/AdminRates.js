import { useEffect, useState, useMemo } from 'react';
import { Save, Percent, Coins, ArrowRight, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';

const PAIRS = [
  { key: 'USDT_XOF', from: 'USDT', to: 'XOF', group: 'USDT → FCFA', inverse: false },
  { key: 'USDT_XAF', from: 'USDT', to: 'XAF', group: 'USDT → FCFA', inverse: false },
  { key: 'XOF_USDT', from: 'XOF', to: 'USDT', group: 'FCFA → USDT', inverse: true },
  { key: 'XAF_USDT', from: 'XAF', to: 'USDT', group: 'FCFA → USDT', inverse: true },
  { key: 'XOF_XAF', from: 'XOF', to: 'XAF', group: 'FCFA ↔ FCFA', inverse: true },
  { key: 'XAF_XOF', from: 'XAF', to: 'XOF', group: 'FCFA ↔ FCFA', inverse: true },
];

const GROUPS = ['USDT → FCFA', 'FCFA → USDT', 'FCFA ↔ FCFA'];

export default function AdminRates() {
  const [cfg, setCfg] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => { api.get('/admin/conversion/config').then(({ data }) => setCfg(data)).catch(() => toast.error('Erreur')); }, []);

  const grouped = useMemo(() => {
    const g = {}; GROUPS.forEach((n) => (g[n] = []));
    PAIRS.forEach((p) => g[p.group].push(p));
    return g;
  }, []);

  if (!cfg) return <div className="text-slate-500 text-sm">Chargement…</div>;

  const patch = (path, value) => {
    setCfg((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      const parts = path.split('.');
      let node = next; for (let i = 0; i < parts.length - 1; i++) node = node[parts[i]];
      node[parts[parts.length - 1]] = value;
      return next;
    });
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.patch('/admin/conversion/config', {
        conversion_rates: cfg.rates,
        conversion_limits: cfg.limits,
        conversion_pairs_enabled: cfg.pairs_enabled,
        conversion_fee: cfg.fee,
      });
      toast.success('Enregistré');
      setDirty(false);
    } catch (e) { toast.error(e.response?.data?.detail || 'Erreur'); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-6" data-testid="admin-rates-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-cabinet font-extrabold text-slate-900 text-xl">Gestion des taux de conversion</h1>
          <p className="text-xs text-slate-500 mt-0.5">Modifiez les taux et les frais. Les changements s'appliquent immédiatement sur toute la plateforme.</p>
        </div>
        <button onClick={save} disabled={!dirty || saving} data-testid="btn-save-rates"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-900 text-white font-semibold text-sm disabled:opacity-40 hover:bg-slate-800">
          <Save className="w-4 h-4" /> {saving ? 'Enregistrement…' : 'Enregistrer'}
        </button>
      </div>

      {/* Fee configuration */}
      <div className="bg-white border border-slate-100 rounded-2xl p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-violet-50 text-violet-600 flex items-center justify-center"><Percent className="w-5 h-5" /></div>
          <div>
            <h2 className="font-cabinet font-bold text-slate-900">Frais de conversion</h2>
            <p className="text-[11px] text-slate-500">Appliqués automatiquement à chaque conversion, sur la devise source.</p>
          </div>
        </div>
        <div className="grid sm:grid-cols-4 gap-4">
          <label className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl cursor-pointer">
            <input type="checkbox" checked={!!cfg.fee.enabled} onChange={(e) => patch('fee.enabled', e.target.checked)} data-testid="fee-enabled" className="w-4 h-4 accent-emerald-600" />
            <div className="text-xs font-semibold">Activé</div>
          </label>
          <div>
            <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Mode</label>
            <select value={cfg.fee.type || 'percent'} onChange={(e) => patch('fee.type', e.target.value)} data-testid="fee-type"
              className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 text-sm">
              <option value="percent">Pourcentage (%)</option>
              <option value="fixed">Fixe (montant)</option>
            </select>
          </div>
          <div>
            <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Valeur</label>
            <input type="number" step="0.01" value={cfg.fee.value ?? 0} onChange={(e) => patch('fee.value', parseFloat(e.target.value) || 0)} data-testid="fee-value"
              className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 text-sm" />
          </div>
          <div>
            <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Frais min</label>
            <input type="number" step="0.01" value={cfg.fee.min_fee ?? 0} onChange={(e) => patch('fee.min_fee', parseFloat(e.target.value) || 0)}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 text-sm" />
          </div>
        </div>
      </div>

      {/* Rates & limits grid */}
      {GROUPS.map((group) => (
        <div key={group} className="bg-white border border-slate-100 rounded-2xl p-5">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center"><Coins className="w-5 h-5" /></div>
            <h2 className="font-cabinet font-bold text-slate-900">{group}</h2>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            {grouped[group].map((p) => {
              const rateStored = cfg.rates[p.key] ?? 0;
              // For inverse-quotation pairs (FCFA→USDT, XOF↔XAF), the admin
              // types "how many FROM units = 1 TO unit". We store the maths-
              // friendly rate (1 FROM = ? TO) which is the reciprocal.
              const displayRate = p.inverse
                ? (rateStored > 0 ? 1 / rateStored : 0)
                : rateStored;
              const min = cfg.limits[p.key]?.min ?? 0;
              const max = cfg.limits[p.key]?.max ?? 0;
              const on = cfg.pairs_enabled[p.key] !== false;
              const setRate = (raw) => {
                const num = parseFloat(raw);
                if (isNaN(num) || num <= 0) { patch(`rates.${p.key}`, 0); return; }
                patch(`rates.${p.key}`, p.inverse ? (1 / num) : num);
              };
              return (
                <div key={p.key} data-testid={`pair-${p.key}`} className={`p-4 rounded-xl border-2 ${on ? 'border-emerald-200 bg-emerald-50/30' : 'border-slate-200 bg-slate-50'}`}>
                  <div className="flex items-center justify-between mb-3">
                    <div className="inline-flex items-center gap-2 font-cabinet font-extrabold text-slate-900">
                      <span className="px-2 py-0.5 rounded-md bg-white text-blue-700 text-xs border border-blue-200">{p.from}</span>
                      <ArrowRight className="w-4 h-4 text-slate-400" />
                      <span className="px-2 py-0.5 rounded-md bg-white text-emerald-700 text-xs border border-emerald-200">{p.to}</span>
                    </div>
                    <label className="inline-flex items-center cursor-pointer">
                      <input type="checkbox" checked={on} onChange={(e) => patch(`pairs_enabled.${p.key}`, e.target.checked)} data-testid={`toggle-${p.key}`} className="sr-only peer" />
                      <div className="relative w-10 h-5 bg-slate-300 peer-checked:bg-emerald-500 rounded-full transition-colors">
                        <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${on ? 'translate-x-5' : ''}`} />
                      </div>
                    </label>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                        Taux · {p.inverse ? `${p.from} pour 1 ${p.to}` : `${p.to} pour 1 ${p.from}`}
                      </label>
                      <input type="number" step={p.inverse ? '1' : '0.000001'} value={displayRate}
                        onChange={(e) => setRate(e.target.value)}
                        data-testid={`rate-${p.key}`}
                        className="mt-1 w-full px-2 py-1.5 rounded-lg border border-slate-200 text-sm font-mono" />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Min</label>
                      <input type="number" step="0.01" value={min}
                        onChange={(e) => patch(`limits.${p.key}.min`, parseFloat(e.target.value) || 0)}
                        className="mt-1 w-full px-2 py-1.5 rounded-lg border border-slate-200 text-sm" />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Max</label>
                      <input type="number" step="0.01" value={max}
                        onChange={(e) => patch(`limits.${p.key}.max`, parseFloat(e.target.value) || 0)}
                        className="mt-1 w-full px-2 py-1.5 rounded-lg border border-slate-200 text-sm" />
                    </div>
                  </div>
                  <div className="mt-2 text-[10px] text-slate-500">
                    {p.inverse
                      ? <>{displayRate.toLocaleString(undefined, { maximumFractionDigits: 6 })} {p.from} = <span className="font-semibold text-slate-800">1 {p.to}</span></>
                      : <>1 {p.from} = <span className="font-semibold text-slate-800">{rateStored.toLocaleString(undefined, { maximumFractionDigits: 6 })}</span> {p.to}</>
                    }
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <div className="p-3 rounded-xl bg-slate-900 text-white text-[11px] flex items-center gap-2">
        <ShieldCheck className="w-4 h-4 text-emerald-400" />
        Aucun taux n'est codé en dur — tout est piloté depuis cette page. Les changements prennent effet instantanément.
      </div>
    </div>
  );
}
