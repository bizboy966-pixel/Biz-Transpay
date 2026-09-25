import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, BookOpen, Check, Copy, Download, Menu, Search, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import api from '@/api';

const asList = (value) => {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).map(([name, item]) => ({
    name,
    ...(item && typeof item === 'object' ? item : { description: item }),
  }));
};

const titleOf = (item) => item?.title || item?.name || item?.label || item?.id || 'Endpoint';
const pathOf = (item) => item?.path || item?.route || item?.url || item?.endpoint || '';
const formatJson = (value) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const normalizedKey = (value) => String(value || '').trim().toLowerCase().replace(/[àáâä]/g, 'a').replace(/[èéêë]/g, 'e').replace(/[îï]/g, 'i').replace(/[ôö]/g, 'o').replace(/[ùûü]/g, 'u').replace(/[^a-z0-9]+/g, '-');
const groupOf = (item) => typeof item?.section === 'object' ? item.section.id || item.section.name || item.section.title : item?.section || item?.group || item?.category;

const LANGUAGE_LABELS = {
  curl: 'cURL',
  php: 'PHP',
  js: 'JavaScript',
  javascript: 'JavaScript',
  python: 'Python',
};

function CodeBlock({ value }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success('Exemple copié');
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      toast.error('Copie indisponible');
    }
  };

  return (
    <div className="relative">
      <button type="button" onClick={copy} className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md bg-slate-800 px-2 py-1 text-[11px] font-bold text-slate-200 hover:bg-slate-700">
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        {copied ? 'Copié' : 'Copier'}
      </button>
      <pre className="overflow-x-auto rounded-xl bg-slate-950 p-4 pr-20 font-mono text-xs leading-relaxed text-slate-100">
        <code>{value}</code>
      </pre>
    </div>
  );
}

function DataBlock({ title, value }) {
  if (value === undefined || value === null || value === '') return null;
  const text = typeof value === 'object' ? formatJson(value) : value;
  return (
    <div className="mt-4">
      <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">{title}</h4>
      <CodeBlock value={text} />
    </div>
  );
}

function ParametersTable({ parameters }) {
  const rows = asList(parameters);
  if (!rows.length) return null;
  return (
    <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
      <table className="w-full min-w-[560px] text-left text-xs">
        <thead className="bg-slate-50 text-slate-500">
          <tr>
            <th className="px-3 py-2.5">Paramètre</th>
            <th className="px-3 py-2.5">Type</th>
            <th className="px-3 py-2.5">Requis</th>
            <th className="px-3 py-2.5">Description</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((parameter, index) => (
            <tr key={parameter.name || parameter.key || index}>
              <td className="px-3 py-2 font-mono text-slate-700">{parameter.name || parameter.key || '—'}</td>
              <td className="px-3 py-2 text-slate-500">{parameter.type || '—'}</td>
              <td className="px-3 py-2 text-slate-500">{parameter.required === true ? 'Oui' : parameter.required === false ? 'Non' : '—'}</td>
              <td className="px-3 py-2 leading-relaxed text-slate-600">{parameter.description || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CodeExamples({ examples }) {
  const normalized = Object.entries(examples || {}).filter(([, value]) => value !== undefined && value !== null && value !== '');
  const [language, setLanguage] = useState(normalized[0]?.[0] || '');
  const selected = normalized.find(([key]) => key === language)?.[1] || normalized[0]?.[1];
  if (!normalized.length) return null;

  return (
    <div className="mt-5">
      <div className="flex flex-wrap gap-1 border-b border-slate-200">
        {normalized.map(([key]) => (
          <button type="button" key={key} onClick={() => setLanguage(key)} className={`px-3 py-2 text-xs font-bold ${language === key ? 'border-b-2 border-slate-900 text-slate-900' : 'text-slate-500 hover:text-slate-900'}`}>
            {LANGUAGE_LABELS[key] || key}
          </button>
        ))}
      </div>
      <div className="mt-3"><CodeBlock value={typeof selected === 'string' ? selected : formatJson(selected)} /></div>
    </div>
  );
}

function Endpoint({ item }) {
  const method = String(item.method || item.http_method || 'GET').toUpperCase();
  const examples = item.code_examples || item.examples || item.code || {};
  const request = item.request || item.request_body || item.request_example;
  const response = item.response || item.response_body || item.response_example;
  const errors = item.errors || item.error_codes || item.http_errors || item.status_codes;
  const auth = item.authentication || item.auth || item.authorization;
  const anchor = item.id || pathOf(item).replace(/[^\w]+/g, '-');

  return (
    <article id={anchor} className="scroll-mt-24 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-md px-2 py-1 font-mono text-[11px] font-bold ${method === 'GET' ? 'bg-blue-50 text-blue-700' : method === 'POST' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800'}`}>{method}</span>
        <code className="break-all text-xs text-slate-700">{pathOf(item) || 'Route non renseignée'}</code>
      </div>
      <h3 className="mt-3 font-cabinet text-lg font-extrabold text-slate-900">{titleOf(item)}</h3>
      {(item.description || item.summary) && <p className="mt-1 text-sm leading-relaxed text-slate-600">{item.description || item.summary}</p>}
      {auth && <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50 p-3 text-xs leading-relaxed text-blue-950"><strong className="font-bold">Authentification</strong><div className="mt-1 whitespace-pre-wrap">{typeof auth === 'string' ? auth : formatJson(auth)}</div></div>}
      <ParametersTable parameters={item.parameters || item.params} />
      <DataBlock title="Corps de la requête" value={request} />
      <DataBlock title="Exemple de réponse" value={response} />
      {errors && <DataBlock title="Erreurs et codes HTTP" value={errors} />}
      <CodeExamples examples={examples} />
    </article>
  );
}

function DocumentationSection({ section, endpoints, query }) {
  const sectionId = section.id || section.name || normalizedKey(titleOf(section));
  const sectionEndpoints = endpoints.filter((item) => normalizedKey(groupOf(item)) === normalizedKey(sectionId)
    || normalizedKey(groupOf(item)) === normalizedKey(titleOf(section)));
  const visibleEndpoints = sectionEndpoints.filter((item) => !query.trim() || JSON.stringify(item).toLowerCase().includes(query.toLowerCase()));
  const sectionExamples = section.code_examples || section.examples || section.code;

  return (
    <section id={sectionId} className="scroll-mt-24">
      <h2 className="font-cabinet text-2xl font-extrabold text-slate-900">{titleOf(section)}</h2>
      {(section.description || section.content) && <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-600">{section.description || section.content}</p>}
      <CodeExamples examples={sectionExamples} />
      {visibleEndpoints.length > 0 && <div className="mt-5 space-y-5">{visibleEndpoints.map((item, index) => <Endpoint key={item.id || pathOf(item) || index} item={item} />)}</div>}
    </section>
  );
}

export default function IntegrationDocs() {
  const [documentation, setDocumentation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    api.get('/integration/documentation')
      .then(({ data }) => setDocumentation(data))
      .catch((err) => setError(err.response?.data?.detail || 'La documentation est indisponible.'))
      .finally(() => setLoading(false));
  }, []);

  const sections = useMemo(() => asList(documentation?.sections), [documentation]);
  const endpoints = useMemo(() => asList(documentation?.endpoints), [documentation]);
  const groupedEndpointKeys = useMemo(() => new Set(sections.flatMap((section) => [section.id, section.name, section.title].map(normalizedKey).filter(Boolean))), [sections]);
  const ungroupedEndpoints = endpoints.filter((item) => !groupedEndpointKeys.has(normalizedKey(groupOf(item))));
  const hasVisibleEndpoints = sections.some((section) => endpoints.some((item) => (
    (normalizedKey(groupOf(item)) === normalizedKey(section.id)
      || normalizedKey(groupOf(item)) === normalizedKey(section.name)
      || normalizedKey(groupOf(item)) === normalizedKey(section.title))
    && (!query.trim() || JSON.stringify(item).toLowerCase().includes(query.toLowerCase()))
  ))) || ungroupedEndpoints.some((item) => !query.trim() || JSON.stringify(item).toLowerCase().includes(query.toLowerCase()));

  const download = async () => {
    try {
      const response = await api.get('/integration/documentation.pdf', { responseType: 'blob' });
      const url = URL.createObjectURL(response.data);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'biz-transpay-integration-docs.pdf';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Le PDF n’a pas pu être téléchargé.');
    }
  };

  return (
    <div className="min-h-screen bg-slate-50" data-testid="integration-docs">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6">
          <button type="button" onClick={() => setMobileOpen((value) => !value)} className="rounded-lg border border-slate-200 p-2 lg:hidden" aria-label="Ouvrir le sommaire">{mobileOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}</button>
          <Link to="/dashboard/integration" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-600 hover:text-slate-900"><ArrowLeft className="h-4 w-4" /> Console d’intégration</Link>
          <div className="hidden items-center gap-2 md:flex"><BookOpen className="h-4 w-4 text-blue-600" /><span className="font-cabinet text-sm font-extrabold text-slate-900">Documentation Biz-transPay</span></div>
          <div className="relative ml-auto hidden md:block"><Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-slate-400" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Rechercher" className="w-56 rounded-lg border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-xs outline-none focus:border-blue-500" /></div>
          <button type="button" onClick={download} aria-label="Télécharger la documentation PDF" className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-bold text-white hover:bg-slate-700"><Download className="h-3.5 w-3.5" /><span className="hidden sm:inline">Télécharger la documentation PDF</span><span className="sm:hidden">PDF</span></button>
        </div>
      </header>
      <div className="mx-auto flex max-w-7xl">
        <aside className={`${mobileOpen ? 'translate-x-0' : '-translate-x-full'} fixed inset-y-[57px] left-0 z-20 w-72 border-r border-slate-200 bg-white transition-transform lg:sticky lg:top-[57px] lg:h-[calc(100vh-57px)] lg:translate-x-0`}>
          <nav className="space-y-1 overflow-y-auto p-4">
            <a href="#overview" onClick={() => setMobileOpen(false)} className="block rounded-lg px-3 py-2 text-xs font-bold text-slate-600 hover:bg-blue-50 hover:text-blue-700">Vue d’ensemble</a>
            {sections.map((section, index) => <a key={section.id || section.name || index} href={`#${section.id || section.name}`} onClick={() => setMobileOpen(false)} className="block rounded-lg px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-blue-50 hover:text-blue-700">{titleOf(section)}</a>)}
            {ungroupedEndpoints.length > 0 && <a href="#other-endpoints" onClick={() => setMobileOpen(false)} className="block rounded-lg px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-blue-50 hover:text-blue-700">Autres endpoints</a>}
          </nav>
        </aside>
        <main className="min-w-0 flex-1 px-4 py-8 sm:px-8 lg:max-w-4xl lg:px-12">
          <section id="overview" className="scroll-mt-24">
            <div className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-[11px] font-bold text-blue-700"><BookOpen className="h-3.5 w-3.5" /> API d’intégration</div>
            <h1 className="mt-4 font-cabinet text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">{documentation?.title || 'Intégrer Biz-transPay'}</h1>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-600">{documentation?.description || 'Référence publique des endpoints disponibles pour connecter vos opérations financières.'}</p>
          </section>
          {loading && <div className="mt-8 space-y-4"><div className="h-24 animate-pulse rounded-2xl bg-slate-200" /><div className="h-72 animate-pulse rounded-2xl bg-slate-200" /></div>}
          {!loading && error && <div className="mt-8 rounded-2xl border border-red-200 bg-red-50 p-8 text-center text-sm font-semibold text-red-900">{error}</div>}
          {!loading && !error && (
            <div className="mt-8 space-y-8">
              {sections.map((section, index) => <DocumentationSection key={section.id || section.name || index} section={section} endpoints={endpoints} query={query} />)}
              {ungroupedEndpoints.length > 0 && <section id="other-endpoints" className="scroll-mt-24"><h2 className="font-cabinet text-2xl font-extrabold text-slate-900">Autres endpoints</h2><div className="mt-5 space-y-5">{ungroupedEndpoints.filter((item) => !query.trim() || JSON.stringify(item).toLowerCase().includes(query.toLowerCase())).map((item, index) => <Endpoint key={item.id || pathOf(item) || index} item={item} />)}</div></section>}
              {!sections.length && !ungroupedEndpoints.length && <div className="rounded-2xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-500">Aucun endpoint documenté n’est disponible.</div>}
              {!hasVisibleEndpoints && <div className="rounded-2xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-500">Aucun endpoint documenté ne correspond à cette recherche.</div>}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}