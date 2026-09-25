import { useEffect, useState } from 'react';
import { Save, Repeat, PauseCircle, PlayCircle, AlertTriangle, Trash2, X, Smartphone, Bitcoin } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';
import { useAuth } from '@/context/AuthContext';

export default function AdminPlatform() {
  const { user } = useAuth();
  const [cfg, setCfg] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetInput, setResetInput] = useState('');
  const [resetting, setResetting] = useState(false);
  const [fullWipeOpen, setFullWipeOpen] = useState(false);
  const [fullWipeInput, setFullWipeInput] = useState('');
  const [fullWiping, setFullWiping] = useState(false);
  const [features, setFeatures] = useState(null);
  const [savingFeature, setSavingFeature] = useState(null);
  const [referralLoading, setReferralLoading] = useState(true);
  const [referralError, setReferralError] = useState(false);
  const [referralSaving, setReferralSaving] = useState(false);
  const [referralRate, setReferralRate] = useState('');
  const canEditReferralRate = user?.permissions?.includes('*') || user?.permissions?.includes('settings:write');

  const load = () => api.get('/admin/platform/config').then(({ data }) => setCfg(data));
  const loadFeatures = () => api.get('/admin/settings/features').then(({ data }) => setFeatures(data));
  const loadReferralConfig = async () => {
    setReferralLoading(true);
    setReferralError(false);
    try {
      const { data } = await api.get('/admin/referrals/config');
      setReferralRate(data?.rate_percent ?? '');
    } catch {
      setReferralError(true);
    } finally {
      setReferralLoading(false);
    }
  };
  useEffect(() => { load(); loadFeatures(); loadReferralConfig(); }, []);

  const saveReferralConfig = async (event) => {
    event.preventDefault();
    const rate = Number(referralRate);
    if (!Number.isFinite(rate) || rate < 2 || rate > 2.5) {
      toast.error('Saisissez un taux compris entre 2 % et 2,5 %.');
      return;
    }
    setReferralSaving(true);
    try {
      const { data } = await api.patch('/admin/referrals/config', { rate_percent: rate });
      setReferralRate(data?.rate_percent ?? rate);
      toast.success('Taux de parrainage enregistré.');
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Impossible d’enregistrer le taux de parrainage.');
    } finally {
      setReferralSaving(false);
    }
  };

  const toggleFeature = async (key, value) => {
    setSavingFeature(key);
    try {
      const { data } = await api.patch('/admin/settings/features', { [key]: value });
      setFeatures(data);
      toast.success(value ? 'Fonctionnalité activée' : 'Fonctionnalité désactivée');
    } catch (err) { toast.error(err.response?.data?.detail || 'Erreur'); }
    finally { setSavingFeature(null); }
  };

  const saveFeatureMessage = async (key, value) => {
    try {
      await api.patch('/admin/settings/features', { [key]: value });
      toast.success('Message enregistré');
    } catch (err) { toast.error(err.response?.data?.detail || 'Erreur'); }
  };

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

      <section className="rounded-2xl border border-blue-100 bg-white p-4 sm:p-5" aria-labelledby="referral-config-title" data-testid="admin-referral-config">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h2 id="referral-config-title" className="font-cabinet font-bold text-slate-900">Commission de parrainage</h2>
            <p className="mt-0.5 text-[11px] text-slate-500">Taux appliqué à la commission unique après 5 inscriptions qualifiées.</p>
          </div>
          {referralLoading ? (
            <div className="h-9 w-40 animate-pulse rounded-lg bg-slate-100" aria-label="Chargement du taux" />
          ) : referralError ? (
            <button type="button" onClick={loadReferralConfig} className="self-start rounded-full border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 hover:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-500">Réessayer</button>
          ) : (
            <form onSubmit={saveReferralConfig} className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-end">
              <div className="flex-1 sm:w-32">
                <label htmlFor="referral-rate-percent" className="mb-1 block text-[11px] font-semibold text-slate-600">Taux (%)</label>
                <input
                  id="referral-rate-percent"
                  type="number"
                  min="2"
                  max="2.5"
                  step="0.01"
                  value={referralRate}
                  onChange={(event) => setReferralRate(event.target.value)}
                  disabled={!canEditReferralRate || referralSaving}
                  readOnly={!canEditReferralRate}
                  aria-describedby="referral-rate-help"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-[#2563EB] focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50"
                />
              </div>
              {canEditReferralRate && (
                <button type="submit" disabled={referralSaving || referralRate === ''} className="inline-flex min-h-9 items-center justify-center gap-2 rounded-full bg-[#2563EB] px-4 py-2 text-xs font-bold text-white hover:bg-[#1D4ED8] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50">
                  <Save className="h-3.5 w-3.5" /> {referralSaving ? 'Enregistrement…' : 'Enregistrer'}
                </button>
              )}
            </form>
          )}
        </div>
        {!referralLoading && !referralError && (
          <p id="referral-rate-help" className="mt-2 text-[10px] text-slate-500">
            {canEditReferralRate
              ? 'Valeur comprise entre 2 % et 2,5 %. Seuls les rôles autorisés aux paramètres peuvent modifier ce taux.'
              : 'Lecture seule : votre rôle ne dispose pas de l’autorisation settings:write.'}
          </p>
        )}
      </section>

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
             Aperçu : sur un échange de <b>{previewOn.toLocaleString()} XOF</b> → frais appliqués : <b className="text-slate-900">{previewClamped.toLocaleString(undefined, { maximumFractionDigits: 2 })} XOF</b>
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

      {/* Feature toggles — Mobile Money / Crypto wallets */}
      {features && (
        <div className="bg-white border border-slate-100 rounded-2xl p-5" data-testid="feature-toggles">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-violet-50 text-violet-600 flex items-center justify-center"><PauseCircle className="w-5 h-5" /></div>
            <div className="flex-1">
              <h2 className="font-cabinet font-bold text-slate-900">Portefeuilles disponibles</h2>
              <p className="text-[11px] text-slate-500">
                Désactivez un portefeuille pour masquer toutes ses fonctionnalités
                côté utilisateur (dépôt, retrait, échange, liens de paiement, API).
                Un écran <em>« Bientôt disponible »</em> s&apos;affiche à la place.
              </p>
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            {/* Mobile Money */}
            <div className={`p-4 rounded-2xl border-2 transition-colors ${features.mobile_money_enabled ? 'border-emerald-200 bg-emerald-50/40' : 'border-slate-200 bg-slate-50/60'}`}>
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-white text-blue-600 flex items-center justify-center shadow-sm shrink-0">
                  <Smartphone className="w-5 h-5" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-cabinet font-bold text-sm text-slate-900">Mobile Money</div>
                      <div className="text-[11px] text-slate-500">Easy Change Pay · catalogue crypto synchronisé</div>
                    </div>
                    <label className="inline-flex items-center cursor-pointer shrink-0">
                      <input type="checkbox"
                        checked={!!features.mobile_money_enabled}
                        onChange={(e) => toggleFeature('mobile_money_enabled', e.target.checked)}
                        disabled={savingFeature === 'mobile_money_enabled'}
                        data-testid="toggle-mobile-money"
                        className="sr-only peer" />
                      <div className="relative w-11 h-6 bg-slate-300 peer-checked:bg-emerald-500 rounded-full transition-colors">
                        <div className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${features.mobile_money_enabled ? 'translate-x-5' : ''}`} />
                      </div>
                    </label>
                  </div>
                  {!features.mobile_money_enabled && (
                    <div className="mt-3">
                      <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Message affiché aux utilisateurs</label>
                      <input
                        type="text"
                        defaultValue={features.mobile_money_coming_soon_message}
                        onBlur={(e) => e.target.value !== features.mobile_money_coming_soon_message && saveFeatureMessage('mobile_money_coming_soon_message', e.target.value)}
                        data-testid="msg-mobile-money"
                        placeholder="Bientôt disponible…"
                        className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 focus:border-blue-400 focus:outline-none text-xs bg-white" />
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Crypto */}
            <div className={`p-4 rounded-2xl border-2 transition-colors ${features.crypto_enabled ? 'border-emerald-200 bg-emerald-50/40' : 'border-slate-200 bg-slate-50/60'}`}>
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-white text-amber-600 flex items-center justify-center shadow-sm shrink-0">
                  <Bitcoin className="w-5 h-5" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-cabinet font-bold text-sm text-slate-900">Crypto</div>
                      <div className="text-[11px] text-slate-500">IziChange · USDT · USDC · BTC · ETH · 40+ actifs</div>
                    </div>
                    <label className="inline-flex items-center cursor-pointer shrink-0">
                      <input type="checkbox"
                        checked={!!features.crypto_enabled}
                        onChange={(e) => toggleFeature('crypto_enabled', e.target.checked)}
                        disabled={savingFeature === 'crypto_enabled'}
                        data-testid="toggle-crypto"
                        className="sr-only peer" />
                      <div className="relative w-11 h-6 bg-slate-300 peer-checked:bg-emerald-500 rounded-full transition-colors">
                        <div className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${features.crypto_enabled ? 'translate-x-5' : ''}`} />
                      </div>
                    </label>
                  </div>
                  {!features.crypto_enabled && (
                    <div className="mt-3">
                      <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Message affiché aux utilisateurs</label>
                      <input
                        type="text"
                        defaultValue={features.crypto_coming_soon_message}
                        onBlur={(e) => e.target.value !== features.crypto_coming_soon_message && saveFeatureMessage('crypto_coming_soon_message', e.target.value)}
                        data-testid="msg-crypto"
                        placeholder="Bientôt disponible…"
                        className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 focus:border-blue-400 focus:outline-none text-xs bg-white" />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Danger zone — full platform reset */}
      <div className="rounded-2xl border-2 border-red-200 bg-red-50/60 p-5" data-testid="danger-zone">
        <div className="flex items-start gap-4">
          <div className="w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 bg-red-500 text-white">
            <AlertTriangle className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h2 className="font-cabinet font-bold text-red-900">Zone de danger — Réinitialiser la plateforme</h2>
            <p className="text-xs text-red-800/90 mt-1 leading-relaxed max-w-2xl">
              Supprime <b>définitivement</b> tous les utilisateurs (sauf les super_admin), toutes les
              transactions, tous les liens de paiement, webhooks, notifications, KYC, tickets, journaux
              API, dépôts crypto, historiques et clés API. Les soldes des super_admin sont remis à zéro.
              Toutes les cartes du tableau de bord reviennent à 0.
              <br />
              <b>Cette action est irréversible.</b> Assurez-vous d&apos;avoir un backup avant de confirmer.
            </p>
          </div>
          <button
            onClick={() => { setResetInput(''); setResetOpen(true); }}
            data-testid="btn-open-platform-reset"
            className="inline-flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white font-bold px-4 py-2 rounded-full text-xs shrink-0"
          >
            <Trash2 className="w-3.5 h-3.5" /> Réinitialiser
          </button>
           <button
             onClick={() => { setFullWipeInput(''); setFullWipeOpen(true); }}
             data-testid="btn-open-full-wipe"
             className="inline-flex items-center gap-2 bg-red-950 hover:bg-black text-white font-bold px-4 py-2 rounded-full text-xs shrink-0"
           >
             <Trash2 className="w-3.5 h-3.5" /> Supprimer tous les comptes
           </button>
        </div>
      </div>

      {resetOpen && (
        <div className="fixed inset-0 z-[100] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4" data-testid="reset-modal">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden">
            <div className="p-5 border-b border-slate-100 flex items-center justify-between bg-red-50">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-red-500 text-white flex items-center justify-center">
                  <AlertTriangle className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-cabinet font-bold text-red-900 text-base">Réinitialiser la plateforme</h3>
                  <p className="text-[11px] text-red-800/80">Action irréversible</p>
                </div>
              </div>
              <button onClick={() => !resetting && setResetOpen(false)} disabled={resetting} className="text-slate-400 hover:text-slate-700"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-5 space-y-3.5">
              <div className="rounded-xl bg-red-50 border border-red-200 p-3 text-[12px] text-red-900 leading-relaxed">
                Vous êtes sur le point de supprimer <b>toutes les données</b> de la plateforme : utilisateurs (sauf super_admin), transactions, liens, webhooks, notifications, KYC, journaux, clés API, dépôts crypto. Les soldes des super_admin sont remis à zéro.
              </div>
              <div>
                <label className="text-xs font-bold text-slate-700 mb-1.5 block">
                  Pour confirmer, tapez <span className="font-mono px-1.5 py-0.5 bg-slate-100 rounded text-red-700">RÉINITIALISER</span> ci-dessous :
                </label>
                <input
                  type="text"
                  value={resetInput}
                  onChange={(e) => setResetInput(e.target.value)}
                  data-testid="reset-confirm-input"
                  autoFocus
                  disabled={resetting}
                  className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-red-500 text-sm font-mono"
                  placeholder="RÉINITIALISER"
                />
              </div>
            </div>
            <div className="p-5 pt-0 flex items-center justify-end gap-2">
              <button
                onClick={() => setResetOpen(false)}
                disabled={resetting}
                className="px-4 py-2 rounded-full text-xs font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-50"
              >
                Annuler
              </button>
              <button
                onClick={async () => {
                  if (resetInput !== 'RÉINITIALISER') return;
                  setResetting(true);
                  try {
                    const { data } = await api.post('/admin/platform/reset', { confirmation: 'RÉINITIALISER' });
                    toast.success(`Plateforme réinitialisée — ${data.deleted_users} utilisateurs supprimés`);
                    setResetOpen(false);
                    setResetInput('');
                  } catch (err) {
                    toast.error(err.response?.data?.detail || 'Erreur pendant la réinitialisation');
                  } finally {
                    setResetting(false);
                  }
                }}
                disabled={resetInput !== 'RÉINITIALISER' || resetting}
                data-testid="btn-confirm-platform-reset"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-xs font-bold text-white bg-red-600 hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {resetting ? (<><Repeat className="w-3.5 h-3.5 animate-spin" /> Réinitialisation…</>) : (<><Trash2 className="w-3.5 h-3.5" /> Confirmer</>)}
              </button>
            </div>
          </div>
        </div>
      )}

      {fullWipeOpen && (
        <div className="fixed inset-0 z-[100] bg-slate-900/70 backdrop-blur-sm flex items-center justify-center p-4" data-testid="full-wipe-modal">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden">
            <div className="p-5 border-b border-red-200 flex items-center justify-between bg-red-950">
              <div className="flex items-center gap-2.5 text-white">
                <AlertTriangle className="w-5 h-5" />
                <div>
                  <h3 className="font-cabinet font-bold text-base">Supprimer toute la base utilisateur</h3>
                  <p className="text-[11px] text-red-100/80">Action définitive — aucun compte ne sera conservé</p>
                </div>
              </div>
              <button onClick={() => !fullWiping && setFullWipeOpen(false)} disabled={fullWiping} className="text-red-100 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-5 space-y-3.5">
              <div className="rounded-xl bg-red-50 border border-red-200 p-3 text-[12px] text-red-950 leading-relaxed">
                Cette action supprime définitivement <b>tous les comptes</b>, sessions, clés API,
                transactions, liens de paiement, KYC, notifications, journaux et données financières.
                Vous serez déconnecté et devrez créer le premier compte à nouveau.
                <br /><b>Cette action est irréversible. Vérifiez vos sauvegardes avant de continuer.</b>
              </div>
              <div>
                <label className="text-xs font-bold text-slate-700 mb-1.5 block">
                  Pour confirmer, tapez <span className="font-mono px-1.5 py-0.5 bg-slate-100 rounded text-red-700">SUPPRIMER_TOUT</span> :
                </label>
                <input
                  type="text"
                  value={fullWipeInput}
                  onChange={(e) => setFullWipeInput(e.target.value)}
                  data-testid="full-wipe-confirm-input"
                  autoFocus
                  disabled={fullWiping}
                  className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-red-950 text-sm font-mono"
                  placeholder="SUPPRIMER_TOUT"
                />
              </div>
            </div>
            <div className="p-5 pt-0 flex items-center justify-end gap-2">
              <button
                onClick={() => setFullWipeOpen(false)}
                disabled={fullWiping}
                className="px-4 py-2 rounded-full text-xs font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-50"
              >Annuler</button>
              <button
                onClick={async () => {
                  if (fullWipeInput !== 'SUPPRIMER_TOUT') return;
                  setFullWiping(true);
                  try {
                    const { data } = await api.post('/admin/platform/reset', {
                      confirmation: 'SUPPRIMER_TOUT',
                      delete_all: true,
                    });
                    toast.success(`${data.deleted_users} comptes supprimés. Vous pouvez refaire la première inscription.`);
                    window.location.href = '/register';
                  } catch (err) {
                    toast.error(err.response?.data?.detail || 'Erreur pendant la suppression complète');
                    setFullWiping(false);
                  }
                }}
                disabled={fullWipeInput !== 'SUPPRIMER_TOUT' || fullWiping}
                data-testid="btn-confirm-full-wipe"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-xs font-bold text-white bg-red-950 hover:bg-black disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {fullWiping ? (<><Repeat className="w-3.5 h-3.5 animate-spin" /> Suppression…</>) : (<><Trash2 className="w-3.5 h-3.5" /> Supprimer définitivement</>)}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
