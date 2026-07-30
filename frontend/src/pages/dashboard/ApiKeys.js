import { useEffect, useState, useCallback } from 'react';
import {
  Copy, RefreshCw, Book, KeyRound, Webhook, ListChecks, Terminal,
  Check, X, AlertTriangle, Plus, Trash2, Send, Pencil, ToggleLeft, ToggleRight, Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';
import { useAuth } from '@/context/AuthContext';

const copy = (v) => { navigator.clipboard.writeText(v); toast.success('Copié dans le presse-papier'); };

// ---------- Reusable modal — shows a plaintext secret ONCE ----------
function OneTimeSecretModal({ title, value, hint, onClose }) {
  const [ack, setAck] = useState(false);
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" data-testid="onetime-modal">
      <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
          <div className="w-9 h-9 rounded-full bg-amber-50 flex items-center justify-center"><AlertTriangle className="w-4 h-4 text-amber-600" /></div>
          <h3 className="font-cabinet font-extrabold text-slate-900">{title}</h3>
        </div>
        <div className="p-5">
          <div className="rounded-xl bg-amber-50 border border-amber-100 p-3 text-[12px] text-amber-800 leading-relaxed">
            <b>Ce secret ne sera plus jamais affiché.</b> Copiez-le maintenant et stockez-le en lieu sûr (variables d&apos;environnement, gestionnaire de secrets…). Si vous le perdez, régénérez-en un nouveau.
          </div>
          {hint && <div className="mt-3 text-[11px] text-slate-500">Empreinte : <code className="font-mono text-slate-700">{hint}</code></div>}
          <div className="mt-3 flex items-center gap-2 p-3 rounded-xl bg-slate-900 border border-slate-800">
            <code data-testid="onetime-value" className="flex-1 font-mono text-[12px] text-emerald-300 break-all">{value}</code>
            <button onClick={() => copy(value)} data-testid="btn-copy-onetime" className="w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 flex items-center justify-center"><Copy className="w-4 h-4 text-slate-300" /></button>
          </div>
          <label className="mt-4 flex items-start gap-2 text-xs text-slate-700 cursor-pointer">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="onetime-ack" className="mt-0.5" />
            J&apos;ai copié et sécurisé ce secret.
          </label>
          <div className="mt-5 flex justify-end">
            <button onClick={onClose} disabled={!ack} data-testid="btn-onetime-close" className="px-5 py-2 rounded-lg bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-bold">Fermer</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ConfirmModal({ title, message, danger, onConfirm, onClose }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" data-testid="confirm-modal">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100">
          <h3 className="font-cabinet font-extrabold text-slate-900">{title}</h3>
        </div>
        <div className="p-5 text-sm text-slate-700">{message}</div>
        <div className="p-4 flex items-center justify-end gap-2 bg-slate-50">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-xs font-bold text-slate-700 bg-white hover:bg-slate-100 border border-slate-200">Annuler</button>
          <button onClick={onConfirm} data-testid="btn-confirm-yes" className={`px-4 py-2 rounded-lg text-xs font-bold text-white ${danger ? 'bg-red-600 hover:bg-red-700' : 'bg-[#2563EB] hover:bg-[#1D4ED8]'}`}>Confirmer</button>
        </div>
      </div>
    </div>
  );
}

// -------------------- Main page --------------------
export default function ApiKeys() {
  const { user } = useAuth();
  const [tab, setTab] = useState('keys');
  const [reveal, setReveal] = useState(null);

  if (user?.account_type !== 'merchant') {
    return <div className="p-6 text-center text-slate-500 text-sm">Réservé aux comptes marchands.</div>;
  }

  return (
    <div className="space-y-5" data-testid="page-api">
      {reveal && <OneTimeSecretModal {...reveal} onClose={() => setReveal(null)} />}
      <div className="flex items-start sm:items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-cabinet text-3xl font-extrabold tracking-tighter text-slate-900">API de paiement</h1>
          <p className="text-slate-500 text-sm mt-1">Gérez plusieurs clés API et plusieurs webhooks. Chaque clé et chaque webhook peuvent être activés, renommés ou supprimés indépendamment.</p>
        </div>
        <a href="/dashboard/api/docs" data-testid="btn-open-docs" className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold shadow-sm">
          <Book className="w-3.5 h-3.5" /> Documentation API
        </a>
      </div>

      <div className="flex items-center gap-1 border-b border-slate-200 overflow-x-auto">
        <TabBtn active={tab === 'keys'} onClick={() => setTab('keys')} I={KeyRound} label="Clés API" testId="tab-keys" />
        <TabBtn active={tab === 'webhook'} onClick={() => setTab('webhook')} I={Webhook} label="Webhooks" testId="tab-webhook" />
        <TabBtn active={tab === 'deliveries'} onClick={() => setTab('deliveries')} I={ListChecks} label="Livraisons" testId="tab-deliveries" />
        <TabBtn active={tab === 'logs'} onClick={() => setTab('logs')} I={Terminal} label="Logs API" testId="tab-logs" />
      </div>

      {tab === 'keys' && <KeysTab onReveal={setReveal} />}
      {tab === 'webhook' && <WebhooksTab onReveal={setReveal} />}
      {tab === 'deliveries' && <DeliveriesTab />}
      {tab === 'logs' && <LogsTab />}
    </div>
  );
}

function TabBtn({ active, onClick, I, label, testId }) {
  return (
    <button onClick={onClick} data-testid={testId}
      className={`inline-flex items-center gap-1.5 px-3 py-2 -mb-px text-xs font-semibold border-b-2 whitespace-nowrap transition-colors ${active ? 'border-[#2563EB] text-[#2563EB]' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
      <I className="w-3.5 h-3.5" /> {label}
    </button>
  );
}

// ============================================================
//                          KEYS TAB
// ============================================================
function KeysTab({ onReveal }) {
  const [keys, setKeys] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/merchant/keys');
      setKeys(data.data || []);
    } catch { toast.error('Impossible de charger les clés'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggleActive = async (k) => {
    try {
      await api.patch(`/merchant/keys/${k.id}`, { active: !k.active });
      toast.success(k.active ? 'Clé désactivée' : 'Clé activée');
      load();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Erreur'); }
  };

  const rename = async (k) => {
    const newName = window.prompt('Nouveau nom de la clé :', k.name || '');
    if (!newName || newName === k.name) return;
    try {
      await api.patch(`/merchant/keys/${k.id}`, { name: newName });
      load();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Erreur'); }
  };

  const regen = async (k) => {
    if (!window.confirm(`Régénérer la clé « ${k.name} » ? L\u2019ancienne clé sera immédiatement invalidée.`)) return;
    try {
      const { data } = await api.post(`/merchant/keys/${k.id}/regenerate`);
      onReveal({ title: `Nouveau secret — ${k.name}`, value: data.secret, hint: data.secret_hint });
      load();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Erreur'); }
  };

  const doDelete = async (k) => {
    try {
      await api.delete(`/merchant/keys/${k.id}`);
      toast.success('Clé supprimée');
      setConfirmDelete(null);
      load();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Erreur'); }
  };

  return (
    <div className="bg-white border border-slate-100 rounded-2xl overflow-hidden" data-testid="keys-tab">
      <div className="p-4 border-b border-slate-100 flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="font-cabinet font-extrabold text-sm text-slate-900">Clés API ({keys?.length || 0})</h3>
          <p className="text-[11px] text-slate-500">Créez une clé par intégration (application mobile, site web, tests…). Une clé désactivée renvoie 403 sur toutes les routes /v1/*.</p>
        </div>
        <button onClick={() => setShowCreate(true)} data-testid="btn-create-key" className="inline-flex items-center gap-1.5 bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-xs font-bold px-3 py-1.5 rounded-full">
          <Plus className="w-3.5 h-3.5" /> Créer une clé
        </button>
      </div>

      {keys === null && <div className="p-8 text-center text-xs text-slate-400">Chargement…</div>}
      {keys?.length === 0 && (
        <div className="p-10 text-center">
          <KeyRound className="w-8 h-8 text-slate-300 mx-auto mb-2" />
          <p className="text-sm text-slate-500 mb-3">Aucune clé pour le moment.</p>
          <button onClick={() => setShowCreate(true)} className="inline-flex items-center gap-1.5 bg-[#2563EB] text-white text-xs font-bold px-3 py-1.5 rounded-full">
            <Plus className="w-3.5 h-3.5" /> Créer votre première clé
          </button>
        </div>
      )}

      {keys?.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              <tr>
                <th className="text-left px-4 py-2">Nom</th>
                <th className="text-left px-4 py-2">Env</th>
                <th className="text-left px-4 py-2">Clé publique</th>
                <th className="text-left px-4 py-2">Secret</th>
                <th className="text-center px-4 py-2">Actif</th>
                <th className="text-right px-4 py-2">Utilisée</th>
                <th className="text-center px-4 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} data-testid={`key-row-${k.id}`} className="border-t border-slate-50 hover:bg-slate-50/60">
                  <td className="px-4 py-2 font-semibold text-slate-900">{k.name}</td>
                  <td className="px-4 py-2">
                    <span className={`inline-flex px-1.5 py-0.5 rounded-full text-[10px] font-bold uppercase ${k.env === 'live' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>{k.env}</span>
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-1.5">
                      <code className="font-mono text-[11px] text-slate-700">{k.public_key}</code>
                      <button onClick={() => copy(k.public_key)} className="w-6 h-6 rounded hover:bg-slate-100 flex items-center justify-center"><Copy className="w-3 h-3 text-slate-500" /></button>
                    </div>
                  </td>
                  <td className="px-4 py-2 font-mono text-[11px] text-slate-500">{k.secret_hint || '—'}</td>
                  <td className="px-4 py-2 text-center">
                    <button onClick={() => toggleActive(k)} data-testid={`btn-toggle-${k.id}`} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${k.active ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
                      {k.active ? <ToggleRight className="w-3 h-3" /> : <ToggleLeft className="w-3 h-3" />}
                      {k.active ? 'Actif' : 'Off'}
                    </button>
                  </td>
                  <td className="px-4 py-2 text-right text-[10px] text-slate-500">{k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : 'jamais'}</td>
                  <td className="px-4 py-2 text-center whitespace-nowrap">
                    <button onClick={() => rename(k)} title="Renommer" className="w-7 h-7 rounded hover:bg-blue-50 text-slate-500 hover:text-[#2563EB] inline-flex items-center justify-center"><Pencil className="w-3.5 h-3.5" /></button>
                    <button onClick={() => regen(k)} title="Régénérer" data-testid={`btn-regen-${k.id}`} className="w-7 h-7 rounded hover:bg-amber-50 text-slate-500 hover:text-amber-700 inline-flex items-center justify-center"><RefreshCw className="w-3.5 h-3.5" /></button>
                    <button onClick={() => setConfirmDelete(k)} title="Supprimer" data-testid={`btn-delete-${k.id}`} className="w-7 h-7 rounded hover:bg-red-50 text-slate-500 hover:text-red-600 inline-flex items-center justify-center"><Trash2 className="w-3.5 h-3.5" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && <CreateKeyModal onClose={() => setShowCreate(false)} onCreated={(k) => { onReveal({ title: `Clé créée — ${k.name}`, value: k.secret, hint: k.secret_hint }); setShowCreate(false); load(); }} />}
      {confirmDelete && <ConfirmModal title="Supprimer la clé ?" message={`Cette action est irréversible. La clé « ${confirmDelete.name} » sera invalidée immédiatement.`} danger onClose={() => setConfirmDelete(null)} onConfirm={() => doDelete(confirmDelete)} />}
    </div>
  );
}

function CreateKeyModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [env, setEnv] = useState('test');
  const [loading, setLoading] = useState(false);
  const submit = async () => {
    if (!name.trim()) { toast.error('Nom requis'); return; }
    setLoading(true);
    try {
      const { data } = await api.post('/merchant/keys', { name: name.trim(), env });
      onCreated(data);
    } catch (e) { toast.error(e?.response?.data?.detail || 'Erreur'); }
    finally { setLoading(false); }
  };
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" data-testid="create-key-modal">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
          <div className="w-9 h-9 rounded-full bg-blue-50 flex items-center justify-center"><KeyRound className="w-4 h-4 text-[#2563EB]" /></div>
          <h3 className="font-cabinet font-extrabold text-slate-900">Nouvelle clé API</h3>
        </div>
        <div className="p-5 space-y-3">
          <div>
            <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500 block mb-1">Nom</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex : Application mobile" data-testid="input-key-name" autoFocus
              className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm outline-none focus:border-[#2563EB]" />
          </div>
          <div>
            <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500 block mb-1">Environnement</label>
            <div className="flex gap-2">
              {['test', 'live'].map((e) => (
                <button key={e} onClick={() => setEnv(e)} data-testid={`input-key-env-${e}`}
                  className={`flex-1 py-2 rounded-xl text-xs font-bold uppercase border transition-colors ${env === e ? (e === 'live' ? 'bg-red-50 text-red-700 border-red-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200') : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
                  {e}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="p-4 flex items-center justify-end gap-2 bg-slate-50">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-xs font-bold text-slate-700 bg-white hover:bg-slate-100 border border-slate-200">Annuler</button>
          <button onClick={submit} disabled={loading} data-testid="btn-create-key-submit" className="px-4 py-2 rounded-lg text-xs font-bold text-white bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-50 inline-flex items-center gap-1.5">
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Créer la clé
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
//                       WEBHOOKS TAB
// ============================================================
function WebhooksTab({ onReveal }) {
  const [rows, setRows] = useState(null);
  const [events, setEvents] = useState([]);
  const [editing, setEditing] = useState(null); // {} for new, or existing wh
  const [confirmDelete, setConfirmDelete] = useState(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/merchant/webhooks');
      setRows(data.data || []);
      setEvents(data.available_events || []);
    } catch { toast.error('Erreur webhooks'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggle = async (w) => {
    try {
      await api.patch(`/merchant/webhooks/${w.id}`, { active: !w.active });
      load();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Erreur'); }
  };
  const sendTest = async (w) => {
    try {
      await api.post(`/merchant/webhooks/${w.id}/test`);
      toast.success('Event de test envoyé — voir onglet Livraisons');
    } catch (e) { toast.error(e?.response?.data?.detail || 'Erreur'); }
  };
  const regenSecret = async (w) => {
    if (!window.confirm(`Régénérer le secret de « ${w.name} » ? Votre serveur devra utiliser le nouveau pour vérifier les signatures.`)) return;
    try {
      const { data } = await api.post(`/merchant/webhooks/${w.id}/regenerate-secret`);
      onReveal({ title: `Nouveau webhook secret — ${w.name}`, value: data.secret, hint: data.secret_hint });
      load();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Erreur'); }
  };
  const doDelete = async (w) => {
    try {
      await api.delete(`/merchant/webhooks/${w.id}`);
      toast.success('Webhook supprimé'); setConfirmDelete(null); load();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Erreur'); }
  };

  return (
    <div className="bg-white border border-slate-100 rounded-2xl overflow-hidden" data-testid="webhooks-tab">
      <div className="p-4 border-b border-slate-100 flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="font-cabinet font-extrabold text-sm text-slate-900">Webhooks ({rows?.length || 0})</h3>
          <p className="text-[11px] text-slate-500">Chaque webhook reçoit indépendamment les événements qu&apos;il a cochés. Événements signés HMAC-SHA256.</p>
        </div>
        <button onClick={() => setEditing({})} data-testid="btn-create-webhook" className="inline-flex items-center gap-1.5 bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-xs font-bold px-3 py-1.5 rounded-full">
          <Plus className="w-3.5 h-3.5" /> Ajouter un webhook
        </button>
      </div>

      {rows === null && <div className="p-8 text-center text-xs text-slate-400">Chargement…</div>}
      {rows?.length === 0 && (
        <div className="p-10 text-center">
          <Webhook className="w-8 h-8 text-slate-300 mx-auto mb-2" />
          <p className="text-sm text-slate-500 mb-3">Aucun webhook configuré.</p>
          <button onClick={() => setEditing({})} className="inline-flex items-center gap-1.5 bg-[#2563EB] text-white text-xs font-bold px-3 py-1.5 rounded-full">
            <Plus className="w-3.5 h-3.5" /> Ajouter votre premier webhook
          </button>
        </div>
      )}

      {rows?.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              <tr>
                <th className="text-left px-4 py-2">Nom</th>
                <th className="text-left px-4 py-2">URL</th>
                <th className="text-center px-4 py-2">Événements</th>
                <th className="text-center px-4 py-2">Actif</th>
                <th className="text-center px-4 py-2">Échecs</th>
                <th className="text-center px-4 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.id} data-testid={`webhook-row-${w.id}`} className="border-t border-slate-50 hover:bg-slate-50/60">
                  <td className="px-4 py-2 font-semibold text-slate-900">{w.name}</td>
                  <td className="px-4 py-2 font-mono text-[11px] max-w-xs truncate" title={w.url}>{w.url}</td>
                  <td className="px-4 py-2 text-center">
                    <span className="inline-flex px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 text-[10px] font-bold">{w.events?.length || 0}</span>
                  </td>
                  <td className="px-4 py-2 text-center">
                    <button onClick={() => toggle(w)} data-testid={`wh-toggle-${w.id}`} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${w.active ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
                      {w.active ? <ToggleRight className="w-3 h-3" /> : <ToggleLeft className="w-3 h-3" />}
                      {w.active ? 'Actif' : 'Off'}
                    </button>
                  </td>
                  <td className="px-4 py-2 text-center text-[11px]">
                    {w.failure_count > 0 ? <span className="text-red-600 font-bold">{w.failure_count}</span> : <span className="text-slate-400">0</span>}
                  </td>
                  <td className="px-4 py-2 text-center whitespace-nowrap">
                    <button onClick={() => sendTest(w)} title="Envoyer un event de test" data-testid={`wh-test-${w.id}`} className="w-7 h-7 rounded hover:bg-emerald-50 text-slate-500 hover:text-emerald-700 inline-flex items-center justify-center"><Send className="w-3.5 h-3.5" /></button>
                    <button onClick={() => setEditing(w)} title="Modifier" className="w-7 h-7 rounded hover:bg-blue-50 text-slate-500 hover:text-[#2563EB] inline-flex items-center justify-center"><Pencil className="w-3.5 h-3.5" /></button>
                    <button onClick={() => regenSecret(w)} title="Régénérer le secret" className="w-7 h-7 rounded hover:bg-amber-50 text-slate-500 hover:text-amber-700 inline-flex items-center justify-center"><RefreshCw className="w-3.5 h-3.5" /></button>
                    <button onClick={() => setConfirmDelete(w)} title="Supprimer" data-testid={`wh-delete-${w.id}`} className="w-7 h-7 rounded hover:bg-red-50 text-slate-500 hover:text-red-600 inline-flex items-center justify-center"><Trash2 className="w-3.5 h-3.5" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && <WebhookModal wh={editing} events={events} onClose={() => setEditing(null)} onSaved={(w) => {
        if (w?.secret) onReveal({ title: `Webhook créé — ${w.name}`, value: w.secret, hint: w.secret_hint });
        setEditing(null); load();
      }} />}
      {confirmDelete && <ConfirmModal title="Supprimer le webhook ?" message={`Cette action est irréversible. Le webhook « ${confirmDelete.name} » ne recevra plus aucun événement.`} danger onClose={() => setConfirmDelete(null)} onConfirm={() => doDelete(confirmDelete)} />}
    </div>
  );
}

function WebhookModal({ wh, events, onClose, onSaved }) {
  const isNew = !wh?.id;
  const [name, setName] = useState(wh?.name || '');
  const [url, setUrl] = useState(wh?.url || '');
  const [selected, setSelected] = useState(new Set(wh?.events || events));
  const [loading, setLoading] = useState(false);

  const toggle = (ev) => {
    const s = new Set(selected);
    s.has(ev) ? s.delete(ev) : s.add(ev);
    setSelected(s);
  };

  const submit = async () => {
    if (!name.trim() || !url.trim()) { toast.error('Nom et URL requis'); return; }
    if (!/^https?:\/\//.test(url.trim())) { toast.error('URL doit commencer par http:// ou https://'); return; }
    setLoading(true);
    try {
      const body = { name: name.trim(), url: url.trim(), events: Array.from(selected) };
      if (isNew) {
        const { data } = await api.post('/merchant/webhooks', body);
        onSaved(data);
      } else {
        const { data } = await api.patch(`/merchant/webhooks/${wh.id}`, body);
        onSaved(data);
      }
    } catch (e) { toast.error(e?.response?.data?.detail || 'Erreur'); }
    finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" data-testid="webhook-modal">
      <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
          <div className="w-9 h-9 rounded-full bg-blue-50 flex items-center justify-center"><Webhook className="w-4 h-4 text-[#2563EB]" /></div>
          <h3 className="font-cabinet font-extrabold text-slate-900">{isNew ? 'Nouveau webhook' : 'Modifier le webhook'}</h3>
        </div>
        <div className="p-5 space-y-3 overflow-y-auto">
          <div>
            <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500 block mb-1">Nom</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex : Serveur crypto" data-testid="input-wh-name" autoFocus
              className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm outline-none focus:border-[#2563EB]" />
          </div>
          <div>
            <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500 block mb-1">URL</label>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://votre-serveur.com/webhooks/biztranspay" data-testid="input-wh-url"
              className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm font-mono outline-none focus:border-[#2563EB]" />
          </div>
          <div>
            <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500 block mb-1.5">Événements à recevoir ({selected.size}/{events.length})</label>
            <div className="border border-slate-200 rounded-xl max-h-48 overflow-y-auto p-2 space-y-0.5">
              {events.map((ev) => (
                <label key={ev} className="flex items-center gap-2 py-1.5 px-2 rounded-lg hover:bg-slate-50 cursor-pointer">
                  <input type="checkbox" checked={selected.has(ev)} onChange={() => toggle(ev)} data-testid={`wh-event-${ev}`}
                    className="w-3.5 h-3.5 accent-[#2563EB]" />
                  <code className="font-mono text-[11px] text-slate-700">{ev}</code>
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="p-4 flex items-center justify-end gap-2 bg-slate-50 border-t border-slate-100">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-xs font-bold text-slate-700 bg-white hover:bg-slate-100 border border-slate-200">Annuler</button>
          <button onClick={submit} disabled={loading} data-testid="btn-wh-submit" className="px-4 py-2 rounded-lg text-xs font-bold text-white bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-50 inline-flex items-center gap-1.5">
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {isNew ? 'Créer' : 'Enregistrer'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
//                     DELIVERIES + LOGS (unchanged)
// ============================================================
function DeliveriesTab() {
  const [items, setItems] = useState(null);
  useEffect(() => { api.get('/api-keys/webhook/deliveries').then(({ data }) => setItems(data)).catch(() => setItems([])); }, []);
  return (
    <div className="bg-white border border-slate-100 rounded-2xl overflow-hidden">
      <div className="p-4 border-b border-slate-100">
        <h3 className="font-cabinet font-extrabold text-sm text-slate-900">Livraisons webhook</h3>
        <p className="text-[11px] text-slate-500">Les 50 dernières tentatives, avec code HTTP et corps de réponse.</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            <tr><th className="text-left px-4 py-2">Événement</th><th className="text-left px-4 py-2">URL</th><th className="text-center px-4 py-2">Statut</th><th className="text-center px-4 py-2">Tentatives</th><th className="text-right px-4 py-2">Envoyé</th></tr>
          </thead>
          <tbody>
            {items === null && <tr><td colSpan={5} className="p-6 text-center text-slate-400 text-xs">Chargement…</td></tr>}
            {items?.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-slate-400 text-xs">Aucune livraison pour le moment.</td></tr>}
            {items?.map((d) => (
              <tr key={d.id} data-testid={`delivery-row-${d.id}`} className="border-t border-slate-50 hover:bg-slate-50/60">
                <td className="px-4 py-2 font-mono text-[11px]">{d.event_type}</td>
                <td className="px-4 py-2 text-[11px] truncate max-w-[240px]" title={d.url}>{d.url}</td>
                <td className="px-4 py-2 text-center">
                  {d.status === 'delivered' ? <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[10px] font-bold"><Check className="w-3 h-3" /> {d.status_code || 200}</span>
                  : d.status === 'failed' ? <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-red-50 text-red-700 text-[10px] font-bold"><X className="w-3 h-3" /> {d.status_code || 'error'}</span>
                  : <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 text-[10px] font-bold">pending</span>}
                </td>
                <td className="px-4 py-2 text-center text-[11px]">{d.attempts || 0}</td>
                <td className="px-4 py-2 text-right text-[11px] text-slate-500">{new Date(d.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LogsTab() {
  const [items, setItems] = useState(null);
  useEffect(() => { api.get('/api-keys/logs').then(({ data }) => setItems(data)).catch(() => setItems([])); }, []);
  return (
    <div className="bg-white border border-slate-100 rounded-2xl overflow-hidden">
      <div className="p-4 border-b border-slate-100">
        <h3 className="font-cabinet font-extrabold text-sm text-slate-900">Logs API</h3>
        <p className="text-[11px] text-slate-500">Les 100 dernières requêtes reçues sur vos endpoints /v1/*.</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            <tr><th className="text-left px-4 py-2">Méthode</th><th className="text-left px-4 py-2">Endpoint</th><th className="text-center px-4 py-2">Statut</th><th className="text-center px-4 py-2">Durée</th><th className="text-right px-4 py-2">Reçu</th></tr>
          </thead>
          <tbody>
            {items === null && <tr><td colSpan={5} className="p-6 text-center text-slate-400 text-xs">Chargement…</td></tr>}
            {items?.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-slate-400 text-xs">Aucune requête API pour le moment.</td></tr>}
            {items?.map((l) => (
              <tr key={l.id} data-testid={`log-row-${l.id}`} className="border-t border-slate-50 hover:bg-slate-50/60">
                <td className="px-4 py-2 font-mono text-[11px] font-bold text-[#2563EB]">{l.method}</td>
                <td className="px-4 py-2 font-mono text-[11px]">{l.path}</td>
                <td className="px-4 py-2 text-center">
                  <span className={`inline-flex px-1.5 py-0.5 rounded-full text-[10px] font-bold ${l.status < 400 ? 'bg-emerald-50 text-emerald-700' : l.status < 500 ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700'}`}>{l.status}</span>
                </td>
                <td className="px-4 py-2 text-center text-[11px]">{l.duration_ms} ms</td>
                <td className="px-4 py-2 text-right text-[11px] text-slate-500">{new Date(l.timestamp).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
