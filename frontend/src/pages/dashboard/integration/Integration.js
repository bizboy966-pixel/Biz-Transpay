import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BookOpen, Check, ChevronDown, ChevronRight, Clipboard, Code2, ExternalLink, Eye, EyeOff, KeyRound, Link2, Loader2, Pencil, Plus, RefreshCw, Send, ShieldCheck, Terminal, Trash2, Webhook, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import api from '@/api';
import ComplianceWarningModal from '@/components/ComplianceWarningModal';
import { useFeatures } from '@/hooks/useFeatures';

const ENVIRONMENTS = {
  test: { label: 'Sandbox', title: 'Environnement de test', tone: 'blue' },
  live: { label: 'Live', title: 'Environnement de production', tone: 'emerald' },
};

const errorMessage = (error, fallback) => {
  const detail = error?.response?.data?.detail;
  return typeof detail === 'string' ? detail : detail?.message || fallback;
};
const PUBLIC_DOCS_URL = 'https://biz-transppayy.com/integration/docs';
const DELETE_CONFIRMATION_PHRASE = 'SUPPRIMER';

function Badge({ children, tone = 'slate' }) {
  const styles = {
    blue: 'border-blue-200 bg-blue-50 text-blue-700',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    amber: 'border-amber-200 bg-amber-50 text-amber-800',
    red: 'border-red-200 bg-red-50 text-red-700',
    slate: 'border-slate-200 bg-slate-50 text-slate-600',
  };
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-bold ${styles[tone]}`}>{children}</span>;
}

function CopyButton({ value, label = 'Copier' }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success('Copié dans le presse-papiers');
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Copie indisponible dans ce navigateur');
    }
  };
  return <button type="button" onClick={copy} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-bold text-slate-500 hover:bg-slate-100 hover:text-slate-900">
    {copied ? <Check className="h-3.5 w-3.5" /> : <Clipboard className="h-3.5 w-3.5" />}{copied ? 'Copié' : label}
  </button>;
}

function SecretReveal({ reveal, onClose }) {
  const [visible, setVisible] = useState(false);
  const [ack, setAck] = useState(false);
  if (!reveal) return null;
  const secret = reveal.secret || '';
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="secret-title">
    <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
      <div className="flex items-start gap-3 border-b border-slate-100 p-5">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700"><AlertTriangle className="h-5 w-5" /></div>
        <div className="flex-1"><h2 id="secret-title" className="font-cabinet text-lg font-extrabold text-slate-900">Secret affiché une seule fois</h2><p className="mt-1 text-xs leading-relaxed text-slate-500">Copiez-le maintenant. Biz-transPay ne l’affichera plus après cette fenêtre.</p></div>
        <button type="button" onClick={() => ack && onClose()} disabled={!ack} aria-label="Fermer" className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-30"><X className="h-4 w-4" /></button>
      </div>
      <div className="space-y-4 p-5">
        <div className="flex items-center gap-2 text-xs text-slate-500">Type <Badge tone="amber">{reveal.type}</Badge><span>·</span>{reveal.environment}</div>
        <div className="flex items-start gap-2 rounded-xl bg-slate-950 p-4 font-mono text-xs text-emerald-300">
          <span className="min-w-0 flex-1 break-all">{visible ? secret : '•'.repeat(Math.max(40, secret.length))}</span>
          <button type="button" onClick={() => setVisible((value) => !value)} aria-label={visible ? 'Masquer le secret' : 'Afficher le secret'} className="text-slate-400 hover:text-white">{visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
        </div>
        <button type="button" onClick={() => navigator.clipboard?.writeText(secret).then(() => toast.success('Secret copié')).catch(() => toast.error('Copie indisponible'))} className="flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 py-2.5 text-sm font-bold text-white hover:bg-slate-700"><Clipboard className="h-4 w-4" /> Copier le secret</button>
        <label className="flex cursor-pointer items-start gap-2 text-xs leading-relaxed text-slate-700"><input type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} className="mt-0.5 accent-slate-900" />J’ai copié le secret et comprends qu’il ne sera plus affiché.</label>
      </div>
      <div className="flex justify-end border-t border-slate-100 bg-slate-50 p-4"><button type="button" onClick={() => ack && onClose()} disabled={!ack} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-40">Terminé</button></div>
    </div>
  </div>;
}

function EnvironmentToggle({ value, onChange }) {
  return <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1 shadow-sm" role="group" aria-label="Environnement">
    {Object.entries(ENVIRONMENTS).map(([key, item]) => <button type="button" key={key} onClick={() => onChange(key)} className={`rounded-lg px-4 py-2 text-xs font-bold transition-colors ${value === key ? (key === 'live' ? 'bg-emerald-600 text-white' : 'bg-blue-600 text-white') : 'text-slate-500 hover:bg-slate-50'}`}><span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-current align-middle" />{item.label}</button>)}
  </div>;
}

function Skeleton() {
  return <div className="space-y-4"><div className="h-36 animate-pulse rounded-2xl bg-slate-200" /><div className="h-72 animate-pulse rounded-2xl bg-slate-200" /></div>;
}

export default function Integration() {
  const features = useFeatures();
  const [environment, setEnvironment] = useState('test');
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [reveal, setReveal] = useState(null);
  const [webhooks, setWebhooks] = useState([]);
  const [webhookForm, setWebhookForm] = useState({ name: '', url: '' });
  const [editingWebhook, setEditingWebhook] = useState(null);
  const [deliveries, setDeliveries] = useState(null);
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const [deleteConfirmationPhrase, setDeleteConfirmationPhrase] = useState('');
  const [complianceConfirmationOpen, setComplianceConfirmationOpen] = useState(false);

  const load = async (env = environment, { clearWebhookData = false } = {}) => {
    setLoading(true); setError('');
    try {
      const [settingsResponse, webhookResponse, deliveryResponse] = await Promise.all([
        api.get(`/integration/settings?environment=${env}`),
        api.get(`/integration/webhooks/${env}`),
        api.get(`/integration/webhooks/${env}/deliveries`),
      ]);
      setSettings(settingsResponse.data || {});
      setWebhooks(webhookResponse.data?.webhooks || []);
      setDeliveries(deliveryResponse.data?.data || deliveryResponse.data || []);
      if (clearWebhookData) {
        setWebhookForm({ name: '', url: '' });
        setEditingWebhook(null);
      }
    } catch (err) {
      setError(errorMessage(err, 'Impossible de charger la configuration d’intégration.'));
    } finally { setLoading(false); }
  };
  // The loader intentionally owns the request lifecycle for the selected environment.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (features?.payment_api_enabled === false) {
      setLoading(false);
      setError('');
      return;
    }
    load(environment);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environment]);

  const createCredentials = () => setComplianceConfirmationOpen(true);
  const confirmCreateCredentials = async () => {
    setBusy('credentials');
    try {
      const { data } = await api.post('/integration/credentials', {
        environment,
        payout_opt_in: false,
      });
      setComplianceConfirmationOpen(false);
      setReveal({ secret: data.secret_key, type: 'Clé secrète', environment: ENVIRONMENTS[environment].label });
      await load();
    } catch (err) { toast.error(errorMessage(err, 'Les identifiants n’ont pas pu être créés.')); } finally { setBusy(''); }
  };
  const regenerateCredentials = async () => {
    if (!window.confirm('Régénérer cette clé secrète ? L’ancienne cessera immédiatement de fonctionner.')) return;
    setBusy('regenerate');
    try {
      const { data } = await api.post(`/integration/credentials/${environment}/regenerate`);
      setReveal({ secret: data.secret_key, type: 'Nouvelle clé secrète', environment: ENVIRONMENTS[environment].label });
      await load();
    } catch (err) { toast.error(errorMessage(err, 'La clé n’a pas pu être régénérée.')); } finally { setBusy(''); }
  };
  const toggleCredentials = async () => {
    setBusy('toggle');
    try { await api.patch(`/integration/credentials/${environment}`, { active: !settings?.credentials?.active }); toast.success(settings?.credentials?.active ? 'Identifiants désactivés' : 'Identifiants activés'); await load(); }
    catch (err) { toast.error(errorMessage(err, 'Le statut des identifiants n’a pas pu être modifié.')); } finally { setBusy(''); }
  };
  const deleteCredentials = async () => {
    if (deleteConfirmationPhrase !== DELETE_CONFIRMATION_PHRASE) return;
    setBusy('delete');
    try {
      const { data } = await api.delete(`/integration/credentials/${environment}`, {
        data: { confirmation: DELETE_CONFIRMATION_PHRASE },
      });
      if (!data?.deleted) throw new Error('La suppression n’a pas été confirmée par le serveur.');
      setDeleteConfirmationOpen(false);
      setDeleteConfirmationPhrase('');
      setWebhooks([]);
      setDeliveries([]);
      toast.success(`Identifiants ${ENVIRONMENTS[environment].label} supprimés`);
      await load(environment, { clearWebhookData: true });
    } catch (err) {
      toast.error(errorMessage(err, err.message || 'Les identifiants n’ont pas pu être supprimés.'));
    } finally { setBusy(''); }
  };
  const togglePayoutAuthorization = async () => {
    const nextValue = !payoutEnabled;
    if (nextValue && !window.confirm('Autoriser les retraits en Live ?\n\nUne clé secrète Live exposée pourrait initier des retraits depuis votre compte. Activez cette autorisation uniquement lorsque votre serveur protège correctement le secret.')) return;
    setBusy('payout');
    try {
      await api.patch('/integration/credentials/live', {
        active: Boolean(settings?.credentials?.active),
        payout_opt_in: nextValue,
      });
      toast.success(nextValue ? 'Retraits Live autorisés' : 'Autorisation des retraits désactivée');
      await load('live');
    } catch (err) {
      toast.error(errorMessage(err, 'L’autorisation des retraits n’a pas pu être modifiée.'));
    } finally { setBusy(''); }
  };
  const saveWebhook = async (event) => {
    event.preventDefault();
    setBusy('webhook');
    try {
      const payload = {
        name: webhookForm.name.trim(),
        url: webhookForm.url.trim(),
      };
      const { data } = editingWebhook
        ? await api.patch(`/integration/webhooks/${environment}/${editingWebhook.id}`, payload)
        : await api.post(`/integration/webhooks/${environment}`, payload);
      if (data?.webhook_secret) {
        setReveal({
          secret: data.webhook_secret,
          type: `Secret du webhook « ${payload.name} »`,
          environment: ENVIRONMENTS[environment].label,
        });
      }
      setWebhookForm({ name: '', url: '' });
      setEditingWebhook(null);
      toast.success(editingWebhook ? 'Webhook mis à jour' : 'Webhook ajouté');
      await load();
    } catch (err) { toast.error(errorMessage(err, 'Le webhook n’a pas pu être enregistré.')); } finally { setBusy(''); }
  };
  const startEditingWebhook = (webhook) => {
    setEditingWebhook(webhook);
    setWebhookForm({ name: webhook.name || '', url: webhook.url || '' });
  };
  const cancelEditingWebhook = () => {
    setEditingWebhook(null);
    setWebhookForm({ name: '', url: '' });
  };
  const webhookAction = async (action, message, webhook) => {
    const busyKey = `${action}-${webhook.id}`;
    setBusy(busyKey);
    try {
      const path = action === 'rotate'
        ? `/integration/webhooks/${environment}/${webhook.id}/regenerate-secret`
        : `/integration/webhooks/${environment}/${webhook.id}/test`;
      const { data } = await api.post(path, action === 'test' ? {} : undefined);
      if (data?.webhook_secret) {
        setReveal({
          secret: data.webhook_secret,
          type: `Nouveau secret du webhook « ${webhook.name} »`,
          environment: ENVIRONMENTS[environment].label,
        });
      }
      toast.success(message); await load();
    } catch (err) { toast.error(errorMessage(err, 'L’action webhook a échoué.')); } finally { setBusy(''); }
  };
  const toggleWebhook = async (webhook) => {
    const busyKey = `toggle-${webhook.id}`;
    setBusy(busyKey);
    try {
      await api.patch(`/integration/webhooks/${environment}/${webhook.id}`, {
        active: !webhook.active,
      });
      toast.success(webhook.active ? 'Webhook désactivé' : 'Webhook activé');
      await load();
    } catch (err) {
      toast.error(errorMessage(err, 'Le statut du webhook n’a pas pu être modifié.'));
    } finally { setBusy(''); }
  };
  const deleteWebhook = async (webhook) => {
    if (!window.confirm(`Supprimer le webhook « ${webhook.name} » ? Son historique sera conservé.`)) return;
    const busyKey = `delete-${webhook.id}`;
    setBusy(busyKey);
    try {
      await api.delete(`/integration/webhooks/${environment}/${webhook.id}`);
      toast.success('Webhook supprimé');
      if (editingWebhook?.id === webhook.id) cancelEditingWebhook();
      await load();
    } catch (err) {
      toast.error(errorMessage(err, 'Le webhook n’a pas pu être supprimé.'));
    } finally { setBusy(''); }
  };
  const active = settings?.credentials?.active;
  const hasCredentials = Boolean(settings?.credentials?.public_key);
  const liveScopes = Array.isArray(settings?.credentials?.scopes) ? settings.credentials.scopes : [];
  const payoutScopeEnabled = liveScopes.includes('payouts:write');
  const payoutOptIn = settings?.credentials?.payout_opt_in;
  const payoutEnabled = payoutOptIn === true || payoutScopeEnabled;
  const env = ENVIRONMENTS[environment];
  const deliveryRows = useMemo(() => Array.isArray(deliveries) ? deliveries : deliveries?.items || [], [deliveries]);

  if (features?.payment_api_enabled === false) {
    return <div className="mx-auto max-w-3xl rounded-2xl border border-amber-200 bg-amber-50 p-8 text-center" data-testid="payment-api-disabled">
      <AlertTriangle className="mx-auto h-7 w-7 text-amber-700" />
      <h1 className="mt-3 font-cabinet text-xl font-extrabold text-amber-950">API de paiement temporairement indisponible</h1>
      <p className="mt-2 text-sm text-amber-900">L’accès à la gestion des identifiants et des intégrations API est désactivé par l’administration. Vos clés, opérations et historiques sont conservés.</p>
    </div>;
  }

  return <div className="mx-auto max-w-6xl space-y-6" data-testid="page-integration">
    <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
      <div><div className="mb-2 inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-[11px] font-bold text-blue-700"><Code2 className="h-3.5 w-3.5" /> API & Intégration</div><h1 className="font-cabinet text-3xl font-extrabold tracking-tight text-slate-900">Connectez Biz-transPay à votre plateforme.</h1><p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-500">Gérez vos identifiants et vos webhooks sans exposer de secret côté client.</p></div>
      <EnvironmentToggle value={environment} onChange={setEnvironment} />
    </div>
    <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0"><div className="text-xs font-bold text-slate-800">URL de la documentation publique (après publication)</div><a href={PUBLIC_DOCS_URL} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 break-all text-xs text-blue-700 underline underline-offset-2 hover:text-blue-900">{PUBLIC_DOCS_URL}<ExternalLink className="h-3 w-3 shrink-0" /></a></div>
      <div className="flex shrink-0 items-center gap-2"><CopyButton value={PUBLIC_DOCS_URL} label="Copier le lien" /><a href={PUBLIC_DOCS_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:bg-slate-50"><ExternalLink className="h-3.5 w-3.5" />Ouvrir</a></div>
    </div>
    <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-950"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><p><strong>Ne partagez jamais vos clés API ni vos secrets avec l’agent d’intégration dans le chat.</strong> Les clés secrètes doivent rester sur votre serveur.</p></div>
    <div className={`flex items-start gap-3 rounded-2xl border p-4 ${environment === 'live' ? 'border-emerald-200 bg-emerald-50 text-emerald-950' : 'border-blue-200 bg-blue-50 text-blue-950'}`}><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" /><div><div className="text-sm font-bold">{env.title}</div><p className="mt-1 text-xs leading-relaxed">{environment === 'live' ? 'Les opérations peuvent toucher vos fonds réels. Vérifiez votre serveur, vos URLs et vos contrôles avant d’activer Live.' : 'Sandbox n’appelle pas vos opérations financières réelles. Utilisez-le pour valider votre intégration avant le passage en Live.'}</p></div></div>
    {loading ? <Skeleton /> : error ? <div className="rounded-2xl border border-red-200 bg-red-50 p-8 text-center"><AlertTriangle className="mx-auto h-6 w-6 text-red-600" /><p className="mt-3 text-sm font-semibold text-red-900">{error}</p><button type="button" onClick={() => load()} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-xs font-bold text-white"><RefreshCw className="h-3.5 w-3.5" /> Réessayer</button></div> : <>
       {environment === 'test' && <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"><div className="flex items-center gap-2 font-bold"><AlertTriangle className="h-4 w-4" /> Sandbox indisponible pour les écritures financières</div><p className="mt-1 text-xs">{settings?.message || 'Cet environnement ne déclenche pas d’opérations financières. Utilisez-le pour préparer votre intégration, puis vérifiez votre serveur en Live.'}</p></div>}
      <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
         <div className="flex flex-col gap-3 border-b border-slate-100 p-5 sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2"><KeyRound className="h-4 w-4 text-blue-600" /><h2 className="font-cabinet text-lg font-extrabold text-slate-900">Identifiants API</h2>{hasCredentials && <Badge tone={active ? 'emerald' : 'red'}>{active ? 'Actifs' : 'Désactivés'}</Badge>}</div><p className="mt-1 text-xs text-slate-500">La clé secrète reste uniquement en mémoire après sa création ou sa rotation.</p></div><div className="flex flex-wrap gap-2"><Link to="/integration/docs" className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50"><BookOpen className="h-3.5 w-3.5" /> Documentation</Link>{hasCredentials && <><button type="button" onClick={toggleCredentials} disabled={!!busy} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50">{busy === 'toggle' ? 'Mise à jour…' : active ? 'Désactiver' : 'Activer'}</button><button type="button" onClick={regenerateCredentials} disabled={!!busy} className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-bold text-white hover:bg-slate-700">{busy === 'regenerate' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Régénérer</button><button type="button" onClick={() => { setDeleteConfirmationPhrase(''); setDeleteConfirmationOpen(true); }} disabled={!!busy} className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-xs font-bold text-red-700 hover:bg-red-50"><Trash2 className="h-3.5 w-3.5" /> Supprimer</button></>}</div></div>
        <div className="p-5">{hasCredentials ? <div className="grid gap-4 md:grid-cols-2"><div><label className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Clé publique</label><div className="mt-2 flex items-center justify-between gap-2 rounded-xl bg-slate-50 p-3 font-mono text-xs text-slate-700"><span className="break-all">{settings.credentials.public_key}</span><CopyButton value={settings.credentials.public_key} /></div></div><div><label className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Clé secrète</label><div className="mt-2 rounded-xl bg-slate-50 p-3 font-mono text-xs text-slate-500">•••••••••••••••••••• <span className="font-sans text-[11px]">non récupérable</span></div></div></div> : <div className="flex flex-col items-start justify-between gap-4 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-5 sm:flex-row sm:items-center"><div><h3 className="text-sm font-bold text-slate-900">Aucun identifiant {env.label}</h3><p className="mt-1 max-w-xl text-xs leading-relaxed text-slate-500">La création est une action explicite. Gardez la clé secrète sur votre serveur et ne la partagez jamais dans une application publique.</p></div><button type="button" onClick={createCredentials} disabled={!!busy} className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40">{busy === 'credentials' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />} Créer les identifiants</button></div>}</div>
      </section>
       {environment === 'live' && <section className="rounded-2xl border border-amber-200 bg-white shadow-sm">
         <div className="flex flex-col gap-3 border-b border-amber-100 bg-amber-50/70 p-5 sm:flex-row sm:items-start sm:justify-between">
           <div>
             <div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-amber-700" /><h2 className="font-cabinet text-lg font-extrabold text-slate-900">Autorisation des retraits Live</h2><Badge tone={payoutEnabled ? 'amber' : 'slate'}>{payoutEnabled ? 'Autorisée' : 'Désactivée'}</Badge></div>
             <p className="mt-2 max-w-2xl text-xs leading-relaxed text-amber-950">Cette autorisation ajoute le scope <code className="rounded bg-amber-100 px-1 font-mono">payouts:write</code> à vos identifiants Live. Une clé secrète Live divulguée pourrait alors initier des retraits. Elle est désactivée par défaut.</p>
           </div>
           <button type="button" onClick={togglePayoutAuthorization} disabled={!hasCredentials || !!busy} className={`shrink-0 rounded-lg px-3 py-2 text-xs font-bold ${payoutEnabled ? 'border border-amber-300 bg-white text-amber-800 hover:bg-amber-50' : 'bg-amber-700 text-white hover:bg-amber-800'} disabled:cursor-not-allowed disabled:opacity-40`}>{busy === 'payout' ? 'Mise à jour…' : payoutEnabled ? 'Désactiver' : 'Autoriser les retraits'}</button>
         </div>
         <div className="grid gap-3 p-5 text-xs sm:grid-cols-2">
           <div className="rounded-xl border border-slate-200 bg-slate-50 p-3"><div className="font-bold text-slate-700">État d’opt-in</div><div className="mt-1 text-slate-500">{payoutOptIn === true ? 'Opt-in explicite activé' : payoutOptIn === false ? 'Opt-in explicite désactivé' : 'Aucun opt-in explicite retourné'}</div></div>
           <div className="rounded-xl border border-slate-200 bg-slate-50 p-3"><div className="font-bold text-slate-700">Scope actuel</div><div className="mt-1 font-mono text-slate-500">{payoutScopeEnabled ? 'payouts:write' : 'payouts:write absent'}</div></div>
         </div>
       </section>}
       <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
         <div className="border-b border-slate-100 p-5">
           <div className="flex flex-wrap items-center gap-2">
             <Webhook className="h-4 w-4 text-blue-600" />
             <h2 className="font-cabinet text-lg font-extrabold text-slate-900">Webhooks par site</h2>
             <Badge tone={webhooks.some((webhook) => webhook.active) ? 'emerald' : 'slate'}>
               {webhooks.filter((webhook) => webhook.active).length} actif(s)
             </Badge>
           </div>
           <p className="mt-1 max-w-3xl text-xs leading-relaxed text-slate-500">
             Ajoutez une destination pour chaque site. Les mêmes clés API servent à tous les sites ;
             chaque destination possède son propre secret de signature et reçoit les événements en parallèle.
           </p>
         </div>
         <div className="space-y-5 p-5">
           <form onSubmit={saveWebhook} className="rounded-xl border border-blue-100 bg-blue-50/50 p-4">
             <div className="mb-3 text-sm font-bold text-slate-800">
               {editingWebhook ? `Modifier « ${editingWebhook.name} »` : 'Ajouter une destination webhook'}
             </div>
             <div className="grid gap-3 md:grid-cols-[minmax(150px,0.7fr)_minmax(250px,1.3fr)_auto] md:items-end">
               <label className="text-xs font-bold text-slate-700">Nom du site
                 <input
                   type="text"
                   required
                   maxLength={80}
                   value={webhookForm.name}
                   onChange={(event) => setWebhookForm((current) => ({ ...current, name: event.target.value }))}
                   placeholder="Boutique principale"
                   className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                 />
               </label>
               <label className="text-xs font-bold text-slate-700">URL de destination
                 <input
                   type="url"
                   required
                   maxLength={2048}
                   value={webhookForm.url}
                   onChange={(event) => setWebhookForm((current) => ({ ...current, url: event.target.value }))}
                   placeholder="https://votre-domaine.com/webhooks/biz-transpay"
                   className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                 />
               </label>
               <div className="flex gap-2">
                 {editingWebhook && <button type="button" onClick={cancelEditingWebhook} disabled={!!busy} className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs font-bold text-slate-700 hover:bg-slate-50">Annuler</button>}
                 <button type="submit" disabled={!!busy || !webhookForm.name.trim() || !webhookForm.url.trim()} className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-blue-700 disabled:opacity-40">
                   {busy === 'webhook' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : editingWebhook ? <Check className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                   {editingWebhook ? 'Enregistrer' : 'Ajouter'}
                 </button>
               </div>
             </div>
           </form>

           {webhooks.length ? <div className="space-y-3">
             {webhooks.map((webhook) => <article key={webhook.id} className="rounded-xl border border-slate-200 bg-white p-4">
               <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                 <div className="min-w-0 flex-1">
                   <div className="flex flex-wrap items-center gap-2">
                     <h3 className="font-cabinet text-sm font-extrabold text-slate-900">{webhook.name}</h3>
                     <Badge tone={webhook.active ? 'emerald' : 'slate'}>{webhook.active ? 'Actif' : 'Désactivé'}</Badge>
                     {webhook.is_default && <Badge>Principal</Badge>}
                     <Badge tone={webhook.secret_configured ? 'blue' : 'amber'}>
                       {webhook.secret_configured ? 'Secret configuré' : 'Secret manquant'}
                     </Badge>
                   </div>
                   <p className="mt-2 break-all font-mono text-xs text-slate-600">{webhook.url}</p>
                 </div>
                 <div className="flex shrink-0 flex-wrap gap-2">
                   <button type="button" onClick={() => startEditingWebhook(webhook)} disabled={!!busy} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-40"><Pencil className="h-3.5 w-3.5" /> Modifier</button>
                   <button type="button" onClick={() => toggleWebhook(webhook)} disabled={!!busy} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-40">
                     {busy === `toggle-${webhook.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : webhook.active ? <EyeOff className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
                     {webhook.active ? 'Désactiver' : 'Activer'}
                   </button>
                   <button type="button" onClick={() => webhookAction('test', 'Test webhook envoyé', webhook)} disabled={!!busy || !webhook.active} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-40">
                     {busy === `test-${webhook.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Tester
                   </button>
                   <button type="button" onClick={() => webhookAction('rotate', 'Secret webhook régénéré', webhook)} disabled={!!busy} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-40">
                     {busy === `rotate-${webhook.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Nouveau secret
                   </button>
                   <button type="button" onClick={() => deleteWebhook(webhook)} disabled={!!busy} className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-2.5 py-2 text-xs font-bold text-red-700 hover:bg-red-50 disabled:opacity-40">
                     {busy === `delete-${webhook.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Supprimer
                   </button>
                 </div>
               </div>
             </article>)}
           </div> : <div className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-xs text-slate-500">
             <Terminal className="mx-auto mb-2 h-5 w-5 text-slate-300" />Aucune destination configurée pour cet environnement.
           </div>}

           <div>
             <div className="mb-2 flex items-center justify-between">
               <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">Dernières livraisons</h3>
               <button type="button" onClick={() => load()} className="text-xs font-bold text-blue-600 hover:text-blue-700">Actualiser</button>
             </div>
             {deliveryRows.length ? <div className="overflow-x-auto rounded-xl border border-slate-200">
               <table className="w-full min-w-[700px] text-left text-xs">
                 <thead className="bg-slate-50 text-slate-500"><tr><th className="px-3 py-2.5">Destination</th><th className="px-3 py-2.5">Événement</th><th className="px-3 py-2.5">Statut</th><th className="px-3 py-2.5">Tentatives</th><th className="px-3 py-2.5">Date</th></tr></thead>
                 <tbody className="divide-y divide-slate-100">{deliveryRows.map((row, index) => <tr key={row.id || index}>
                   <td className="px-3 py-3 font-semibold text-slate-700">{row.destination_name || row.destination_id || row.url || '—'}</td>
                   <td className="px-3 py-3 font-mono text-slate-700">{row.event || row.event_type || '—'}</td>
                   <td className="px-3 py-3"><Badge tone={row.status === 'delivered' || row.success || row.status_code >= 200 && row.status_code < 300 ? 'emerald' : row.status === 'disabled' ? 'slate' : 'red'}>{row.status || row.status_code || 'Erreur'}</Badge></td>
                   <td className="px-3 py-3 text-slate-500">{row.attempts ?? row.attempt_count ?? '—'}</td>
                   <td className="px-3 py-3 text-slate-500">{row.completed_at || row.created_at ? new Date(row.completed_at || row.created_at).toLocaleString('fr-FR') : '—'}</td>
                 </tr>)}</tbody>
               </table>
             </div> : <div className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-xs text-slate-500"><Terminal className="mx-auto mb-2 h-5 w-5 text-slate-300" />Aucune livraison pour le moment.</div>}
           </div>
         </div>
       </section>
    </>}
    <SecretReveal reveal={reveal} onClose={() => setReveal(null)} />
    {complianceConfirmationOpen && <ComplianceWarningModal onConfirm={confirmCreateCredentials} onCancel={() => setComplianceConfirmationOpen(false)} busy={busy === 'credentials'} />}
    {deleteConfirmationOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="delete-credentials-title">
      <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-red-200 bg-white shadow-2xl">
        <div className="flex items-start gap-3 border-b border-slate-100 p-5"><div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-red-100 text-red-700"><AlertTriangle className="h-5 w-5" /></div><div className="flex-1"><h2 id="delete-credentials-title" className="font-cabinet text-lg font-extrabold text-slate-900">Supprimer les identifiants {env.label} ?</h2><p className="mt-1 text-xs leading-relaxed text-slate-600">Cette action est définitive et nécessite une authentification récente.</p></div><button type="button" onClick={() => setDeleteConfirmationOpen(false)} disabled={busy === 'delete'} aria-label="Fermer" className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-40"><X className="h-4 w-4" /></button></div>
        <div className="space-y-3 p-5 text-xs leading-relaxed text-slate-700"><p>Les anciennes clés ne permettront plus de nouvelles requêtes après suppression et la configuration du webhook de cet environnement sera supprimée. Les opérations déjà lancées ne sont pas annulées.</p><p className="rounded-xl border border-blue-100 bg-blue-50 p-3 text-blue-950"><strong>Vos opérations historiques, paiements et journaux de livraison sont conservés.</strong> Seuls les identifiants et la configuration du webhook sont supprimés.</p><label className="block font-bold text-slate-700">Tapez <span className="font-mono text-red-700">{DELETE_CONFIRMATION_PHRASE}</span> pour confirmer<input autoFocus value={deleteConfirmationPhrase} onChange={(event) => setDeleteConfirmationPhrase(event.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 font-mono text-sm outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100" /></label></div>
        <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 p-4"><button type="button" onClick={() => setDeleteConfirmationOpen(false)} disabled={busy === 'delete'} className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-bold text-slate-700 hover:bg-white">Annuler</button><button type="button" onClick={deleteCredentials} disabled={!!busy || deleteConfirmationPhrase !== DELETE_CONFIRMATION_PHRASE} className="inline-flex items-center gap-2 rounded-lg bg-red-700 px-4 py-2 text-sm font-bold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-40">{busy === 'delete' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}Supprimer définitivement</button></div>
      </div>
    </div>}
  </div>;
}