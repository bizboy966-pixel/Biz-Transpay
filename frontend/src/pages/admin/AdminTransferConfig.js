import { useEffect, useState } from 'react';
import { Save, Plus, Trash2, ToggleLeft, ToggleRight, Smartphone, Landmark } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';
import { COUNTRIES } from '@/constants/countries';

export default function AdminTransferConfig() {
  const [cfg, setCfg] = useState(null);
  const [dirty, setDirty] = useState(false);

  const load = () => api.get('/admin/transfer/config').then(({ data }) => setCfg(data)).catch(() => {});
  useEffect(() => { load(); }, []);

  const save = async () => {
    try {
      await api.patch('/admin/transfer/config', { mobile_money: cfg.mobile_money, bank: cfg.bank });
      toast.success('Configuration enregistrée');
      setDirty(false);
    } catch (err) { toast.error(err.response?.data?.detail || 'Erreur'); }
  };

  if (!cfg) return <div className="text-slate-500 text-sm">Chargement…</div>;

  const mm = cfg.mobile_money || { enabled: false, operators: [] };
  const bank = cfg.bank || { enabled: false, banks: [] };

  const toggle = (section) => {
    setCfg({ ...cfg, [section]: { ...cfg[section], enabled: !cfg[section].enabled } });
    setDirty(true);
  };

  const updateOp = (idx, key, val) => {
    const ops = [...mm.operators];
    ops[idx] = { ...ops[idx], [key]: val };
    setCfg({ ...cfg, mobile_money: { ...mm, operators: ops } });
    setDirty(true);
  };
  const addOp = () => {
    setCfg({ ...cfg, mobile_money: { ...mm, operators: [...mm.operators, { country: 'TG', code: '', name: '', fee_pct: 1.5, min: 100, max: 500000, active: true }] } });
    setDirty(true);
  };
  const removeOp = (idx) => {
    setCfg({ ...cfg, mobile_money: { ...mm, operators: mm.operators.filter((_, i) => i !== idx) } });
    setDirty(true);
  };

  const updateBank = (idx, key, val) => {
    const banks = [...bank.banks];
    banks[idx] = { ...banks[idx], [key]: val };
    setCfg({ ...cfg, bank: { ...bank, banks } });
    setDirty(true);
  };
  const addBank = () => {
    setCfg({ ...cfg, bank: { ...bank, banks: [...bank.banks, { country: 'TG', code: '', name: '', fee_pct: 2.0, min: 1000, max: 5000000, active: true }] } });
    setDirty(true);
  };
  const removeBank = (idx) => {
    setCfg({ ...cfg, bank: { ...bank, banks: bank.banks.filter((_, i) => i !== idx) } });
    setDirty(true);
  };

  return (
    <div className="space-y-6" data-testid="admin-transfer-config">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-cabinet font-bold text-slate-900 text-lg">Configuration des transferts</h1>
          <p className="text-xs text-slate-500 mt-0.5">Paramétrez les pays, opérateurs, frais et disponibilité.</p>
        </div>
        <button onClick={save} disabled={!dirty} data-testid="btn-save-transfer-config" className="inline-flex items-center gap-2 bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold px-4 py-2 rounded-full text-xs disabled:opacity-50">
          <Save className="w-3.5 h-3.5" /> Enregistrer les modifications
        </button>
      </div>

      {/* Mobile Money */}
      <div className="bg-white border border-slate-100 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center"><Smartphone className="w-5 h-5" /></div>
            <div>
              <h2 className="font-cabinet font-bold text-slate-900">Biz-trans → Mobile Money</h2>
              <p className="text-[11px] text-slate-500">{mm.operators.length} opérateurs configurés</p>
            </div>
          </div>
          <button onClick={() => toggle('mobile_money')} data-testid="toggle-mm" className={`flex items-center gap-2 px-3 py-1.5 rounded-full font-bold text-xs ${mm.enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
            {mm.enabled ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
            {mm.enabled ? 'Activé' : 'Désactivé'}
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              <tr>
                <th className="text-left px-3 py-2">Pays</th>
                <th className="text-left px-3 py-2">Code</th>
                <th className="text-left px-3 py-2">Nom</th>
                <th className="text-right px-3 py-2">Frais %</th>
                <th className="text-right px-3 py-2">Min</th>
                <th className="text-right px-3 py-2">Max</th>
                <th className="text-center px-3 py-2">Actif</th>
                <th className="text-center px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {mm.operators.map((o, idx) => (
                <tr key={idx} data-testid={`op-row-${idx}`} className="border-t border-slate-50">
                  <td className="px-3 py-2">
                    <select value={o.country} onChange={(e) => updateOp(idx, 'country', e.target.value)} className="px-2 py-1 border border-slate-200 rounded-lg text-xs">
                      {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.flag} {c.code}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2"><input value={o.code} onChange={(e) => updateOp(idx, 'code', e.target.value.toLowerCase())} className="w-24 px-2 py-1 border border-slate-200 rounded-lg text-xs font-mono" /></td>
                  <td className="px-3 py-2"><input value={o.name} onChange={(e) => updateOp(idx, 'name', e.target.value)} className="w-40 px-2 py-1 border border-slate-200 rounded-lg text-xs" /></td>
                  <td className="px-3 py-2"><input type="number" step="0.1" value={o.fee_pct} onChange={(e) => updateOp(idx, 'fee_pct', parseFloat(e.target.value) || 0)} className="w-16 px-2 py-1 border border-slate-200 rounded-lg text-xs text-right" /></td>
                  <td className="px-3 py-2"><input type="number" value={o.min} onChange={(e) => updateOp(idx, 'min', parseInt(e.target.value) || 0)} className="w-20 px-2 py-1 border border-slate-200 rounded-lg text-xs text-right" /></td>
                  <td className="px-3 py-2"><input type="number" value={o.max} onChange={(e) => updateOp(idx, 'max', parseInt(e.target.value) || 0)} className="w-24 px-2 py-1 border border-slate-200 rounded-lg text-xs text-right" /></td>
                  <td className="px-3 py-2 text-center">
                    <input type="checkbox" checked={o.active} onChange={(e) => updateOp(idx, 'active', e.target.checked)} className="w-4 h-4 accent-[#2563EB]" />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <button onClick={() => removeOp(idx)} data-testid={`btn-remove-op-${idx}`} className="w-7 h-7 rounded-lg hover:bg-red-50 text-red-500 flex items-center justify-center mx-auto"><Trash2 className="w-3.5 h-3.5" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button onClick={addOp} data-testid="btn-add-op" className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-[#2563EB] hover:text-[#1D4ED8]">
          <Plus className="w-3.5 h-3.5" /> Ajouter un opérateur
        </button>
      </div>

      {/* Banks */}
      <div className="bg-white border border-slate-100 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-violet-50 text-violet-600 flex items-center justify-center"><Landmark className="w-5 h-5" /></div>
            <div>
              <h2 className="font-cabinet font-bold text-slate-900">Biz-trans → Banque</h2>
              <p className="text-[11px] text-slate-500">{bank.banks.length} banques configurées</p>
            </div>
          </div>
          <button onClick={() => toggle('bank')} data-testid="toggle-bank" className={`flex items-center gap-2 px-3 py-1.5 rounded-full font-bold text-xs ${bank.enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
            {bank.enabled ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
            {bank.enabled ? 'Activé' : 'Désactivé'}
          </button>
        </div>
        {bank.banks.length === 0 && (
          <div className="text-center py-6 text-xs text-slate-500">Aucune banque configurée. Ajoutez-en une pour activer les transferts bancaires.</div>
        )}
        {bank.banks.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="text-left px-3 py-2">Pays</th>
                  <th className="text-left px-3 py-2">Code</th>
                  <th className="text-left px-3 py-2">Nom</th>
                  <th className="text-right px-3 py-2">Frais %</th>
                  <th className="text-right px-3 py-2">Min</th>
                  <th className="text-right px-3 py-2">Max</th>
                  <th className="text-center px-3 py-2">Actif</th>
                  <th className="text-center px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {bank.banks.map((b, idx) => (
                  <tr key={idx} className="border-t border-slate-50">
                    <td className="px-3 py-2">
                      <select value={b.country} onChange={(e) => updateBank(idx, 'country', e.target.value)} className="px-2 py-1 border border-slate-200 rounded-lg text-xs">
                        {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.flag} {c.code}</option>)}
                      </select>
                    </td>
                    <td className="px-3 py-2"><input value={b.code} onChange={(e) => updateBank(idx, 'code', e.target.value)} className="w-24 px-2 py-1 border border-slate-200 rounded-lg text-xs" /></td>
                    <td className="px-3 py-2"><input value={b.name} onChange={(e) => updateBank(idx, 'name', e.target.value)} className="w-52 px-2 py-1 border border-slate-200 rounded-lg text-xs" /></td>
                    <td className="px-3 py-2"><input type="number" step="0.1" value={b.fee_pct} onChange={(e) => updateBank(idx, 'fee_pct', parseFloat(e.target.value) || 0)} className="w-16 px-2 py-1 border border-slate-200 rounded-lg text-xs text-right" /></td>
                    <td className="px-3 py-2"><input type="number" value={b.min} onChange={(e) => updateBank(idx, 'min', parseInt(e.target.value) || 0)} className="w-20 px-2 py-1 border border-slate-200 rounded-lg text-xs text-right" /></td>
                    <td className="px-3 py-2"><input type="number" value={b.max} onChange={(e) => updateBank(idx, 'max', parseInt(e.target.value) || 0)} className="w-24 px-2 py-1 border border-slate-200 rounded-lg text-xs text-right" /></td>
                    <td className="px-3 py-2 text-center"><input type="checkbox" checked={b.active} onChange={(e) => updateBank(idx, 'active', e.target.checked)} className="w-4 h-4 accent-[#2563EB]" /></td>
                    <td className="px-3 py-2 text-center"><button onClick={() => removeBank(idx)} className="text-red-500"><Trash2 className="w-3.5 h-3.5" /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <button onClick={addBank} data-testid="btn-add-bank" className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-[#2563EB]">
          <Plus className="w-3.5 h-3.5" /> Ajouter une banque
        </button>
      </div>
    </div>
  );
}
