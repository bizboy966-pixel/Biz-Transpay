import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, BookOpen, Check, Code2, Copy, Download, KeyRound, Menu, ShieldCheck, Webhook, X } from 'lucide-react';
import { toast } from 'sonner';
import api from '../../api';

const API = `${process.env.REACT_APP_PUBLIC_DOMAIN || 'https://biz-transppayy.com'}/api/v1`;

const products = [
  { id: 'crypto-payin', name: 'BizPay Crypto · Pay-In', label: 'Dépôt crypto', tone: 'blue', path: '/payments', description: 'Créez un paiement crypto et redirigez le client vers sa page de paiement.' },
  { id: 'checkout', name: 'BizPay Checkout · PAR', label: 'Redirection', tone: 'blue', path: '/checkout', description: 'Créez une session PAR et redirigez votre client vers la page de paiement du prestataire.' },
  { id: 'psr', name: 'BizPay PSR', label: 'SDK intégré', tone: 'violet', path: '/psr', description: 'Créez une session PSR et remettez son jeton à usage unique au SDK de paiement intégré.' },
  { id: 'direct', name: 'BizPay Direct · SoftPay', label: 'Confirmation téléphone', tone: 'emerald', path: '/direct-payments', description: 'Déclenchez une confirmation Mobile Money depuis votre serveur, sans redirection.' },
  { id: 'push', name: 'BizPUSH · Mobile Money', label: 'Retrait automatique', tone: 'amber', path: '/push', description: 'Envoyez des fonds vers un numéro Mobile Money et suivez le statut du retrait.' },
  { id: 'crypto-payout', name: 'BizPUSH · Crypto', label: 'Retrait crypto', tone: 'amber', path: '/payouts', description: 'Envoyez des crypto vers une adresse et vérifiez le traitement du retrait.' },
];

const examples = {
  'crypto-payin': {
    curl: `curl -X POST ${API}/payments \\
  -H "Authorization: Bearer sk_test_YOUR_KEY" \\
  -H "Idempotency-Key: order-2048-crypto-1" \\
  -H "Content-Type: application/json" \\
  -d '{"amount":25,"coin":"USDT","accepted_networks":["TRC20"],"reference":"ORDER-2048","customer_email":"client@example.com"}'`,
    js: `const response = await fetch('${API}/payments', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer sk_test_YOUR_KEY',
    'Idempotency-Key': 'order-2048-crypto-1',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    amount: 25, coin: 'USDT', accepted_networks: ['TRC20'],
    reference: 'ORDER-2048', customer_email: 'client@example.com',
  }),
});
const payment = await response.json();
if (!response.ok) throw new Error(payment.message || payment.code);
console.log(payment.id, payment.status, payment.payment_url);`,
    php: `<?php
$ch = curl_init('${API}/payments');
curl_setopt_array($ch, [
  CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => [
    'Authorization: Bearer sk_test_YOUR_KEY',
    'Idempotency-Key: order-2048-crypto-1',
    'Content-Type: application/json',
  ],
  CURLOPT_POSTFIELDS => json_encode([
    'amount' => 25, 'coin' => 'USDT',
    'accepted_networks' => ['TRC20'], 'reference' => 'ORDER-2048',
  ]),
]);
$payment = json_decode(curl_exec($ch), true);
curl_close($ch);
if (isset($payment['payment_url'])) {
  header('Location: ' . $payment['payment_url']);
}`,
    python: `import requests

response = requests.post(
    '${API}/payments',
    json={'amount': 25, 'coin': 'USDT',
          'accepted_networks': ['TRC20'], 'reference': 'ORDER-2048'},
    headers={'Authorization': 'Bearer sk_test_YOUR_KEY',
             'Idempotency-Key': 'order-2048-crypto-1'},
    timeout=20,
)
response.raise_for_status()
payment = response.json()
print(payment['id'], payment['status'], payment.get('payment_url'))`,
  },
  checkout: {
    curl: `curl -X POST ${API}/checkout \\
  -H "Authorization: Bearer sk_test_YOUR_KEY" \\
  -H "Idempotency-Key: order-2048-attempt-1" \\
  -H "Content-Type: application/json" \\
  -d '{"amount":12500,"currency":"XOF","country":"TG","operator":"tmoney_tg","customer_name":"Afi Mensah","customer_email":"client@example.com","customer_phone":"22890000000","reference":"ORDER-2048","return_url":"https://shop.example/success"}'`,
    js: `const response = await fetch('${API}/checkout', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer sk_test_YOUR_KEY',
    'Idempotency-Key': 'order-2048-attempt-1',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ amount: 12500, currency: 'XOF', country: 'TG', operator: 'tmoney_tg', customer_name: 'Afi Mensah', reference: 'ORDER-2048' }),
});
const session = await response.json();
window.location.assign(session.checkout_url);`,
    php: `<?php
$ch = curl_init('${API}/checkout');
curl_setopt_array($ch, [
  CURLOPT_POST => true,
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => [
    'Authorization: Bearer sk_test_YOUR_KEY',
    'Idempotency-Key: order-2048-attempt-1',
    'Content-Type: application/json',
  ],
  CURLOPT_POSTFIELDS => json_encode([
    'amount' => 12500, 'currency' => 'XOF', 'country' => 'TG',
    'operator' => 'tmoney_tg', 'customer_name' => 'Afi Mensah',
    'reference' => 'ORDER-2048',
  ]),
]);
$session = json_decode(curl_exec($ch), true);
curl_close($ch);
header('Location: ' . $session['checkout_url']);`,
    python: `import requests

session = requests.post(
    '${API}/checkout',
    json={'amount': 12500, 'currency': 'XOF', 'country': 'TG',
          'operator': 'tmoney_tg', 'customer_name': 'Afi Mensah',
          'reference': 'ORDER-2048'},
    headers={
        'Authorization': 'Bearer sk_test_YOUR_KEY',
        'Idempotency-Key': 'order-2048-attempt-1',
    },
).json()
print(session['checkout_url'])`,
  },
  psr: {
    curl: `curl -X POST ${API}/psr \\
  -H "Authorization: Bearer sk_test_YOUR_KEY" \\
  -H "Idempotency-Key: order-2048-attempt-1" \\
  -H "Content-Type: application/json" \\
  -d '{"amount":12500,"currency":"XOF","country":"TG","operator":"tmoney_tg","customer_name":"Afi Mensah","customer_email":"client@example.com","reference":"ORDER-2048"}'`,
    js: `const response = await fetch('${API}/psr', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer sk_live_YOUR_KEY',
    'Idempotency-Key': 'order-2048-attempt-1',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ amount: 12500, currency: 'XOF', country: 'TG', operator: 'tmoney_tg', customer_name: 'Afi Mensah', reference: 'ORDER-2048' }),
});
const session = await response.json();
// Send this short-lived URL to your client app, then pass its token
// to the official PayDunya PSR SDK. Never send your API key to the client.
const tokenResponse = await fetch(new URL(session.psr_token_url, '${API}'));
const psrCredentials = await tokenResponse.json();`,
    php: `<?php
$ch = curl_init('${API}/psr');
curl_setopt_array($ch, [
  CURLOPT_POST => true,
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => [
    'Authorization: Bearer sk_live_YOUR_KEY',
    'Idempotency-Key: order-2048-attempt-1',
    'Content-Type: application/json',
  ],
  CURLOPT_POSTFIELDS => json_encode([
    'amount' => 12500, 'currency' => 'XOF', 'country' => 'TG',
    'operator' => 'tmoney_tg', 'customer_name' => 'Afi Mensah',
    'reference' => 'ORDER-2048',
  ]),
]);
$session = json_decode(curl_exec($ch), true);
curl_close($ch);
echo $session['psr_token_url']; // Forward to your client app`,
    python: `import requests

session = requests.post(
    '${API}/psr',
    json={'amount': 12500, 'currency': 'XOF', 'country': 'TG',
          'operator': 'tmoney_tg', 'customer_name': 'Afi Mensah',
          'reference': 'ORDER-2048'},
    headers={
        'Authorization': 'Bearer sk_live_YOUR_KEY',
        'Idempotency-Key': 'order-2048-attempt-1',
    },
).json()
print(session['psr_token_url'])  # Forward to your client app`,
  },
  direct: {
    curl: `curl -X POST ${API}/direct-payments \\
  -H "Authorization: Bearer sk_test_YOUR_KEY" \\
  -H "Idempotency-Key: invoice-771-attempt-1" \\
  -H "Content-Type: application/json" \\
  -d '{"amount":8900,"currency":"XOF","country":"TG","operator":"tmoney_tg","customer_phone":"22890000000","customer_email":"client@example.com","reference":"INV-771"}'`,
    js: `const response = await fetch('${API}/direct-payments', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer sk_test_YOUR_KEY',
    'Idempotency-Key': 'invoice-771-attempt-1',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ amount: 8900, currency: 'XOF', country: 'TG', operator: 'tmoney_tg', customer_phone: '22890000000', reference: 'INV-771' }),
});
const payment = await response.json();
console.log(payment.id, payment.status);`,
    php: `<?php
$ch = curl_init('${API}/direct-payments');
curl_setopt_array($ch, [
  CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => [
    'Authorization: Bearer sk_test_YOUR_KEY',
    'Idempotency-Key: invoice-771-attempt-1',
    'Content-Type: application/json',
  ],
  CURLOPT_POSTFIELDS => json_encode([
    'amount' => 8900, 'currency' => 'XOF', 'country' => 'TG',
    'operator' => 'tmoney_tg', 'customer_phone' => '22890000000',
    'reference' => 'INV-771',
  ]),
]);
$payment = json_decode(curl_exec($ch), true);
curl_close($ch);`,
    python: `import requests

payment = requests.post(
    '${API}/direct-payments',
    json={'amount': 8900, 'currency': 'XOF', 'country': 'TG',
          'operator': 'tmoney_tg', 'customer_phone': '22890000000',
          'reference': 'INV-771'},
    headers={'Authorization': 'Bearer sk_test_YOUR_KEY',
             'Idempotency-Key': 'invoice-771-attempt-1'},
).json()
print(payment['id'], payment['status'])`,
  },
  push: {
    curl: `curl -X POST ${API}/push \\
  -H "Authorization: Bearer sk_live_YOUR_KEY" \\
  -H "Idempotency-Key: payroll-88-attempt-1" \\
  -H "Content-Type: application/json" \\
  -d '{"amount":15000,"currency":"XOF","country":"TG","operator":"tmoney_tg","beneficiary_phone":"22890000000","beneficiary_name":"Kossi Mensah","reference":"PAYROLL-88"}'`,
    js: `const response = await fetch('${API}/push', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer sk_live_YOUR_KEY',
    'Idempotency-Key': 'payroll-88-attempt-1',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ amount: 15000, currency: 'XOF', country: 'TG', operator: 'tmoney_tg', beneficiary_phone: '22890000000', beneficiary_name: 'Kossi Mensah', reference: 'PAYROLL-88' }),
});
const transfer = await response.json();
console.log('Queued:', transfer.id, transfer.status);`,
    php: `<?php
$ch = curl_init('${API}/push');
curl_setopt_array($ch, [
  CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => [
    'Authorization: Bearer sk_live_YOUR_KEY',
    'Idempotency-Key: payroll-88-attempt-1',
    'Content-Type: application/json',
  ],
  CURLOPT_POSTFIELDS => json_encode([
    'amount' => 15000, 'currency' => 'XOF', 'country' => 'TG',
    'operator' => 'tmoney_tg', 'beneficiary_phone' => '22890000000',
    'beneficiary_name' => 'Kossi Mensah', 'reference' => 'PAYROLL-88',
  ]),
]);
$transfer = json_decode(curl_exec($ch), true);
curl_close($ch);`,
    python: `import requests

transfer = requests.post(
    '${API}/push',
    json={'amount': 15000, 'currency': 'XOF', 'country': 'TG',
          'operator': 'tmoney_tg', 'beneficiary_phone': '22890000000',
          'beneficiary_name': 'Kossi Mensah', 'reference': 'PAYROLL-88'},
    headers={'Authorization': 'Bearer sk_live_YOUR_KEY',
             'Idempotency-Key': 'payroll-88-attempt-1'},
).json()
print('Queued:', transfer['id'], transfer['status'])`,
  },
  'crypto-payout': {
    curl: `curl -X POST ${API}/payouts \\
  -H "Authorization: Bearer sk_test_YOUR_KEY" \\
  -H "Idempotency-Key: withdrawal-88-attempt-1" \\
  -H "Content-Type: application/json" \\
  -d '{"amount":25,"coin":"USDT","network":"TRC20","destination_address":"TJRabPrwbZy45sbavfcjinPJC18kjpRTv8","reference":"WD-88","fee_bearer":"sender"}'`,
    js: `const response = await fetch('${API}/payouts', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer sk_test_YOUR_KEY',
    'Idempotency-Key': 'withdrawal-88-attempt-1',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    amount: 25, coin: 'USDT', network: 'TRC20',
    destination_address: 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8',
    reference: 'WD-88', fee_bearer: 'sender',
  }),
});
const payout = await response.json();
if (!response.ok) throw new Error(payout.message || payout.code);
const statusResponse = await fetch(\`${API}/payouts/\${payout.id}/status\`, {
  headers: { Authorization: 'Bearer sk_test_YOUR_KEY' },
});
console.log(payout.id, (await statusResponse.json()).status);`,
    php: `<?php
$ch = curl_init('${API}/payouts');
curl_setopt_array($ch, [
  CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => [
    'Authorization: Bearer sk_test_YOUR_KEY',
    'Idempotency-Key: withdrawal-88-attempt-1',
    'Content-Type: application/json',
  ],
  CURLOPT_POSTFIELDS => json_encode([
    'amount' => 25, 'coin' => 'USDT', 'network' => 'TRC20',
    'destination_address' => 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8',
    'reference' => 'WD-88', 'fee_bearer' => 'sender',
  ]),
]);
$payout = json_decode(curl_exec($ch), true);
curl_close($ch);
echo $payout['id'] . ' ' . $payout['status'];`,
    python: `import requests

headers = {'Authorization': 'Bearer sk_test_YOUR_KEY',
           'Idempotency-Key': 'withdrawal-88-attempt-1'}
response = requests.post(
    '${API}/payouts',
    json={'amount': 25, 'coin': 'USDT', 'network': 'TRC20',
          'destination_address': 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8',
          'reference': 'WD-88', 'fee_bearer': 'sender'},
    headers=headers, timeout=20,
)
response.raise_for_status()
payout = response.json()
status = requests.get('${API}/payouts/' + payout['id'] + '/status',
                      headers={'Authorization': headers['Authorization']},
                      timeout=20)
status.raise_for_status()
print(payout['id'], status.json()['status'])`,
  },
};

const statusCode = `curl ${API}/payments/PAYMENT_ID \\
  -H "Authorization: Bearer sk_test_YOUR_KEY"

curl ${API}/payments/PAYMENT_ID/status \\
  -H "Authorization: Bearer sk_test_YOUR_KEY"

curl ${API}/push/PUSH_ID/status \\
  -H "Authorization: Bearer sk_test_YOUR_KEY"

curl ${API}/payouts/PAYOUT_ID/status \\
  -H "Authorization: Bearer sk_test_YOUR_KEY"`;

function CodeBlock({ code }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    toast.success('Exemple copié');
    window.setTimeout(() => setCopied(false), 1400);
  };
  return <div className="relative my-3">
    <button type="button" onClick={copy} className="pdf-copy-control absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-md bg-slate-800 px-2 py-1 text-[11px] font-semibold text-slate-200 hover:bg-slate-700">
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}{copied ? 'Copié' : 'Copier'}
    </button>
    <pre className="overflow-x-auto rounded-xl bg-slate-950 p-4 pr-20 font-mono text-[12px] leading-relaxed text-slate-100"><code>{code}</code></pre>
  </div>;
}

function Info({ icon: Icon, title, children, tone = 'blue' }) {
  const styles = { blue: 'border-blue-200 bg-blue-50 text-blue-950', emerald: 'border-emerald-200 bg-emerald-50 text-emerald-950', amber: 'border-amber-200 bg-amber-50 text-amber-950' };
  return <div className={`my-4 flex gap-3 rounded-xl border p-4 text-[13px] leading-relaxed ${styles[tone]}`}>
    <Icon className="mt-0.5 h-5 w-5 shrink-0" />
    <div><strong className="block mb-1">{title}</strong>{children}</div>
  </div>;
}

function ApiTable({ headers, rows }) {
  return <div className="my-4 overflow-x-auto rounded-xl border border-slate-200 bg-white">
    <table className="w-full min-w-[620px] border-collapse text-left text-xs">
      <thead className="bg-slate-100 text-slate-700">
        <tr>{headers.map((header) => <th key={header} className="px-3 py-2.5 font-bold">{header}</th>)}</tr>
      </thead>
      <tbody className="divide-y divide-slate-100 text-slate-700">
        {rows.map((row, index) => <tr key={`${index}-${row[0]}`}>
          {row.map((cell, cellIndex) => <td key={cellIndex} className="px-3 py-2.5 align-top leading-relaxed">{cell}</td>)}
        </tr>)}
      </tbody>
    </table>
  </div>;
}

function ProductExample({ product }) {
  const [lang, setLang] = useState('curl');
  const item = products.find((entry) => entry.id === product);
  return <section id={product} className="scroll-mt-24">
    <div className="flex flex-wrap items-center gap-2">
      <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${item.tone === 'blue' ? 'bg-blue-100 text-blue-700' : item.tone === 'violet' ? 'bg-violet-100 text-violet-700' : item.tone === 'emerald' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-800'}`}>{item.label}</span>
      <span className="font-mono text-xs text-slate-400">POST {item.path}</span>
    </div>
    <h2 className="mt-2 font-cabinet text-2xl font-extrabold text-slate-900">{item.name}</h2>
    <p className="mt-2 text-[14px] leading-relaxed text-slate-700">{item.description}</p>
    <div className="mt-4 flex flex-wrap gap-1 border-b border-slate-200">
      {['curl', 'js', 'php', 'python'].map((key) => <button type="button" key={key} onClick={() => setLang(key)} className={`rounded-t-md px-3 py-2 text-xs font-bold ${lang === key ? 'border-b-2 border-slate-900 text-slate-900' : 'text-slate-500 hover:text-slate-900'}`}>{key === 'js' ? 'JavaScript' : key === 'curl' ? 'cURL' : key[0].toUpperCase() + key.slice(1)}</button>)}
    </div>
    <CodeBlock code={examples[product][lang]} />
    <div className="pdf-all-examples">
      <h3 className="mt-5 text-sm font-bold text-slate-900">Exemples {item.name}</h3>
      {['curl', 'js', 'php', 'python'].map((key) => (
        <div key={key}>
          <div className="mt-3 text-xs font-bold uppercase tracking-wide text-slate-500">{key === 'js' ? 'JavaScript' : key === 'curl' ? 'cURL' : key[0].toUpperCase() + key.slice(1)}</div>
          <CodeBlock code={examples[product][key]} />
        </div>
      ))}
    </div>
    {product === 'psr' && <Info icon={ShieldCheck} title="Échange sécurisé avec le SDK" tone="blue">En live, <code>psr_token_url</code> est une URL temporaire à usage unique. Votre serveur la transmet à l’application cliente, qui la récupère auprès de Biz-transPay puis remet le jeton au SDK PSR officiel. N’exposez jamais votre clé API. En test, aucun prestataire n’est appelé : utilisez <code>simulation_endpoint</code> depuis votre serveur.</Info>}
  </section>;
}

export default function ApiDocs() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [query, setQuery] = useState('');
  const sections = useMemo(() => [
    ['start', 'Démarrage'], ['auth', 'Authentification'], ['environments', 'Test et live'],
    ['crypto-payin', 'Pay-In crypto'],
    ['checkout', 'BizPay Checkout · PAR'], ['psr', 'BizPay PSR'],
    ['direct', 'BizPay Direct · SoftPay'], ['push', 'Retrait Mobile Money'],
    ['crypto-payout', 'Retrait crypto'], ['contracts', 'Champs et réponses'],
    ['status', 'Statuts et suivi'], ['webhooks', 'Webhooks signés'], ['errors', 'Erreurs'],
  ].filter(([, label]) => !query.trim() || label.toLowerCase().includes(query.toLowerCase())), [query]);

  const downloadPdf = async () => {
    try {
      const response = await api.get('/documentation.pdf', { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([response.data], { type: 'application/pdf' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'biz-transpay-api-docs.pdf';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
      toast.success('Documentation PDF téléchargée');
    } catch {
      toast.error('Le PDF n’a pas pu être téléchargé.');
    }
  };

  return <div className="api-docs-page min-h-screen bg-slate-50" data-testid="api-docs-page">
    <style>{`
      @media print {
        @page { size: A4; margin: 14mm; }
        .api-docs-page { background: #fff !important; }
        .api-docs-header, .api-docs-sidebar, .bt-bottom-nav, .pdf-copy-control { display: none !important; }
        .api-docs-layout, .api-docs-main { display: block !important; max-width: none !important; width: 100% !important; }
        .api-docs-main { padding: 0 !important; }
        .pdf-all-examples { display: block !important; }
        .pdf-all-examples > div { break-inside: avoid; }
        pre { white-space: pre-wrap !important; overflow: visible !important; font-size: 9px !important; }
        section { break-inside: avoid; }
        a { color: inherit !important; text-decoration: none !important; }
      }
      .pdf-all-examples { display: none; }
    `}</style>
    <header className="api-docs-header sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl items-center gap-4 px-5 py-3">
        <button type="button" onClick={() => setMobileOpen((value) => !value)} className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 lg:hidden">{mobileOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}</button>
        <Link to="/dashboard/api" className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-slate-600 hover:text-slate-900"><ArrowLeft className="h-4 w-4" /> Retour aux clés</Link>
        <div className="hidden items-center gap-2 md:flex"><BookOpen className="h-4 w-4 text-blue-600" /><span className="font-cabinet text-sm font-extrabold text-slate-900">API Biz-transPay <span className="font-normal text-slate-400">v1</span></span></div>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Rechercher dans la documentation" className="ml-auto hidden w-64 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs outline-none focus:border-blue-500 md:block" />
        <button type="button" onClick={downloadPdf} data-testid="btn-download-api-pdf" className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-bold text-white shadow-sm hover:bg-slate-700">
          <Download className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Télécharger le PDF</span><span className="sm:hidden">PDF</span>
        </button>
      </div>
    </header>
    <div className="api-docs-layout mx-auto flex max-w-7xl">
      <aside className={`api-docs-sidebar ${mobileOpen ? 'translate-x-0' : '-translate-x-full'} fixed inset-y-14 left-0 z-20 w-64 overflow-y-auto border-r border-slate-200 bg-white transition-transform lg:sticky lg:top-14 lg:h-[calc(100vh-3.5rem)] lg:translate-x-0 lg:border-none lg:bg-transparent`}>
        <nav className="space-y-1 p-4">{sections.map(([id, label]) => <a key={id} href={`#${id}`} onClick={() => setMobileOpen(false)} className="block rounded-lg px-3 py-2 text-[13px] font-semibold text-slate-600 hover:bg-blue-50 hover:text-blue-700">{label}</a>)}</nav>
      </aside>
      <main className="api-docs-main min-w-0 max-w-3xl flex-1 px-5 py-8 lg:px-10 lg:py-12">
          <section id="start" className="scroll-mt-24">
          <div className="inline-flex items-center gap-2 rounded-full bg-blue-100 px-2.5 py-1 text-[11px] font-bold text-blue-700"><Code2 className="h-3 w-3" /> API REST · v1</div>
          <h1 className="mt-3 font-cabinet text-3xl font-extrabold tracking-tight text-slate-900 md:text-4xl">Dépôts et retraits automatisés par API.</h1>
           <p className="mt-3 text-[15px] leading-relaxed text-slate-700">Intégrez les dépôts crypto et Mobile Money, puis les retraits Mobile Money ou crypto. PAR redirige vers la page du prestataire, PSR utilise le SDK intégré, Direct déclenche SoftPay et BizPUSH initie les envois. Chaque création et lecture utilise les autorisations de clé correspondantes.</p>
          <div className="mt-6 grid gap-3 md:grid-cols-2 xl:grid-cols-4">{products.map((product) => <a href={`#${product.id}`} key={product.id} className="rounded-xl border border-slate-200 bg-white p-4 hover:-translate-y-0.5 hover:border-blue-300 transition-transform"><div className="font-cabinet text-sm font-bold text-slate-900">{product.name}</div><div className="mt-1 text-xs leading-relaxed text-slate-500">{product.description}</div><div className="mt-3 font-mono text-[11px] text-blue-700">POST {product.path}</div></a>)}</div>
            <Info icon={ShieldCheck} title="Vérification serveur-à-serveur" tone="blue">Après chaque dépôt, conservez l’identifiant et vérifiez son statut par <code>GET /payments/{'{id}'}/status</code>. Un retrait Mobile Money se suit sur <code>GET /push/{'{id}'}/status</code> et un retrait crypto sur <code>GET /payouts/{'{id}'}/status</code>. Un statut <code>pending</code> ou <code>processing</code> n’est pas une confirmation de réussite.</Info>
        </section>

          <section id="auth" className="scroll-mt-24"><h2 className="mt-12 font-cabinet text-2xl font-extrabold text-slate-900">Authentification</h2><p className="mt-2 text-[14px] leading-relaxed text-slate-700">Envoyez la clé secrète dans l'en-tête Bearer. Les clés secrètes restent sur votre serveur : ne les placez jamais dans une application mobile ou un navigateur. Toutes les routes ci-dessous sont relatives à <code>{API}</code>.</p><CodeBlock code={`Authorization: Bearer sk_test_YOUR_KEY\nContent-Type: application/json`} /><ApiTable headers={['Scope', 'Accès']} rows={[
            [<code>checkout:create</code>, 'Créer des dépôts crypto, des sessions PAR et des paiements Mobile Money via la route compatible /payments.'],
            [<code>psr:create</code>, 'Créer une session de dépôt Mobile Money avec le SDK PSR.'],
            [<code>direct:create</code>, 'Créer une demande Mobile Money Direct / SoftPay.'],
            [<code>push:create</code>, 'Créer un retrait BizPUSH Mobile Money ou un retrait crypto.'],
            [<code>payments:read</code>, 'Lire, rechercher et suivre les dépôts et retraits.'],
          ]} /><Info icon={KeyRound} title="Clé et idempotence" tone="amber">Utilisez une <code>Idempotency-Key</code> distincte par opération métier et réutilisez-la uniquement lors d’un retry réseau de cette même opération. Elle est obligatoire sur <code>/checkout</code>, <code>/psr</code>, <code>/direct-payments</code> et <code>/push</code>. Elle est facultative mais recommandée sur le Pay-In crypto <code>/payments</code> et le retrait crypto <code>/payouts</code>. Les alias <code>/payments</code> en Mobile Money et <code>/bizpush/payouts</code> exigent aussi cette clé. Elle ne peut dépasser 255 caractères; les créations idempotentes sont conservées 24 h.</Info></section>
          <section id="environments" className="scroll-mt-24"><h2 className="mt-12 font-cabinet text-2xl font-extrabold text-slate-900">Test et live</h2><p className="mt-2 text-[14px] leading-relaxed text-slate-700">La base URL reste la même. Le préfixe de la clé choisit l’environnement : <code className="font-mono text-blue-700">sk_test_</code> crée des opérations locales sans appel fournisseur ni mouvement de solde réel ; <code className="font-mono text-emerald-700">sk_live_</code> peut déclencher de vrais paiements ou retraits. Les données et clés d’idempotence sont séparées. Créez et révoquez les clés depuis <Link to="/dashboard/api" className="font-semibold text-blue-700 underline">Clés API</Link>. Testez avec une clé test avant de passer en live.</p><Info icon={ShieldCheck} title="Simuler un dépôt confirmé" tone="blue">Pour les paiements Mobile Money, PSR, Direct et crypto, utilisez le chemin <code>simulation_endpoint</code> renvoyé avec une clé test. Il marque localement le dépôt comme confirmé et peut émettre le webhook de test. Les endpoints de retrait BizPUSH et crypto créent uniquement un enregistrement de test en attente : ils n’appellent pas le fournisseur, ne déplacent pas de solde et n’ont pas d’endpoint de simulation de réussite.</Info><Info icon={ShieldCheck} title="Numéro Mobile Money" tone="emerald">Envoyez le code pays ISO-2, l’opérateur actif de votre catalogue et le numéro au format national ou international. Exemple Togo : <code>91978352</code>, <code>22891978352</code> ou <code>+228 91 97 83 52</code>. Vérifiez toujours le couple pays/opérateur/devise configuré dans votre compte.</Info><CodeBlock code={`curl -X POST ${API}/test/payments/PAYMENT_ID/complete \\
  -H "Authorization: Bearer sk_test_YOUR_KEY"`} /></section>

        <div className="space-y-14 mt-12"><ProductExample product="crypto-payin" /><ProductExample product="checkout" /><ProductExample product="psr" /><ProductExample product="direct" /><ProductExample product="push" /><ProductExample product="crypto-payout" /></div>

          <section id="contracts" className="scroll-mt-24">
            <h2 className="mt-12 font-cabinet text-2xl font-extrabold text-slate-900">Champs, réponses et contrats</h2>
            <p className="mt-2 text-[14px] leading-relaxed text-slate-700">Les clés API utilisent les routes de création suivantes. Les codes opérateur et réseaux doivent être actifs pour le compte et l’environnement concernés.</p>
            <ApiTable headers={['Méthode et route', 'Scope', 'Idempotence']} rows={[
              ['POST /payments (crypto)', 'checkout:create', 'Facultative, recommandée'],
              ['POST /checkout (Mobile Money PAR)', 'checkout:create', 'Obligatoire'],
              ['POST /psr (Mobile Money PSR)', 'psr:create', 'Obligatoire'],
              ['POST /direct-payments (Mobile Money SoftPay)', 'direct:create', 'Obligatoire'],
              ['POST /push (retrait Mobile Money)', 'push:create', 'Obligatoire'],
              ['POST /payouts (retrait crypto)', 'push:create', 'Facultative, recommandée'],
              ['POST /bizpush/payouts (alias de /payouts)', 'push:create', 'Obligatoire'],
            ]} />
            <h3 className="mt-7 font-cabinet text-lg font-bold text-slate-900">Dépôts Mobile Money : PAR et PSR</h3>
            <ApiTable headers={['Champ', 'Type / contrainte', 'Requis']} rows={[
              [<code>amount</code>, 'Nombre strictement supérieur à 0, dans la devise demandée.', 'Oui'],
              [<code>currency</code>, 'XOF, XAF, CDF, USD, GMD, GNF, UGX, TZS, KES, RWF, GHS, NGN, ZAR, ZMW ou EGP.', 'Oui'],
              [<code>country</code>, 'Code pays ISO-2, par ex. TG.', 'Oui'],
              [<code>operator</code>, 'Code opérateur actif dans le catalogue du compte, par ex. tmoney_tg.', 'Oui'],
              [<code>customer_phone</code>, '6 à 32 caractères; facultatif pour PAR/PSR si le parcours fournisseur le permet.', 'Non'],
              [<code>customer_name</code>, '1 à 120 caractères; défaut Client.', 'Non'],
              [<code>customer_email</code>, 'Adresse e-mail du client.', 'Non'],
              [<code>fee_bearer</code>, 'client ou merchant; défaut client.', 'Non'],
              [<code>reference</code>, 'Référence marchande, jusqu’à 128 caractères.', 'Non'],
              [<code>return_url</code>, 'URL vers laquelle retourner le client après le parcours hébergé.', 'Non'],
              [<code>metadata</code>, 'Objet JSON libre pour vos données de rapprochement.', 'Non'],
            ]} />
            <p className="mt-2 text-[13px] leading-relaxed text-slate-600">PAR renvoie <code>checkout_url</code> pour la page hébergée. PSR renvoie <code>psr_token_url</code>, un lien temporaire à usage unique à transmettre à votre application cliente; le SDK reçoit ensuite le jeton. Ne transmettez jamais la clé secrète à l’application. Les réponses Mobile Money exposent notamment <code>requested_amount</code>, <code>charged_amount</code>, <code>wallet_credit_amount</code>, <code>gateway_fee</code>, <code>platform_fee</code>, <code>fee</code> et <code>fee_bearer</code>. Les frais dépendent de l’opérateur et de sa configuration; utilisez les montants retournés pour le rapprochement.</p>
            <h3 className="mt-7 font-cabinet text-lg font-bold text-slate-900">Dépôt Mobile Money Direct / SoftPay</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-slate-700"><code>POST /direct-payments</code> exige les mêmes <code>amount</code>, <code>currency</code>, <code>country</code> et <code>operator</code>, ainsi qu’un <code>customer_phone</code> (6 à 32 caractères). <code>customer_email</code>, <code>reference</code> (1 à 128 caractères), <code>return_url</code> et <code>metadata</code> sont facultatifs. Ce parcours déclenche la demande de confirmation sur le téléphone; il ne redirige pas vers un checkout.</p>
            <h3 className="mt-7 font-cabinet text-lg font-bold text-slate-900">Dépôt crypto</h3>
            <ApiTable headers={['Champ', 'Type / valeur', 'Requis']} rows={[
              [<code>amount</code>, 'Nombre supérieur ou égal à 1.', 'Oui'],
              [<code>coin</code>, 'Actif crypto demandé; défaut USDT.', 'Non'],
              [<code>accepted_networks</code>, 'Tableau de réseaux acceptés; défaut TRC20, BEP20 et ERC20.', 'Non'],
              [<code>payment_method</code>, 'crypto (défaut) ou mobile_money. Pour Mobile Money, préférez /checkout, /psr ou /direct-payments.', 'Non'],
              [<code>currency, country, operator, customer_phone</code>, 'Requis uniquement avec payment_method=mobile_money.', 'Conditionnel'],
              [<code>customer_name, customer_email, reference, return_url, metadata</code>, 'Données client, référence marchande, retour et métadonnées.', 'Non'],
            ]} />
            <h3 className="mt-7 font-cabinet text-lg font-bold text-slate-900">Retrait BizPUSH Mobile Money · POST /push</h3>
            <ApiTable headers={['Champ', 'Type / contrainte', 'Requis']} rows={[
              [<code>amount</code>, 'Nombre strictement supérieur à 0; montant envoyé au bénéficiaire.', 'Oui'],
              [<code>currency</code>, 'XOF, XAF, CDF, USD, GMD, GNF, UGX, TZS, KES, RWF, GHS, NGN, ZAR, ZMW ou EGP.', 'Oui'],
              [<code>country</code>, 'Code pays ISO-2.', 'Oui'],
              [<code>operator</code>, 'Code opérateur actif du catalogue de retrait.', 'Oui'],
              [<code>beneficiary_phone</code>, '6 à 32 caractères.', 'Oui'],
              [<code>beneficiary_name, beneficiary_email</code>, 'Identité du bénéficiaire.', 'Non'],
              [<code>reference</code>, 'Référence marchande, 1 à 128 caractères.', 'Non'],
              [<code>metadata</code>, 'Objet JSON libre.', 'Non'],
            ]} />
            <p className="mt-2 text-[13px] leading-relaxed text-slate-700">La réponse expose <code>id</code>, <code>object: "payout"</code>, <code>product: "bizpush"</code>, <code>status</code>, <code>amount</code>, <code>currency</code>, <code>reference</code>, <code>fee</code>, <code>total_debit</code>, les horodatages et vos métadonnées publiques. <code>total_debit</code> inclut les frais calculés selon le pays et l’opérateur; consultez-le avant de rapprocher le solde. En live, un incident de liquidité du fournisseur peut laisser le retrait en attente de résolution manuelle; ne supposez pas qu’un état pending entraîne un remboursement automatique.</p>
            <h3 className="mt-7 font-cabinet text-lg font-bold text-slate-900">Retrait crypto · POST /payouts</h3>
            <ApiTable headers={['Champ', 'Type / contrainte', 'Requis']} rows={[
              [<code>amount</code>, 'Nombre strictement supérieur à 0.', 'Oui'],
              [<code>coin</code>, 'Actif crypto demandé; défaut USDT.', 'Non'],
              [<code>network</code>, 'Réseau actif pour l’actif choisi, par ex. TRC20.', 'Oui'],
              [<code>destination_address</code>, 'Adresse compatible avec le réseau.', 'Oui'],
              [<code>fee_bearer</code>, 'sender (défaut) ou recipient.', 'Non'],
              [<code>reference</code>, 'Référence marchande, jusqu’à 128 caractères.', 'Non'],
              [<code>beneficiary_name, beneficiary_email, metadata</code>, 'Données facultatives du bénéficiaire et métadonnées.', 'Non'],
            ]} />
            <p className="mt-2 text-[13px] leading-relaxed text-slate-700">La réponse inclut <code>amount</code>, <code>amount_net</code>, <code>fee</code>, <code>fee_pct</code>, <code>total_debit</code>, <code>coin</code>, <code>network</code>, <code>asset_code</code>, <code>destination_address</code>, <code>provider_id</code>, <code>provider_status</code>, <code>error_code</code> et les horodatages. La disponibilité et les montants dépendent des actifs et réseaux actifs. <code>/bizpush/payouts</code> est un alias de ce retrait crypto; ce n’est pas le retrait Mobile Money <code>/push</code>.</p>
            <h3 className="mt-7 font-cabinet text-lg font-bold text-slate-900">Exemples de réponses</h3>
            <CodeBlock code={`// Dépôt Mobile Money (montants et frais dépendent de l’opérateur)
{
  "id": "pay_...",
  "object": "payment",
  "product": "bizpay_checkout",
  "status": "pending",
  "amount": "12500.00",
  "requested_amount": "12500.00",
  "charged_amount": "12500.00",
  "wallet_credit_amount": "12500.00",
  "fee": "0.00",
  "fee_bearer": "client",
  "currency": "XOF",
  "reference": "ORDER-2048",
  "checkout_url": "https://provider.example/...",
  "simulation_endpoint": null
}`} />
            <CodeBlock code={`// Retrait Mobile Money ou crypto: vérifier le statut après création
{
  "id": "payout_...",
  "object": "payout",
  "status": "pending",
  "amount": "15000.00",
  "fee": "150.00",
  "total_debit": "15150.00",
  "currency": "XOF",
  "reference": "PAYROLL-88"
}`} />
          </section>

          <section id="status" className="scroll-mt-24">
            <h2 className="mt-12 font-cabinet text-2xl font-extrabold text-slate-900">Statuts et suivi</h2>
            <p className="mt-2 text-[14px] leading-relaxed text-slate-700">Une réponse de création signifie que la requête a été enregistrée, pas que les fonds sont déjà reçus ou envoyés. Faites le suivi depuis votre serveur, avec la même clé API, et ne traitez que l’état terminal positif comme une réussite.</p>
            <ApiTable headers={['Opération', 'Lecture de statut', 'Autres lectures']} rows={[
              ['Dépôt crypto ou Mobile Money', 'GET /payments/{id}/status', 'GET /payments/{id}, /completed; GET /payments/search?reference=…; GET /payments?limit=20&offset=0&status=paid'],
              ['Retrait Mobile Money BizPUSH', 'GET /push/{id}/status', 'GET /push/{id}'],
              ['Retrait crypto', 'GET /payouts/{id}/status', 'GET /payouts/{id}, /completed; GET /payouts/search?reference=…; GET /payouts?limit=20&offset=0'],
            ]} />
            <p className="mt-2 text-[13px] leading-relaxed text-slate-700">Toutes ces lectures demandent <code>payments:read</code>. Un dépôt Mobile Money renvoie généralement <code>pending</code>, puis <code>paid</code> ou <code>failed</code>. Le Pay-In crypto peut passer par <code>initiated</code> et <code>confirming</code> avant <code>paid</code>, ou finir en <code>expired</code>, <code>failed</code> ou <code>canceled</code>. Pour les deux retraits, considérez seulement <code>completed</code> comme un succès; <code>pending</code>, <code>processing</code> et <code>sent</code> ne sont pas des confirmations terminales. Les retraits test restent <code>pending</code>, sans endpoint de simulation.</p>
            <CodeBlock code={statusCode} />
            <Info icon={ShieldCheck} title="Reprise après timeout" tone="amber">Si une création expire côté client, renvoyez le même corps avec la même <code>Idempotency-Key</code> afin de retrouver l’opération initiale. N’en créez pas une seconde avant d’avoir vérifié son identifiant et son statut.</Info>
          </section>
          <section id="webhooks" className="scroll-mt-24">
            <h2 className="mt-12 font-cabinet text-2xl font-extrabold text-slate-900">Webhooks signés <span className="text-base font-semibold text-slate-400">(facultatifs)</span></h2>
            <p className="mt-2 text-[14px] leading-relaxed text-slate-700">Configurez une URL de webhook et son secret dans la section API du tableau de bord. Les événements actuellement émis sont <code>payment.created</code>, <code>payment.confirming</code>, <code>payment.completed</code>, <code>payment.failed</code>, <code>payment.expired</code>, <code>mobile_money.payment.approved</code>, <code>mobile_money.payment.declined</code>, <code>mobile_money.payment.canceled</code>, <code>push.succeeded</code> et <code>push.failed</code>. Les événements <code>push.*</code> couvrent BizPUSH Mobile Money. Le retrait crypto <code>/payouts</code> n’émet pas actuellement de webhook : utilisez son endpoint de statut.</p>
            <p className="mt-2 text-[13px] leading-relaxed text-slate-700">Le corps JSON contient <code>id</code>, <code>type</code>, <code>data</code> et <code>created_at</code>. Vérifiez la signature HMAC SHA-256 sur les octets exacts du corps précédés de l’horodatage et d’un point. Utilisez le corps brut, le secret du webhook, l’identifiant d’événement pour dédupliquer et comparez les signatures en temps constant.</p>
            <ApiTable headers={['En-tête', 'Contenu']} rows={[
              ['X-BizTransPay-Signature', 'sha256=<HMAC hexadécimal>'],
              ['X-BizTransPay-Timestamp', 'Horodatage Unix en secondes utilisé pour signer.'],
              ['X-BizTransPay-Event-Id', 'Identifiant à dédupliquer; une livraison peut être retentée.'],
              ['X-BizTransPay-Event-Type', 'Nom de l’événement envoyé.'],
            ]} />
            <Info icon={Webhook} title="Source de vérité" tone="emerald">Ne validez jamais une commande à partir d’une redirection navigateur ou d’une notification téléphone seule. Vérifiez le webhook signé ou confirmez le statut avec l’API et n’exécutez votre logique métier qu’une fois l’opération terminée.</Info>
            <CodeBlock code={`import crypto from 'node:crypto';

// Configurez votre serveur pour conserver les octets HTTP bruts dans req.rawBody.
const rawBody = req.rawBody;
const timestamp = req.headers['x-biztranspay-timestamp'];
const received = Buffer.from(req.headers['x-biztranspay-signature'] || '');
const expected = Buffer.from('sha256=' + crypto
  .createHmac('sha256', process.env.BIZTRANSPAY_WEBHOOK_SECRET)
  .update(timestamp + '.' + rawBody.toString('utf8'))
  .digest('hex'));

if (received.length !== expected.length ||
    !crypto.timingSafeEqual(received, expected)) {
  return res.status(401).end();
}
const event = JSON.parse(rawBody.toString('utf8'));
// Dédupliquer event.id avant d'appliquer les effets métier.
return res.status(200).end();`} />
          </section>
          <section id="errors" className="scroll-mt-24"><h2 className="mt-12 font-cabinet text-2xl font-extrabold text-slate-900">Erreurs et bonnes pratiques</h2><p className="mt-2 text-[14px] leading-relaxed text-slate-700">Les erreurs renvoient un code HTTP et, en général, un corps avec <code>statusCode</code>, <code>message</code>, <code>code</code> et des <code>details</code> facultatifs. Corrigez les erreurs de validation avant de réessayer; pour un timeout ou une erreur amont ambiguë, vérifiez l’opération avec son idempotency key ou son identifiant. La limite configurée est de 100 requêtes par minute et par clé; respectez les en-têtes de limitation renvoyés, dont <code>Retry-After</code> s’il est présent.</p><ApiTable headers={['HTTP / code', 'Quand / action']} rows={[
            ['400', 'Champ requis manquant, devise/opérateur/réseau non pris en charge ou requête invalide.'],
            ['401', 'Clé absente ou invalide. Vérifiez Authorization: Bearer.'],
            ['403', 'Clé désactivée, compte bloqué ou scope manquant.'],
            ['404', 'Identifiant inexistant ou appartenant à un autre compte/environnement.'],
            ['409', 'Conflit : clé d’idempotence réutilisée avec une charge utile différente, paiement déjà payé ou état incompatible.'],
            ['422', 'Format ou contrainte de champ invalide.'],
            ['429', 'Limite de requêtes atteinte; respectez Retry-After si présent.'],
            ['502 / 503', 'Erreur ou indisponibilité fournisseur. Vérifiez le statut avant de créer une autre opération.'],
            ['MISSING_REQUIRED_FIELD', 'La réponse indique missing_fields; ajoutez les champs requis.'],
            ['IDEMPOTENCY_KEY_REQUIRED / IDEMPOTENCY_KEY_REUSED', 'Ajoutez une clé ou réutilisez-la seulement avec le corps original.'],
            ['PAYMENT_METHOD_UNAVAILABLE / CURRENCY_NOT_SUPPORTED', 'Vérifiez le catalogue actif pays/opérateur/devise.'],
            ['PAYMENT_STATUS_UNKNOWN', 'Résultat fournisseur ambigu; consultez le statut, ne créez pas un doublon.'],
            ['INSUFFICIENT_BALANCE / INVALID_ASSET / INVALID_DESTINATION_ADDRESS', 'Corrigez le solde ou le couple actif/réseau/adresse avant de réessayer.'],
          ]} /><Info icon={ShieldCheck} title="Besoin d'une clé ?" >Ouvrez <Link to="/dashboard/api" className="font-semibold text-blue-700 underline">l'espace API</Link> pour créer une clé de test, puis générez une clé live lorsque votre intégration est prête.</Info></section>
      </main>
    </div>
  </div>;
}