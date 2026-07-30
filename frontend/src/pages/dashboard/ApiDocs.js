import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  Copy, ArrowLeft, Code2, ShieldCheck, Zap, Webhook, ListChecks,
  AlertCircle, Book, Download, Terminal, KeyRound, Radio, PlayCircle,
  RotateCw, ChevronRight, CheckCircle2, Clock, XCircle, ArrowRight,
} from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';

// Always show the OFFICIAL public domain in curl/SDK examples — never the
// preview host. Overridable at build time via REACT_APP_PUBLIC_DOMAIN.
const OFFICIAL = process.env.REACT_APP_PUBLIC_DOMAIN || 'https://biz-transppayy.com';
const API_BASE = OFFICIAL.replace(/\/$/, '') + '/api';

// ------------------------- SECTIONS -------------------------
const SECTIONS = [
  { id: 'overview', label: 'Vue d\u2019ensemble', icon: Book },
  { id: 'base-url', label: 'Base URL & environnements', icon: Terminal },
  { id: 'auth', label: 'Authentification', icon: KeyRound },
  { id: 'headers', label: 'Headers communs', icon: ListChecks },
  { id: 'idempotency', label: 'Idempotency-Key', icon: RotateCw },
  { id: 'ratelimit', label: 'Rate limits', icon: Zap },
  { id: 'errors', label: 'Format d\u2019erreur & codes', icon: AlertCircle },
  { id: 'lifecycle', label: 'Cycle de vie d\u2019un paiement', icon: ChevronRight },
  { id: 'create-payment', label: 'Créer un paiement', icon: Code2 },
  { id: 'retrieve-payment', label: 'Récupérer / lister', icon: Radio },
  { id: 'webhooks', label: 'Webhooks & signature', icon: Webhook },
  { id: 'health', label: 'Health check', icon: ShieldCheck },
  { id: 'playground', label: 'Playground (Try it)', icon: PlayCircle },
];

// ------------------------- CODE SNIPPETS -------------------------
const CREATE_SNIPPETS = {
  curl: `curl -X POST ${API_BASE}/v1/payments \\
  -H "Authorization: Bearer sk_test_XXXXX" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order-123-attempt-1" \\
  -d '{
    "amount": 10.00,
    "coin": "USDT",
    "reference": "order_123",
    "customer_email": "buyer@shop.com",
    "accepted_networks": ["TRC20", "BEP20", "ERC20"],
    "return_url": "https://myshop.com/orders/123/done"
  }'`,
  node: `import fetch from 'node-fetch';

const res = await fetch('${API_BASE}/v1/payments', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + process.env.BIZTRANSPAY_KEY,
    'Content-Type': 'application/json',
    'Idempotency-Key': 'order-123-attempt-1',
  },
  body: JSON.stringify({
    amount: 10.00,
    coin: 'USDT',
    reference: 'order_123',
    customer_email: 'buyer@shop.com',
    return_url: 'https://myshop.com/orders/123/done',
  }),
});

const payment = await res.json();
if (!res.ok) throw new Error(payment.message);
console.log(payment.payment_url); // Redirect the customer here`,
  python: `import os, requests

r = requests.post(
    '${API_BASE}/v1/payments',
    headers={
        'Authorization': f"Bearer {os.environ['BIZTRANSPAY_KEY']}",
        'Content-Type': 'application/json',
        'Idempotency-Key': 'order-123-attempt-1',
    },
    json={
        'amount': 10.00,
        'coin': 'USDT',
        'reference': 'order_123',
        'customer_email': 'buyer@shop.com',
        'return_url': 'https://myshop.com/orders/123/done',
    },
    timeout=15,
)
payment = r.json()
r.raise_for_status()
print(payment['payment_url'])`,
  php: `<?php
$ch = curl_init('${API_BASE}/v1/payments');
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => [
        'Authorization: Bearer ' . getenv('BIZTRANSPAY_KEY'),
        'Content-Type: application/json',
        'Idempotency-Key: order-123-attempt-1',
    ],
    CURLOPT_POSTFIELDS => json_encode([
        'amount' => 10.00,
        'coin' => 'USDT',
        'reference' => 'order_123',
        'customer_email' => 'buyer@shop.com',
        'return_url' => 'https://myshop.com/orders/123/done',
    ]),
]);
$response = json_decode(curl_exec($ch), true);
$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
if ($status !== 200) throw new Exception($response['message']);
header('Location: ' . $response['payment_url']);`,
  laravel: `use Illuminate\\Support\\Facades\\Http;

$payment = Http::withHeaders([
    'Authorization' => 'Bearer ' . config('services.biztranspay.key'),
    'Idempotency-Key' => 'order-' . $order->id . '-attempt-1',
])->post('${API_BASE}/v1/payments', [
    'amount' => $order->total,
    'coin' => 'USDT',
    'reference' => (string) $order->id,
    'customer_email' => $order->customer->email,
    'return_url' => route('orders.done', $order),
])->throw()->json();

return redirect($payment['payment_url']);`,
};

const WEBHOOK_VERIFY = {
  node: `import crypto from 'crypto';

function verifyBizTransPay(rawBody, signature, timestamp, secret) {
  const signed = timestamp + '.' + rawBody;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signed)
    .digest('hex');
  const provided = signature.replace('sha256=', '');
  return crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(provided, 'hex')
  );
}

// Express handler
app.post('/webhooks/biztranspay',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const sig = req.headers['x-biztranspay-signature'];
    const ts  = req.headers['x-biztranspay-timestamp'];
    if (!verifyBizTransPay(req.body, sig, ts, process.env.WEBHOOK_SECRET)) {
      return res.status(401).send('invalid signature');
    }
    const event = JSON.parse(req.body);
    // ... process event by type
    res.json({ received: true });
  }
);`,
  python: `import hmac, hashlib

def verify_biztranspay(raw_body: bytes, signature: str, timestamp: str,
                       secret: str) -> bool:
    signed = f"{timestamp}.{raw_body.decode()}".encode()
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    provided = signature.replace("sha256=", "")
    return hmac.compare_digest(expected, provided)

# Flask
@app.route("/webhooks/biztranspay", methods=["POST"])
def biztranspay_webhook():
    if not verify_biztranspay(
        request.get_data(),
        request.headers.get("X-BizTransPay-Signature", ""),
        request.headers.get("X-BizTransPay-Timestamp", ""),
        os.environ["WEBHOOK_SECRET"],
    ):
        abort(401)
    event = request.get_json()
    # ... process event
    return {"received": True}`,
  php: `<?php
function verifyBizTransPay($rawBody, $signature, $timestamp, $secret) {
    $signed = $timestamp . '.' . $rawBody;
    $expected = hash_hmac('sha256', $signed, $secret);
    $provided = str_replace('sha256=', '', $signature);
    return hash_equals($expected, $provided);
}

$rawBody = file_get_contents('php://input');
$sig = $_SERVER['HTTP_X_BIZTRANSPAY_SIGNATURE'] ?? '';
$ts  = $_SERVER['HTTP_X_BIZTRANSPAY_TIMESTAMP'] ?? '';
if (!verifyBizTransPay($rawBody, $sig, $ts, getenv('WEBHOOK_SECRET'))) {
    http_response_code(401); exit('invalid signature');
}
$event = json_decode($rawBody, true);
// ... process event
echo json_encode(['received' => true]);`,
};

// ------------------------- SMALL COMPONENTS -------------------------
function CodeBlock({ code, lang = 'bash' }) {
  return (
    <div className="relative group rounded-xl overflow-hidden bg-slate-950 border border-slate-800">
      <button
        onClick={() => { navigator.clipboard.writeText(code); toast.success('Code copié'); }}
        className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 md:opacity-100 transition-opacity bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10px] font-bold px-2 py-1 rounded flex items-center gap-1"
      >
        <Copy className="w-3 h-3" /> Copier
      </button>
      <pre className="text-[12px] leading-relaxed p-4 pr-16 text-slate-100 overflow-x-auto font-mono">{code}</pre>
      <div className="absolute left-0 top-0 text-[9px] font-bold uppercase tracking-widest text-slate-500 px-3 py-1.5 bg-slate-900 border-r border-b border-slate-800 rounded-br-md">
        {lang}
      </div>
    </div>
  );
}

function LangTabs({ snippets }) {
  const langs = Object.keys(snippets);
  const [active, setActive] = useState(langs[0]);
  return (
    <div>
      <div className="flex gap-1 mb-2 flex-wrap">
        {langs.map((l) => (
          <button key={l} onClick={() => setActive(l)}
            className={`text-[11px] font-bold px-2.5 py-1 rounded-md transition-colors ${active === l ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
            {l.toUpperCase()}
          </button>
        ))}
      </div>
      <CodeBlock code={snippets[active]} lang={active} />
    </div>
  );
}

function InlineCode({ children }) {
  return <code className="px-1.5 py-0.5 bg-slate-100 text-slate-800 rounded text-[12px] font-mono">{children}</code>;
}

function SectionTitle({ id, children }) {
  return (
    <h2 id={id} className="scroll-mt-24 font-cabinet font-extrabold text-slate-900 text-2xl mt-10 mb-3 flex items-center gap-2">
      {children}
    </h2>
  );
}

function InfoBox({ tone = 'blue', children }) {
  const tones = {
    blue: 'bg-blue-50 border-blue-200 text-blue-900',
    amber: 'bg-amber-50 border-amber-200 text-amber-900',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-900',
    red: 'bg-red-50 border-red-200 text-red-900',
    slate: 'bg-slate-50 border-slate-200 text-slate-800',
  };
  return (
    <div className={`rounded-xl border-l-4 border p-3 text-[13px] leading-relaxed ${tones[tone]}`}>
      {children}
    </div>
  );
}

// ------------------------- PLAYGROUND -------------------------
function Playground() {
  const [method, setMethod] = useState('GET');
  const [path, setPath] = useState('/v1/health');
  const [body, setBody] = useState('');
  const [idem, setIdem] = useState('');
  const [running, setRunning] = useState(false);
  const [resp, setResp] = useState(null);

  const runIt = async () => {
    setRunning(true);
    setResp(null);
    let parsedBody = null;
    if (body.trim() && (method === 'POST' || method === 'PUT')) {
      try {
        parsedBody = JSON.parse(body);
      } catch {
        toast.error('Body invalide (JSON attendu)');
        setRunning(false);
        return;
      }
    }
    try {
      const { data } = await api.post('/api-keys/playground', {
        method,
        path,
        body: parsedBody,
        idempotency_key: idem.trim() || undefined,
      });
      setResp(data);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Erreur');
    } finally {
      setRunning(false);
    }
  };

  const presets = [
    { name: 'Health check', m: 'GET', p: '/v1/health', b: '' },
    { name: 'Lister paiements', m: 'GET', p: '/v1/payments', b: '' },
    { name: 'Créer paiement (25 USDT)', m: 'POST', p: '/v1/payments',
      b: JSON.stringify({ amount: 25, coin: 'USDT', reference: 'order_demo_' + Date.now(), customer_email: 'demo@example.com', accepted_networks: ['TRC20', 'BEP20', 'ERC20'] }, null, 2) },
    { name: 'Erreur — montant trop petit', m: 'POST', p: '/v1/payments',
      b: JSON.stringify({ amount: 0.5, coin: 'USDT' }, null, 2) },
  ];

  const statusColor = resp?.status_code >= 500 ? 'text-red-700 bg-red-50 border-red-200'
    : resp?.status_code >= 400 ? 'text-amber-800 bg-amber-50 border-amber-200'
    : resp?.status_code >= 300 ? 'text-blue-700 bg-blue-50 border-blue-200'
    : 'text-emerald-700 bg-emerald-50 border-emerald-200';

  return (
    <div className="rounded-2xl border-2 border-slate-900 bg-white overflow-hidden" data-testid="api-playground">
      <div className="bg-slate-900 text-white px-4 py-2.5 flex items-center gap-2">
        <PlayCircle className="w-4 h-4 text-emerald-400" />
        <span className="font-bold text-sm">Playground</span>
        <span className="text-[10px] text-slate-400 ml-2">Exécute des appels réels avec votre clé test</span>
      </div>

      <div className="p-4 space-y-3">
        {/* Presets */}
        <div className="flex flex-wrap gap-1.5">
          {presets.map((p) => (
            <button key={p.name} onClick={() => { setMethod(p.m); setPath(p.p); setBody(p.b); setIdem(''); }}
              className="text-[11px] font-semibold px-2.5 py-1 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors"
              data-testid={`playground-preset-${p.name.replace(/\s+/g, '-').toLowerCase()}`}>
              {p.name}
            </button>
          ))}
        </div>

        {/* Method + path */}
        <div className="flex gap-2">
          <select value={method} onChange={(e) => setMethod(e.target.value)} data-testid="playground-method"
            className="px-3 py-2 border border-slate-200 rounded-lg text-xs font-bold bg-white">
            <option>GET</option>
            <option>POST</option>
            <option>PUT</option>
            <option>DELETE</option>
          </select>
          <input value={path} onChange={(e) => setPath(e.target.value)} data-testid="playground-path"
            placeholder="/v1/payments"
            className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-xs font-mono focus:border-[#2563EB] outline-none" />
          <button onClick={runIt} disabled={running} data-testid="playground-run"
            className="inline-flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold px-4 py-2 rounded-lg disabled:opacity-50">
            {running ? <RotateCw className="w-3.5 h-3.5 animate-spin" /> : <PlayCircle className="w-3.5 h-3.5" />}
            {running ? 'En cours…' : 'Exécuter'}
          </button>
        </div>

        {/* Body */}
        {(method === 'POST' || method === 'PUT') && (
          <div>
            <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1 block">Body JSON</label>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} data-testid="playground-body"
              placeholder='{ "amount": 10, "coin": "USDT" }'
              rows={6}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-[12px] font-mono focus:border-[#2563EB] outline-none" />
          </div>
        )}

        {/* Idempotency-Key */}
        {method === 'POST' && (
          <div>
            <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1 block flex items-center gap-1">
              <RotateCw className="w-3 h-3" /> Idempotency-Key (optionnel)
            </label>
            <input value={idem} onChange={(e) => setIdem(e.target.value)} data-testid="playground-idem"
              placeholder="ex: order-42-attempt-1"
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-[12px] font-mono focus:border-[#2563EB] outline-none" />
          </div>
        )}

        {/* Response */}
        {resp && (
          <div className="mt-3 space-y-2" data-testid="playground-response">
            <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border font-bold text-xs ${statusColor}`}>
              HTTP {resp.status_code}
              <span className="text-slate-500 font-normal">·</span>
              <span className="text-slate-600 font-normal">{resp.duration_ms} ms</span>
            </div>
            {Object.keys(resp.headers || {}).length > 0 && (
              <details className="text-[11px] bg-slate-50 rounded-lg border border-slate-200 p-2.5">
                <summary className="font-bold text-slate-700 cursor-pointer">Response headers ({Object.keys(resp.headers).length})</summary>
                <div className="mt-2 space-y-0.5 font-mono">
                  {Object.entries(resp.headers).map(([k, v]) => (
                    <div key={k} className="flex gap-2"><span className="text-slate-500">{k}:</span><span className="text-slate-900">{v}</span></div>
                  ))}
                </div>
              </details>
            )}
            <CodeBlock code={JSON.stringify(resp.body, null, 2)} lang="response" />
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------- MAIN PAGE -------------------------
export default function ApiDocs() {
  const [activeSection, setActiveSection] = useState('overview');
  const [downloading, setDownloading] = useState(false);

  // Scroll spy — highlight the current section in the sidebar.
  useEffect(() => {
    const observers = SECTIONS.map((s) => {
      const el = document.getElementById(s.id);
      if (!el) return null;
      const obs = new IntersectionObserver(([entry]) => {
        if (entry.isIntersecting) setActiveSection(s.id);
      }, { rootMargin: '-30% 0px -60% 0px' });
      obs.observe(el);
      return obs;
    }).filter(Boolean);
    return () => observers.forEach((o) => o.disconnect());
  }, []);

  const downloadPdf = async () => {
    setDownloading(true);
    try {
      const res = await api.get('/api-keys/documentation.pdf', { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'biz-transpay-api-docs.pdf';
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Documentation téléchargée');
    } catch { toast.error('Erreur téléchargement'); }
    finally { setDownloading(false); }
  };

  return (
    <div className="min-h-screen bg-white" data-testid="api-docs-page">
      {/* Header */}
      <div className="border-b border-slate-100 bg-white sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <Link to="/dashboard/api" className="inline-flex items-center gap-2 text-xs font-bold text-slate-600 hover:text-slate-900">
            <ArrowLeft className="w-3.5 h-3.5" /> Retour au module API
          </Link>
          <button onClick={downloadPdf} disabled={downloading} data-testid="btn-download-pdf"
            className="inline-flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold px-3.5 py-1.5 rounded-full disabled:opacity-60">
            <Download className="w-3.5 h-3.5" /> {downloading ? 'Génération…' : 'Télécharger PDF'}
          </button>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-6 grid grid-cols-1 lg:grid-cols-[240px_1fr] gap-8">
        {/* Sidebar nav */}
        <aside className="hidden lg:block sticky top-16 h-[calc(100vh-5rem)] overflow-y-auto">
          <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2 px-2">API Reference</div>
          <nav className="space-y-0.5">
            {SECTIONS.map((s) => {
              const Icon = s.icon;
              const active = activeSection === s.id;
              return (
                <a key={s.id} href={`#${s.id}`} onClick={() => setActiveSection(s.id)}
                  className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12px] font-semibold transition-colors ${active ? 'bg-blue-50 text-[#2563EB]' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}>
                  <Icon className="w-3.5 h-3.5 shrink-0" strokeWidth={2} />
                  <span>{s.label}</span>
                </a>
              );
            })}
          </nav>
        </aside>

        {/* Content */}
        <main className="min-w-0 max-w-3xl">
          {/* Overview */}
          <section id="overview" className="scroll-mt-24">
            <div className="text-[11px] font-bold uppercase tracking-widest text-[#2563EB] mb-2">API Documentation · v1.0</div>
            <h1 className="font-cabinet font-extrabold text-slate-900 text-4xl leading-tight">Biz-transPay API</h1>
            <p className="text-slate-600 mt-3 text-base leading-relaxed">
              Encaissez des paiements crypto (USDT, BTC, ETH…) et soyez reversé automatiquement dans votre portefeuille Biz-transPay.
              L'API est REST/JSON, protégée par clés Bearer, et respecte les conventions modernes (Idempotency-Key, HMAC webhooks, codes d'erreur machine).
            </p>
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-2">
              <a href="#playground" className="p-3 rounded-xl border border-slate-200 hover:border-emerald-400 hover:bg-emerald-50/40 transition-colors">
                <PlayCircle className="w-4 h-4 text-emerald-600 mb-1.5" />
                <div className="font-bold text-xs text-slate-900">Try it live</div>
                <div className="text-[11px] text-slate-500">Testez avec votre clé test</div>
              </a>
              <a href="#create-payment" className="p-3 rounded-xl border border-slate-200 hover:border-blue-400 hover:bg-blue-50/40 transition-colors">
                <Code2 className="w-4 h-4 text-blue-600 mb-1.5" />
                <div className="font-bold text-xs text-slate-900">Créer un paiement</div>
                <div className="text-[11px] text-slate-500">5 langages disponibles</div>
              </a>
              <a href="#webhooks" className="p-3 rounded-xl border border-slate-200 hover:border-violet-400 hover:bg-violet-50/40 transition-colors">
                <Webhook className="w-4 h-4 text-violet-600 mb-1.5" />
                <div className="font-bold text-xs text-slate-900">Webhooks HMAC</div>
                <div className="text-[11px] text-slate-500">6 événements signés</div>
              </a>
            </div>
          </section>

          {/* Base URL */}
          <SectionTitle id="base-url">Base URL &amp; environnements</SectionTitle>
          <p className="text-slate-600 text-[13px] leading-relaxed">
            Deux environnements disponibles ; la même clé fonctionne dans les deux avec un préfixe distinct.
          </p>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="p-4 rounded-xl border border-slate-200">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Production</div>
              <div className="font-mono text-sm text-slate-900 font-bold">{API_BASE}/v1/</div>
              <div className="text-[11px] text-slate-500 mt-1">Clés préfixées <InlineCode>sk_live_…</InlineCode></div>
            </div>
            <div className="p-4 rounded-xl border border-slate-200">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Test / Sandbox</div>
              <div className="font-mono text-sm text-slate-900 font-bold">{API_BASE}/v1/</div>
              <div className="text-[11px] text-slate-500 mt-1">Clés préfixées <InlineCode>sk_test_…</InlineCode></div>
            </div>
          </div>

          {/* Authentication */}
          <SectionTitle id="auth">Authentification</SectionTitle>
          <p className="text-slate-600 text-[13px] leading-relaxed">
            Chaque appel doit inclure le header <InlineCode>Authorization: Bearer sk_test_… (ou sk_live_…)</InlineCode>.
            La clé secrète n'est révélée <b>qu'une seule fois</b>, au moment de la génération dans le dashboard : copiez-la immédiatement.
            En cas de perte, régénérez-la depuis <Link to="/dashboard/api" className="text-[#2563EB] hover:underline">le module API</Link>.
          </p>
          <div className="mt-3">
            <CodeBlock lang="bash" code={`Authorization: Bearer sk_test_51Kz9…`} />
          </div>
          <InfoBox tone="amber">
            <b>⚠️ Ne jamais</b> exposer la clé secrète côté navigateur, dans un dépôt public ou dans un email. Utilisez toujours une variable d'environnement.
          </InfoBox>

          {/* Headers */}
          <SectionTitle id="headers">Headers communs</SectionTitle>
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full text-[12px]">
              <thead className="bg-slate-50 text-left">
                <tr>
                  <th className="p-2.5 font-bold text-slate-700">Header</th>
                  <th className="p-2.5 font-bold text-slate-700">Sens</th>
                  <th className="p-2.5 font-bold text-slate-700">Quand</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-mono">
                <tr><td className="p-2.5">Authorization: Bearer sk_…</td><td className="p-2.5 font-sans">Clé API</td><td className="p-2.5 font-sans">Toutes routes (sauf <InlineCode>/v1/health</InlineCode>)</td></tr>
                <tr><td className="p-2.5">Idempotency-Key: &lt;string&gt;</td><td className="p-2.5 font-sans">Anti-doublon</td><td className="p-2.5 font-sans">POST création (optionnel, TTL 24h)</td></tr>
                <tr><td className="p-2.5">X-RateLimit-Limit</td><td className="p-2.5 font-sans">Quota /min</td><td className="p-2.5 font-sans">Réponse (informatif)</td></tr>
                <tr><td className="p-2.5">X-RateLimit-Remaining</td><td className="p-2.5 font-sans">Reste dispo</td><td className="p-2.5 font-sans">Réponse</td></tr>
                <tr><td className="p-2.5">X-RateLimit-Reset</td><td className="p-2.5 font-sans">UNIX ts reset</td><td className="p-2.5 font-sans">Réponse</td></tr>
              </tbody>
            </table>
          </div>

          {/* Idempotency */}
          <SectionTitle id="idempotency">Idempotency-Key</SectionTitle>
          <p className="text-slate-600 text-[13px] leading-relaxed">
            Pour éviter les doublons en cas de reprise réseau ou de retry client, incluez un header <InlineCode>Idempotency-Key</InlineCode> arbitraire (jusqu'à 255 caractères) sur vos POST.
            Un second appel avec la <b>même clé</b> renvoie la <b>même réponse</b> sans créer de deuxième paiement (TTL 24h).
          </p>
          <div className="mt-3">
            <CodeBlock lang="bash" code={`# Premier appel — crée le paiement
curl -X POST ${API_BASE}/v1/payments \\
  -H "Authorization: Bearer sk_test_XXX" \\
  -H "Idempotency-Key: order-42-attempt-1" \\
  -d '{"amount": 25, "coin": "USDT"}'
# → { "id": "abc123", "status": "initiated", ... }

# Retry avec la MÊME Idempotency-Key — retourne le même paiement
curl -X POST ${API_BASE}/v1/payments \\
  -H "Authorization: Bearer sk_test_XXX" \\
  -H "Idempotency-Key: order-42-attempt-1" \\
  -d '{"amount": 25, "coin": "USDT"}'
# → { "id": "abc123", "status": "initiated", ... }  (identique)`} />
          </div>

          {/* Rate limits */}
          <SectionTitle id="ratelimit">Rate limits</SectionTitle>
          <p className="text-slate-600 text-[13px] leading-relaxed">
            Chaque clé peut effectuer <b>100 appels par minute</b> (sliding window). Les headers <InlineCode>X-RateLimit-*</InlineCode> apparaissent sur chaque réponse.
            En cas de dépassement, la réponse est <InlineCode>429 RATE_LIMITED</InlineCode> avec un header <InlineCode>Retry-After</InlineCode>.
          </p>

          {/* Errors */}
          <SectionTitle id="errors">Format d'erreur &amp; codes</SectionTitle>
          <p className="text-slate-600 text-[13px] leading-relaxed">Toute erreur suit ce format normalisé :</p>
          <div className="mt-3">
            <CodeBlock lang="json" code={`{
  "statusCode": 400,
  "message": "Minimum amount: 1 USDT",
  "code": "AMOUNT_TOO_SMALL"
}`} />
          </div>
          <p className="text-slate-600 text-[13px] leading-relaxed mt-3">Codes machine émis :</p>
          <div className="overflow-x-auto rounded-xl border border-slate-200 mt-2">
            <table className="w-full text-[12px]">
              <thead className="bg-slate-50 text-left">
                <tr>
                  <th className="p-2.5 font-bold text-slate-700">HTTP</th>
                  <th className="p-2.5 font-bold text-slate-700">Code</th>
                  <th className="p-2.5 font-bold text-slate-700">Sens</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {[
                  ['401', 'MISSING_AUTH_HEADER', 'Header Authorization manquant'],
                  ['401', 'INVALID_API_KEY_FORMAT', 'Préfixe attendu sk_test_ ou sk_live_'],
                  ['401', 'INVALID_API_KEY', 'Clé inconnue ou révoquée'],
                  ['403', 'API_KEY_SUSPENDED', 'Clés suspendues par l\'administrateur'],
                  ['403', 'ACCOUNT_INACTIVE', 'Compte marchand bloqué'],
                  ['400', 'AMOUNT_TOO_SMALL', 'Montant en dessous du minimum'],
                  ['400', 'IDEMPOTENCY_KEY_TOO_LONG', 'Idempotency-Key > 255 caractères'],
                  ['400', 'GATEWAY_REJECTED', 'Passerelle crypto refuse la requête'],
                  ['404', 'PAYMENT_NOT_FOUND', 'ID de paiement inconnu'],
                  ['422', 'VALIDATION_ERROR', 'Payload JSON invalide'],
                  ['429', 'RATE_LIMITED', 'Trop d\'appels par minute'],
                  ['502', 'GATEWAY_ERROR', 'Erreur passerelle en amont'],
                  ['503', 'GATEWAY_UNAVAILABLE', 'Passerelle non configurée'],
                  ['500', 'INTERNAL_ERROR', 'Erreur inattendue côté serveur'],
                ].map(([http, code, sense]) => (
                  <tr key={code}>
                    <td className="p-2.5 font-mono text-slate-500">{http}</td>
                    <td className="p-2.5 font-mono text-red-700 font-semibold">{code}</td>
                    <td className="p-2.5 text-slate-700">{sense}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Lifecycle */}
          <SectionTitle id="lifecycle">Cycle de vie d'un paiement</SectionTitle>
          <p className="text-slate-600 text-[13px] leading-relaxed">Chaque paiement traverse ces états :</p>
          <div className="mt-4 flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-100 text-slate-700 text-[11px] font-bold"><Clock className="w-3 h-3" /> initiated</span>
            <ArrowRight className="w-3 h-3 text-slate-400" />
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-blue-100 text-blue-800 text-[11px] font-bold"><Radio className="w-3 h-3" /> confirming</span>
            <ArrowRight className="w-3 h-3 text-slate-400" />
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-100 text-emerald-800 text-[11px] font-bold"><CheckCircle2 className="w-3 h-3" /> completed</span>
            <span className="text-slate-400 text-xs mx-1">ou</span>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-100 text-amber-800 text-[11px] font-bold"><Clock className="w-3 h-3" /> expired</span>
            <span className="text-slate-400 text-xs mx-1">ou</span>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-red-100 text-red-800 text-[11px] font-bold"><XCircle className="w-3 h-3" /> failed</span>
          </div>
          <ul className="mt-4 space-y-1.5 text-[13px] text-slate-700 list-disc list-inside">
            <li><b>initiated</b> — paiement créé, l'utilisateur n'a pas encore envoyé les fonds.</li>
            <li><b>confirming</b> — transaction repérée on-chain, en attente des confirmations réseau.</li>
            <li><b>completed</b> — fonds confirmés et crédités sur votre balance USDT.</li>
            <li><b>expired</b> — 10 minutes écoulées sans transaction on-chain détectée.</li>
            <li><b>failed</b> — transaction rejetée, montant irrégulier ou rollback.</li>
          </ul>

          {/* Create Payment */}
          <SectionTitle id="create-payment">Créer un paiement</SectionTitle>
          <div className="flex items-center gap-2 text-xs font-mono">
            <span className="bg-emerald-100 text-emerald-800 font-bold px-2 py-0.5 rounded">POST</span>
            <span className="text-slate-700">{API_BASE}/v1/payments</span>
          </div>
          <p className="text-slate-600 text-[13px] leading-relaxed mt-3">
            Retourne <InlineCode>payment_url</InlineCode> — redirigez votre client vers cette URL pour qu'il paie.
            Vous serez notifié via webhook lorsque le paiement sera confirmé.
          </p>
          <div className="mt-4"><LangTabs snippets={CREATE_SNIPPETS} /></div>
          <p className="text-slate-600 text-[13px] leading-relaxed mt-4">Exemple de réponse (200 OK) :</p>
          <div className="mt-2">
            <CodeBlock lang="json" code={`{
  "id": "e6db8b85-be20-4c93-b202-a68c015eedac",
  "status": "initiated",
  "coin": "USDT",
  "amount": "10.00",
  "amount_gross": null,
  "amount_net": null,
  "fee": null,
  "reference": "order_123",
  "customer_email": "buyer@shop.com",
  "payment_url": "${OFFICIAL}/pay/checkout/…",
  "accepted_networks": ["TRC20", "BEP20", "ERC20"],
  "expires_at": "2026-08-01T14:30:00Z",
  "created_at": "2026-08-01T14:20:00Z"
}`} />
          </div>

          {/* Retrieve/List */}
          <SectionTitle id="retrieve-payment">Récupérer / lister</SectionTitle>
          <div className="flex items-center gap-2 text-xs font-mono mb-1">
            <span className="bg-blue-100 text-blue-800 font-bold px-2 py-0.5 rounded">GET</span>
            <span className="text-slate-700">{API_BASE}/v1/payments/&#123;id&#125;</span>
          </div>
          <p className="text-slate-600 text-[13px] leading-relaxed">Retourne le paiement, son statut, tx_hash s'il a été confirmé.</p>
          <div className="flex items-center gap-2 text-xs font-mono mt-4 mb-1">
            <span className="bg-blue-100 text-blue-800 font-bold px-2 py-0.5 rounded">GET</span>
            <span className="text-slate-700">{API_BASE}/v1/payments?limit=50&amp;status=completed</span>
          </div>
          <p className="text-slate-600 text-[13px] leading-relaxed">Liste paginée. Filtrable par <InlineCode>status</InlineCode>.</p>
          <div className="mt-2">
            <CodeBlock lang="json" code={`{
  "data": [ { "id": "…", "status": "completed", "amount": "25.00", ... } ],
  "count": 1,
  "has_more": false
}`} />
          </div>

          {/* Webhooks */}
          <SectionTitle id="webhooks">Webhooks &amp; signature HMAC</SectionTitle>
          <p className="text-slate-600 text-[13px] leading-relaxed">
            Chaque événement est livré via POST HTTPS avec les headers suivants :
          </p>
          <div className="overflow-x-auto rounded-xl border border-slate-200 mt-3">
            <table className="w-full text-[12px]">
              <thead className="bg-slate-50 text-left">
                <tr>
                  <th className="p-2.5 font-bold text-slate-700">Header</th>
                  <th className="p-2.5 font-bold text-slate-700">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-mono">
                <tr><td className="p-2.5">X-BizTransPay-Signature</td><td className="p-2.5 font-sans">HMAC SHA-256 <code className="text-[11px]">sha256=&lt;hex&gt;</code></td></tr>
                <tr><td className="p-2.5">X-BizTransPay-Timestamp</td><td className="p-2.5 font-sans">UNIX secondes — anti-replay 5 min</td></tr>
                <tr><td className="p-2.5">X-BizTransPay-Event-Id</td><td className="p-2.5 font-sans">Idempotency côté client (déduplication)</td></tr>
                <tr><td className="p-2.5">X-BizTransPay-Event-Type</td><td className="p-2.5 font-sans">ex. <InlineCode>payment.completed</InlineCode></td></tr>
              </tbody>
            </table>
          </div>
          <p className="text-slate-600 text-[13px] leading-relaxed mt-4">
            Signature calculée sur la chaîne <InlineCode>&lt;timestamp&gt;.&lt;raw_body&gt;</InlineCode>.
            Vérifiez toujours la signature <b>avant</b> de traiter l'événement, puis répondez <InlineCode>200 OK</InlineCode> rapidement (les 5xx sont retentés).
          </p>
          <div className="mt-3"><LangTabs snippets={WEBHOOK_VERIFY} /></div>

          <div className="mt-6">
            <h3 className="font-bold text-slate-900 text-sm mb-2">Événements émis</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {[
                ['payment.created', 'Paiement créé, en attente du client', 'bg-slate-50 border-slate-200'],
                ['payment.confirming', 'Transaction on-chain détectée', 'bg-blue-50 border-blue-200'],
                ['payment.completed', 'Fonds crédités sur votre balance', 'bg-emerald-50 border-emerald-200'],
                ['payment.expired', '10 minutes écoulées, expiré', 'bg-amber-50 border-amber-200'],
                ['payment.failed', 'Rejet, irregularité ou rollback', 'bg-red-50 border-red-200'],
                ['refund.created', 'Remboursement initié', 'bg-violet-50 border-violet-200'],
              ].map(([ev, desc, cls]) => (
                <div key={ev} className={`p-2.5 rounded-lg border ${cls}`}>
                  <div className="font-mono text-[12px] font-bold text-slate-900">{ev}</div>
                  <div className="text-[11px] text-slate-600 mt-0.5">{desc}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Health */}
          <SectionTitle id="health">Health check</SectionTitle>
          <div className="flex items-center gap-2 text-xs font-mono mb-1">
            <span className="bg-blue-100 text-blue-800 font-bold px-2 py-0.5 rounded">GET</span>
            <span className="text-slate-700">{API_BASE}/v1/health</span>
            <span className="text-[11px] text-slate-500 ml-2">— aucune auth requise</span>
          </div>
          <p className="text-slate-600 text-[13px] leading-relaxed">Endpoint public pour vos outils de monitoring uptime (StatusCake, Uptime Kuma, Grafana…).</p>
          <div className="mt-2">
            <CodeBlock lang="json" code={`{
  "status": "ok",
  "version": "1.0.0",
  "timestamp": "2026-08-01T14:20:00Z",
  "uptime_seconds": 3600
}`} />
          </div>

          {/* Playground */}
          <SectionTitle id="playground">Playground — Try it live</SectionTitle>
          <p className="text-slate-600 text-[13px] leading-relaxed">
            Exécutez de vrais appels sur votre compte de test. La clé test est utilisée automatiquement côté serveur — vous n'avez rien à configurer.
          </p>
          <div className="mt-3">
            <Playground />
          </div>

          <div className="h-32" />
        </main>
      </div>
    </div>
  );
}
