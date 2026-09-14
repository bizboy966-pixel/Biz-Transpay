import { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown, EyeOff, Eye, Globe2, KeyRound, Loader2,
  Plus, RotateCcw, Save, Smartphone, Trash2, WalletCards, X, Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';

const SECRET_FIELDS = [
  { key: 'master_key', label: 'Master key', hint: 'Clé principale de la boutique' },
  { key: 'public_key', label: 'Public key', hint: 'Clé publique PayDunya' },
  { key: 'private_key', label: 'Private key', hint: 'Clé privée PayDunya' },
  { key: 'token', label: 'Token', hint: 'Jeton d’authentification' },
];

const PAYMENT_MODES = [
  { key: 'softpay_direct', title: 'SoftPay direct', description: 'Déclenche la demande Mobile Money directement sur le téléphone du client.' },
  { key: 'psr', title: 'PSR sans redirection', description: 'Paiement sécurisé dans le parcours Biz-transPay, sans ouvrir une page externe.' },
  { key: 'par_redirect', title: 'PAR avec redirection', description: 'Redirige vers la page PayDunya uniquement après le choix explicite du client.' },
];

const blankOperator = {
  id: '',
  country: '',
  country_label: '',
  code: '',
  name: '',
  currency: 'XOF',
  endpoint_slug: '',
  active: true,
  archived: false,
  gateway_fee_pct: 0,
  gateway_fee_fixed: 0,
  platform_fee_pct: 0,
  platform_fee_fixed: 0,
  min: 100,
  max: '',
};

function enabledMode(value, fallback = false) {
  if (typeof value === 'object' && value !== null) return value.enabled !== false;
  if (value === undefined || value === null) return fallback;
  return value !== false;
}

function normalizeConfig(data) {
  const credentials = Object.fromEntries(
    SECRET_FIELDS.map(({ key }) => {
      const metadata = data?.credentials?.[key];
      return [key, {
        configured: Boolean(
          typeof metadata === 'object' ? metadata.configured : metadata
        ) || Boolean(data?.[`${key}_configured`]),
      }];
    }),
  );
  return {
    enabled: data?.enabled !== false,
    mode: data?.mode === 'live' ? 'live' : 'test',
    store_name: data?.store_name || '',
    modes: {
      softpay_direct: enabledMode(data?.modes?.softpay_direct ?? data?.modes?.softpay ?? data?.provider_modes?.softpay_direct ?? data?.softpay_enabled, true),
      psr: enabledMode(data?.modes?.psr ?? data?.provider_modes?.psr ?? data?.psr_enabled, false),
      par_redirect: enabledMode(data?.modes?.par_redirect ?? data?.modes?.par ?? data?.provider_modes?.par_redirect ?? data?.par_enabled, false),
    },
    credentials,
    catalog: Array.isArray(data?.catalog) ? data.catalog.map((item, index) => ({
      ...blankOperator,
      ...item,
      id: item.id || `operator-${index}`,
      active: item.active !== false,
      archived: item.archived === true,
    })) : [],
  };
}

export default function AdminPaymentProviders() {
  const [config, setConfig] = useState(null);
  const [secretDraft, setSecretDraft] = useState({});
  const [showSecrets, setShowSecrets] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [newOperator, setNewOperator] = useState({ ...blankOperator });
  const [countryFilter, setCountryFilter] = useState('all');

  const load = () => {
    setLoading(true);
    api.get('/admin/payment-providers/paydunya')
      .then(({ data }) => setConfig(normalizeConfig(data)))
      .catch((err) => toast.error(err.response?.data?.detail || 'Impossible de charger PayDunya'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const countries = useMemo(() => Array.from(new Set((config?.catalog || []).map((item) => item.country).filter(Boolean)))
    .sort((a, b) => (a === 'TG' ? -1 : b === 'TG' ? 1 : a.localeCompare(b))), [config]);
  const visibleCatalog = useMemo(() => (config?.catalog || [])
    .filter((item) => countryFilter === 'all' || item.country === countryFilter)
    // Keep the launch market easy to find without changing the order within
    // each country.
    .sort((a, b) => (a.country === 'TG' ? -1 : b.country === 'TG' ? 1 : 0)), [config, countryFilter]);

  const update = (key, value) => setConfig((current) => ({ ...current, [key]: value }));
  const updateMode = (key, value) => setConfig((current) => ({
    ...current,
    modes: { ...current.modes, [key]: value },
  }));
  const updateOperator = (id, key, value) => setConfig((current) => ({
    ...current,
    catalog: current.catalog.map((item) => item.id === id ? { ...item, [key]: value } : item),
  }));

  const save = async () => {
    if (!config) return;
    setSaving(true);
    try {
      // A blank secret is deliberately omitted: the API preserves the current
      // value, while GET responses only expose a configured boolean.
      const credentials = Object.fromEntries(
        SECRET_FIELDS
          .map(({ key }) => [key, secretDraft[key]])
          .filter(([, value]) => value && value.trim())
          .map(([key, value]) => [key, value.trim()]),
      );
      const payload = {
        enabled: config.enabled,
        mode: config.mode,
        store_name: config.store_name,
        modes: Object.fromEntries(Object.entries(config.modes).map(([key, enabled]) => [key, { enabled }])),
        credentials,
        catalog: config.catalog,
        ...credentials,
      };
      const { data } = await api.put('/admin/payment-providers/paydunya', payload);
      setConfig(normalizeConfig(data));
      setSecretDraft({});
      toast.success('Configuration PayDunya enregistrée');
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Impossible d’enregistrer la configuration');
    } finally {
      setSaving(false);
    }
  };

  const addOperator = () => {
    if (!newOperator.country.trim() || !newOperator.country_label.trim() || !newOperator.code.trim() || !newOperator.name.trim() || !newOperator.endpoint_slug.trim()) {
      toast.error('Pays, code opérateur, nom et endpoint sont obligatoires');
      return;
    }
    const item = {
      ...newOperator,
      id: newOperator.id || `operator-${Date.now()}`,
      country: newOperator.country.trim().toUpperCase(),
      country_label: newOperator.country_label.trim(),
      code: newOperator.code.trim().toUpperCase(),
      name: newOperator.name.trim(),
      endpoint_slug: newOperator.endpoint_slug.trim(),
      currency: newOperator.currency.trim().toUpperCase() || 'XOF',
    };
    setConfig((current) => ({ ...current, catalog: [...current.catalog, item] }));
    setNewOperator({ ...blankOperator });
    setAddOpen(false);
    setCountryFilter(item.country);
  };

  const archive = (item) => {
    setConfig((current) => ({
      ...current,
      catalog: current.catalog.map((entry) => entry.id === item.id
        ? { ...entry, archived: !entry.archived, active: entry.archived }
        : entry),
    }));
  };

  if (loading) return <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="w-4 h-4 animate-spin" /> Chargement de la configuration…</div>;
  if (!config) return <div className="rounded-2xl bg-white border border-slate-100 p-6 text-sm text-slate-500">Configuration indisponible.</div>;

  return (
    <div className="space-y-5" data-testid="admin-payment-providers-page">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 rounded-xl bg-violet-50 text-violet-600 flex items-center justify-center"><WalletCards className="w-5 h-5" /></div>
            <div>
              <h1 className="font-cabinet font-extrabold text-slate-900 text-lg sm:text-xl">Prestataire de paiement</h1>
              <p className="text-xs text-slate-500 mt-0.5">PayDunya · Mobile Money direct pour Biz-transPay</p>
            </div>
          </div>
        </div>
        <button onClick={save} disabled={saving} data-testid="btn-save-paydunya" className="inline-flex items-center justify-center gap-2 bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold px-4 py-2.5 rounded-full text-xs disabled:opacity-50">
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Enregistrer
        </button>
      </div>

      <section className="bg-white border border-slate-100 rounded-2xl p-4 sm:p-5" data-testid="paydunya-settings">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${config.enabled ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}><Smartphone className="w-5 h-5" /></div>
          <div className="flex-1">
            <h2 className="font-cabinet font-bold text-slate-900">PayDunya</h2>
            <p className="text-[11px] text-slate-500">Le catalogue actif est proposé aux utilisateurs lors d’un dépôt Mobile Money.</p>
          </div>
          <label className="inline-flex items-center gap-2 cursor-pointer self-start sm:self-center">
            <input type="checkbox" checked={config.enabled} onChange={(e) => update('enabled', e.target.checked)} className="sr-only peer" data-testid="paydunya-enabled" />
            <span className="relative w-11 h-6 rounded-full bg-slate-200 peer-checked:bg-emerald-500 transition-colors"><span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${config.enabled ? 'translate-x-5' : ''}`} /></span>
            <span className="text-xs font-bold text-slate-700">{config.enabled ? 'Activé' : 'Désactivé'}</span>
          </label>
        </div>
        <div className="grid sm:grid-cols-2 gap-3 mt-5">
          <div>
            <label className="text-xs font-semibold text-slate-700 mb-1.5 block">Mode PayDunya</label>
            <div className="grid grid-cols-2 gap-2">
              {['test', 'live'].map((mode) => (
                <button key={mode} type="button" onClick={() => update('mode', mode)} data-testid={`paydunya-mode-${mode}`} className={`p-2.5 rounded-xl border-2 text-xs font-bold capitalize ${config.mode === mode ? 'border-[#2563EB] bg-blue-50 text-[#2563EB]' : 'border-slate-200 text-slate-500'}`}>
                  {mode === 'live' ? 'Production' : 'Test / sandbox'}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-700 mb-1.5 block">Nom de la boutique</label>
            <input value={config.store_name} onChange={(e) => update('store_name', e.target.value)} data-testid="paydunya-store-name" placeholder="Biz-transPay" className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm" />
          </div>
        </div>
      </section>

      <section className="bg-white border border-slate-100 rounded-2xl p-4 sm:p-5" data-testid="paydunya-modes">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-9 h-9 rounded-xl bg-violet-50 text-violet-600 flex items-center justify-center"><Zap className="w-4 h-4" /></div>
          <div>
            <h2 className="font-cabinet font-bold text-slate-900">Modes de paiement</h2>
            <p className="text-[11px] text-slate-500 mt-0.5">Chaque mode est indépendant. Le désactiver le retire du parcours client et bloque sa création côté paiement.</p>
          </div>
        </div>
        <div className="grid lg:grid-cols-3 gap-3">
          {PAYMENT_MODES.map((mode) => {
            const active = config.modes[mode.key];
            return (
              <div key={mode.key} className={`rounded-xl border-2 p-3 transition-colors ${active ? 'border-violet-200 bg-violet-50/40' : 'border-slate-200 bg-slate-50'}`} data-testid={`paydunya-mode-card-${mode.key}`}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-xs font-bold text-slate-900">{mode.title}</div>
                    <p className="text-[10px] leading-relaxed text-slate-500 mt-1">{mode.description}</p>
                  </div>
                  <label className="inline-flex items-center gap-1.5 cursor-pointer shrink-0">
                    <input type="checkbox" checked={active} onChange={(e) => updateMode(mode.key, e.target.checked)} className="sr-only peer" data-testid={`paydunya-mode-toggle-${mode.key}`} />
                    <span className="relative w-9 h-5 rounded-full bg-slate-200 peer-checked:bg-violet-500 transition-colors"><span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${active ? 'translate-x-4' : ''}`} /></span>
                  </label>
                </div>
                <div className={`mt-2 text-[10px] font-semibold ${active ? 'text-emerald-600' : 'text-slate-400'}`}>{active ? 'Disponible pour les clients' : 'Désactivé et inaccessible'}</div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="bg-white border border-slate-100 rounded-2xl p-4 sm:p-5" data-testid="paydunya-credentials">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-9 h-9 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center"><KeyRound className="w-4 h-4" /></div>
          <div>
            <h2 className="font-cabinet font-bold text-slate-900">Identifiants sécurisés</h2>
            <p className="text-[11px] text-slate-500 mt-0.5">Les secrets ne sont jamais affichés. Laissez un champ vide pour conserver la valeur actuelle.</p>
          </div>
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          {SECRET_FIELDS.map(({ key, label, hint }) => {
            const status = config.credentials?.[key] || {};
            const visible = showSecrets[key];
            return (
              <div key={key}>
                <label className="text-xs font-semibold text-slate-700 mb-1.5 block">{label}</label>
                <div className="relative">
                   <input type={visible ? 'text' : 'password'} value={secretDraft[key] || ''} onChange={(e) => setSecretDraft((current) => ({ ...current, [key]: e.target.value }))} placeholder={status.configured ? 'Configuré · saisir pour remplacer' : 'Non configuré'} autoComplete="new-password" className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm pr-10 font-mono" data-testid={`paydunya-secret-${key}`} />
                  <button type="button" onClick={() => setShowSecrets((current) => ({ ...current, [key]: !visible }))} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700" aria-label={visible ? 'Masquer' : 'Afficher'}>
                    {visible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                 <div className="text-[10px] text-slate-400 mt-1">{hint} · {status.configured ? <span className="text-emerald-600 font-semibold">Configuré</span> : 'Non configuré'}</div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="bg-white border border-slate-100 rounded-2xl p-4 sm:p-5" data-testid="paydunya-catalog">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between mb-4">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-xl bg-blue-50 text-[#2563EB] flex items-center justify-center"><Globe2 className="w-4 h-4" /></div>
            <div>
              <h2 className="font-cabinet font-bold text-slate-900">Catalogue Mobile Money</h2>
              <p className="text-[11px] text-slate-500 mt-0.5">Activez les opérateurs et maîtrisez leurs frais, limites et devise.</p>
            </div>
          </div>
          <button type="button" onClick={() => setAddOpen((open) => !open)} className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-full bg-slate-900 text-white text-[11px] font-bold"><Plus className="w-3.5 h-3.5" /> Ajouter un opérateur</button>
        </div>

        {addOpen && (
          <div className="mb-4 p-3 sm:p-4 rounded-xl border border-blue-100 bg-blue-50/50" data-testid="paydunya-add-operator">
            <div className="flex items-center justify-between mb-3"><h3 className="text-xs font-bold text-slate-900">Nouvel opérateur</h3><button type="button" onClick={() => setAddOpen(false)}><X className="w-4 h-4 text-slate-400" /></button></div>
            <OperatorFields item={newOperator} onChange={(key, value) => setNewOperator((current) => ({ ...current, [key]: value }))} compact />
            <div className="flex justify-end gap-2 mt-3"><button type="button" onClick={() => setAddOpen(false)} className="px-3 py-2 rounded-full text-xs font-bold text-slate-600">Annuler</button><button type="button" onClick={addOperator} className="px-3 py-2 rounded-full bg-[#2563EB] text-white text-xs font-bold">Ajouter</button></div>
          </div>
        )}

        <div className="flex items-center gap-2 mb-3 overflow-x-auto">
          <button type="button" onClick={() => setCountryFilter('all')} className={`px-3 py-1.5 rounded-full text-[11px] font-bold whitespace-nowrap ${countryFilter === 'all' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600'}`}>Tous ({config.catalog.length})</button>
          {countries.map((country) => <button type="button" key={country} onClick={() => setCountryFilter(country)} className={`px-3 py-1.5 rounded-full text-[11px] font-bold whitespace-nowrap ${countryFilter === country ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'}`}>{country}</button>)}
        </div>

        {visibleCatalog.length === 0 ? <div className="p-6 text-center text-xs text-slate-500 border border-dashed border-slate-200 rounded-xl">Aucun opérateur dans ce catalogue.</div> : (
          <div className="space-y-3">
            {visibleCatalog.map((item) => <CatalogItem key={item.id} item={item} onChange={(key, value) => updateOperator(item.id, key, value)} onArchive={() => archive(item)} />)}
          </div>
        )}
      </section>
      <MbiyoPanel />
    </div>
  );
}

function MbiyoPanel() {
  const [config, setConfig] = useState(null);
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [show, setShow] = useState({});

  useEffect(() => {
    api.get('/admin/payment-providers/mbiyo')
      .then(({ data }) => setConfig(data))
      .catch((err) => toast.error(err.response?.data?.detail || 'Impossible de charger Mbiyo'));
  }, []);

  if (!config) return <section className="bg-white border border-slate-100 rounded-2xl p-5 text-xs text-slate-500">Chargement de Mbiyo…</section>;
  const set = (key, value) => setConfig((current) => ({ ...current, [key]: value }));
  const setOp = (id, key, value) => setConfig((current) => ({
    ...current, catalog: current.catalog.map((op) => op.id === id ? { ...op, [key]: value } : op),
  }));
  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        enabled: config.enabled, mode: config.mode, catalog: config.catalog,
        ...(draft.api_key?.trim() ? { api_key: draft.api_key.trim() } : {}),
        ...(draft.webhook_secret?.trim() ? { webhook_secret: draft.webhook_secret.trim() } : {}),
      };
      const { data } = await api.put('/admin/payment-providers/mbiyo', payload);
      setConfig(data); setDraft({});
      toast.success('Configuration Mbiyo enregistrée');
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Impossible d’enregistrer Mbiyo');
    } finally { setSaving(false); }
  };
  return (
    <section className="bg-white border border-slate-100 rounded-2xl p-4 sm:p-5" data-testid="mbiyo-settings">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className={`w-11 h-11 rounded-xl flex items-center justify-center ${config.enabled ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}><Smartphone className="w-5 h-5" /></div>
        <div className="flex-1"><h2 className="font-cabinet font-bold text-slate-900">Mbiyo</h2><p className="text-[11px] text-slate-500">Dépôts et retraits Mobile Money XOF / XAF, avec webhooks signés.</p></div>
        <label className="inline-flex items-center gap-2 cursor-pointer text-xs font-bold"><input type="checkbox" checked={!!config.enabled} onChange={(e) => set('enabled', e.target.checked)} className="accent-emerald-500" /> {config.enabled ? 'Activé' : 'Désactivé'}</label>
        <button onClick={save} disabled={saving} className="inline-flex items-center gap-2 bg-[#2563EB] text-white font-bold px-4 py-2.5 rounded-full text-xs disabled:opacity-50">{saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Enregistrer</button>
      </div>
      <div className="grid sm:grid-cols-2 gap-3 mt-4">
        <div><label className="text-xs font-semibold text-slate-700 mb-1.5 block">Mode</label><div className="grid grid-cols-2 gap-2">{['test', 'live'].map((mode) => <button key={mode} type="button" onClick={() => set('mode', mode)} className={`p-2 rounded-xl border-2 text-xs font-bold ${config.mode === mode ? 'border-blue-600 bg-blue-50 text-blue-600' : 'border-slate-200 text-slate-500'}`}>{mode === 'live' ? 'Production' : 'Test'}</button>)}</div></div>
        <SecretInput label="Clé API Mbiyo" configured={config.configured} value={draft.api_key || ''} visible={show.api} onToggle={() => setShow((s) => ({ ...s, api: !s.api }))} onChange={(value) => setDraft((d) => ({ ...d, api_key: value }))} />
        <SecretInput label="Secret webhook" configured={config.webhook_secret_configured} value={draft.webhook_secret || ''} visible={show.webhook} onToggle={() => setShow((s) => ({ ...s, webhook: !s.webhook }))} onChange={(value) => setDraft((d) => ({ ...d, webhook_secret: value }))} />
      </div>
      <div className="mt-5 flex items-center justify-between"><div><h3 className="font-cabinet font-bold text-slate-900 text-sm">Catalogue XOF / XAF</h3><p className="text-[10px] text-slate-500">Activez séparément chaque pays et opérateur.</p></div><span className="text-[10px] text-slate-400">{(config.catalog || []).filter((o) => o.active).length} actifs / {(config.catalog || []).length}</span></div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2 mt-3">
        {(config.catalog || []).map((op) => <label key={op.id} className={`flex items-center gap-2 p-2.5 rounded-xl border text-xs ${op.active ? 'border-emerald-200 bg-emerald-50/40' : 'border-slate-200'}`}><input type="checkbox" checked={!!op.active} onChange={(e) => setOp(op.id, 'active', e.target.checked)} className="accent-emerald-500" /><span className="font-bold">{op.country} · {op.network}</span><span className="ml-auto text-[10px] text-slate-500">{op.currency}</span></label>)}
      </div>
    </section>
  );
}

function SecretInput({ label, configured, value, visible, onToggle, onChange }) {
  return <div><label className="text-xs font-semibold text-slate-700 mb-1.5 block">{label}</label><div className="relative"><input type={visible ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} placeholder={configured ? 'Configuré · saisir pour remplacer' : 'Non configuré'} autoComplete="new-password" className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none text-sm pr-10 font-mono" /><button type="button" onClick={onToggle} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400">{visible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}</button></div><div className="text-[10px] text-slate-400 mt-1">{configured ? <span className="text-emerald-600 font-semibold">Configuré</span> : 'Non configuré'}</div></div>;
}

function CatalogItem({ item, onChange, onArchive }) {
  const [expanded, setExpanded] = useState(false);
  const featured = item.country === 'TG' || ['T-MONEY', 'TMONEY', 'MOOV', 'MOOV MONEY'].some((term) => `${item.code} ${item.name}`.toUpperCase().includes(term));
  return (
    <div className={`rounded-xl border ${item.archived ? 'border-slate-200 bg-slate-50' : featured ? 'border-violet-200 bg-violet-50/30' : 'border-slate-200 bg-white'}`} data-testid={`catalog-operator-${item.id}`}>
      <div className="p-3 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2.5 flex-1 min-w-0">
          <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${featured ? 'bg-violet-100 text-violet-700' : 'bg-slate-100 text-slate-600'}`}><Smartphone className="w-4 h-4" /></div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5"><span className="font-bold text-sm text-slate-900">{item.name || 'Sans nom'}</span>{featured && <span className="px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 text-[9px] font-bold">PRIORITAIRE</span>}{item.archived && <span className="px-1.5 py-0.5 rounded bg-slate-200 text-slate-600 text-[9px] font-bold">ARCHIVÉ</span>}</div>
            <div className="text-[10px] text-slate-500">{item.country_label || item.country} · {item.code} · {item.currency}</div>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:flex items-center gap-2">
          <label className="inline-flex items-center gap-1.5 text-[10px] font-bold text-slate-600"><input type="checkbox" checked={item.active} disabled={item.archived} onChange={(e) => onChange('active', e.target.checked)} className="accent-emerald-500" /> {item.active ? 'Actif' : 'Inactif'}</label>
          <button type="button" onClick={() => setExpanded((open) => !open)} className="inline-flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-100 text-[10px] font-bold text-slate-700"><ChevronDown className={`w-3 h-3 transition-transform ${expanded ? 'rotate-180' : ''}`} /> Modifier</button>
          <button type="button" onClick={onArchive} className={`inline-flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-lg text-[10px] font-bold ${item.archived ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`} title={item.archived ? 'Réactiver' : 'Supprimer / archiver'}>
            {item.archived ? <RotateCcw className="w-3 h-3" /> : <Trash2 className="w-3 h-3" />} {item.archived ? 'Réactiver' : 'Supprimer'}
          </button>
        </div>
      </div>
      {expanded && <div className="border-t border-slate-100 p-3"><OperatorFields item={item} onChange={onChange} /></div>}
    </div>
  );
}

function OperatorFields({ item, onChange, compact }) {
  const fields = [
    ['country', 'Code pays', 'text'],
    ['country_label', 'Nom du pays', 'text'],
    ['code', 'Code opérateur', 'text'],
    ['name', 'Nom affiché', 'text'],
    ['currency', 'Devise', 'text'],
    ['endpoint_slug', 'Endpoint slug', 'text'],
    ['gateway_fee_pct', 'Frais gateway (%)', 'number'],
    ['gateway_fee_fixed', 'Frais gateway (fixe)', 'number'],
    ['platform_fee_pct', 'Frais plateforme (%)', 'number'],
    ['platform_fee_fixed', 'Frais plateforme (fixe)', 'number'],
    ['min', 'Minimum', 'number'],
    ['max', 'Maximum (vide = illimité)', 'number'],
  ];
  return (
    <div className={`grid ${compact ? 'sm:grid-cols-3' : 'sm:grid-cols-2 lg:grid-cols-3'} gap-3`}>
      {fields.map(([key, label, type]) => (
        <div key={key}>
          <label className="text-[11px] font-semibold text-slate-700 mb-1 block">{label}</label>
          <input type={type} step={type === 'number' ? '0.01' : undefined} value={item[key] ?? ''} onChange={(e) => onChange(key, type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)} className="w-full px-3 py-2 border border-slate-200 rounded-lg outline-none focus:border-[#2563EB] text-xs" />
        </div>
      ))}
    </div>
  );
}
