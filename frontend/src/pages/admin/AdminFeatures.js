import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Wallet, Coins, Bitcoin, ArrowDownToLine, ArrowUpFromLine, Eye, EyeOff, Check, X, AlertTriangle, Info, Link2, Code2 } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';
import { FEATURES_QUERY_KEY } from '@/hooks/useFeatures';

/* Currency descriptors — order matters (visual order in the page). */
const CURRENCIES = [
  {
    key: 'xof',
    label: 'XOF',
    subtitle: 'Franc CFA (BCEAO)',
    country: 'Bénin · Togo · Côte d\'Ivoire · Sénégal · Mali · Burkina · Niger · Guinée-Bissau',
    accent: 'from-[#3B82F6] to-[#1D4ED8]',
    ring: 'ring-blue-100',
    chip: 'bg-blue-50 text-blue-700 border-blue-200',
    I: Coins,
  },
  {
    key: 'xaf',
    label: 'XAF',
    subtitle: 'Franc CFA (BEAC)',
    country: 'Cameroun · Congo · Gabon · Tchad · RCA · Guinée Équatoriale',
    accent: 'from-emerald-500 to-emerald-700',
    ring: 'ring-emerald-100',
    chip: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    I: Coins,
  },
  {
    key: 'crypto',
    label: 'Crypto',
    subtitle: 'USDT · USDC · BTC · ETH · 40+ actifs',
    country: 'TRC20 · BEP20 · ERC20 · Polygon · Solana · Bitcoin',
    accent: 'from-amber-500 to-orange-600',
    ring: 'ring-amber-100',
    chip: 'bg-amber-50 text-amber-700 border-amber-200',
    I: Bitcoin,
  },
];

/* Toggle pill — reused across all switches. */
function Toggle({ checked, onChange, disabled, size = 'md', tid }) {
  const dims = size === 'lg'
    ? { track: 'w-14 h-7', thumb: 'w-6 h-6', shift: 'translate-x-7' }
    : { track: 'w-11 h-6', thumb: 'w-5 h-5', shift: 'translate-x-5' };
  return (
    <label className={`inline-flex items-center ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} data-testid={tid} className="sr-only peer" />
      <div className={`relative ${dims.track} bg-slate-300 peer-checked:bg-emerald-500 rounded-full transition-colors`}>
        <div className={`absolute top-0.5 left-0.5 ${dims.thumb} bg-white rounded-full shadow-md transition-transform ${checked ? dims.shift : ''} flex items-center justify-center`}>
          {checked ? <Check className="w-3 h-3 text-emerald-500" /> : <X className="w-3 h-3 text-slate-400" />}
        </div>
      </div>
    </label>
  );
}

/* ------------------------------ Page ------------------------------- */
export default function AdminFeatures() {
  const queryClient = useQueryClient();
  const [features, setFeatures] = useState(null);
  const [saving, setSaving] = useState(null);

  const load = () => api.get('/admin/settings/features').then(({ data }) => setFeatures(data));
  useEffect(() => { load(); }, []);

  const patch = async (key, value) => {
    setSaving(key);
    try {
      const { data } = await api.patch('/admin/settings/features', { [key]: value });
      setFeatures(data);
      queryClient.invalidateQueries({ queryKey: FEATURES_QUERY_KEY });
      toast.success(value ? 'Activé' : 'Désactivé');
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Erreur');
    } finally { setSaving(null); }
  };

  if (!features) return <div className="text-slate-500 text-sm">Chargement…</div>;

  const hasAnyDisabled = CURRENCIES.some((c) =>
    !features[`wallet_${c.key}_enabled`]
    || !features[`deposit_${c.key}_enabled`]
    || !features[`withdrawal_${c.key}_enabled`]
  );

  return (
    <div className="space-y-6" data-testid="admin-features-page">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <h1 className="font-cabinet font-extrabold text-slate-900 text-xl">Fonctionnalités</h1>
          {hasAnyDisabled && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[10px] font-bold border border-amber-200">
              <AlertTriangle className="w-3 h-3" /> Certaines fonctions sont désactivées
            </span>
          )}
        </div>
        <p className="text-xs text-slate-500 mt-1 max-w-2xl">
          Contrôlez précisément quels portefeuilles sont visibles côté utilisateur et quelles opérations
          (dépôts, retraits) sont autorisées pour chaque devise. Chaque changement est appliqué
          instantanément — les utilisateurs voient <em>« Bientôt disponible »</em> à la place des
          fonctionnalités désactivées.
        </p>
      </div>

      {/* Info banner */}
      <div className="p-4 rounded-2xl bg-blue-50 border border-blue-200 flex gap-3">
        <div className="w-8 h-8 rounded-lg bg-blue-500 text-white flex items-center justify-center shrink-0"><Info className="w-4 h-4" /></div>
        <div className="text-[13px] text-blue-900 leading-relaxed">
          <b>Priorité des contrôles</b> — Désactiver un <b>portefeuille</b> masque à la fois son solde et toutes ses opérations chez l'utilisateur.
          Vous pouvez aussi désactiver uniquement le <b>dépôt</b> ou le <b>retrait</b> pour une devise, sans masquer le portefeuille (les autres devises restent utilisables).
        </div>
      </div>

      {/* Currency cards */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {CURRENCIES.map((c) => {
          const walletKey = `wallet_${c.key}_enabled`;
          const depKey = `deposit_${c.key}_enabled`;
          const wdKey = `withdrawal_${c.key}_enabled`;
          const walletOn = !!features[walletKey];
          return (
            <div key={c.key}
                 data-testid={`feature-card-${c.key}`}
                 className={`rounded-2xl p-5 bg-white border border-slate-100 shadow-[0_2px_10px_rgba(15,23,42,0.03)] transition-shadow ${walletOn ? '' : 'opacity-80'}`}>
              {/* Header */}
              <div className="flex items-start gap-3 mb-4">
                <div className={`w-12 h-12 rounded-2xl bg-gradient-to-br ${c.accent} text-white flex items-center justify-center shadow-sm shrink-0`}>
                  <c.I className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="font-cabinet font-extrabold text-lg text-slate-900">{c.label}</div>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${c.chip}`}>
                      {walletOn ? <span className="inline-flex items-center gap-1"><Eye className="w-2.5 h-2.5" /> visible</span> : <span className="inline-flex items-center gap-1"><EyeOff className="w-2.5 h-2.5" /> masqué</span>}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-500">{c.subtitle}</div>
                  <div className="text-[10px] text-slate-400 mt-1 leading-tight">{c.country}</div>
                </div>
              </div>

              {/* Master toggle — wallet visibility */}
              <div className={`p-4 rounded-xl mb-3 ${walletOn ? 'bg-emerald-50 border border-emerald-200' : 'bg-slate-100 border border-slate-200'}`}>
                <div className="flex items-center gap-3">
                  <Wallet className="w-4 h-4 text-slate-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="font-cabinet font-bold text-sm text-slate-900">Portefeuille {c.label}</div>
                    <div className="text-[11px] text-slate-500">Solde + toutes les opérations visibles chez l'utilisateur</div>
                  </div>
                  <Toggle
                    checked={walletOn}
                    onChange={(v) => patch(walletKey, v)}
                    disabled={saving === walletKey}
                    size="lg"
                    tid={`toggle-wallet-${c.key}`}
                  />
                </div>
              </div>

              {/* Deposit / Withdrawal per currency */}
              <div className={`space-y-2 ${!walletOn ? 'opacity-50 pointer-events-none' : ''}`}>
                <div className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-slate-50">
                  <ArrowDownToLine className="w-4 h-4 text-emerald-600 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-semibold text-slate-900">Dépôts {c.label}</div>
                    <div className="text-[10px] text-slate-500">Créditer le solde depuis l'extérieur</div>
                  </div>
                  <Toggle
                    checked={!!features[depKey]}
                    onChange={(v) => patch(depKey, v)}
                    disabled={saving === depKey}
                    tid={`toggle-deposit-${c.key}`}
                  />
                </div>

                <div className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-slate-50">
                  <ArrowUpFromLine className="w-4 h-4 text-red-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-semibold text-slate-900">Retraits {c.label}</div>
                    <div className="text-[10px] text-slate-500">Envoyer vers l'extérieur (banque, wallet, Mobile Money)</div>
                  </div>
                  <Toggle
                    checked={!!features[wdKey]}
                    onChange={(v) => patch(wdKey, v)}
                    disabled={saving === wdKey}
                    tid={`toggle-withdrawal-${c.key}`}
                  />
                </div>
              </div>

              {/* Status summary */}
              {walletOn && (!features[depKey] || !features[wdKey]) && (
                <div className="mt-3 p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-[11px] text-amber-800 flex items-start gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>
                    Le portefeuille reste visible mais {!features[depKey] && !features[wdKey]
                      ? 'ni les dépôts ni les retraits'
                      : !features[depKey] ? 'les dépôts sont' : 'les retraits sont'} désactivé{(!features[depKey] && !features[wdKey]) || !features[depKey] ? 's' : ''}.
                  </span>
                </div>
              )}
              {!walletOn && (
                <div className="mt-3 p-2.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px] text-slate-600 flex items-start gap-2">
                  <EyeOff className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>Portefeuille totalement masqué. L'utilisateur voit « Bientôt disponible ».</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Advanced modules — global toggles */}
      <div className="rounded-2xl bg-white border border-slate-100 p-5 shadow-[0_2px_10px_rgba(15,23,42,0.03)]">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-9 h-9 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0">
            <Wallet className="w-4 h-4" />
          </div>
          <div>
            <div className="font-cabinet font-extrabold text-base text-slate-900">Modules avancés</div>
            <div className="text-[11px] text-slate-500">Activez ou désactivez complètement des sections chez tous les utilisateurs. Désactivés = l'entrée n'apparaît plus dans le menu et la page renvoie « Bientôt disponible ».</div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className={`p-4 rounded-xl flex items-center gap-3 ${features.links_enabled ? 'bg-emerald-50 border border-emerald-200' : 'bg-slate-100 border border-slate-200'}`}>
            <Link2 className="w-5 h-5 text-slate-500 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="font-cabinet font-bold text-sm text-slate-900">Liens de paiement</div>
              <div className="text-[11px] text-slate-500">Création et gestion des liens de paiement partageables</div>
            </div>
            <Toggle
              checked={!!features.links_enabled}
              onChange={(v) => patch('links_enabled', v)}
              disabled={saving === 'links_enabled'}
              size="lg"
              tid="toggle-links-enabled"
            />
          </div>
          <div className={`p-4 rounded-xl flex items-center gap-3 ${features.payment_api_enabled ? 'bg-emerald-50 border border-emerald-200' : 'bg-slate-100 border border-slate-200'}`}>
            <Code2 className="w-5 h-5 text-slate-500 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="font-cabinet font-bold text-sm text-slate-900">API de paiement</div>
              <div className="text-[11px] text-slate-500">Clés API, opérations d’intégration et webhooks marchands</div>
            </div>
            <Toggle
              checked={!!features.payment_api_enabled}
              onChange={(v) => patch('payment_api_enabled', v)}
              disabled={saving === 'payment_api_enabled'}
              size="lg"
              tid="toggle-payment-api-enabled"
            />
          </div>
        </div>
      </div>

      {/* Global summary */}
      <div className="rounded-2xl bg-slate-900 text-white p-5">
        <div className="text-[11px] font-bold uppercase tracking-widest opacity-70 mb-2">État global</div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          {CURRENCIES.map((c) => (
            <div key={c.key} className="p-3 rounded-xl bg-white/5">
              <div className="text-[10px] font-bold uppercase tracking-widest opacity-60">{c.label}</div>
              <div className="mt-1 text-sm font-semibold">
                {features[`wallet_${c.key}_enabled`] ? (
                  <span className="text-emerald-400">● Actif</span>
                ) : (
                  <span className="text-red-400">● Masqué</span>
                )}
              </div>
              <div className="mt-1 text-[10px] opacity-70">
                Dépôts <span className={features[`deposit_${c.key}_enabled`] ? 'text-emerald-300' : 'text-red-300'}>{features[`deposit_${c.key}_enabled`] ? 'ON' : 'OFF'}</span>
                {' · '}Retraits <span className={features[`withdrawal_${c.key}_enabled`] ? 'text-emerald-300' : 'text-red-300'}>{features[`withdrawal_${c.key}_enabled`] ? 'ON' : 'OFF'}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
