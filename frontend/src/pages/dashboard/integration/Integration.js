import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BookOpen, Check, ChevronDown, ChevronRight, Clipboard, Code2, ExternalLink, Eye, EyeOff, KeyRound, Link2, Loader2, RefreshCw, Send, ShieldCheck, Terminal, Trash2, Webhook, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import api from '@/api';

const ENVIRONMENTS = {
  test: { label: 'Sandbox', title: 'Environnement de test', tone: 'blue' },
  live: { label: 'Live', title: 'Environnement de production', tone: 'emerald' },
};

const errorMessage = (error, fallback) => error?.response?.data?.detail || fallback;
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
  const [environment, setEnvironment] = useState('test');
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [reveal, setReveal] = useState(null);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [deliveries, setDeliveries] = useState(null);
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const [deleteConfirmationPhrase, setDeleteConfirmationPhrase] = useState('');

  const load = async (env = environment, { clearWebhookData = false } = {}) => {
    setLoading(true); setError('');
    try {
      const { data } = await api.get(`/integration/settings?environment=${env}`);
      setSettings(data || {});
      setWebhookUrl(clearWebhookData ? '' : data?.webhook?.url || '');
      if (clearWebhookData || !data?.credentials || !data?.webhook) {
        setDeliveries([]);
      } else {
        const deliveryResponse = await api.get(`/integration/webhooks/${env}/deliveries`);
        setDeliveries(deliveryResponse.data?.data || deliveryResponse.data || []);
      }
    } catch (err) {
      setError(errorMessage(err, 'Impossible de charger la configuration d’intégration.'));
    } finally { setLoading(false); }
  };
  // The loader intentionally owns the request lifecycle for the selected environment.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(environment); }, [environment]);

  const createCredentials = async () => {
    if (!window.confirm(`Créer des identifiants ${environment === 'live' ? 'Live' : 'Sandbox'} ? Cette action crée un secret qui ne sera visible qu’une fois.`)) return;
    setBusy('credentials');
    try {
      const { data } = await api.post('/integration/credentials', {
        environment,
        payout_opt_in: false,
      });
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
      setWebhookUrl('');
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
      const { data } = await api.put(`/integration/webhooks/${environment}`, { url: webhookUrl.trim(), active: true });
      if (data?.webhook_secret) setReveal({ secret: data.webhook_secret, type: 'Secret webhook', environment: ENVIRONMENTS[environment].label });
      toast.success('Webhook enregistré'); await load();
    } catch (err) { toast.error(errorMessage(err, 'Le webhook n’a pas pu être enregistré.')); } finally { setBusy(''); }
  };
  const webhookAction = async (action, message) => {
    setBusy(action);
    try {
      const { data } = await api.post(`/integration/webhooks/${environment}/${action === 'rotate' ? 'regenerate-secret' : 'test'}`, action === 'test' ? {} : undefined);
      if (data?.webhook_secret) setReveal({ secret: data.webhook_secret, type: 'Nouveau secret webhook', environment: ENVIRONMENTS[environment].label });
      toast.success(message); await load();
    } catch (err) { toast.error(errorMessage(err, 'L’action webhook a échoué.')); } finally { setBusy(''); }
  };
  const disableWebhook = async () => {
    setBusy('disable');
    try { await api.put(`/integration/webhooks/${environment}`, { url: webhookUrl.trim(), active: false }); toast.success('Webhook désactivé'); await load(); }
    catch (err) { toast.error(errorMessage(err, 'Le webhook n’a pas pu être désactivé.')); } finally { setBusy(''); }
  };
  const active = settings?.credentials?.active;
  const hasCredentials = Boolean(settings?.credentials?.public_key);
  const liveScopes = Array.isArray(settings?.credentials?.scopes) ? settings.credentials.scopes : [];
  const payoutScopeEnabled = liveScopes.includes('payouts:write');
  const payoutOptIn = settings?.credentials?.payout_opt_in;
  const payoutEnabled = payoutOptIn === true || payoutScopeEnabled;
  const env = ENVIRONMENTS[environment];
  const deliveryRows = useMemo(() => Array.isArray(deliveries) ? deliveries : deliveries?.items || [], [deliveries]);

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
        <div className="border-b border-slate-100 p-5"><div className="flex items-center gap-2"><Webhook className="h-4 w-4 text-blue-600" /><h2 className="font-cabinet text-lg font-extrabold text-slate-900">Webhooks</h2>{settings?.webhook?.active && <Badge tone="emerald">Actif</Badge>}</div><p className="mt-1 text-xs text-slate-500">Recevez les changements d’état signés sur votre serveur. Répondez rapidement avec un code HTTP 2xx.</p></div>
        <div className="space-y-5 p-5"><form onSubmit={saveWebhook} className="flex flex-col gap-2 sm:flex-row sm:items-end"><label className="flex-1 text-xs font-bold text-slate-700">URL de destination<input type="url" required value={webhookUrl} onChange={(event) => setWebhookUrl(event.target.value)} placeholder="https://votre-domaine.com/webhooks/biz-transpay" className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" /></label><button type="submit" disabled={!!busy || !webhookUrl.trim()} className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-blue-700 disabled:opacity-40">{busy === 'webhook' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />} Enregistrer</button></form>
          <div className="flex flex-wrap gap-2">{settings?.webhook?.active && <><button type="button" onClick={() => webhookAction('test', 'Test webhook envoyé')} disabled={!!busy} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50"><Send className="h-3.5 w-3.5" /> Envoyer un test</button><button type="button" onClick={() => webhookAction('rotate', 'Secret webhook régénéré')} disabled={!!busy} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50"><RefreshCw className="h-3.5 w-3.5" /> Régénérer le secret</button><button type="button" onClick={disableWebhook} disabled={!!busy} className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-xs font-bold text-red-700 hover:bg-red-50"><EyeOff className="h-3.5 w-3.5" /> Désactiver</button></>}</div>
          <div><div className="mb-2 flex items-center justify-between"><h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">Dernières livraisons</h3><button type="button" onClick={() => load()} className="text-xs font-bold text-blue-600 hover:text-blue-700">Actualiser</button></div>{deliveryRows.length ? <div className="overflow-x-auto rounded-xl border border-slate-200"><table className="w-full min-w-[580px] text-left text-xs"><thead className="bg-slate-50 text-slate-500"><tr><th className="px-3 py-2.5">Événement</th><th className="px-3 py-2.5">Statut</th><th className="px-3 py-2.5">Tentatives</th><th className="px-3 py-2.5">Date</th></tr></thead><tbody className="divide-y divide-slate-100">{deliveryRows.map((row, index) => <tr key={row.id || index}><td className="px-3 py-3 font-mono text-slate-700">{row.event || row.event_type || '—'}</td><td className="px-3 py-3"><Badge tone={row.success || row.status_code >= 200 && row.status_code < 300 ? 'emerald' : 'red'}>{row.status || row.status_code || 'Erreur'}</Badge></td><td className="px-3 py-3 text-slate-500">{row.attempts ?? row.attempt_count ?? '—'}</td><td className="px-3 py-3 text-slate-500">{row.created_at ? new Date(row.created_at).toLocaleString('fr-FR') : '—'}</td></tr>)}</tbody></table></div> : <div className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-xs text-slate-500"><Terminal className="mx-auto mb-2 h-5 w-5 text-slate-300" />Aucune livraison pour le moment.</div>}</div>
        </div>
      </section>
    </>}
    <SecretReveal reveal={reveal} onClose={() => setReveal(null)} />
    {deleteConfirmationOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="delete-credentials-title">
      <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-red-200 bg-white shadow-2xl">
        <div className="flex items-start gap-3 border-b border-slate-100 p-5"><div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-red-100 text-red-700"><AlertTriangle className="h-5 w-5" /></div><div className="flex-1"><h2 id="delete-credentials-title" className="font-cabinet text-lg font-extrabold text-slate-900">Supprimer les identifiants {env.label} ?</h2><p className="mt-1 text-xs leading-relaxed text-slate-600">Cette action est définitive et nécessite une authentification récente.</p></div><button type="button" onClick={() => setDeleteConfirmationOpen(false)} disabled={busy === 'delete'} aria-label="Fermer" className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-40"><X className="h-4 w-4" /></button></div>
        <div className="space-y-3 p-5 text-xs leading-relaxed text-slate-700"><p>Les anciennes clés ne permettront plus de nouvelles requêtes après suppression et la configuration du webhook de cet environnement sera supprimée. Les opérations déjà lancées ne sont pas annulées.</p><p className="rounded-xl border border-blue-100 bg-blue-50 p-3 text-blue-950"><strong>Vos opérations historiques, paiements et journaux de livraison sont conservés.</strong> Seuls les identifiants et la configuration du webhook sont supprimés.</p><label className="block font-bold text-slate-700">Tapez <span className="font-mono text-red-700">{DELETE_CONFIRMATION_PHRASE}</span> pour confirmer<input autoFocus value={deleteConfirmationPhrase} onChange={(event) => setDeleteConfirmationPhrase(event.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 font-mono text-sm outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100" /></label></div>
        <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 p-4"><button type="button" onClick={() => setDeleteConfirmationOpen(false)} disabled={busy === 'delete'} className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-bold text-slate-700 hover:bg-white">Annuler</button><button type="button" onClick={deleteCredentials} disabled={!!busy || deleteConfirmationPhrase !== DELETE_CONFIRMATION_PHRASE} className="inline-flex items-center gap-2 rounded-lg bg-red-700 px-4 py-2 text-sm font-bold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-40">{busy === 'delete' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}Supprimer définitivement</button></div>
      </div>
    </div>}
  </div>;
}