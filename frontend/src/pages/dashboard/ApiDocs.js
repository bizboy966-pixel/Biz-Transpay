import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, ArrowLeft, Code2, ShieldCheck, Zap, Webhook, ListChecks, AlertCircle, Book } from 'lucide-react';
import { toast } from 'sonner';

const API_BASE = (process.env.REACT_APP_BACKEND_URL || '') + '/api';

// ------------------------- CODE SNIPPETS -------------------------
const CREATE_SNIPPETS = {
  curl: `curl -X POST ${API_BASE}/v1/payments \\
  -H "Authorization: Bearer sk_test_XXXXX" \\
  -H "Content-Type: application/json" \\
  -d '{
    "amount": 10.00,
    "coin": "USDT",
    "reference": "order_123",
    "customer_email": "buyer@shop.com",
    "accepted_networks": ["TRC20", "BEP20", "ERC20"]
  }'`,
  node: `import biztranspay from '@biztranspay/sdk';
const btp = biztranspay('sk_test_XXXXX');

const payment = await btp.payments.create({
  amount: 10.00,
  coin: 'USDT',
  reference: 'order_123',
  customer_email: 'buyer@shop.com',
});

console.log(payment.payment_url); // Redirect the customer here`,
  javascript: `const res = await fetch('${API_BASE}/v1/payments', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer sk_test_XXXXX',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    amount: 10.00,
    coin: 'USDT',
    reference: 'order_123',
    customer_email: 'buyer@shop.com',
  }),
});
const payment = await res.json();
window.location.href = payment.payment_url;`,
  python: `import biztranspay
btp = biztranspay.Client('sk_test_XXXXX')

payment = btp.payments.create(
    amount=10.00,
    coin='USDT',
    reference='order_123',
    customer_email='buyer@shop.com',
)

print(payment['payment_url'])`,
  php: `<?php
require 'vendor/autoload.php';
$btp = new \\BizTransPay\\Client('sk_test_XXXXX');

$payment = $btp->payments->create([
  'amount' => 10.00,
  'coin' => 'USDT',
  'reference' => 'order_123',
  'customer_email' => 'buyer@shop.com',
]);

header('Location: ' . $payment['payment_url']);`,
  laravel: `<?php
// In your controller
use BizTransPay\\Client;

public function checkout(Request $req)
{
    $btp = new Client(config('services.biztranspay.secret'));

    $payment = $btp->payments->create([
      'amount' => $req->amount,
      'coin' => 'USDT',
      'reference' => 'order_' . $req->order_id,
      'customer_email' => auth()->user()->email,
    ]);

    return redirect($payment['payment_url']);
}`,
};

const VERIFY_SNIPPETS = {
  node: `import crypto from 'crypto';
import express from 'express';

const app = express();
const WEBHOOK_SECRET = process.env.BIZTRANSPAY_WEBHOOK_SECRET;

app.post('/webhooks/biztranspay',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const timestamp = req.headers['x-biztranspay-timestamp'];
    const signature = req.headers['x-biztranspay-signature'];
    const raw = req.body.toString('utf-8');

    const expected = 'sha256=' + crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(\`\${timestamp}.\${raw}\`)
      .digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
      return res.status(401).send('Invalid signature');
    }

    const event = JSON.parse(raw);
    switch (event.type) {
      case 'payment.completed':
        console.log('Paid:', event.data.reference);
        break;
      case 'payment.expired':
        console.log('Expired:', event.data.reference);
        break;
    }
    res.status(200).send('ok');
  }
);`,
  python: `import hmac, hashlib
from flask import Flask, request, abort

app = Flask(__name__)
WEBHOOK_SECRET = os.environ['BIZTRANSPAY_WEBHOOK_SECRET']

@app.route('/webhooks/biztranspay', methods=['POST'])
def webhook():
    timestamp = request.headers.get('X-BizTransPay-Timestamp', '')
    signature = request.headers.get('X-BizTransPay-Signature', '')
    raw = request.get_data(as_text=True)

    expected = 'sha256=' + hmac.new(
        WEBHOOK_SECRET.encode(),
        f'{timestamp}.{raw}'.encode(),
        hashlib.sha256
    ).hexdigest()

    if not hmac.compare_digest(expected, signature):
        abort(401)

    event = request.get_json()
    if event['type'] == 'payment.completed':
        # Fulfill the order
        print('Paid:', event['data']['reference'])
    return 'ok', 200`,
  php: `<?php
$WEBHOOK_SECRET = getenv('BIZTRANSPAY_WEBHOOK_SECRET');

$timestamp = $_SERVER['HTTP_X_BIZTRANSPAY_TIMESTAMP'] ?? '';
$signature = $_SERVER['HTTP_X_BIZTRANSPAY_SIGNATURE'] ?? '';
$raw = file_get_contents('php://input');

$expected = 'sha256=' . hash_hmac(
    'sha256',
    "\${timestamp}.\${raw}",
    $WEBHOOK_SECRET
);

if (!hash_equals($expected, $signature)) {
  http_response_code(401);
  exit('Invalid signature');
}

$event = json_decode($raw, true);
if ($event['type'] === 'payment.completed') {
  // Fulfill order
  error_log('Paid: ' . $event['data']['reference']);
}
http_response_code(200);
echo 'ok';`,
  laravel: `// routes/api.php
Route::post('webhooks/biztranspay', [WebhookController::class, 'handle'])
    ->withoutMiddleware(\\App\\Http\\Middleware\\VerifyCsrfToken::class);

// app/Http/Controllers/WebhookController.php
public function handle(Request $request)
{
    $secret = config('services.biztranspay.webhook_secret');
    $timestamp = $request->header('X-BizTransPay-Timestamp');
    $signature = $request->header('X-BizTransPay-Signature');
    $raw = $request->getContent();

    $expected = 'sha256=' . hash_hmac('sha256', "\${timestamp}.\${raw}", $secret);
    if (!hash_equals($expected, $signature)) {
        abort(401, 'Invalid signature');
    }

    $event = $request->json()->all();
    if ($event['type'] === 'payment.completed') {
        Order::where('reference', $event['data']['reference'])
             ->update(['status' => 'paid']);
    }
    return response('ok');
}`,
};

const RESPONSES = {
  created: `{
  "id": "3a7b4b73-6417-4880-9756-ea99e2c9d9bc",
  "payment_url": "https://checkout.pay.izichange.com/pay/6288...",
  "deposit_address": "TXYZabc123...",
  "amount_to_send": "10.000000",
  "amount": 10.00,
  "coin": "USDT",
  "accepted_networks": ["TRC20", "BEP20", "ERC20"],
  "expires_at": "2026-02-08T15:32:44.211243+00:00",
  "status": "initiated"
}`,
  get: `{
  "id": "3a7b4b73-6417-4880-9756-ea99e2c9d9bc",
  "status": "paid",
  "amount": 10.00,
  "amount_gross": 10.00,
  "amount_net": 9.60,
  "fee": 0.40,
  "fee_pct": 4.0,
  "coin": "USDT",
  "reference": "order_123",
  "payment_url": "https://checkout.pay.izichange.com/pay/6288...",
  "deposit_address": "TXYZabc123...",
  "tx_hash": "0x1a2b3c...",
  "expires_at": "2026-02-08T15:32:44+00:00",
  "created_at": "2026-02-08T15:22:44+00:00",
  "paid_at": "2026-02-08T15:28:12+00:00"
}`,
  list: `{
  "data": [
    { "id": "3a7b...", "status": "paid", "amount": 10.00, "coin": "USDT", ... },
    { "id": "9b81...", "status": "expired", "amount": 5.00, "coin": "USDT", ... }
  ],
  "count": 2
}`,
  webhook: `{
  "id": "evt_a1b2c3d4-e5f6-7890",
  "type": "payment.completed",
  "created_at": "2026-02-08T15:28:12+00:00",
  "data": {
    "payment_id": "3a7b4b73-6417-4880-9756-ea99e2c9d9bc",
    "reference": "order_123",
    "amount_gross": 10.00,
    "amount_net": 9.60,
    "fee": 0.40,
    "fee_pct": 4.0,
    "coin": "USDT",
    "tx_hash": "0x1a2b3c...",
    "customer_email": "buyer@shop.com",
    "paid_at": "2026-02-08T15:28:12+00:00"
  }
}`,
};

// ------------------------- COMPONENT -------------------------
export default function ApiDocs() {
  const copy = (v) => { navigator.clipboard.writeText(v); toast.success('Code copié'); };

  return (
    <div className="space-y-6" data-testid="page-api-docs">
      <div className="flex items-center gap-3">
        <Link to="/dashboard/api" className="w-9 h-9 rounded-lg border border-slate-200 hover:bg-slate-50 inline-flex items-center justify-center" data-testid="btn-back-api">
          <ArrowLeft className="w-4 h-4 text-slate-600" />
        </Link>
        <div>
          <h1 className="font-cabinet text-3xl font-extrabold tracking-tighter text-slate-900">Documentation API</h1>
          <p className="text-slate-500 text-sm mt-0.5">Intégrez Biz-transPay en quelques minutes avec notre SDK ou l&apos;API REST brute.</p>
        </div>
      </div>

      {/* Nav de section */}
      <nav className="bg-white border border-slate-100 rounded-2xl p-3 flex flex-wrap items-center gap-1 sticky top-16 z-20 backdrop-blur-sm bg-white/80">
        <SectionLink href="#auth" I={ShieldCheck} label="Authentification" />
        <SectionLink href="#create" I={Zap} label="Créer un paiement" />
        <SectionLink href="#retrieve" I={Book} label="Récupérer un paiement" />
        <SectionLink href="#list" I={ListChecks} label="Lister les paiements" />
        <SectionLink href="#webhooks" I={Webhook} label="Webhooks" />
        <SectionLink href="#errors" I={AlertCircle} label="Codes d'erreur" />
        <SectionLink href="#sdk" I={Code2} label="SDK" />
      </nav>

      {/* Section: Auth */}
      <Card id="auth" title="Authentification" icon={ShieldCheck}>
        <p className="text-sm text-slate-700">
          Chaque requête à l&apos;API doit inclure une <b>clé secrète</b> dans l&apos;en-tête <code className="bg-slate-100 px-1.5 py-0.5 rounded font-mono text-xs">Authorization: Bearer sk_test_...</code>. Les clés commençant par <code className="font-mono text-xs">sk_test_</code> sont pour l&apos;environnement <b>test</b>, celles par <code className="font-mono text-xs">sk_live_</code> pour la <b>production</b>.
        </p>
        <div className="mt-3 rounded-xl bg-amber-50 border border-amber-100 p-3 text-[12px] text-amber-800">
          <b>⚠️ Sécurité :</b> ne jamais exposer votre clé secrète côté client (JavaScript navigateur). Elle doit rester sur votre serveur uniquement.
        </div>
        <CodeBlock title="cURL" code={`curl ${API_BASE}/v1/payments \\
  -H "Authorization: Bearer sk_test_XXXXX"`} onCopy={copy} />
      </Card>

      {/* Section: Create */}
      <Card id="create" title="Créer un paiement" icon={Zap} method="POST" endpoint="/v1/payments">
        <p className="text-sm text-slate-700 mb-2">Crée un nouveau paiement. Le paiement expire après 10 minutes.</p>
        <Params rows={[
          ['amount', 'number', 'Montant en unités de la crypto (min 1 USDT). Ex: 10.5'],
          ['coin', 'string', 'Ticker de la crypto acceptée. Ex: "USDT", "BTC"'],
          ['reference', 'string (optionnel)', 'Votre référence interne (ex: order ID)'],
          ['customer_email', 'string (optionnel)', 'Email du client (pour notifications)'],
          ['accepted_networks', 'array (optionnel)', 'Réseaux acceptés. Défaut: ["TRC20","BEP20","ERC20"]'],
        ]} />
        <LangTabs snippets={CREATE_SNIPPETS} onCopy={copy} />
        <div className="mt-4">
          <div className="text-[11px] font-bold uppercase tracking-widest text-slate-500 mb-1.5">Réponse 200</div>
          <CodeBlock code={RESPONSES.created} onCopy={copy} />
        </div>
      </Card>

      {/* Section: Retrieve */}
      <Card id="retrieve" title="Récupérer un paiement" icon={Book} method="GET" endpoint="/v1/payments/{id}">
        <p className="text-sm text-slate-700 mb-2">Récupère le statut d&apos;un paiement. Statuts possibles : <code className="font-mono text-xs">initiated</code>, <code className="font-mono text-xs">pending</code>, <code className="font-mono text-xs">paid</code>, <code className="font-mono text-xs">expired</code>, <code className="font-mono text-xs">failed</code>.</p>
        <CodeBlock title="cURL" code={`curl ${API_BASE}/v1/payments/PAYMENT_ID \\
  -H "Authorization: Bearer sk_test_XXXXX"`} onCopy={copy} />
        <div className="mt-4">
          <div className="text-[11px] font-bold uppercase tracking-widest text-slate-500 mb-1.5">Réponse 200</div>
          <CodeBlock code={RESPONSES.get} onCopy={copy} />
        </div>
      </Card>

      {/* Section: List */}
      <Card id="list" title="Lister les paiements" icon={ListChecks} method="GET" endpoint="/v1/payments">
        <Params rows={[
          ['limit', 'integer (défaut 50, max 200)', 'Nombre de résultats à retourner'],
          ['status', 'string (optionnel)', 'Filtrer par statut'],
        ]} />
        <CodeBlock title="cURL" code={`curl "${API_BASE}/v1/payments?limit=20&status=paid" \\
  -H "Authorization: Bearer sk_test_XXXXX"`} onCopy={copy} />
        <div className="mt-4">
          <div className="text-[11px] font-bold uppercase tracking-widest text-slate-500 mb-1.5">Réponse 200</div>
          <CodeBlock code={RESPONSES.list} onCopy={copy} />
        </div>
      </Card>

      {/* Section: Webhooks */}
      <Card id="webhooks" title="Webhooks" icon={Webhook}>
        <p className="text-sm text-slate-700">
          Configurez une URL webhook dans <Link className="text-[#2563EB] hover:underline" to="/dashboard/api">votre dashboard API</Link>. Biz-transPay y enverra automatiquement les événements avec une signature HMAC-SHA256.
        </p>

        <div className="mt-4">
          <div className="text-[11px] font-bold uppercase tracking-widest text-slate-500 mb-1.5">En-têtes envoyés</div>
          <table className="w-full text-xs border border-slate-200 rounded-xl overflow-hidden">
            <tbody className="divide-y divide-slate-100">
              <tr className="bg-slate-50"><td className="px-3 py-2 font-mono text-[11px]">X-BizTransPay-Signature</td><td className="px-3 py-2 text-slate-600">HMAC-SHA256 hex, préfixé par <code>sha256=</code></td></tr>
              <tr><td className="px-3 py-2 font-mono text-[11px]">X-BizTransPay-Timestamp</td><td className="px-3 py-2 text-slate-600">Timestamp Unix utilisé pour signer</td></tr>
              <tr className="bg-slate-50"><td className="px-3 py-2 font-mono text-[11px]">X-BizTransPay-Event-Id</td><td className="px-3 py-2 text-slate-600">ID unique de l&apos;événement (idempotence)</td></tr>
              <tr><td className="px-3 py-2 font-mono text-[11px]">X-BizTransPay-Event-Type</td><td className="px-3 py-2 text-slate-600">Type d&apos;événement (ex: <code>payment.completed</code>)</td></tr>
            </tbody>
          </table>
        </div>

        <div className="mt-4">
          <div className="text-[11px] font-bold uppercase tracking-widest text-slate-500 mb-1.5">Événements</div>
          <div className="flex flex-wrap gap-1.5">
            {['payment.created', 'payment.completed', 'payment.failed', 'payment.expired', 'refund.created', 'refund.completed'].map((e) => (
              <span key={e} className="inline-flex items-center px-2 py-0.5 rounded-full bg-blue-50 text-[#2563EB] text-[10px] font-mono font-semibold">{e}</span>
            ))}
          </div>
        </div>

        <div className="mt-4">
          <div className="text-[11px] font-bold uppercase tracking-widest text-slate-500 mb-1.5">Payload exemple</div>
          <CodeBlock code={RESPONSES.webhook} onCopy={copy} />
        </div>

        <div className="mt-4">
          <div className="text-[11px] font-bold uppercase tracking-widest text-slate-500 mb-1.5">Vérifier la signature</div>
          <LangTabs snippets={VERIFY_SNIPPETS} onCopy={copy} />
        </div>

        <div className="mt-4 rounded-xl bg-emerald-50 border border-emerald-100 p-3 text-[12px] text-emerald-800">
          <b>✓ Idempotence :</b> Chaque événement a un ID unique (<code className="font-mono">X-BizTransPay-Event-Id</code>). Stockez-le et rejetez les événements déjà traités — Biz-transPay peut re-envoyer un même événement en cas de retry.
        </div>

        <div className="mt-3 rounded-xl bg-slate-50 border border-slate-200 p-3 text-[12px] text-slate-700">
          <b>Retries :</b> en cas de réponse HTTP ≠ 2xx (ou erreur réseau), Biz-transPay retente automatiquement 2 fois (30s puis 60s après la première tentative).
        </div>
      </Card>

      {/* Section: Errors */}
      <Card id="errors" title="Codes d'erreur" icon={AlertCircle}>
        <table className="w-full text-xs border border-slate-200 rounded-xl overflow-hidden">
          <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            <tr><th className="px-3 py-2 text-left">Code</th><th className="px-3 py-2 text-left">Signification</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {[
              ['200', 'Succès'],
              ['400', 'Requête invalide (paramètre manquant, montant hors limites, coin non supporté)'],
              ['401', 'Clé API invalide ou manquante'],
              ['403', 'Compte marchand suspendu ou banni'],
              ['404', 'Paiement introuvable'],
              ['429', 'Trop de requêtes (rate limit) — rare, patientez quelques secondes'],
              ['500', 'Erreur serveur — contactez le support si le problème persiste'],
              ['503', 'Passerelle crypto indisponible (temporaire)'],
            ].map(([c, m]) => (
              <tr key={c}><td className="px-3 py-2 font-mono font-bold">{c}</td><td className="px-3 py-2 text-slate-700">{m}</td></tr>
            ))}
          </tbody>
        </table>
        <div className="mt-3 text-[12px] text-slate-600">Format des erreurs :</div>
        <CodeBlock code={`{ "detail": "Message d'erreur en français explicatif" }`} onCopy={copy} />
      </Card>

      {/* Section: SDK */}
      <Card id="sdk" title="SDK officiel" icon={Code2}>
        <p className="text-sm text-slate-700 mb-3">
          Nos SDK officiels enveloppent l&apos;API REST avec du typage strict et une gestion propre des erreurs.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {[
            { lang: 'Node.js', pkg: '@biztranspay/sdk', cmd: 'npm install @biztranspay/sdk', color: 'from-emerald-500 to-teal-600' },
            { lang: 'PHP / Laravel', pkg: 'biztranspay/php-sdk', cmd: 'composer require biztranspay/php-sdk', color: 'from-indigo-500 to-purple-600' },
            { lang: 'Python', pkg: 'biztranspay', cmd: 'pip install biztranspay', color: 'from-blue-500 to-cyan-600' },
          ].map((s) => (
            <div key={s.lang} className="rounded-xl overflow-hidden border border-slate-100">
              <div className={`p-3 bg-gradient-to-br ${s.color} text-white`}>
                <div className="font-cabinet font-extrabold text-sm">{s.lang}</div>
                <div className="text-[11px] opacity-90 font-mono">{s.pkg}</div>
              </div>
              <div className="p-3">
                <div className="flex items-center gap-2 bg-slate-900 rounded-lg p-2">
                  <code className="text-[10px] text-emerald-300 flex-1 font-mono">{s.cmd}</code>
                  <button onClick={() => copy(s.cmd)} className="text-slate-400 hover:text-white"><Copy className="w-3 h-3" /></button>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 rounded-xl bg-amber-50 border border-amber-100 p-3 text-[12px] text-amber-800">
          <b>🚧 En cours de publication :</b> les SDK officiels seront disponibles sur npm/composer/pypi prochainement. En attendant, utilisez l&apos;API REST directement avec les exemples ci-dessus.
        </div>
      </Card>
    </div>
  );
}

// ------------------------- SUB-COMPONENTS -------------------------
function SectionLink({ href, I, label }) {
  return (
    <a href={href} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-slate-600 hover:bg-slate-50 hover:text-slate-900 transition-colors">
      <I className="w-3 h-3" /> {label}
    </a>
  );
}

function Card({ id, title, icon: I, method, endpoint, children }) {
  return (
    <section id={id} className="bg-white border border-slate-100 rounded-2xl p-5 sm:p-6 scroll-mt-32" data-testid={`section-${id}`}>
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center">
          <I className="w-5 h-5 text-[#2563EB]" strokeWidth={1.75} />
        </div>
        <h2 className="font-cabinet text-lg sm:text-xl font-extrabold text-slate-900">{title}</h2>
        {method && endpoint && (
          <div className="ml-auto flex items-center gap-2">
            <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold ${method === 'GET' ? 'bg-blue-50 text-[#2563EB]' : method === 'POST' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-700'}`}>{method}</span>
            <code className="font-mono text-xs text-slate-800">{endpoint}</code>
          </div>
        )}
      </div>
      {children}
    </section>
  );
}

function Params({ rows }) {
  return (
    <div className="mt-2">
      <div className="text-[11px] font-bold uppercase tracking-widest text-slate-500 mb-1.5">Paramètres du body (JSON)</div>
      <table className="w-full text-xs border border-slate-200 rounded-xl overflow-hidden">
        <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500">
          <tr><th className="px-3 py-2 text-left">Nom</th><th className="px-3 py-2 text-left">Type</th><th className="px-3 py-2 text-left">Description</th></tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map(([n, t, d]) => (
            <tr key={n}><td className="px-3 py-2 font-mono font-bold text-slate-800">{n}</td><td className="px-3 py-2 text-slate-500">{t}</td><td className="px-3 py-2 text-slate-700">{d}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LangTabs({ snippets, onCopy }) {
  const langs = Object.keys(snippets);
  const [active, setActive] = useState(langs[0]);
  return (
    <div className="mt-3">
      <div className="flex items-center gap-1 border-b border-slate-200 mb-2 overflow-x-auto">
        {langs.map((l) => (
          <button
            key={l}
            onClick={() => setActive(l)}
            data-testid={`lang-tab-${l}`}
            className={`inline-flex items-center px-3 py-1.5 -mb-px text-[11px] font-semibold border-b-2 whitespace-nowrap transition-colors ${active === l ? 'border-[#2563EB] text-[#2563EB]' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
          >
            {LANG_LABEL[l] || l}
          </button>
        ))}
      </div>
      <CodeBlock code={snippets[active]} onCopy={onCopy} />
    </div>
  );
}

const LANG_LABEL = {
  curl: 'cURL', node: 'Node.js', javascript: 'JavaScript',
  python: 'Python', php: 'PHP', laravel: 'Laravel',
};

function CodeBlock({ title, code, onCopy }) {
  return (
    <div className="rounded-xl overflow-hidden border border-slate-800 bg-slate-900">
      {title && (
        <div className="px-3 py-1.5 bg-slate-800 text-[10px] font-mono uppercase tracking-wider text-slate-400 border-b border-slate-700">{title}</div>
      )}
      <div className="relative group">
        <pre className="p-3 sm:p-4 text-[11px] sm:text-xs overflow-x-auto text-emerald-200 font-mono leading-relaxed">
          <code>{code}</code>
        </pre>
        <button onClick={() => onCopy(code)} className="absolute top-2 right-2 w-7 h-7 rounded-lg bg-slate-800 hover:bg-slate-700 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
          <Copy className="w-3.5 h-3.5 text-slate-300" />
        </button>
      </div>
    </div>
  );
}
