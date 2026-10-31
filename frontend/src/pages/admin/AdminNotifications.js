import { useEffect, useState } from 'react';
import { Bell, Send } from 'lucide-react';
import api from '@/api';
import { toast } from 'sonner';

const initial = { audience: 'all', user_id: '', account_type: '', country: '', kyc_status: '', title: '', body: '', url: '/dashboard' };
export default function AdminNotifications() {
  const [form, setForm] = useState(initial);
  const [options, setOptions] = useState({ countries: [], account_types: [], kyc_statuses: [] });
  const [users, setUsers] = useState([]);
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [busy, setBusy] = useState(false);
  const [firebaseConfig, setFirebaseConfig] = useState(null);
  useEffect(() => {
    api.get('/push/config').then(({ data }) => setFirebaseConfig(data)).catch(() => setFirebaseConfig({
      configured: false,
      server_configured: false,
      missing: [],
      server_missing: [],
      status_error: true,
    }));
    api.get('/admin/push/audience-options').then(({ data }) => setOptions(data));
    const loadCampaigns = () => api.get('/admin/push/campaigns?limit=20').then(({ data }) => setCampaigns(data.campaigns || []));
    loadCampaigns();
    const timer = window.setInterval(loadCampaigns, 5000);
    return () => window.clearInterval(timer);
  }, []);
  const firebaseReady = Boolean(firebaseConfig?.configured && firebaseConfig?.server_configured);
  const missingFirebaseSettings = [
    ...(firebaseConfig?.missing || []),
    ...(firebaseConfig?.server_missing || []),
  ];
  const set = (key, value) => { setForm((f) => ({ ...f, [key]: value })); setPreview(null); };
  const search = async (value) => { setQuery(value); set('user_id', ''); setPreview(null); if (value.length >= 2) { const { data } = await api.get('/admin/push/users', { params: { q: value } }); setUsers(data.users || []); } else setUsers([]); };
  const audiencePayload = () => ({ audience: form.audience, ...(form.audience === 'user' ? { user_id: form.user_id } : {}), ...(form.audience === 'group' ? { account_type: form.account_type || undefined, country: form.country || undefined, kyc_status: form.kyc_status || undefined } : {}) });
  const doPreview = async () => { try { const { data } = await api.post('/admin/push/preview', audiencePayload()); setPreview(data); } catch (e) { toast.error(e.response?.data?.detail || 'Aperçu impossible'); } };
  const send = async () => {
    if (!preview || preview.devices < 1) {
      toast.error('Prévisualisez d’abord une audience avec au moins un appareil inscrit.');
      return;
    }
    if (window.prompt('Tapez CONFIRMER pour envoyer cette campagne') !== 'CONFIRMER') return;
    setBusy(true);
    try { const { data } = await api.post('/admin/push/send', { ...audiencePayload(), title: form.title, body: form.body, url: form.url, confirmation: 'CONFIRMER', request_id: crypto.randomUUID() }); toast.success('Campagne envoyée'); setCampaigns((c) => [data, ...c]); setPreview(null); }
    catch (e) { toast.error(e.response?.data?.detail || 'Envoi impossible'); } finally { setBusy(false); }
  };
  return <div className="space-y-6" data-testid="page-admin-notifications">
    <div>
      <h1 className="font-cabinet text-3xl font-extrabold text-slate-900">Notifications push</h1>
      <p className="text-slate-500 mt-1">Envoyez un message aux clients actifs ayant activé les notifications sur leur navigateur.</p>
      {firebaseConfig === null ? (
        <p className="text-sm mt-2 font-semibold text-slate-500">Vérification de la configuration Firebase…</p>
      ) : firebaseReady ? (
        <p className="text-sm mt-2 font-semibold text-emerald-600">Firebase est prêt pour les notifications.</p>
      ) : (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold">
            {firebaseConfig.status_error
              ? 'Impossible de lire la configuration Firebase depuis le serveur.'
              : 'Configuration Firebase incomplète : les campagnes ne pourront pas être livrées.'}
          </p>
          {missingFirebaseSettings.length > 0 && (
            <p className="mt-1">
              Variables à vérifier dans Plesk &gt; Node.js &gt; Environment Variables :{' '}
              <code>{missingFirebaseSettings.join(', ')}</code>
            </p>
          )}
          <p className="mt-1">
            Après toute modification, enregistre les variables et redémarre l’application Node.
            Ne partage jamais le contenu du compte de service.
          </p>
        </div>
      )}
    </div>
    <section className="bg-white border border-slate-100 rounded-2xl p-5 sm:p-7 space-y-5">
      <h2 className="font-bold text-xl flex items-center gap-2"><Bell className="w-5 h-5 text-blue-600" /> Audience</h2>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Audience">
        {['all', 'user', 'group'].map((a) => <button key={a} type="button" onClick={() => set('audience', a)} className={`px-4 py-2 rounded-full text-sm font-bold ${form.audience === a ? 'bg-blue-600 text-white' : 'bg-slate-100'}`}>{a === 'all' ? 'Tous' : a === 'user' ? 'Un utilisateur' : 'Un groupe'}</button>)}
      </div>
      {form.audience === 'user' && <div><label className="label">Rechercher un utilisateur</label><input value={query} onChange={(e) => search(e.target.value)} className="input" placeholder="Nom ou identifiant" />{users.length > 0 && <div className="border rounded-xl mt-1 divide-y">{users.map((u) => <button type="button" key={u.id} onClick={() => { set('user_id', u.id); setQuery(`${u.full_name} (@${u.username})`); setUsers([]); }} className="w-full text-left p-3 hover:bg-blue-50 text-sm">{u.full_name} <span className="text-slate-400">@{u.username}</span></button>)}</div>}</div>}
      {form.audience === 'group' && <div className="grid sm:grid-cols-3 gap-3">{[['account_type','Type de compte','account_types'],['country','Pays','countries'],['kyc_status','Statut KYC','kyc_statuses']].map(([key,label,list]) => <label key={key} className="text-sm font-semibold text-slate-700">{label}<select value={form[key]} onChange={(e) => set(key,e.target.value)} className="input mt-1"><option value="">Tous</option>{options[list].map((v) => <option key={v} value={v}>{v}</option>)}</select></label>)}</div>}
      <div className="grid gap-3"><label className="text-sm font-semibold">Titre<input value={form.title} onChange={(e) => set('title',e.target.value)} className="input mt-1" maxLength={100} /></label><label className="text-sm font-semibold">Message<textarea value={form.body} onChange={(e) => set('body',e.target.value)} className="input mt-1" rows="3" maxLength={500} /></label><label className="text-sm font-semibold">Chemin au clic<input value={form.url} onChange={(e) => set('url',e.target.value)} className="input mt-1" /></label></div>
      <div className="flex flex-wrap items-center gap-3"><button type="button" onClick={doPreview} className="px-5 py-2.5 rounded-full bg-slate-100 font-bold">Prévisualiser</button>{preview && <span className="text-sm font-semibold text-slate-600">{preview.users} utilisateurs · {preview.devices} appareils éligibles</span>}<button type="button" disabled={busy || !firebaseReady || !preview || preview.devices < 1 || !form.title || !form.body || (form.audience === 'user' && !form.user_id) || (form.audience === 'group' && !form.account_type && !form.country && !form.kyc_status)} onClick={send} className="sm:ml-auto px-5 py-2.5 rounded-full bg-blue-600 text-white font-bold disabled:opacity-40"><Send className="inline w-4 h-4 mr-2" />Envoyer</button></div>
    </section>
    <section className="bg-white border border-slate-100 rounded-2xl p-5 sm:p-7"><h2 className="font-bold text-xl mb-4">Campagnes récentes</h2><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-slate-500"><th className="p-2">Campagne</th><th className="p-2">Audience</th><th className="p-2">Statut</th><th className="p-2">Résultat</th></tr></thead><tbody>{campaigns.map((c) => { const a = c.audience || {}; const filters = [a.account_type, a.country, a.kyc_status].filter(Boolean); const audience = typeof a === 'string' ? a : a.audience === 'all' ? 'Tous les clients' : a.audience === 'user' ? 'Utilisateur ciblé' : `Groupe${filters.length ? ` (${filters.join(', ')})` : ''}`; const status = { queued: 'En attente', sending: 'En cours', sent: 'Envoyée', partial: 'Partielle', failed: 'Échec' }[c.status] || c.status; return <tr key={c.id} className="border-t"><td className="p-2 font-semibold">{c.title}</td><td className="p-2">{audience}</td><td className="p-2">{status}</td><td className="p-2">{c.sent ?? 0} envoyées · {c.failed ?? 0} échecs</td></tr>; })}</tbody></table></div></section>
  </div>;
}