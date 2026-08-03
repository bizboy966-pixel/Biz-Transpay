import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Book, Copy, Check, ChevronRight, Search, Menu, X, Code2, Zap, ShieldCheck, KeyRound, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

const API = `${process.env.REACT_APP_BACKEND_URL}/api/v1`;

/* --------------------------- CodeBlock w/ Copy --------------------------- */
const CodeBlock = ({ code, lang = 'bash' }) => {
  const [copied, setCopied] = useState(false);
  const doCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    toast.success('Copié');
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="relative group my-3">
      <div className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <button onClick={doCopy} className="px-2 py-1 rounded-md bg-slate-800/80 text-slate-100 text-[11px] font-semibold hover:bg-slate-700 flex items-center gap-1">
          {copied ? <><Check className="w-3 h-3" /> Copié</> : <><Copy className="w-3 h-3" /> Copier</>}
        </button>
      </div>
      <pre className="p-4 rounded-xl bg-slate-950 text-slate-100 font-mono text-[12px] leading-relaxed overflow-x-auto">
        <code className={`language-${lang}`}>{code}</code>
      </pre>
    </div>
  );
};

/* ----------------------------- Language tabs ---------------------------- */
const LangTabs = ({ items }) => {
  const [tab, setTab] = useState(items[0].lang);
  const active = items.find(i => i.lang === tab) || items[0];
  return (
    <div className="my-3">
      <div className="flex items-center flex-wrap gap-1 mb-2 border-b border-slate-200">
        {items.map(i => (
          <button
            key={i.lang}
            data-testid={`lang-${i.lang}`}
            onClick={() => setTab(i.lang)}
            className={`px-3 py-1.5 text-[12px] font-semibold rounded-t-md transition-colors ${tab === i.lang ? 'text-slate-900 border-b-2 border-slate-900 -mb-px' : 'text-slate-500 hover:text-slate-800'}`}>
            {i.label}
          </button>
        ))}
      </div>
      <CodeBlock code={active.code} lang={active.lang} />
    </div>
  );
};

/* --------------------- Left sidebar table of contents -------------------- */
const SECTIONS = [
  { id: 'intro', label: 'Présentation', group: 'Getting Started' },
  { id: 'auth', label: 'Authentification', group: 'Getting Started' },
  { id: 'base-url', label: 'Base URL', group: 'Getting Started' },
  { id: 'api-keys', label: 'Clés API', group: 'Getting Started' },
  { id: 'sandbox', label: 'Sandbox & Production', group: 'Getting Started' },
  { id: 'create-payment', label: 'Créer un paiement', group: 'Paiements' },
  { id: 'get-payment', label: 'Vérifier le statut', group: 'Paiements' },
  { id: 'search-payment', label: 'Rechercher une transaction', group: 'Paiements' },
  { id: 'list-payments', label: 'Liste des transactions', group: 'Paiements' },
  { id: 'cancel-payment', label: 'Annuler une transaction', group: 'Paiements' },
  { id: 'pagination', label: 'Pagination', group: 'Paiements' },
  { id: 'errors', label: 'Gestion des erreurs', group: 'Références' },
  { id: 'http-codes', label: 'Codes HTTP', group: 'Références' },
  { id: 'idempotency', label: 'Idempotence', group: 'Références' },
  { id: 'rate-limits', label: 'Rate Limits', group: 'Références' },
  { id: 'best-practices', label: 'Bonnes pratiques', group: 'Références' },
  { id: 'faq', label: 'FAQ', group: 'Références' },
];

/* --------------------- Language example generators ---------------------- */
const createPaymentExamples = () => {
  const body = { amount: 25, coin: 'USDT', reference: 'ORDER-42', customer_email: 'client@example.com' };
  const bodyStr = JSON.stringify(body, null, 2);
  const url = `${API}/payments`;
  return [
    { lang: 'curl', label: 'cURL', code:
`curl -X POST ${url} \\
  -H "Authorization: Bearer sk_test_YOUR_KEY" \\
  -H "Idempotency-Key: order-42-attempt-1" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(body)}'` },
    { lang: 'js', label: 'JavaScript', code:
`const res = await fetch('${url}', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer sk_test_YOUR_KEY',
    'Idempotency-Key': 'order-42-attempt-1',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(${bodyStr}),
});
const payment = await res.json();
console.log(payment.payment_url);` },
    { lang: 'node', label: 'Node.js', code:
`import axios from 'axios';

const { data } = await axios.post(
  '${url}',
  ${bodyStr},
  {
    headers: {
      Authorization: 'Bearer sk_test_YOUR_KEY',
      'Idempotency-Key': 'order-42-attempt-1',
    },
  },
);
console.log('Redirect customer to:', data.payment_url);` },
    { lang: 'php', label: 'PHP', code:
`<?php
$ch = curl_init('${url}');
curl_setopt_array($ch, [
  CURLOPT_POST => true,
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => [
    'Authorization: Bearer sk_test_YOUR_KEY',
    'Idempotency-Key: order-42-attempt-1',
    'Content-Type: application/json',
  ],
  CURLOPT_POSTFIELDS => json_encode(${JSON.stringify(body)}),
]);
$response = json_decode(curl_exec($ch), true);
curl_close($ch);
echo $response['payment_url'];` },
    { lang: 'python', label: 'Python', code:
`import requests

payment = requests.post(
    '${url}',
    json=${bodyStr.replace(/"/g, "'")},
    headers={
        'Authorization': 'Bearer sk_test_YOUR_KEY',
        'Idempotency-Key': 'order-42-attempt-1',
    },
).json()

print('Redirect customer to:', payment['payment_url'])` },
    { lang: 'java', label: 'Java', code:
`import java.net.http.*;
import java.net.URI;

var body = """
${bodyStr}
""";
var request = HttpRequest.newBuilder()
    .uri(URI.create("${url}"))
    .header("Authorization", "Bearer sk_test_YOUR_KEY")
    .header("Idempotency-Key", "order-42-attempt-1")
    .header("Content-Type", "application/json")
    .POST(HttpRequest.BodyPublishers.ofString(body))
    .build();

var response = HttpClient.newHttpClient()
    .send(request, HttpResponse.BodyHandlers.ofString());
System.out.println(response.body());` },
    { lang: 'csharp', label: 'C#', code:
`using System.Net.Http.Json;

var http = new HttpClient();
http.DefaultRequestHeaders.Add("Authorization", "Bearer sk_test_YOUR_KEY");
http.DefaultRequestHeaders.Add("Idempotency-Key", "order-42-attempt-1");

var payment = await http.PostAsJsonAsync(
    "${url}",
    new { amount = 25, coin = "USDT", reference = "ORDER-42", customer_email = "client@example.com" }
);

var result = await payment.Content.ReadFromJsonAsync<Dictionary<string, object>>();
Console.WriteLine(result["payment_url"]);` },
  ];
};

const getStatusExamples = () => {
  const url = `${API}/payments/{id}/status`;
  return [
    { lang: 'curl', label: 'cURL', code:
`curl ${url} \\
  -H "Authorization: Bearer sk_test_YOUR_KEY"` },
    { lang: 'js', label: 'JavaScript', code:
`const res = await fetch('${url.replace('{id}', 'PAYMENT_ID')}', {
  headers: { Authorization: 'Bearer sk_test_YOUR_KEY' },
});
const { status, completed } = await res.json();` },
    { lang: 'node', label: 'Node.js', code:
`const { data } = await axios.get('${url.replace('{id}', 'PAYMENT_ID')}', {
  headers: { Authorization: 'Bearer sk_test_YOUR_KEY' },
});
if (data.status === 'paid') { /* fulfill order */ }` },
    { lang: 'php', label: 'PHP', code:
`<?php
$ch = curl_init('${url.replace('{id}', 'PAYMENT_ID')}');
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => ['Authorization: Bearer sk_test_YOUR_KEY'],
]);
$status = json_decode(curl_exec($ch), true);
curl_close($ch);` },
    { lang: 'python', label: 'Python', code:
`import requests

status = requests.get(
    '${url.replace('{id}', 'PAYMENT_ID')}',
    headers={'Authorization': 'Bearer sk_test_YOUR_KEY'},
).json()

if status['status'] == 'paid':
    fulfill_order()` },
    { lang: 'java', label: 'Java', code:
`var request = HttpRequest.newBuilder()
    .uri(URI.create("${url.replace('{id}', 'PAYMENT_ID')}"))
    .header("Authorization", "Bearer sk_test_YOUR_KEY")
    .GET()
    .build();

var response = HttpClient.newHttpClient()
    .send(request, HttpResponse.BodyHandlers.ofString());` },
    { lang: 'csharp', label: 'C#', code:
`http.DefaultRequestHeaders.Add("Authorization", "Bearer sk_test_YOUR_KEY");
var res = await http.GetFromJsonAsync<Dictionary<string, object>>(
    "${url.replace('{id}', 'PAYMENT_ID')}"
);
if (res["status"].ToString() == "paid") { /* fulfill order */ }` },
  ];
};

const searchExamples = () => [
  { lang: 'curl', label: 'cURL', code:
`curl "${API}/payments/search?reference=ORDER-42" \\
  -H "Authorization: Bearer sk_test_YOUR_KEY"` },
  { lang: 'node', label: 'Node.js', code:
`const { data } = await axios.get('${API}/payments/search', {
  params: { reference: 'ORDER-42' },
  headers: { Authorization: 'Bearer sk_test_YOUR_KEY' },
});` },
  { lang: 'python', label: 'Python', code:
`payment = requests.get(
    '${API}/payments/search',
    params={'reference': 'ORDER-42'},
    headers={'Authorization': 'Bearer sk_test_YOUR_KEY'},
).json()` },
];

const listExamples = () => [
  { lang: 'curl', label: 'cURL', code:
`curl "${API}/payments?limit=20&offset=0&status=paid" \\
  -H "Authorization: Bearer sk_test_YOUR_KEY"` },
  { lang: 'node', label: 'Node.js', code:
`const { data } = await axios.get('${API}/payments', {
  params: { limit: 20, offset: 0, status: 'paid' },
  headers: { Authorization: 'Bearer sk_test_YOUR_KEY' },
});
console.log(\`Page: \${data.data.length} / Total: \${data.total}\`);` },
  { lang: 'python', label: 'Python', code:
`page = requests.get(
    '${API}/payments',
    params={'limit': 20, 'offset': 0, 'status': 'paid'},
    headers={'Authorization': 'Bearer sk_test_YOUR_KEY'},
).json()

for payment in page['data']:
    print(payment['id'], payment['status'])` },
];

const cancelExamples = () => [
  { lang: 'curl', label: 'cURL', code:
`curl -X POST ${API}/payments/PAYMENT_ID/cancel \\
  -H "Authorization: Bearer sk_test_YOUR_KEY"` },
  { lang: 'node', label: 'Node.js', code:
`await axios.post('${API}/payments/PAYMENT_ID/cancel', null, {
  headers: { Authorization: 'Bearer sk_test_YOUR_KEY' },
});` },
];

/* ------------------------------ Content ------------------------------- */
function InfoCard({ tone = 'blue', icon: Icon, title, children }) {
  const tones = {
    blue: 'bg-blue-50 border-blue-200 text-blue-900',
    amber: 'bg-amber-50 border-amber-200 text-amber-900',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-900',
    red: 'bg-red-50 border-red-200 text-red-900',
  };
  return (
    <div className={`my-4 p-4 rounded-xl border ${tones[tone]} flex gap-3`}>
      {Icon && <div className="shrink-0"><Icon className="w-5 h-5 mt-0.5" /></div>}
      <div>
        {title && <div className="font-semibold text-sm mb-1">{title}</div>}
        <div className="text-[13px] leading-relaxed">{children}</div>
      </div>
    </div>
  );
}

function ResponseBlock({ status, body }) {
  return (
    <div className="my-3 rounded-xl overflow-hidden border border-slate-200">
      <div className="px-4 py-2 bg-slate-100 flex items-center gap-2 text-[11px] font-semibold text-slate-700">
        <span className={`inline-flex items-center px-2 py-0.5 rounded-md ${status < 300 ? 'bg-emerald-100 text-emerald-700' : status < 500 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>{status}</span>
        Response
      </div>
      <pre className="p-4 bg-slate-950 text-slate-100 font-mono text-[12px] overflow-x-auto"><code>{JSON.stringify(body, null, 2)}</code></pre>
    </div>
  );
}

const H2 = ({ id, children }) => (
  <h2 id={id} className="scroll-mt-24 font-cabinet text-2xl md:text-3xl font-extrabold text-slate-900 mt-10 mb-3">{children}</h2>
);
const H3 = ({ children }) => <h3 className="font-cabinet text-lg font-bold text-slate-900 mt-6 mb-2">{children}</h3>;
const P = ({ children }) => <p className="text-[14px] text-slate-700 leading-relaxed my-2">{children}</p>;

/* -------------------------------- Page --------------------------------- */
export default function ApiDocs() {
  const [active, setActive] = useState('intro');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [q, setQ] = useState('');
  const refs = useRef({});

  useEffect(() => {
    const obs = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) setActive(e.target.id); });
    }, { rootMargin: '-30% 0px -60% 0px' });
    SECTIONS.forEach(s => {
      const el = document.getElementById(s.id);
      if (el) obs.observe(el);
    });
    return () => obs.disconnect();
  }, []);

  const filteredSections = useMemo(() => {
    if (!q.trim()) return SECTIONS;
    const nq = q.toLowerCase();
    return SECTIONS.filter(s => s.label.toLowerCase().includes(nq) || s.group.toLowerCase().includes(nq));
  }, [q]);

  const grouped = useMemo(() => {
    const g = {};
    filteredSections.forEach(s => { (g[s.group] = g[s.group] || []).push(s); });
    return g;
  }, [filteredSections]);

  return (
    <div className="min-h-screen bg-slate-50" data-testid="api-docs-page">
      {/* Top bar */}
      <header className="sticky top-0 z-30 bg-white/85 backdrop-blur-md border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-5 py-3 flex items-center gap-4">
          <button onClick={() => setMobileNavOpen(v => !v)} className="lg:hidden w-9 h-9 rounded-lg border border-slate-200 flex items-center justify-center">
            {mobileNavOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
          </button>
          <Link to="/dashboard/api" data-testid="link-back-api" className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-slate-600 hover:text-slate-900">
            <ArrowLeft className="w-4 h-4" /> Retour aux clés
          </Link>
          <div className="hidden md:flex items-center gap-2">
            <Book className="w-4 h-4 text-slate-400" />
            <div className="font-cabinet font-extrabold text-slate-900 text-sm">API Biz-transPay <span className="text-slate-400 font-normal">v1</span></div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div className="hidden md:flex items-center gap-2 bg-slate-100 rounded-lg px-3 py-1.5">
              <Search className="w-4 h-4 text-slate-400" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher…" className="bg-transparent focus:outline-none text-sm w-52" data-testid="input-search" />
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-0 lg:px-5 flex">
        {/* Sidebar */}
        <aside className={`fixed lg:sticky top-14 lg:top-16 left-0 z-20 h-[calc(100vh-3.5rem)] lg:h-[calc(100vh-4rem)] w-64 bg-white lg:bg-transparent border-r border-slate-200 lg:border-none overflow-y-auto shrink-0 transition-transform duration-300 ${mobileNavOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>
          <nav className="p-4 space-y-4">
            {Object.entries(grouped).map(([group, items]) => (
              <div key={group}>
                <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">{group}</div>
                <div className="space-y-0.5">
                  {items.map(s => (
                    <a
                      key={s.id}
                      href={`#${s.id}`}
                      data-testid={`nav-${s.id}`}
                      onClick={() => { setMobileNavOpen(false); }}
                      className={`flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg text-[13px] transition-colors ${active === s.id ? 'bg-slate-900 text-white font-semibold' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}>
                      <span>{s.label}</span>
                      {active === s.id && <ChevronRight className="w-3 h-3" />}
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </nav>
        </aside>

        {/* Main content */}
        <main className="flex-1 min-w-0 px-5 lg:px-8 py-6 lg:py-10 max-w-3xl mx-auto lg:mx-0">
          {/* ---- Intro ---- */}
          <section id="intro" className="scroll-mt-24">
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-blue-100 text-blue-700 text-[11px] font-semibold">
              <Code2 className="w-3 h-3" /> API REST · v1
            </div>
            <h1 className="mt-3 font-cabinet text-3xl md:text-4xl font-extrabold text-slate-900">Documentation Biz-transPay</h1>
            <P>
              Bienvenue dans la documentation officielle de l'API Biz-transPay.
              Encaissez des paiements crypto (USDT et 40+ actifs, TRC20/BEP20/ERC20)
              via une API REST simple, sans avoir à gérer vous-même de portefeuilles,
              d'adresses ou de webhooks.
            </P>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
              <div className="p-4 rounded-xl bg-white border border-slate-200">
                <Zap className="w-5 h-5 text-blue-600 mb-2" />
                <div className="font-semibold text-slate-900 text-sm">Intégration éclair</div>
                <div className="text-[12px] text-slate-500 mt-1">Un `POST /payments` et vous recevez un lien de paiement prêt.</div>
              </div>
              <div className="p-4 rounded-xl bg-white border border-slate-200">
                <ShieldCheck className="w-5 h-5 text-emerald-600 mb-2" />
                <div className="font-semibold text-slate-900 text-sm">Sans webhooks</div>
                <div className="text-[12px] text-slate-500 mt-1">Interrogez le statut à votre rythme via `GET /payments/{'{id}'}/status`.</div>
              </div>
              <div className="p-4 rounded-xl bg-white border border-slate-200">
                <KeyRound className="w-5 h-5 text-amber-600 mb-2" />
                <div className="font-semibold text-slate-900 text-sm">Clés isolées</div>
                <div className="text-[12px] text-slate-500 mt-1">Vos clés Biz-transPay uniquement. Aucun accès aux passerelles amont.</div>
              </div>
            </div>
          </section>

          {/* ---- Auth ---- */}
          <H2 id="auth">Authentification</H2>
          <P>
            Toutes les requêtes doivent porter un en-tête <code className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-800 font-mono text-[12px]">Authorization</code>
            avec votre clé secrète en Bearer :
          </P>
          <CodeBlock code={`Authorization: Bearer sk_test_YOUR_KEY`} />
          <InfoCard tone="amber" icon={AlertTriangle} title="Ne jamais exposer votre clé secrète">
            Les clés <code>sk_live_…</code> permettent de charger vos clients réels. Utilisez-les uniquement côté serveur.
            Si une clé est compromise, révoquez-la immédiatement depuis <Link to="/dashboard/api" className="underline font-semibold">votre tableau de bord</Link>.
          </InfoCard>

          {/* ---- Base URL ---- */}
          <H2 id="base-url">Base URL</H2>
          <P>Tous les endpoints utilisent la même base URL :</P>
          <CodeBlock code={API} />
          <P>Aucun endpoint <code>/sandbox</code> distinct — l'environnement est déterminé par le préfixe de votre clé.</P>

          {/* ---- API Keys ---- */}
          <H2 id="api-keys">Clés API</H2>
          <P>Deux types de clés sont disponibles :</P>
          <div className="overflow-x-auto my-3">
            <table className="w-full text-sm border border-slate-200 rounded-lg overflow-hidden">
              <thead className="bg-slate-100 text-left text-[12px] font-semibold text-slate-700">
                <tr>
                  <th className="px-4 py-2">Préfixe</th>
                  <th className="px-4 py-2">Environnement</th>
                  <th className="px-4 py-2">Utilisation</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-[13px]">
                <tr>
                  <td className="px-4 py-2 font-mono text-blue-700">sk_test_…</td>
                  <td className="px-4 py-2">Sandbox</td>
                  <td className="px-4 py-2">Développement, tests, aucune charge réelle</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-mono text-emerald-700">sk_live_…</td>
                  <td className="px-4 py-2">Production</td>
                  <td className="px-4 py-2">Encaisse de vrais paiements clients</td>
                </tr>
              </tbody>
            </table>
          </div>
          <InfoCard tone="blue" title="Reveal one-time">
            Lorsque vous créez une clé, la valeur complète (<code>sk_...</code>) n'est affichée <strong>qu'une seule fois</strong>.
            Copiez-la immédiatement — nous n'en gardons qu'un hash côté serveur.
            Si vous la perdez, régénérez-la depuis le tableau de bord (l'ancienne cesse alors de fonctionner).
          </InfoCard>

          {/* ---- Sandbox ---- */}
          <H2 id="sandbox">Sandbox & Production</H2>
          <P>
            L'API distingue Sandbox et Production uniquement par le préfixe de votre clé.
            Utilisez <code className="font-mono">sk_test_…</code> pour votre intégration puis basculez
            simplement à <code className="font-mono">sk_live_…</code> — sans changer d'URL ni de logique.
          </P>
          <P>Vos clés Sandbox et Production sont indépendantes et n'affectent jamais les mêmes données.</P>

          {/* ---- Create payment ---- */}
          <H2 id="create-payment">Créer un paiement</H2>
          <div className="flex items-center gap-2 text-[12px] font-semibold my-2">
            <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-700">POST</span>
            <code className="font-mono text-slate-700">/v1/payments</code>
          </div>
          <P>Crée une nouvelle intention de paiement crypto. Retourne un <code>payment_url</code> vers lequel rediriger votre client.</P>

          <H3>Paramètres</H3>
          <div className="overflow-x-auto my-3">
            <table className="w-full text-sm border border-slate-200 rounded-lg overflow-hidden">
              <thead className="bg-slate-100 text-left text-[12px] font-semibold text-slate-700">
                <tr>
                  <th className="px-4 py-2">Champ</th>
                  <th className="px-4 py-2">Type</th>
                  <th className="px-4 py-2">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-[13px]">
                <tr><td className="px-4 py-2 font-mono">amount <span className="text-red-500">*</span></td><td className="px-4 py-2">number</td><td className="px-4 py-2">Montant à encaisser (≥ 1)</td></tr>
                <tr><td className="px-4 py-2 font-mono">coin</td><td className="px-4 py-2">string</td><td className="px-4 py-2">Actif crypto — défaut <code>USDT</code></td></tr>
                <tr><td className="px-4 py-2 font-mono">accepted_networks</td><td className="px-4 py-2">string[]</td><td className="px-4 py-2">Réseaux autorisés — défaut <code>["TRC20","BEP20","ERC20"]</code></td></tr>
                <tr><td className="px-4 py-2 font-mono">reference</td><td className="px-4 py-2">string</td><td className="px-4 py-2">Votre référence interne (n° commande, etc.)</td></tr>
                <tr><td className="px-4 py-2 font-mono">customer_email</td><td className="px-4 py-2">string</td><td className="px-4 py-2">Email du client</td></tr>
                <tr><td className="px-4 py-2 font-mono">return_url</td><td className="px-4 py-2">string</td><td className="px-4 py-2">URL de redirection post-paiement</td></tr>
                <tr><td className="px-4 py-2 font-mono">metadata</td><td className="px-4 py-2">object</td><td className="px-4 py-2">Métadonnées libres attachées à la transaction</td></tr>
              </tbody>
            </table>
          </div>

          <H3>Exemples de requête</H3>
          <LangTabs items={createPaymentExamples()} />

          <H3>Réponse (200)</H3>
          <ResponseBlock status={200} body={{
            id: 'pay_9f8a2c7b',
            status: 'initiated',
            coin: 'USDT',
            amount: '25.00',
            reference: 'ORDER-42',
            payment_url: 'https://checkout.pay.izichange.com/pay/…',
            accepted_networks: ['TRC20', 'BEP20', 'ERC20'],
            expires_at: '2026-08-03T18:25:40Z',
            created_at: '2026-08-03T18:15:40Z',
          }} />

          {/* ---- Get status ---- */}
          <H2 id="get-payment">Vérifier le statut d'un paiement</H2>
          <div className="flex items-center gap-2 text-[12px] font-semibold my-2">
            <span className="px-2 py-0.5 rounded bg-blue-100 text-blue-700">GET</span>
            <code className="font-mono text-slate-700">/v1/payments/{'{id}'}/status</code>
          </div>
          <P>Endpoint léger pour interroger l'état actuel d'un paiement. Idéal pour le polling.</P>
          <LangTabs items={getStatusExamples()} />
          <ResponseBlock status={200} body={{
            id: 'pay_9f8a2c7b',
            status: 'paid',
            updated_at: '2026-08-03T18:18:12Z',
          }} />
          <H3>Endpoint alternatif — booléen</H3>
          <P>Pour un check binaire :</P>
          <CodeBlock code={`GET ${API}/payments/{id}/completed
→ { "id": "…", "completed": true, "status": "paid" }`} />
          <H3>Endpoint alternatif — détails complets</H3>
          <CodeBlock code={`GET ${API}/payments/{id}
→ objet Payment complet (voir schéma "Créer un paiement")`} />

          <div className="overflow-x-auto my-3">
            <table className="w-full text-sm border border-slate-200 rounded-lg overflow-hidden">
              <thead className="bg-slate-100 text-left text-[12px] font-semibold text-slate-700">
                <tr>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Signification</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-[13px]">
                <tr><td className="px-4 py-2 font-mono text-slate-700">initiated</td><td className="px-4 py-2">Créé, en attente que le client envoie les crypto</td></tr>
                <tr><td className="px-4 py-2 font-mono text-blue-700">confirming</td><td className="px-4 py-2">Transaction on-chain détectée, en attente de confirmations</td></tr>
                <tr><td className="px-4 py-2 font-mono text-emerald-700">paid</td><td className="px-4 py-2">Paiement encaissé et crédité ✅</td></tr>
                <tr><td className="px-4 py-2 font-mono text-amber-700">expired</td><td className="px-4 py-2">Délai dépassé (10 min)</td></tr>
                <tr><td className="px-4 py-2 font-mono text-red-700">failed</td><td className="px-4 py-2">Rejeté par la passerelle</td></tr>
                <tr><td className="px-4 py-2 font-mono text-slate-500">canceled</td><td className="px-4 py-2">Annulé via <code>POST /payments/{'{id}'}/cancel</code></td></tr>
              </tbody>
            </table>
          </div>
          <InfoCard tone="emerald" icon={ShieldCheck} title="Synchronisation automatique">
            Chaque appel à un endpoint de statut déclenche une synchronisation en arrière-plan avec la passerelle amont
            — vous obtenez toujours l'état le plus récent, sans avoir à configurer de webhook.
          </InfoCard>

          {/* ---- Search ---- */}
          <H2 id="search-payment">Rechercher une transaction</H2>
          <div className="flex items-center gap-2 text-[12px] font-semibold my-2">
            <span className="px-2 py-0.5 rounded bg-blue-100 text-blue-700">GET</span>
            <code className="font-mono text-slate-700">/v1/payments/search?reference=…</code>
          </div>
          <P>Retrouvez un paiement par votre référence interne (le paramètre <code>reference</code> passé lors de la création).</P>
          <LangTabs items={searchExamples()} />

          {/* ---- List ---- */}
          <H2 id="list-payments">Lister les transactions</H2>
          <div className="flex items-center gap-2 text-[12px] font-semibold my-2">
            <span className="px-2 py-0.5 rounded bg-blue-100 text-blue-700">GET</span>
            <code className="font-mono text-slate-700">/v1/payments</code>
          </div>
          <P>Liste paginée des paiements. Filtres <code>status</code>, <code>reference</code>.</P>
          <LangTabs items={listExamples()} />
          <ResponseBlock status={200} body={{
            data: [
              { id: 'pay_9f8a2c7b', status: 'paid', amount: '25.00', coin: 'USDT', reference: 'ORDER-42', created_at: '…' },
              { id: 'pay_1e2b3c4d', status: 'initiated', amount: '10.00', coin: 'USDT', reference: 'ORDER-41', created_at: '…' },
            ],
            count: 2,
            total: 34,
            offset: 0,
            limit: 20,
            has_more: true,
          }} />

          {/* ---- Cancel ---- */}
          <H2 id="cancel-payment">Annuler une transaction</H2>
          <div className="flex items-center gap-2 text-[12px] font-semibold my-2">
            <span className="px-2 py-0.5 rounded bg-red-100 text-red-700">POST</span>
            <code className="font-mono text-slate-700">/v1/payments/{'{id}'}/cancel</code>
          </div>
          <P>Annule un paiement <code>initiated</code> ou <code>confirming</code> qui n'a pas encore été payé.
          Un paiement déjà <code>paid</code> ne peut pas être annulé — vous devez alors procéder à un remboursement hors API.</P>
          <LangTabs items={cancelExamples()} />
          <ResponseBlock status={200} body={{ id: 'pay_9f8a2c7b', status: 'canceled', canceled_at: '2026-08-03T18:19:00Z' }} />
          <InfoCard tone="amber" icon={AlertTriangle} title="Course avec le client">
            Avant de marquer comme annulé, nous re-synchronisons systématiquement avec la passerelle
            amont pour éviter d'annuler un paiement qui vient d'être crédité.
            Si le client a payé entre-temps, vous recevez <code>409 PAYMENT_ALREADY_PAID</code>.
          </InfoCard>

          {/* ---- Pagination ---- */}
          <H2 id="pagination">Pagination</H2>
          <P>
            L'endpoint <code>GET /v1/payments</code> utilise la pagination classique <code>offset</code>/<code>limit</code>.
            La réponse inclut <code>total</code>, <code>has_more</code>, <code>offset</code>, <code>limit</code>.
          </P>
          <CodeBlock code={`GET /v1/payments?limit=20&offset=0    # première page
GET /v1/payments?limit=20&offset=20   # deuxième page
GET /v1/payments?limit=100            # max 200 par page`} />

          {/* ---- Errors ---- */}
          <H2 id="errors">Gestion des erreurs</H2>
          <P>Toutes les erreurs suivent un format uniforme :</P>
          <CodeBlock code={`{
  "statusCode": 400,
  "message": "Description lisible du problème",
  "code": "MACHINE_CODE",
  "details": { /* optionnel — contexte upstream */ }
}`} />

          <H3>Codes machine</H3>
          <div className="overflow-x-auto my-3">
            <table className="w-full text-sm border border-slate-200 rounded-lg overflow-hidden">
              <thead className="bg-slate-100 text-left text-[12px] font-semibold text-slate-700">
                <tr><th className="px-4 py-2">Code</th><th className="px-4 py-2">Description</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-[13px]">
                <tr><td className="px-4 py-2 font-mono">MISSING_AUTH_HEADER</td><td className="px-4 py-2">Header <code>Authorization</code> absent</td></tr>
                <tr><td className="px-4 py-2 font-mono">INVALID_API_KEY_FORMAT</td><td className="px-4 py-2">La clé ne commence pas par <code>sk_test_</code> ni <code>sk_live_</code></td></tr>
                <tr><td className="px-4 py-2 font-mono">INVALID_API_KEY</td><td className="px-4 py-2">Clé inconnue ou révoquée</td></tr>
                <tr><td className="px-4 py-2 font-mono">API_KEY_DISABLED</td><td className="px-4 py-2">La clé a été désactivée par le marchand</td></tr>
                <tr><td className="px-4 py-2 font-mono">API_KEY_SUSPENDED</td><td className="px-4 py-2">Compte suspendu par l'administrateur</td></tr>
                <tr><td className="px-4 py-2 font-mono">AMOUNT_TOO_SMALL</td><td className="px-4 py-2">Montant inférieur au minimum (1 USDT)</td></tr>
                <tr><td className="px-4 py-2 font-mono">IDEMPOTENCY_KEY_TOO_LONG</td><td className="px-4 py-2">Idempotency-Key {'>'} 255 caractères</td></tr>
                <tr><td className="px-4 py-2 font-mono">GATEWAY_UNAVAILABLE</td><td className="px-4 py-2">Passerelle crypto non configurée (temporaire)</td></tr>
                <tr><td className="px-4 py-2 font-mono">GATEWAY_REJECTED</td><td className="px-4 py-2">La passerelle amont a refusé la requête (<code>details</code> pour le pourquoi)</td></tr>
                <tr><td className="px-4 py-2 font-mono">PAYMENT_NOT_FOUND</td><td className="px-4 py-2">Aucun paiement pour cet id/référence</td></tr>
                <tr><td className="px-4 py-2 font-mono">PAYMENT_ALREADY_PAID</td><td className="px-4 py-2">Impossible d'annuler un paiement déjà encaissé</td></tr>
                <tr><td className="px-4 py-2 font-mono">VALIDATION_ERROR</td><td className="px-4 py-2">Payload invalide (champ manquant, mauvais type)</td></tr>
                <tr><td className="px-4 py-2 font-mono">RATE_LIMITED</td><td className="px-4 py-2">Vous dépassez 100 requêtes/minute</td></tr>
                <tr><td className="px-4 py-2 font-mono">INTERNAL_ERROR</td><td className="px-4 py-2">Erreur inattendue — contactez le support</td></tr>
              </tbody>
            </table>
          </div>

          {/* ---- HTTP codes ---- */}
          <H2 id="http-codes">Codes de réponse HTTP</H2>
          <div className="overflow-x-auto my-3">
            <table className="w-full text-sm border border-slate-200 rounded-lg overflow-hidden">
              <thead className="bg-slate-100 text-left text-[12px] font-semibold text-slate-700">
                <tr><th className="px-4 py-2">Code</th><th className="px-4 py-2">Signification</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-[13px]">
                <tr><td className="px-4 py-2 font-mono text-emerald-700">200</td><td className="px-4 py-2">Succès</td></tr>
                <tr><td className="px-4 py-2 font-mono text-amber-700">400</td><td className="px-4 py-2">Requête invalide (payload, montant, opérateur…)</td></tr>
                <tr><td className="px-4 py-2 font-mono text-amber-700">401</td><td className="px-4 py-2">Clé API manquante ou invalide</td></tr>
                <tr><td className="px-4 py-2 font-mono text-amber-700">403</td><td className="px-4 py-2">Clé désactivée ou compte suspendu</td></tr>
                <tr><td className="px-4 py-2 font-mono text-amber-700">404</td><td className="px-4 py-2">Ressource introuvable</td></tr>
                <tr><td className="px-4 py-2 font-mono text-amber-700">409</td><td className="px-4 py-2">Conflit (ex : annuler un paiement déjà payé)</td></tr>
                <tr><td className="px-4 py-2 font-mono text-amber-700">422</td><td className="px-4 py-2">Validation Pydantic (champ manquant / mauvais type)</td></tr>
                <tr><td className="px-4 py-2 font-mono text-amber-700">429</td><td className="px-4 py-2">Rate limit atteint (100 req/min/clé)</td></tr>
                <tr><td className="px-4 py-2 font-mono text-red-700">500</td><td className="px-4 py-2">Erreur serveur inattendue</td></tr>
                <tr><td className="px-4 py-2 font-mono text-red-700">502</td><td className="px-4 py-2">Passerelle amont injoignable</td></tr>
                <tr><td className="px-4 py-2 font-mono text-red-700">503</td><td className="px-4 py-2">Service temporairement indisponible</td></tr>
              </tbody>
            </table>
          </div>

          {/* ---- Idempotency ---- */}
          <H2 id="idempotency">Idempotence</H2>
          <P>
            Ajoutez un header <code>Idempotency-Key</code> (≤ 255 caractères) à toute requête <code>POST /v1/payments</code>.
            En cas de retry (timeout réseau, doublon accidentel), la même clé retourne la réponse originale — jamais un doublon
            n'est créé côté serveur, la fenêtre est de 24 heures.
          </P>
          <CodeBlock code={`POST /v1/payments
Idempotency-Key: order-42-attempt-1

→ 200 OK (payment created)

POST /v1/payments   # replay
Idempotency-Key: order-42-attempt-1

→ 200 OK (same payment id, no duplicate)`} />

          {/* ---- Rate limits ---- */}
          <H2 id="rate-limits">Rate Limits</H2>
          <P>Chaque clé API dispose de <strong>100 requêtes par minute</strong> (sliding window).</P>
          <P>Chaque réponse inclut ces headers pour vous aider à gérer votre consommation :</P>
          <div className="overflow-x-auto my-3">
            <table className="w-full text-sm border border-slate-200 rounded-lg overflow-hidden">
              <thead className="bg-slate-100 text-left text-[12px] font-semibold text-slate-700">
                <tr><th className="px-4 py-2">Header</th><th className="px-4 py-2">Description</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-[13px]">
                <tr><td className="px-4 py-2 font-mono">X-RateLimit-Limit</td><td className="px-4 py-2">Limite totale (100)</td></tr>
                <tr><td className="px-4 py-2 font-mono">X-RateLimit-Remaining</td><td className="px-4 py-2">Requêtes restantes dans la fenêtre courante</td></tr>
                <tr><td className="px-4 py-2 font-mono">X-RateLimit-Reset</td><td className="px-4 py-2">Timestamp UNIX de réinitialisation</td></tr>
              </tbody>
            </table>
          </div>

          {/* ---- Best practices ---- */}
          <H2 id="best-practices">Bonnes pratiques</H2>
          <ul className="my-3 space-y-2 text-[14px] text-slate-700">
            <li className="flex gap-2"><Check className="w-4 h-4 mt-0.5 text-emerald-600 shrink-0" /><span><strong>Toujours utiliser Idempotency-Key</strong> pour tout <code>POST</code> — évite les doublons en cas de retry réseau.</span></li>
            <li className="flex gap-2"><Check className="w-4 h-4 mt-0.5 text-emerald-600 shrink-0" /><span><strong>Stockez le <code>reference</code></strong> pour retrouver la transaction plus tard via <code>/payments/search</code>.</span></li>
            <li className="flex gap-2"><Check className="w-4 h-4 mt-0.5 text-emerald-600 shrink-0" /><span><strong>Polling raisonnable</strong> : 3–10 secondes entre chaque appel à <code>/status</code> côté serveur, ne jamais poller depuis le navigateur.</span></li>
            <li className="flex gap-2"><Check className="w-4 h-4 mt-0.5 text-emerald-600 shrink-0" /><span><strong>Utilisez sk_test_ en dev</strong> — jamais votre clé live dans du code versionné.</span></li>
            <li className="flex gap-2"><Check className="w-4 h-4 mt-0.5 text-emerald-600 shrink-0" /><span><strong>Régénérez une clé compromise</strong> immédiatement depuis le dashboard.</span></li>
          </ul>

          {/* ---- FAQ ---- */}
          <H2 id="faq">FAQ</H2>
          <div className="space-y-3 my-4">
            {[
              { q: 'Pourquoi pas de webhooks ?', a: 'Simplicité. Vous n\'avez rien à configurer côté serveur — pas de HTTPS obligatoire, pas de vérification de signature. Un simple polling sur `/status` toutes les 5–10s suffit largement pour la majorité des cas.' },
              { q: 'Puis-je encaisser en Bitcoin, ETH, etc. ?', a: 'Oui. Le champ `coin` accepte USDT, USDC, BTC, ETH, BNB, TRX, LTC, SOL, TON, XRP, DOGE, MATIC et 30+ autres actifs. Voir la liste complète via la passerelle.' },
              { q: 'Quelle est la durée de vie d\'un paiement ?', a: '10 minutes à partir de sa création. Passé ce délai, il passe automatiquement en `expired`.' },
              { q: 'Comment tester sans dépenser ?', a: 'Créez une clé `sk_test_…` — l\'environnement Sandbox ne charge aucun client réel.' },
              { q: 'Puis-je rembourser un paiement ?', a: 'Les remboursements ne sont pas encore exposés dans l\'API v1. Pour l\'instant, contactez le support pour les cas ponctuels.' },
              { q: 'Y a-t-il un SDK officiel ?', a: 'L\'API est simple, tous les exemples ci-dessus fonctionnent tels quels. Un SDK officiel Node.js/Python est prévu.' },
            ].map((f, i) => (
              <details key={i} className="group bg-white border border-slate-200 rounded-xl overflow-hidden">
                <summary className="cursor-pointer px-4 py-3 font-semibold text-slate-900 flex items-center justify-between hover:bg-slate-50">
                  <span>{f.q}</span>
                  <ChevronRight className="w-4 h-4 text-slate-400 transition-transform group-open:rotate-90" />
                </summary>
                <div className="px-4 pb-4 pt-1 text-[13px] text-slate-600 leading-relaxed">{f.a}</div>
              </details>
            ))}
          </div>

          {/* Bottom nav */}
          <div className="mt-16 py-6 border-t border-slate-200 flex flex-col md:flex-row md:items-center md:justify-between gap-3 text-[13px]">
            <div className="text-slate-500">Vous avez trouvé un bug ou une amélioration ? <a href="mailto:support@biz-transppayy.com" className="text-blue-600 font-semibold hover:underline">Écrivez-nous</a>.</div>
            <Link to="/dashboard/api" className="inline-flex items-center gap-1.5 text-slate-700 hover:text-slate-900 font-semibold">
              <ArrowLeft className="w-4 h-4" /> Retour à mes clés API
            </Link>
          </div>
        </main>
      </div>
    </div>
  );
}
