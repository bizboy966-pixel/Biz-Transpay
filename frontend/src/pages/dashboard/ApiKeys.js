import { useEffect, useState, useCallback } from 'react';
import {
  Copy, RefreshCw, Save, Code2, Book, Eye, KeyRound, Webhook,
  ListChecks, Terminal, Check, X, AlertTriangle, ExternalLink,
} from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';
import { useAuth } from '@/context/AuthContext';

// --- Utilities -------------------------------------------------------------
const copy = (v) => { navigator.clipboard.writeText(v); toast.success('Copié dans le presse-papier'); };

// A modal that displays a plaintext secret ONCE — cannot be closed until
// the user acknowledges the "I have copied it" checkbox.
function OneTimeSecretModal({ title, value, hint, onClose }) {
  const [ack, setAck] = useState(false);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" data-testid="onetime-modal">
      <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-full bg-amber-50 flex items-center justify-center"><AlertTriangle className="w-4 h-4 text-amber-600" /></div>
            <h3 className="font-cabinet font-extrabold text-slate-900">{title}</h3>
          </div>
        </div>
        <div className="p-5">
          <div className="rounded-xl bg-amber-50 border border-amber-100 p-3 text-[12px] text-amber-800 leading-relaxed">
            <b>Ce secret ne sera plus jamais affiché.</b> Copiez-le maintenant et stockez-le dans un endroit sécurisé (variables d&apos;environnement, gestionnaire de secrets…). Si vous le perdez, vous devrez régénérer un nouveau.
          </div>
          {hint && <div className="mt-3 text-[11px] text-slate-500">Empreinte publique : <code className="font-mono text-slate-700">{hint}</code></div>}
          <div className="mt-3 flex items-center gap-2 p-3 rounded-xl bg-slate-900 border border-slate-800">
            <code data-testid="onetime-value" className="flex-1 font-mono text-[12px] text-emerald-300 break-all">{value}</code>
            <button onClick={() => copy(value)} data-testid="btn-copy-onetime" className="w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 flex items-center justify-center">
              <Copy className="w-4 h-4 text-slate-300" />
            </button>
          </div>
          <label className="mt-4 flex items-start gap-2 text-xs text-slate-700 cursor-pointer">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="onetime-ack" className="mt-0.5" />
            J&apos;ai copié et sécurisé ce secret. Je comprends qu&apos;il ne sera plus accessible.
          </label>
          <div className="mt-5 flex justify-end">
            <button onClick={onClose} disabled={!ack} data-testid="btn-onetime-close" className="px-5 py-2 rounded-lg bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-bold">J&apos;ai compris — fermer</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// -------------------- Page --------------------
export default function ApiKeys() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [env, setEnv] = useState('test');
  const [reveal, setReveal] = useState(null); // { title, value, hint }
  const [tab, setTab] = useState('keys');

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/api-keys');
      setData(data);
      // If backend returned a one-time reveal payload (first fetch after
      // account creation), show the modal for the TEST secret + webhook secret.
      if (data._reveal?.test_secret) {
        setReveal({ title: 'Clé secrète TEST', value: data._reveal.test_secret, hint: data.keys?.test?.secret_hint });
      }
    } catch (e) { toast.error(e?.response?.data?.detail || 'Erreur de chargement'); }
  }, []);

  useEffect(() => { if (user?.account_type === 'merchant') load(); }, [user, load]);

  if (user?.account_type !== 'merchant') {
    return (
      <div className="bg-white border border-slate-100 rounded-[24px] p-10 text-center">
        <Code2 className="w-10 h-10 text-slate-300 mx-auto" />
        <p className="mt-4 text-slate-600">Réservé aux comptes marchands.</p>
      </div>
    );
  }

  const envKey = data?.keys?.[env];

  const regen = async () => {
    if (!window.confirm(`Régénérer les clés ${env.toUpperCase()} ? Les anciennes seront invalidées immédiatement.`)) return;
    try {
      const { data: r } = await api.post('/api-keys/regenerate', { env });
      toast.success(`Clés ${env.toUpperCase()} régénérées`);
      setReveal({ title: `Nouvelle clé secrète ${env.toUpperCase()}`, value: r.secret_key, hint: r.secret_hint });
      load();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Erreur'); }
  };

  const regenWhSecret = async () => {
    if (!window.confirm('Régénérer le secret webhook ? Tous vos webhooks existants ne pourront plus être vérifiés avec l\'ancien secret.')) return;
    try {
      const { data: r } = await api.post('/api-keys/webhook/regenerate-secret');
      setReveal({ title: 'Nouveau webhook secret', value: r.webhook_secret, hint: r.secret_hint });
      toast.success('Webhook secret régénéré');
      load();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Erreur'); }
  };

  return (
    <div className="space-y-5" data-testid="page-api">
      {reveal && <OneTimeSecretModal {...reveal} onClose={() => setReveal(null)} />}

      <div>
        <h1 className="font-cabinet text-3xl font-extrabold tracking-tighter text-slate-900">API de paiement</h1>
        <p className="text-slate-500 text-sm mt-1">Intégrez Biz-transPay dans votre application avec nos clés API et webhooks HMAC-signés.</p>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-slate-200">
        <TabBtn active={tab === 'keys'} onClick={() => setTab('keys')} I={KeyRound} label="Clés API" testId="tab-keys" />
        <TabBtn active={tab === 'webhook'} onClick={() => setTab('webhook')} I={Webhook} label="Webhooks" testId="tab-webhook" />
        <TabBtn active={tab === 'deliveries'} onClick={() => setTab('deliveries')} I={ListChecks} label="Livraisons" testId="tab-deliveries" />
        <TabBtn active={tab === 'logs'} onClick={() => setTab('logs')} I={Terminal} label="Logs API" testId="tab-logs" />
      </div>

      {tab === 'keys' && data && (
        <div className="bg-white border border-slate-100 rounded-2xl p-5 sm:p-6 space-y-4">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-slate-500">Environnement :</span>
            {['test', 'live'].map((e) => (
              <button
                key={e}
                onClick={() => setEnv(e)}
                data-testid={`env-${e}`}
                className={`px-3 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-widest transition-colors ${env === e ? (e === 'live' ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-emerald-50 text-emerald-700 border border-emerald-200') : 'bg-slate-50 text-slate-500 border border-transparent hover:bg-slate-100'}`}
              >
                {e}
              </button>
            ))}
          </div>

          {!envKey && env === 'live' ? (
            <div className="rounded-xl bg-slate-50 p-6 text-center">
              <p className="text-sm text-slate-600 mb-3">Aucune clé <b>LIVE</b> générée pour ce compte.</p>
              <button onClick={regen} data-testid="btn-generate-live" className="inline-flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg text-xs font-bold">
                <KeyRound className="w-3.5 h-3.5" /> Générer les clés LIVE
              </button>
            </div>
          ) : envKey && (
            <>
              <KeyRow label="Clé publique" value={envKey.public_key} copyable dataId="public-key" />
              <KeyRow label="Clé secrète" value={envKey.secret_hint} copyable={false} secretMask dataId="secret-key" hint="Non affichée pour raisons de sécurité. Régénérez-la pour en obtenir une nouvelle." />
              <div className="flex items-center justify-between pt-1 text-[11px] text-slate-500">
                <span>Créé : {new Date(envKey.created_at).toLocaleString()}</span>
                <span>Dernière utilisation : {envKey.last_used_at ? new Date(envKey.last_used_at).toLocaleString() : 'jamais'}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-2">
                <button onClick={regen} data-testid={`btn-regen-${env}`} className="inline-flex items-center gap-2 bg-red-50 text-red-600 hover:bg-red-100 px-3.5 py-2 rounded-lg text-xs font-bold">
                  <RefreshCw className="w-3.5 h-3.5" /> Régénérer {env.toUpperCase()}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'webhook' && data && (
        <WebhookTab webhook={data.webhook} onSaved={load} onRegenSecret={regenWhSecret} />
      )}

      {tab === 'deliveries' && <DeliveriesTab />}
      {tab === 'logs' && <LogsTab />}
    </div>
  );
}

function TabBtn({ active, onClick, I, label, testId }) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className={`inline-flex items-center gap-1.5 px-3 py-2 -mb-px text-xs font-semibold border-b-2 transition-colors ${active ? 'border-[#2563EB] text-[#2563EB]' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
    >
      <I className="w-3.5 h-3.5" /> {label}
    </button>
  );
}

function KeyRow({ label, value, copyable, secretMask, hint, dataId }) {
  return (
    <div>
      <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1.5 block">{label}</label>
      <div className="flex items-center gap-2 bg-slate-50 rounded-xl p-2.5">
        <code data-testid={dataId} className={`flex-1 font-mono text-xs sm:text-sm break-all ${secretMask ? 'text-slate-500' : 'text-slate-800'}`}>{value || '—'}</code>
        {copyable && <button onClick={() => copy(value)} data-testid={`btn-copy-${dataId}`} className="w-8 h-8 rounded-lg bg-white hover:bg-blue-50 flex items-center justify-center"><Copy className="w-3.5 h-3.5 text-slate-600" /></button>}
      </div>
      {hint && <div className="mt-1 text-[10px] text-slate-500">{hint}</div>}
    </div>
  );
}

function WebhookTab({ webhook, onSaved, onRegenSecret }) {
  const [url, setUrl] = useState(webhook?.url || '');
  const [saving, setSaving] = useState(false);
  useEffect(() => { setUrl(webhook?.url || ''); }, [webhook]);
  const save = async () => {
    setSaving(true);
    try {
      await api.patch('/api-keys/webhook', { url });
      toast.success('URL webhook enregistrée');
      onSaved();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Erreur'); }
    finally { setSaving(false); }
  };
  return (
    <div className="bg-white border border-slate-100 rounded-2xl p-5 sm:p-6 space-y-4">
      <div>
        <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1.5 block">URL webhook</label>
        <div className="flex flex-col sm:flex-row gap-2">
          <input value={url} onChange={(e) => setUrl(e.target.value)} data-testid="webhook-url" placeholder="https://votre-site.com/webhooks/biztranspay" className="flex-1 px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-xs sm:text-sm" />
          <button onClick={save} disabled={saving} data-testid="btn-save-webhook" className="bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold px-4 py-2.5 rounded-xl text-xs inline-flex items-center justify-center gap-1.5"><Save className="w-3.5 h-3.5" />{saving ? 'Enregistrement…' : 'Enregistrer'}</button>
        </div>
        <div className="mt-1.5 text-[11px] text-slate-500">Nous enverrons les événements à cette URL avec un header <code className="font-mono">X-BizTransPay-Signature</code> pour vérification HMAC.</div>
      </div>

      <KeyRow label="Secret webhook (signature HMAC)" value={webhook?.secret_hint} secretMask hint="Utilisez ce secret côté serveur pour vérifier X-BizTransPay-Signature. Régénérez-le si compromis." dataId="webhook-secret" />
      <button onClick={onRegenSecret} data-testid="btn-regen-whsecret" className="inline-flex items-center gap-2 bg-red-50 text-red-600 hover:bg-red-100 px-3.5 py-2 rounded-lg text-xs font-bold"><RefreshCw className="w-3.5 h-3.5" /> Régénérer le secret webhook</button>

      <div>
        <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1.5 block">Événements envoyés</label>
        <div className="flex flex-wrap gap-1.5">
          {(webhook?.events || []).map((e) => (
            <span key={e} data-testid={`event-${e}`} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-50 text-[#2563EB] text-[10px] font-mono font-semibold">
              <Check className="w-3 h-3" /> {e}
            </span>
          ))}
        </div>
      </div>

      <div className="rounded-xl bg-slate-50 p-3.5 text-[11px] text-slate-600 leading-relaxed border border-slate-100">
        <b className="text-slate-900">Comment vérifier la signature ?</b>
        <pre className="mt-1.5 text-[10px] overflow-x-auto"><code>{`// Node.js
const crypto = require('crypto');
const raw = req.rawBody; // Buffer or string
const timestamp = req.headers['x-biztranspay-timestamp'];
const signature = req.headers['x-biztranspay-signature'];

const expected = 'sha256=' + crypto
  .createHmac('sha256', YOUR_WEBHOOK_SECRET_HASH)
  .update(\`\${timestamp}.\${raw}\`)
  .digest('hex');

if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
  return res.status(401).send('Invalid signature');
}`}</code></pre>
      </div>
    </div>
  );
}

function DeliveriesTab() {
  const [items, setItems] = useState(null);
  useEffect(() => { api.get('/api-keys/webhook/deliveries').then(({ data }) => setItems(data)).catch(() => setItems([])); }, []);
  return (
    <div className="bg-white border border-slate-100 rounded-2xl overflow-hidden">
      <div className="p-4 border-b border-slate-100 flex items-center justify-between">
        <div>
          <h3 className="font-cabinet font-extrabold text-sm text-slate-900">Livraisons webhook</h3>
          <p className="text-[11px] text-slate-500">Les 50 dernières tentatives de livraison, avec code HTTP et corps de réponse.</p>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            <tr>
              <th className="text-left px-4 py-2">Événement</th>
              <th className="text-left px-4 py-2">URL</th>
              <th className="text-center px-4 py-2">Statut</th>
              <th className="text-center px-4 py-2">Tentatives</th>
              <th className="text-right px-4 py-2">Envoyé</th>
            </tr>
          </thead>
          <tbody>
            {items === null && <tr><td colSpan={5} className="p-6 text-center text-slate-400 text-xs">Chargement…</td></tr>}
            {items?.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-slate-400 text-xs">Aucune livraison pour le moment.</td></tr>}
            {items?.map((d) => (
              <tr key={d.id} data-testid={`delivery-row-${d.id}`} className="border-t border-slate-50 hover:bg-slate-50/60">
                <td className="px-4 py-2 font-mono text-[11px]">{d.event_type}</td>
                <td className="px-4 py-2 text-[11px] truncate max-w-[240px]" title={d.url}>{d.url}</td>
                <td className="px-4 py-2 text-center">
                  {d.status === 'delivered' ? (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[10px] font-bold"><Check className="w-3 h-3" /> {d.status_code || 200}</span>
                  ) : d.status === 'failed' ? (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-red-50 text-red-700 text-[10px] font-bold"><X className="w-3 h-3" /> {d.status_code || 'error'}</span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 text-[10px] font-bold">pending</span>
                  )}
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
            <tr>
              <th className="text-left px-4 py-2">Méthode</th>
              <th className="text-left px-4 py-2">Endpoint</th>
              <th className="text-center px-4 py-2">Statut</th>
              <th className="text-center px-4 py-2">Durée</th>
              <th className="text-right px-4 py-2">Reçu</th>
            </tr>
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
