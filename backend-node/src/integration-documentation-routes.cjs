'use strict';

const SECTIONS = [
  {
    id: 'authentication',
    title: 'Authentification',
    description: 'Envoyez votre clé secrète dans l’en-tête Authorization. Les clés sandbox et live sont distinctes.',
  },
  {
    id: 'transactions',
    title: 'Transactions',
    description: 'Les recherches sont limitées au compte marchand associé à la clé API.',
  },
  {
    id: 'payments',
    title: 'Paiements et actifs',
    description: 'Consultez les opérations et les catalogues actuellement configurés dans cet environnement.',
  },
];

const ENDPOINTS = [
  ['GET', '/api/integration/v1/transactions', 'Lister les transactions', 'transactions'],
  ['GET', '/api/integration/v1/deposits', 'Lister les dépôts Mobile Money', 'transactions'],
  ['GET', '/api/integration/v1/payouts', 'Lister les retraits Mobile Money', 'transactions'],
  ['GET', '/api/integration/v1/crypto/deposits', 'Lister les dépôts crypto', 'transactions'],
  ['GET', '/api/integration/v1/crypto/payouts', 'Lister les retraits crypto', 'transactions'],
  ['GET', '/api/integration/v1/exchanges', 'Lister les échanges', 'transactions'],
  ['GET', '/api/integration/v1/links', 'Lister les liens de paiement', 'transactions'],
  ['GET', '/api/integration/v1/deposits/{id}', 'Consulter un dépôt', 'transactions'],
  ['GET', '/api/integration/v1/payouts/{id}', 'Consulter un retrait', 'transactions'],
  ['GET', '/api/integration/v1/crypto/deposits/{id}', 'Consulter un dépôt crypto', 'transactions'],
  ['GET', '/api/integration/v1/crypto/payouts/{id}', 'Consulter un retrait crypto', 'transactions'],
  ['GET', '/api/integration/v1/exchanges/{id}', 'Consulter un échange', 'transactions'],
  ['GET', '/api/integration/v1/links/{id}', 'Consulter un lien de paiement', 'transactions'],
  ['GET', '/api/integration/v1/links/payments/{id}', 'Consulter le paiement d’un lien', 'transactions'],
  ['GET', '/api/integration/v1/mobile-money/operators?direction=deposit', 'Catalogue Mobile Money pour dépôts', 'payments'],
  ['GET', '/api/integration/v1/mobile-money/operators?direction=payout', 'Catalogue Mobile Money pour retraits', 'payments'],
  ['GET', '/api/integration/v1/crypto/assets?direction=deposit', 'Catalogue crypto pour dépôts', 'payments'],
  ['GET', '/api/integration/v1/crypto/assets?direction=payout', 'Catalogue crypto pour retraits', 'payments'],
  ['GET', '/api/integration/v1/exchanges/quote?from_currency=XOF&to_currency=XAF&amount=1000', 'Obtenir un devis d’échange', 'payments'],
].map(([method, path, title, section]) => ({
  method,
  path,
  title,
  section,
  description: 'Cette opération ne retourne que les données accessibles à la clé API du marchand.',
  auth: 'Authorization: Bearer $BIZ_SECRET_KEY',
  code_examples: {
    curl: `curl -H "Authorization: Bearer $BIZ_SECRET_KEY" "$BIZ_BASE_URL${path}"`,
  },
}));

function pdfText(value) {
  return String(value).normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/[\\()]/g, '\\$&')
    .slice(0, 180);
}

function buildPdf() {
  const lines = [
    'Biz-transPay - Documentation API marchande',
    'Authentification: Authorization: Bearer $BIZ_SECRET_KEY',
    'Les routes documentees ci-dessous sont des lectures protegees par marchand.',
    '',
    ...ENDPOINTS.map(endpoint => `${endpoint.method} ${endpoint.path} - ${endpoint.title}`),
  ].slice(0, 42);
  const commands = ['BT', '/F1 9 Tf'];
  lines.forEach((line, index) => {
    commands.push(`1 0 0 1 40 ${790 - index * 17} Tm (${pdfText(line)}) Tj`);
  });
  commands.push('ET');
  const stream = commands.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'ascii');
}

function createIntegrationDocumentationRoutes() {
  async function handleRoute(req, res) {
    if (req.method !== 'GET') return false;
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (pathname === '/api/integration/documentation') {
      res.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(JSON.stringify({
        title: 'Documentation API Biz-transPay',
        description: 'Référence des opérations de lecture disponibles dans l’environnement actuel.',
        sections: SECTIONS,
        endpoints: ENDPOINTS,
      }));
      return true;
    }
    if (pathname === '/api/integration/documentation.pdf') {
      const pdf = buildPdf();
      res.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Disposition': 'attachment; filename="biz-transpay-integration-docs.pdf"',
        'Content-Length': String(pdf.length),
        'Content-Type': 'application/pdf',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(pdf);
      return true;
    }
    return false;
  }

  return { handleRoute };
}

module.exports = { createIntegrationDocumentationRoutes, buildPdf };
