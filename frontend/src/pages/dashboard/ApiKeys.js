import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Copy, Trash2, RefreshCw, Power, Key, BookOpen, X, AlertTriangle, ShieldCheck, Eye, EyeOff, Code2 } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';

const API_BASE = `${process.env.REACT_APP_PUBLIC_DOMAIN || 'https://biz-transppayy.com'}/api/v1`;
const FULL_API_SCOPES = ['checkout:create', 'direct:create', 'push:create', 'payments:read'];

/* ----------------------------- shared UI bits ---------------------------- */
const Badge = ({ tone = 'slate', children }) => {
  const map = {
    green: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    slate: 'bg-slate-100 text-slate-700 border-slate-200',
    red: 'bg-red-50 text-red-700 border-red-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
  };
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold border ${map[tone]}`}>{children}</span>;
};

const CopyBtn = ({ value, label = 'Copier', testid }) => (
  <button
    data-testid={testid}
    onClick={() => { navigator.clipboard.writeText(value); toast.success('Copié'); }}
    className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition-colors">
    <Copy className="w-3 h-3" /> {label}
  </button>
);

/* --------------------------- One-time reveal modal ----------------------- */
function RevealModal({ open, onClose, secret, keyName, env }) {
  const [ack, setAck] = useState(false);
  const [show, setShow] = useState(false);
  useEffect(() => { if (!open) { setAck(false); setShow(false); } }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden" data-testid="reveal-modal">
        <div className="p-5 border-b border-slate-100 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-100 text-amber-700 flex items-center justify-center">
            <AlertTriangle className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <div className="font-cabinet font-extrabold text-slate-900">Copiez votre clé secrète maintenant</div>
            <div className="text-[12px] text-slate-500">Vous ne pourrez plus la revoir après cette fenêtre.</div>
          </div>
          <button onClick={() => { if (ack) onClose(); }} disabled={!ack} data-testid="btn-close-reveal" className="w-8 h-8 rounded-lg text-slate-400 hover:text-slate-700 disabled:opacity-30 disabled:cursor-not-allowed">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div className="text-xs text-slate-500">Clé <span className="font-semibold text-slate-800">{keyName}</span> · Environnement <Badge tone={env === 'live' ? 'green' : 'blue'}>{env}</Badge></div>
          <div className="bg-slate-950 text-emerald-300 font-mono text-[13px] p-4 rounded-xl break-all flex items-start gap-2" data-testid="reveal-secret">
            <span className="flex-1">{show ? secret : '•'.repeat(Math.max(secret.length, 40))}</span>
            <button onClick={() => setShow(v => !v)} className="text-slate-400 hover:text-white" data-testid="btn-toggle-secret">
              {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          <button
            onClick={() => { navigator.clipboard.writeText(secret); toast.success('Clé copiée'); }}
            data-testid="btn-copy-secret"
            className="w-full py-2.5 rounded-lg bg-slate-900 text-white font-semibold text-sm hover:bg-slate-800 flex items-center justify-center gap-2">
            <Copy className="w-4 h-4" /> Copier la clé secrète
          </button>
          <label className="flex items-start gap-2 text-[13px] text-slate-700 cursor-pointer">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="chk-ack" className="mt-1 accent-slate-900" />
            <span>J'ai copié la clé et je comprends qu'elle ne sera plus jamais affichée.</span>
          </label>
        </div>
        <div className="p-5 border-t border-slate-100 bg-slate-50 flex justify-end">
          <button onClick={() => ack && onClose()} disabled={!ack} data-testid="btn-done-reveal" className="px-4 py-2 rounded-lg bg-slate-900 text-white font-semibold text-sm disabled:opacity-40">Terminé</button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------- Create key modal ---------------------------- */
function CreateKeyModal({ open, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [env, setEnv] = useState('test');
  const [scopes, setScopes] = useState(FULL_API_SCOPES);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef(null);
  useEffect(() => {
    if (open) {
      setName('');
      setEnv('test');
      setScopes(FULL_API_SCOPES);
      requestAnimationFrame(() => dialogRef.current?.scrollIntoView({ block: 'center' }));
    }
  }, [open]);
  if (!open) return null;

  const submit = async () => {
    if (!name.trim()) { toast.error('Nom requis'); return; }
    setBusy(true);
    try {
      const { data } = await api.post('/merchant/keys', {
        name: name.trim(),
        env,
        scopes,
      });
      onCreated(data);
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Erreur');
    } finally { setBusy(false); }
  };

  return (
    <div className="bt-api-key-modal-overlay fixed inset-0 z-40 bg-slate-900/60 backdrop-blur-sm overflow-y-auto">
      <div ref={dialogRef} className="bt-api-key-modal-dialog min-h-full flex items-start sm:items-center justify-center p-4">
      <div className="w-full max-w-md max-h-[calc(100dvh-2rem)] bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col my-auto" data-testid="create-key-modal">
        <div className="p-5 border-b border-slate-100 flex items-center justify-between">
          <div className="font-cabinet font-extrabold text-slate-900">Créer une nouvelle clé API</div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg text-slate-400 hover:bg-slate-100"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-4 overflow-y-auto flex-1 min-h-0">
          <div>
            <label className="text-[12px] font-semibold text-slate-600">Nom de la clé</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ex: Boutique en ligne — production"
              data-testid="input-key-name"
              className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-slate-900/10 text-sm"
              autoFocus
            />
          </div>
          <div>
            <label className="text-[12px] font-semibold text-slate-600">Fonctionnalités de cette clé</label>
            <div className="mt-2 space-y-2">
              {[
                ['checkout:create', 'BizPay Checkout · PAR', 'Créer un paiement avec redirection vers la page hébergée'],
                ['direct:create', 'BizPay Direct · PSR / SoftPay', 'Déclencher un paiement Mobile Money sans redirection'],
                ['push:create', 'BizPUSH', 'Envoyer de l’argent à un bénéficiaire'],
                ['payments:read', 'Statuts et automatisation', 'Lire les statuts pour confirmer, traiter ou rejeter côté serveur'],
              ].map(([value, label, description]) => (
                <label key={value} className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 p-3 hover:border-blue-300">
                  <input
                    type="checkbox"
                    checked={scopes.includes(value)}
                    onChange={(event) => setScopes((current) => event.target.checked ? [...current, value] : current.filter((scope) => scope !== value))}
                    className="mt-0.5 accent-blue-600"
                  />
                  <span>
                    <span className="block text-sm font-semibold text-slate-900">{label}</span>
                    <span className="block text-[11px] text-slate-500">{description}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">Le suivi des statuts est intégré à la clé avec <code className="font-mono text-slate-700">payments:read</code>. Aucun webhook n’est obligatoire : votre serveur peut interroger l’API.</p>
          </div>
          <div>
            <label className="text-[12px] font-semibold text-slate-600">Environnement</label>
            <div className="mt-1 grid grid-cols-2 gap-2">
              {[{ v: 'test', l: 'Test / Sandbox', d: 'Pour vos essais d\'intégration' }, { v: 'live', l: 'Production', d: 'Charge vos clients réels' }].map(o => (
                <button
                  key={o.v}
                  data-testid={`env-${o.v}`}
                  type="button"
                  onClick={() => setEnv(o.v)}
                  className={`text-left p-3 rounded-lg border-2 transition-colors ${env === o.v ? (o.v === 'live' ? 'border-emerald-500 bg-emerald-50' : 'border-blue-500 bg-blue-50') : 'border-slate-200 hover:border-slate-300'}`}>
                  <div className="text-sm font-semibold text-slate-900">{o.l}</div>
                  <div className="text-[11px] text-slate-500 mt-0.5">{o.d}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="sticky bottom-0 p-5 border-t border-slate-100 bg-slate-50 flex justify-end gap-2 shrink-0">
          <button onClick={onClose} className="px-3 py-2 rounded-lg text-sm font-semibold text-slate-600 hover:bg-slate-100">Annuler</button>
          <button onClick={submit} disabled={busy || !name.trim() || scopes.length === 0} data-testid="btn-submit-create-key" className="px-4 py-2 rounded-lg bg-slate-900 text-white font-semibold text-sm disabled:opacity-40">
            {busy ? 'Création…' : 'Créer la clé'}
          </button>
        </div>
      </div>
      </div>
    </div>
  );
}

/* ------------------------------ Page shell ------------------------------ */
export default function ApiKeys() {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [reveal, setReveal] = useState(null); // { secret, name, env }

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/merchant/keys');
      setKeys(data.data || []);
    } catch (e) {
      toast.error('Erreur de chargement');
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const onCreated = (row) => {
    setShowCreate(false);
    setReveal({ secret: row.secret, name: row.name, env: row.env, id: row.id });
    load();
  };

  const regen = async (row) => {
    if (!window.confirm(`Régénérer la clé "${row.name}" ?\n\nL'ancienne clé cessera immédiatement de fonctionner.`)) return;
    try {
      const { data } = await api.post(`/merchant/keys/${row.id}/regenerate`);
      setReveal({ secret: data.secret, name: data.name, env: data.env, id: data.id });
      load();
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Erreur');
    }
  };

  const toggle = async (row) => {
    try {
      await api.patch(`/merchant/keys/${row.id}`, { active: !row.active });
      toast.success(row.active ? 'Clé désactivée' : 'Clé activée');
      load();
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Erreur');
    }
  };

  const remove = async (row) => {
    if (!window.confirm(`Supprimer définitivement la clé "${row.name}" ?`)) return;
    try {
      await api.delete(`/merchant/keys/${row.id}`);
      toast.success('Clé supprimée');
      load();
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Erreur');
    }
  };

  return (
    <div className="space-y-6" data-testid="page-api">
      {/* Hero */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white p-6 md:p-8">
        <div className="absolute -right-10 -top-10 w-40 h-40 bg-blue-500/10 rounded-full blur-3xl" />
        <div className="absolute -left-10 -bottom-10 w-40 h-40 bg-emerald-500/10 rounded-full blur-3xl" />
        <div className="relative flex flex-col md:flex-row md:items-start md:justify-between gap-4">
          <div className="max-w-2xl">
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-white/10 border border-white/10 text-[11px] font-semibold">
              <Code2 className="w-3 h-3" /> Biz-transPay API · v1
            </div>
            <h1 className="mt-3 font-cabinet text-2xl md:text-3xl font-extrabold">Vos clés API</h1>
            <p className="mt-2 text-sm md:text-base text-slate-300 leading-relaxed">
               Intégrez les paiements Mobile Money avec BizPay Checkout, BizPay Direct et BizPUSH
               via une API REST conçue pour les flux asynchrones.
               Utilisez vos clés <span className="text-blue-300 font-semibold">sk_test_…</span> en test, puis passez en
               <span className="text-emerald-300 font-semibold"> sk_live_…</span> en production. Les webhooks signés vous notifient automatiquement.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Link
              to="/dashboard/api/docs"
              data-testid="link-docs"
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-white/10 border border-white/15 hover:bg-white/20 text-sm font-semibold">
              <BookOpen className="w-4 h-4" /> Documentation
            </Link>
            <button
              onClick={() => setShowCreate(true)}
              data-testid="btn-create-key"
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-white text-slate-900 hover:bg-slate-100 text-sm font-semibold">
              <Plus className="w-4 h-4" /> Nouvelle clé
            </button>
          </div>
        </div>
        <div className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-3">
           <div className="p-3 rounded-xl bg-white/5 border border-white/10">
            <div className="text-[11px] text-slate-400 font-semibold">Base URL</div>
            <div className="mt-0.5 font-mono text-[12px] text-blue-200 break-all">{API_BASE}</div>
          </div>
          <div className="p-3 rounded-xl bg-white/5 border border-white/10">
            <div className="text-[11px] text-slate-400 font-semibold">Authentification</div>
            <div className="mt-0.5 font-mono text-[12px] text-blue-200">Authorization: Bearer sk_…</div>
          </div>
          <div className="p-3 rounded-xl bg-white/5 border border-white/10">
            <div className="text-[11px] text-slate-400 font-semibold">Rate limit</div>
             <div className="mt-0.5 font-mono text-[12px] text-blue-200">Webhook signé · statut async</div>
          </div>
        </div>
      </div>

      {/* Keys table */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Key className="w-4 h-4 text-slate-500" />
            <div className="font-cabinet font-bold text-slate-900">Clés API actives</div>
            <Badge tone="slate">{keys.length}</Badge>
          </div>
          <button
            onClick={() => setShowCreate(true)}
            data-testid="btn-create-key-inline"
            className="text-[12px] font-semibold text-blue-600 hover:text-blue-700 inline-flex items-center gap-1">
            <Plus className="w-3.5 h-3.5" /> Nouvelle clé
          </button>
        </div>
        {loading ? (
          <div className="p-8 text-center text-sm text-slate-500">Chargement…</div>
        ) : keys.length === 0 ? (
          <div className="p-10 text-center">
            <div className="mx-auto w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center text-slate-400 mb-3">
              <Key className="w-5 h-5" />
            </div>
            <div className="font-semibold text-slate-800">Aucune clé pour le moment</div>
            <div className="text-sm text-slate-500 mt-1">Créez votre première clé pour commencer.</div>
            <button
              onClick={() => setShowCreate(true)}
              className="mt-4 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-900 text-white text-sm font-semibold">
              <Plus className="w-4 h-4" /> Créer ma première clé
            </button>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {keys.map(k => (
              <div key={k.id} data-testid={`key-row-${k.id}`} className="p-5 flex flex-col md:flex-row md:items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="font-semibold text-slate-900">{k.name}</div>
                    <Badge tone={k.env === 'live' ? 'green' : 'blue'}>{k.env}</Badge>
                    {k.active ? <Badge tone="green"><ShieldCheck className="w-3 h-3" />active</Badge> : <Badge tone="red">désactivée</Badge>}
                  </div>
                  <div className="mt-2 flex items-center flex-wrap gap-x-4 gap-y-1 text-[12px]">
                    <div className="font-mono text-slate-700 break-all">{k.public_key}</div>
                    <CopyBtn value={k.public_key} testid={`copy-pk-${k.id}`} label="Copier clé publique" />
                  </div>
                  <div className="mt-1 flex items-center gap-x-4 flex-wrap text-[11px] text-slate-500">
                    <span>Secret: <span className="font-mono text-slate-700">{k.secret_hint}</span></span>
                    <span>Créée: {new Date(k.created_at).toLocaleDateString('fr-FR')}</span>
                    <span>Dernier usage: {k.last_used_at ? new Date(k.last_used_at).toLocaleString('fr-FR') : '—'}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {(k.scopes || []).map((scope) => <Badge key={scope} tone="slate">{scope}</Badge>)}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => toggle(k)} data-testid={`btn-toggle-${k.id}`} className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800" title={k.active ? 'Désactiver' : 'Activer'}>
                    <Power className="w-4 h-4" />
                  </button>
                  <button onClick={() => regen(k)} data-testid={`btn-regen-${k.id}`} className="p-2 rounded-lg text-slate-500 hover:bg-amber-50 hover:text-amber-700" title="Régénérer">
                    <RefreshCw className="w-4 h-4" />
                  </button>
                  <button onClick={() => remove(k)} data-testid={`btn-delete-${k.id}`} className="p-2 rounded-lg text-slate-500 hover:bg-red-50 hover:text-red-700" title="Supprimer">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Quick start */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="p-5 rounded-2xl bg-white border border-slate-200">
          <div className="text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Checkout</div>
          <div className="mt-2 font-cabinet font-bold text-slate-900">Rediriger un client</div>
          <pre className="mt-3 p-3 rounded-lg bg-slate-950 text-emerald-200 font-mono text-[11px] overflow-x-auto">
{`curl -X POST ${API_BASE}/checkout \\
  -H "Authorization: Bearer sk_test_..." \\
  -H "Idempotency-Key: cart-42-v1" \\
  -d '{ "amount": 12500, "currency": "XOF",
        "country": "TG", "operator": "tmoney_tg",
        "reference": "CMD-42" }'`}
          </pre>
        </div>
        <div className="p-5 rounded-2xl bg-white border border-slate-200">
          <div className="text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Direct & PUSH</div>
          <div className="mt-2 font-cabinet font-bold text-slate-900">Piloter vos flux Mobile Money</div>
          <pre className="mt-3 p-3 rounded-lg bg-slate-950 text-emerald-200 font-mono text-[11px] overflow-x-auto">
{`curl -X POST ${API_BASE}/direct-payments \\
  -H "Authorization: Bearer sk_test_..." \\
  -H "Idempotency-Key: payment-42-v1" \\
  -d '{ "amount": 8900, "currency": "XOF",
        "country": "TG", "operator": "tmoney_tg",
        "customer_phone": "22890000000" }'`}
          </pre>
        </div>
        <div className="p-5 rounded-2xl bg-white border border-slate-200">
          <div className="text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Suivi</div>
          <div className="mt-2 font-cabinet font-bold text-slate-900">Lire un paiement asynchrone</div>
          <pre className="mt-3 p-3 rounded-lg bg-slate-950 text-emerald-200 font-mono text-[11px] overflow-x-auto">
{`curl ${API_BASE}/payments/{id}
curl ${API_BASE}/payments/{id}/status`}
          </pre>
          <Link to="/dashboard/api/docs" data-testid="link-see-docs" className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-blue-600 hover:text-blue-700">
            Voir la documentation complète →
          </Link>
        </div>
      </div>

      <CreateKeyModal open={showCreate} onClose={() => setShowCreate(false)} onCreated={onCreated} />
      <RevealModal open={!!reveal} onClose={() => setReveal(null)} secret={reveal?.secret || ''} keyName={reveal?.name || ''} env={reveal?.env || 'test'} />
    </div>
  );
}
