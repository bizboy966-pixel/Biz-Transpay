import { useEffect, useState } from 'react';
import { Save, Repeat, PauseCircle, PlayCircle, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';

export default function AdminPlatform() {
  const [cfg, setCfg] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = () => api.get('/admin/platform/config').then(({ data }) => setCfg(data));
  useEffect(() => { load(); }, []);

  const save = async () => {
    try {
      await api.patch('/admin/platform/config', { conversion_fee: cfg.conversion_fee, auto_withdrawals_disabled: cfg.auto_withdrawals_disabled });
      toast.success('Configuration enregistrée');
      setDirty(false);
    } catch (err) { toast.error(err.response?.data?.detail || 'Erreur'); }
  };

  // Auto-save a single patch immediately (used for toggles)
  const patchNow = async (patch) => {
    setSaving(true);
    try {
      const { data } = await api.patch('/admin/platform/config', patch);
      setCfg(data);
      toast.success('Modification appliquée');
    } catch (err) { toast.error(err.response?.data?.detail || 'Erreur'); }
    finally { setSaving(false); }
  };

  if (!cfg) return <div className="text-slate-500 text-sm">Chargement…</div>;
  const fee = cfg.conversion_fee || {};

  const update = (path, value) => {
    setCfg((c) => {
      const next = JSON.parse(JSON.stringify(c));
      if (path[0] === 'fee') next.conversion_fee[path[1]] = value;
      else next[path[0]] = value;
      return next;
    });
    setDirty(true);
  };

  const previewOn = 10000;
  const previewFee = !fee.enabled ? 0 : (fee.type === 'fixed' ? +fee.value : previewOn * +fee.value / 100);
  const previewClamped = Math.min(Math.max(previewFee, +(fee.min_fee || 0)), fee.max_fee != null ? +fee.max_fee : previewFee);

  return (
    <div className="space-y-5" data-testid="admin-platform-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-cabinet font-bold text-slate-900 text-lg">Configuration plateforme</h1>
          <p className="text-xs text-slate-500 mt-0.5">Frais de conversion et contrôles globaux.</p>
        </div>
        <button onClick={save} disabled={!dirty} data-testid="btn-save-platform" className="inline-flex items-center gap-2 bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold px-4 py-2 rounded-full text-xs disabled:opacity-50">
          <Save className="w-3.5 h-3.5" /> Enregistrer
        </button>
      </div>

      {/* Conversion fees */}
      <div className="bg-white border border-slate-100 rounded-2xl p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-blue-50 text-[#2563EB] flex items-center justify-center"><Repeat className="w-5 h-5" /></div>
          <div className="flex-1">
            <h2 className="font-cabinet font-bold text-slate-900">Frais de conversion</h2>
            <p className="text-[11px] text-slate-500">Frais appliqués sur toutes les opérations d&apos;échange XOF ↔ XAF.</p>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" data-testid="fee-enabled" checked={fee.enabled} onChange={(e) => patchNow({ conversion_fee: { ...fee, enabled: e.target.checked } })} disabled={saving} className="w-4 h-4 accent-[#2563EB]" />
            <span className="text-xs font-semibold">Activer les frais</span>
          </label>
        </div>

        <div className={`grid sm:grid-cols-2 gap-3 ${!fee.enabled ? 'opacity-50 pointer-events-none' : ''}`}>
          <div>
            <label className="text-xs font-semibold text-slate-700 mb-1.5 block">Type de frais</label>
            <div className="grid grid-cols-2 gap-2">
              {[
                { v: 'percent', l: 'Pourcentage', s: 'Ex: 0.5%' },
                { v: 'fixed', l: 'Montant fixe', s: 'Ex: 100 XOF' },
              ].map((o) => (
                <button key={o.v} type="button" onClick={() => update(['fee', 'type'], o.v)} data-testid={`fee-type-${o.v}`} className={`p-3 rounded-xl border-2 text-left transition-colors ${fee.type === o.v ? 'border-[#2563EB] bg-blue-50/60' : 'border-slate-200 hover:border-slate-300'}`}>
                  <div className="font-cabinet font-bold text-xs text-slate-900">{o.l}</div>
                  <div className="text-[10px] text-slate-500 mt-0.5">{o.s}</div>
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-700 mb-1.5 block">Valeur des frais ({fee.type === 'percent' ? '%' : 'devise'})</label>
            <input data-testid="fee-value" type="number" step="0.01" value={fee.value ?? 0} onChange={(e) => update(['fee', 'value'], parseFloat(e.target.value) || 0)} className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm" />
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-700 mb-1.5 block">Frais minimum (optionnel)</label>
            <input data-testid="fee-min" type="number" value={fee.min_fee ?? 0} onChange={(e) => update(['fee', 'min_fee'], parseFloat(e.target.value) || 0)} className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm" />
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-700 mb-1.5 block">Frais maximum (optionnel, vide = illimité)</label>
            <input data-testid="fee-max" type="number" value={fee.max_fee ?? ''} onChange={(e) => update(['fee', 'max_fee'], e.target.value === '' ? null : parseFloat(e.target.value))} className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm" />
          </div>
        </div>

        {fee.enabled && (
          <div className="mt-4 p-3 bg-slate-50 rounded-xl text-xs text-slate-600" data-testid="fee-preview">
            💡 Aperçu : sur un échange de <b>{previewOn.toLocaleString()} XOF</b> → frais appliqués : <b className="text-slate-900">{previewClamped.toLocaleString(undefined, { maximumFractionDigits: 2 })} XOF</b>
          </div>
        )}
      </div>

      {/* Auto-withdrawals toggle */}
      <div className={`rounded-2xl p-5 border ${cfg.auto_withdrawals_disabled ? 'bg-red-50 border-red-200' : 'bg-white border-slate-100'}`}>
        <div className="flex items-start gap-4">
          <div className={`w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 ${cfg.auto_withdrawals_disabled ? 'bg-red-500 text-white' : 'bg-emerald-500 text-white'}`}>
            {cfg.auto_withdrawals_disabled ? <PauseCircle className="w-5 h-5" /> : <PlayCircle className="w-5 h-5" />}
          </div>
          <div className="flex-1">
            <h2 className="font-cabinet font-bold text-slate-900">Retraits automatiques</h2>
            <p className="text-xs text-slate-600 mt-0.5">
              {cfg.auto_withdrawals_disabled
                ? 'Les retraits automatiques sont SUSPENDUS. Toute nouvelle demande de transfert Mobile Money ou bancaire sera conservée en statut "en attente" et devra être traitée manuellement.'
                : 'Les retraits automatiques fonctionnent normalement selon les paramètres configurés.'}
            </p>
            {cfg.auto_withdrawals_disabled && (
              <div className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-red-700 font-bold">
                <AlertTriangle className="w-3.5 h-3.5" /> Mode maintenance actif
              </div>
            )}
          </div>
          <label className="flex items-center cursor-pointer">
            <input type="checkbox" data-testid="auto-withdrawals-toggle" checked={cfg.auto_withdrawals_disabled} onChange={(e) => patchNow({ auto_withdrawals_disabled: e.target.checked })} disabled={saving} className="sr-only peer" />
            <div className="relative w-12 h-6 bg-slate-200 peer-checked:bg-red-500 rounded-full transition-colors">
              <div className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${cfg.auto_withdrawals_disabled ? 'translate-x-6' : ''}`} />
            </div>
            <span className="ml-2 text-xs font-bold text-slate-900">{cfg.auto_withdrawals_disabled ? 'Désactivés' : 'Activés'}</span>
          </label>
        </div>
      </div>
    </div>
  );
}
