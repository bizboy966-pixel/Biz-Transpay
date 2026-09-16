import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, BookOpen, Check, Code2, Copy, Download, KeyRound, Menu, ShieldCheck, Webhook, X } from 'lucide-react';
import { toast } from 'sonner';

const API = `${process.env.REACT_APP_PUBLIC_DOMAIN || 'https://biz-transppayy.com'}/api/v1`;

const products = [
  { id: 'checkout', name: 'BizPay Checkout · PAR', label: 'Redirection', tone: 'blue', path: '/checkout', description: 'Créez une session PAR et redirigez votre client vers la page de paiement Biz-transPay.' },
  { id: 'direct', name: 'BizPay Direct · PSR / SoftPay', label: 'Sans redirection', tone: 'emerald', path: '/direct-payments', description: 'Déclenchez un paiement PSR / SoftPay Mobile Money depuis votre propre interface, sans redirection.' },
  { id: 'push', name: 'BizPUSH', label: 'Envoi automatisé', tone: 'amber', path: '/push', description: 'Envoyez des fonds à un bénéficiaire et suivez le traitement en arrière-plan.' },
];

const examples = {
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
};

const statusCode = `curl ${API}/payments/PAYMENT_ID \\
  -H "Authorization: Bearer sk_test_YOUR_KEY"

curl ${API}/payments/PAYMENT_ID/status \\
  -H "Authorization: Bearer sk_test_YOUR_KEY"

curl ${API}/push/PAYOUT_ID/status \\
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

function ProductExample({ product }) {
  const [lang, setLang] = useState('curl');
  const item = products.find((entry) => entry.id === product);
  return <section id={product} className="scroll-mt-24">
    <div className="flex flex-wrap items-center gap-2">
      <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${item.tone === 'blue' ? 'bg-blue-100 text-blue-700' : item.tone === 'emerald' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-800'}`}>{item.label}</span>
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
  </section>;
}

export default function ApiDocs() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [query, setQuery] = useState('');
  const sections = useMemo(() => [
    ['start', 'Démarrage'], ['auth', 'Authentification'], ['environments', 'Test et live'],
    ['checkout', 'BizPay Checkout'], ['direct', 'BizPay Direct'], ['push', 'BizPUSH'],
    ['status', 'Statuts et suivi'], ['webhooks', 'Webhooks signés'], ['errors', 'Erreurs'],
  ].filter(([, label]) => !query.trim() || label.toLowerCase().includes(query.toLowerCase())), [query]);

  const downloadPdf = () => {
    toast.info('Dans la fenêtre suivante, choisissez « Enregistrer au format PDF ».');
    window.print();
  };

  return <div className="api-docs-page min-h-screen bg-slate-50" data-testid="api-docs-page">
    <style>{`
      @media print {
        @page { size: A4; margin: 14mm; }
        .api-docs-page { background: #fff !important; }
        .api-docs-header, .api-docs-sidebar, .pdf-copy-control { display: none !important; }
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
          <h1 className="mt-3 font-cabinet text-3xl font-extrabold tracking-tight text-slate-900 md:text-4xl">Paiements Mobile Money, sans détour.</h1>
          <p className="mt-3 text-[15px] leading-relaxed text-slate-700">Trois produits pour couvrir le parcours complet : une page hébergée, un paiement dans votre interface, ou un envoi automatisé. Tous les traitements peuvent être asynchrones : utilisez les webhooks et la lecture de statut pour confirmer le résultat.</p>
          <div className="mt-6 grid gap-3 md:grid-cols-3">{products.map((product) => <a href={`#${product.id}`} key={product.id} className="rounded-xl border border-slate-200 bg-white p-4 hover:-translate-y-0.5 hover:border-blue-300 transition-transform"><div className="font-cabinet text-sm font-bold text-slate-900">{product.name}</div><div className="mt-1 text-xs leading-relaxed text-slate-500">{product.description}</div><div className="mt-3 font-mono text-[11px] text-blue-700">POST {product.path}</div></a>)}</div>
        </section>

         <section id="auth" className="scroll-mt-24"><h2 className="mt-12 font-cabinet text-2xl font-extrabold text-slate-900">Authentification</h2><p className="mt-2 text-[14px] leading-relaxed text-slate-700">Envoyez la clé secrète dans l'en-tête Bearer. Les clés secrètes restent sur votre serveur : ne les placez jamais dans une application mobile ou un navigateur.</p><CodeBlock code={`Authorization: Bearer sk_test_YOUR_KEY\nContent-Type: application/json`} /><Info icon={KeyRound} title="Une clé, plusieurs intégrations" tone="blue">Lors de sa création, choisissez les intégrations nécessaires : <code>checkout:create</code> pour PAR, <code>direct:create</code> pour PSR / SoftPay, <code>push:create</code> pour BizPUSH et <code>payments:read</code> pour consulter les statuts et automatiser votre traitement. Le webhook est facultatif.</Info><Info icon={KeyRound} title="Clé et idempotence" tone="amber">Ajoutez une <code>Idempotency-Key</code> unique par tentative métier sur chaque requête POST. Une nouvelle tentative réseau avec la même clé ne créera pas un second paiement.</Info></section>
        <section id="environments" className="scroll-mt-24"><h2 className="mt-12 font-cabinet text-2xl font-extrabold text-slate-900">Test et live</h2><p className="mt-2 text-[14px] leading-relaxed text-slate-700">La base URL reste la même. L'environnement est porté par le préfixe de la clé : <code className="font-mono text-blue-700">sk_test_</code> simule le parcours sans appel fournisseur, débit ou crédit réel ; <code className="font-mono text-emerald-700">sk_live_</code> traite les opérations de production. Les données et clés d'idempotence des deux environnements sont isolées. Créez et révoquez vos clés depuis <Link to="/dashboard/api" className="font-semibold text-blue-700 underline">Clés API</Link>.</p><Info icon={ShieldCheck} title="Simuler un paiement confirmé" tone="blue">Après avoir créé un Checkout ou un paiement Direct avec une clé test, appelez le chemin <code>simulation_endpoint</code> renvoyé dans la réponse avec la même clé. Biz-transPay passera l'opération à <code>paid</code> et enverra un webhook de test, sans modifier aucun solde réel.</Info><CodeBlock code={`curl -X POST ${API}/test/payments/PAYMENT_ID/complete \\
  -H "Authorization: Bearer sk_test_YOUR_KEY"`} /></section>

        <div className="space-y-14 mt-12"><ProductExample product="checkout" /><ProductExample product="direct" /><ProductExample product="push" /></div>

        <section id="status" className="scroll-mt-24"><h2 className="mt-12 font-cabinet text-2xl font-extrabold text-slate-900">Statuts et suivi</h2><p className="mt-2 text-[14px] leading-relaxed text-slate-700">Une réponse d'acceptation indique que la demande est enregistrée, pas nécessairement que l'argent est arrivé. Conservez l'identifiant, écoutez le webhook, puis confirmez avec une lecture serveur-à-serveur. Checkout et Direct utilisent <code>GET /payments/{'{id}'}</code>. BizPUSH utilise <code>GET /push/{'{id}'}</code>.</p><CodeBlock code={statusCode} /><div className="grid gap-3 sm:grid-cols-3">{[['pending', 'Traitement en cours'], ['paid', 'Paiement confirmé'], ['failed', 'Opération refusée']].map(([key, text]) => <div key={key} className="rounded-xl border border-slate-200 bg-white p-3"><code className="font-mono text-xs font-bold text-slate-900">{key}</code><p className="mt-1 text-xs text-slate-500">{text}</p></div>)}</div></section>
         <section id="webhooks" className="scroll-mt-24"><h2 className="mt-12 font-cabinet text-2xl font-extrabold text-slate-900">Webhooks signés <span className="text-base font-semibold text-slate-400">(optionnels)</span></h2><p className="mt-2 text-[14px] leading-relaxed text-slate-700">Les webhooks sont facultatifs. Vous pouvez intégrer Biz-transPay avec une seule clé API complète et interroger <code>GET /payments/{'{id}'}</code>, <code>GET /payments/{'{id}'}/status</code> ou <code>GET /push/{'{id}'}/status</code> jusqu'à la confirmation finale. Si vous activez les webhooks, Biz-transPay envoie les changements de statut avec une signature HMAC dans <code>X-BizTransPay-Signature</code> et l'heure dans <code>X-BizTransPay-Timestamp</code>.</p><Info icon={Webhook} title="Source de vérité" tone="emerald">Le webhook accélère la mise à jour de votre commande, mais il n'est pas obligatoire. Dans tous les cas, vérifiez le statut côté serveur avant de livrer un bien ou de considérer une transaction comme terminée. Le crédit ou le rejet financier est effectué par Biz-transPay après confirmation sécurisée du prestataire.</Info><CodeBlock code={`const signature = req.headers['x-biztranspay-signature'];
const timestamp = req.headers['x-biztranspay-timestamp'];
const expected = 'sha256=' + hmacSha256(
  process.env.BIZTRANSPAY_WEBHOOK_SECRET,
  timestamp + '.' + rawBody
);
if (!timingSafeEqual(signature, expected)) return res.status(401).end();
return res.status(204).end();`} /></section>
        <section id="errors" className="scroll-mt-24"><h2 className="mt-12 font-cabinet text-2xl font-extrabold text-slate-900">Erreurs et bonnes pratiques</h2><ul className="mt-3 space-y-2 text-[14px] leading-relaxed text-slate-700"><li><strong>401</strong> : clé absente, invalide ou désactivée.</li><li><strong>409</strong> : même Idempotency-Key avec un corps différent.</li><li><strong>422</strong> : données métier à corriger avant de réessayer.</li><li>Ne faites pas confiance à une redirection navigateur pour confirmer un paiement.</li><li>Journalisez votre référence métier et l'identifiant Biz-transPay, jamais la clé secrète.</li></ul><Info icon={ShieldCheck} title="Besoin d'une clé ?" >Ouvrez <Link to="/dashboard/api" className="font-semibold text-blue-700 underline">l'espace API</Link> pour créer une clé de test, puis générez une clé live lorsque votre intégration est prête.</Info></section>
      </main>
    </div>
  </div>;
}