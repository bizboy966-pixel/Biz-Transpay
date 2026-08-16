import { useEffect, useState } from 'react';
import { Save, Plus, Trash2, ToggleLeft, ToggleRight, Smartphone, ArrowDownToLine } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';

// FedaPay-supported countries (must match backend `fedapay.COUNTRY_LABELS`).
const FEDAPAY_COUNTRIES = [
  { code: 'BJ', label: 'Bénin', flag: '🇧🇯' },
  { code: 'CI', label: 'Côte d\u2019Ivoire', flag: '🇨🇮' },
  { code: 'TG', label: 'Togo', flag: '🇹🇬' },
  { code: 'SN', label: 'Sénégal', flag: '🇸🇳' },
  { code: 'ML', label: 'Mali', flag: '🇲🇱' },
  { code: 'NE', label: 'Niger', flag: '🇳🇪' },
  { code: 'BF', label: 'Burkina Faso', flag: '🇧🇫' },
  { code: 'GN', label: 'Guinée', flag: '🇬🇳' },
];

const CURRENCIES = ['XOF', 'XAF', 'GNF', 'CDF', 'USD', 'EUR'];

export default function AdminDepositConfig() {
  const [cfg, setCfg] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [savingSection, setSavingSection] = useState(null);

  const load = () => api.get('/admin/deposit/config').then(({ data }) => setCfg(data)).catch(() => {});
  useEffect(() => { load(); }, []);

  const save = async () => {
    try {
      await api.patch('/admin/deposit/config', { mobile_money: cfg.mobile_money });
      toast.success('Configuration enregistrée');
      setDirty(false);
    } catch (err) { toast.error(err.response?.data?.detail || 'Erreur'); }
  };

  const patchSection = async (section, patch) => {
    setSavingSection(section);
    try {
      const merged = { ...(cfg[section] || {}), ...patch };
      const { data } = await api.patch('/admin/deposit/config', { [section]: merged });
      setCfg(data);
      toast.success(patch.enabled ? 'Activé' : 'Désactivé');
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Erreur');
    } finally { setSavingSection(null); }
  };

  if (!cfg) return <div className="text-slate-500 text-sm">Chargement…</div>;
  const mm = cfg.mobile_money || { enabled: true, operators: [] };
  const setMM = (v) => { setCfg({ ...cfg, mobile_money: v }); setDirty(true); };
  const setEnabled = (enabled) => patchSection('mobile_money', { enabled });

  const updateOp = (idx, key, val) => {
    const ops = [...mm.operators];
    ops[idx] = { ...ops[idx], [key]: val };
    setMM({ ...mm, operators: ops });
  };
  const addOp = () => setMM({
    ...mm,
    operators: [...mm.operators, { country: 'TG', code: '', name: '', currency: 'XOF', fee_pct: 1.5, min: 100, max: 500000, active: true }],
  });
  const removeOp = (idx) => setMM({ ...mm, operators: mm.operators.filter((_, i) => i !== idx) });

  // Countries currently used in the ops list — displayed with a summary badge
  const countryCounts = mm.operators.reduce((acc, o) => {
    acc[o.country] = (acc[o.country] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-4 sm:space-y-6" data-testid="admin-deposit-config">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-cabinet font-bold text-slate-900 text-base sm:text-lg">Configuration des dépôts</h1>
          <p className="text-[11px] sm:text-xs text-slate-500 mt-0.5">
            Frais, montants minimum/maximum et devise par pays et par opérateur Mobile Money.
            Ces valeurs s'appliquent à tous les dépôts (direct, lien de paiement, API).
          </p>
        </div>
        <button onClick={save} disabled={!dirty} data-testid="btn-save-deposit-config"
          className="inline-flex items-center gap-2 bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold px-3 sm:px-4 py-2 rounded-full text-[11px] sm:text-xs disabled:opacity-50">
          <Save className="w-3.5 h-3.5" /> Enregistrer
        </button>
      </div>

      <Section
        title="Dépôts → Mobile Money"
        subtitle={`${mm.operators.length} opérateurs — ${Object.keys(countryCounts).length} pays`}
        Icon={ArrowDownToLine}
        iconBg="bg-blue-50 text-[#2563EB]"
        enabled={mm.enabled}
        saving={savingSection === 'mobile_money'}
        onEnabledChange={setEnabled}
        testId="mm-deposit"
      >
        {/* Country summary chips */}
        <div className="flex flex-wrap gap-1.5 mb-3">
          {FEDAPAY_COUNTRIES.map((c) => (
            <span key={c.code} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${countryCounts[c.code] ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-400'}`}>
              {c.flag} {c.label} · {countryCounts[c.code] || 0}
            </span>
          ))}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-[11px] sm:text-xs">
            <thead className="bg-slate-50 text-[9px] sm:text-[10px] font-bold uppercase tracking-wider text-slate-500">
              <tr>
                <th className="text-left px-2 sm:px-3 py-2">Pays</th>
                <th className="text-left px-2 sm:px-3 py-2">Code</th>
                <th className="text-left px-2 sm:px-3 py-2">Nom affiché</th>
                <th className="text-left px-2 sm:px-3 py-2">Devise</th>
                <th className="text-right px-2 sm:px-3 py-2">Frais passerelle %</th>
                <th className="text-right px-2 sm:px-3 py-2">Frais plateforme %</th>
                <th className="text-right px-2 sm:px-3 py-2">Total %</th>
                <th className="text-right px-2 sm:px-3 py-2">Min</th>
                <th className="text-right px-2 sm:px-3 py-2">Max</th>
                <th className="text-center px-2 sm:px-3 py-2">Actif</th>
                <th className="text-center px-2 sm:px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {mm.operators.map((o, idx) => (
                <tr key={idx} data-testid={`dep-op-row-${idx}`} className="border-t border-slate-50">
                  <td className="px-2 sm:px-3 py-2">
                    <select value={o.country} onChange={(e) => updateOp(idx, 'country', e.target.value)} data-testid={`dep-op-country-${idx}`}
                      className="px-1.5 sm:px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs">
                      {FEDAPAY_COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.flag} {c.code}</option>)}
                    </select>
                  </td>
                  <td className="px-2 sm:px-3 py-2">
                    <input value={o.code} onChange={(e) => updateOp(idx, 'code', e.target.value.toLowerCase())} data-testid={`dep-op-code-${idx}`}
                      className="w-24 sm:w-28 px-1.5 sm:px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs font-mono" />
                  </td>
                  <td className="px-2 sm:px-3 py-2">
                    <input value={o.name} onChange={(e) => updateOp(idx, 'name', e.target.value)} data-testid={`dep-op-name-${idx}`}
                      className="w-36 sm:w-44 px-1.5 sm:px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs" />
                  </td>
                  <td className="px-2 sm:px-3 py-2">
                    <select value={o.currency || 'XOF'} onChange={(e) => updateOp(idx, 'currency', e.target.value)} data-testid={`dep-op-currency-${idx}`}
                      className="px-1.5 sm:px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs">
                      {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </td>
                  <td className="px-2 sm:px-3 py-2">
                    <input type="number" step="0.1" min="0"
                      value={o.gateway_fee_pct ?? o.fee_pct ?? 0}
                      onChange={(e) => {
                        const g = parseFloat(e.target.value) || 0;
                        const p = parseFloat(o.platform_fee_pct) || 0;
                        updateOp(idx, 'gateway_fee_pct', g);
                        updateOp(idx, 'fee_pct', +(g + p).toFixed(4));
                      }}
                      data-testid={`dep-op-gateway-fee-${idx}`}
                      className="w-14 sm:w-16 px-1.5 sm:px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs text-right" />
                  </td>
                  <td className="px-2 sm:px-3 py-2">
                    <input type="number" step="0.1" min="0"
                      value={o.platform_fee_pct ?? 0}
                      onChange={(e) => {
                        const p = parseFloat(e.target.value) || 0;
                        const g = parseFloat(o.gateway_fee_pct ?? o.fee_pct) || 0;
                        updateOp(idx, 'platform_fee_pct', p);
                        updateOp(idx, 'fee_pct', +(g + p).toFixed(4));
                      }}
                      data-testid={`dep-op-platform-fee-${idx}`}
                      className="w-14 sm:w-16 px-1.5 sm:px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs text-right" />
                  </td>
                  <td className="px-2 sm:px-3 py-2 text-right">
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-slate-900 text-white text-[10px] font-bold" data-testid={`dep-op-total-fee-${idx}`}>
                      {((o.gateway_fee_pct ?? o.fee_pct ?? 0) + (o.platform_fee_pct ?? 0)).toFixed(2)} %
                    </span>
                  </td>
                  <td className="px-2 sm:px-3 py-2">
                    <input type="number" value={o.min} onChange={(e) => updateOp(idx, 'min', parseInt(e.target.value) || 0)} data-testid={`dep-op-min-${idx}`}
                      className="w-20 sm:w-24 px-1.5 sm:px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs text-right" />
                  </td>
                  <td className="px-2 sm:px-3 py-2">
                    <input type="number" value={o.max} onChange={(e) => updateOp(idx, 'max', parseInt(e.target.value) || 0)} data-testid={`dep-op-max-${idx}`}
                      className="w-24 sm:w-28 px-1.5 sm:px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs text-right" />
                  </td>
                  <td className="px-2 sm:px-3 py-2 text-center">
                    <input type="checkbox" checked={!!o.active} onChange={(e) => updateOp(idx, 'active', e.target.checked)} data-testid={`dep-op-active-${idx}`}
                      className="w-4 h-4 accent-[#2563EB]" />
                  </td>
                  <td className="px-2 sm:px-3 py-2 text-center">
                    <button onClick={() => removeOp(idx)} data-testid={`dep-op-remove-${idx}`}
                      className="w-7 h-7 rounded-lg hover:bg-red-50 text-red-500 flex items-center justify-center mx-auto">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
              {mm.operators.length === 0 && (
                <tr><td colSpan={11} className="text-center py-6 text-[11px] text-slate-400">Aucun opérateur configuré. Cliquez sur « Ajouter un opérateur ».</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <button onClick={addOp} data-testid="btn-add-dep-op"
          className="mt-3 inline-flex items-center gap-1.5 text-[11px] sm:text-xs font-semibold text-[#2563EB] hover:text-[#1D4ED8]">
          <Plus className="w-3.5 h-3.5" /> Ajouter un opérateur
        </button>

        <div className="mt-4 rounded-xl border border-slate-100 bg-slate-50/60 p-3 text-[11px] text-slate-600 leading-relaxed">
          <div className="flex items-center gap-1.5 font-bold text-slate-700 mb-1"><Smartphone className="w-3 h-3" /> Application des frais</div>
          Les frais et limites configurés ici sont appliqués <b>automatiquement</b> à tous les dépôts Mobile Money :
          <ul className="list-disc list-inside mt-1 space-y-0.5">
            <li>Dépôts directs depuis le tableau de bord</li>
            <li>Paiements via lien de paiement</li>
            <li>Paiements initiés via l'API marchand</li>
          </ul>
          Toute modification est prise en compte <b>immédiatement</b>, sans redémarrage.
        </div>
      </Section>
    </div>
  );
}


function Section({ title, subtitle, Icon, iconBg, enabled, saving, onEnabledChange, children, testId }) {
  return (
    <div className="bg-white border border-slate-100 rounded-2xl p-3 sm:p-5" data-testid={`section-${testId}`}>
      <div className="flex items-start sm:items-center justify-between mb-3 sm:mb-4 flex-wrap gap-2 sm:gap-3">
        <div className="flex items-center gap-2.5 sm:gap-3 min-w-0 flex-1">
          <div className={`w-8 h-8 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center shrink-0 ${iconBg}`}>
            <Icon className="w-4 h-4 sm:w-5 sm:h-5" />
          </div>
          <div className="min-w-0">
            <h2 className="font-cabinet font-bold text-slate-900 text-[13px] sm:text-sm truncate">{title}</h2>
            <p className="text-[10px] sm:text-[11px] text-slate-500 truncate">{subtitle}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          <span data-testid={`state-${testId}`} className={`hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-bold text-[10px] ${enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${enabled ? 'bg-emerald-500' : 'bg-slate-400'}`} /> {enabled ? 'Activé' : 'Désactivé'}
          </span>
          {enabled ? (
            <button onClick={() => onEnabledChange(false)} disabled={saving} data-testid={`toggle-${testId}-off`}
              className="inline-flex items-center gap-1.5 sm:gap-2 px-3 py-1.5 rounded-full font-bold text-[10px] sm:text-xs bg-red-50 text-red-700 hover:bg-red-100 disabled:opacity-50">
              <ToggleRight className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> {saving ? '…' : 'Désactiver'}
            </button>
          ) : (
            <button onClick={() => onEnabledChange(true)} disabled={saving} data-testid={`toggle-${testId}-on`}
              className="inline-flex items-center gap-1.5 sm:gap-2 px-3 py-1.5 rounded-full font-bold text-[10px] sm:text-xs bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50">
              <ToggleLeft className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> {saving ? '…' : 'Activer'}
            </button>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}
