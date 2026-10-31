'use strict';

const API_BASE_URL = 'https://biz-transpay.com';
const READ_AUTH = 'Authorization: Bearer $BIZ_SECRET_KEY\nX-Public-Key: $BIZ_PUBLIC_KEY';
const WRITE_AUTH = `${READ_AUTH}\nIdempotency-Key: $BIZ_IDEMPOTENCY_KEY`;
const LIVE_WRITE_WARNING = 'Attention : cette route POST peut créer une opération réelle. Les clés de test ne simulent pas les écritures financières. Vérifiez le pays, l’opérateur, le montant et la destination avant tout appel avec une clé Live.';

const SECTIONS = [
  {
    id: 'authentication',
    title: 'Authentification et démarrage',
    description: [
      'Base URL de production : https://biz-transpay.com.',
      'Chaque requête doit envoyer ensemble Authorization: Bearer <clé secrète> et X-Public-Key: <clé publique>. Les deux clés doivent appartenir au même environnement.',
      'Conservez les clés sur votre serveur. Les écritures financières sont réservées aux clés Live : les clés de test ne déclenchent aucun dépôt ni retrait réel.',
      'Préparez une clé Idempotency-Key unique pour chaque nouvelle écriture et réutilisez exactement cette clé et le même corps uniquement pour retenter cette même opération.',
    ].join('\n\n'),
    code_examples: {
      curl: `export BIZ_BASE_URL="${API_BASE_URL}"\nexport BIZ_PUBLIC_KEY="pk_live_…"\nexport BIZ_SECRET_KEY="sk_live_…"\n# Définir ces valeurs dans l’environnement serveur; ne pas les exposer au navigateur.`,
    },
  },
  {
    id: 'mobile-money',
    title: 'Dépôts et retraits Mobile Money',
    description: 'Flux recommandé : 1) récupérez le catalogue avec direction=deposit ou direction=payout; 2) pour un dépôt, demandez un devis avec POST /deposits/quote; 3) utilisez code_to_enter si le parcours le fournit, ou remplacez {amount} dans payment_flow.ussd_template par charged_amount; 4) lancez le dépôt puis suivez son id jusqu’au statut final. Biz-transPay choisit en interne le traitement actif pour le pays, l’opérateur et la devise; ne transmettez aucun nom de prestataire. L’opération garde ce même traitement jusqu’à sa finalisation. Une modification du catalogue ne concerne que les nouvelles opérations. fee_bearer indique qui supporte les frais. Espacez les vérifications de statut d’environ 10 secondes et ne relancez pas une opération pending.',
  },
  {
    id: 'transactions',
    title: 'Consulter et suivre les opérations',
    description: 'Les listes donnent les opérations enregistrées. L’endpoint de détail actualise le statut avec le même traitement Biz-transPay que celui choisi à la création. Un dépôt ou un retrait peut rester « pending » pendant l’attente de confirmation; ne modifiez pas le parcours et ne créez pas une deuxième opération pour remplacer une réponse en attente.',
  },
  {
    id: 'crypto',
    title: 'Dépôts et retraits crypto',
    description: 'Utilisez les codes d’actif et de réseau fournis par le catalogue crypto actif. Les retraits exigent aussi une clé Live avec autorisation de retrait, l’activation explicite des retraits API et un KYC marchand vérifié.',
  },
  {
    id: 'other-operations',
    title: 'Échanges et liens de paiement',
    description: 'Les échanges et créations de liens sont des écritures financières : utilisez une clé Live, un Idempotency-Key unique et consultez ensuite l’opération créée.',
  },
  {
    id: 'errors',
    title: 'Réponses, erreurs et sécurité des tentatives',
    description: 'Les erreurs JSON contiennent généralement « detail » et peuvent aussi contenir « code ». Un HTTP 409 signifie que la même clé Idempotency-Key a été réutilisée avec un corps différent. En cas de délai réseau, ne générez pas une nouvelle clé : réessayez avec la clé initiale ou consultez l’opération par son identifiant.',
    code_examples: {
      curl: '{"detail":"Idempotency key was used with a different request."}',
      javascript: '{"detail":"Biz-transPay n’a pas pu préparer le retrait.","code":"BIZTRANSPAY_4002"}',
    },
  },
];

const READ_ROUTES = [
  ['GET', '/api/integration/v1/transactions', 'Lister les transactions', 'transactions'],
  ['GET', '/api/integration/v1/deposits', 'Lister les dépôts Mobile Money', 'transactions'],
  ['GET', '/api/integration/v1/payouts', 'Lister les retraits Mobile Money', 'transactions'],
  ['GET', '/api/integration/v1/crypto/deposits', 'Lister les dépôts crypto', 'transactions'],
  ['GET', '/api/integration/v1/crypto/payouts', 'Lister les retraits crypto', 'transactions'],
  ['GET', '/api/integration/v1/exchanges', 'Lister les échanges', 'transactions'],
  ['GET', '/api/integration/v1/links', 'Lister les liens de paiement', 'transactions'],
  ['GET', '/api/integration/v1/deposits/{id}', 'Consulter et actualiser un dépôt', 'transactions'],
  ['GET', '/api/integration/v1/payouts/{id}', 'Consulter et actualiser un retrait', 'transactions'],
  ['GET', '/api/integration/v1/crypto/deposits/{id}', 'Consulter un dépôt crypto', 'transactions'],
  ['GET', '/api/integration/v1/crypto/payouts/{id}', 'Consulter un retrait crypto', 'transactions'],
  ['GET', '/api/integration/v1/exchanges/{id}', 'Consulter un échange', 'transactions'],
  ['GET', '/api/integration/v1/links/{id}', 'Consulter un lien de paiement', 'transactions'],
  ['GET', '/api/integration/v1/links/{id}/payments', 'Lister les paiements d’un lien', 'transactions'],
  ['GET', '/api/integration/v1/mobile-money/operators?direction=deposit', 'Catalogue Mobile Money pour dépôts', 'mobile-money'],
  ['GET', '/api/integration/v1/mobile-money/operators?direction=payout', 'Catalogue Mobile Money pour retraits', 'mobile-money'],
  ['GET', '/api/integration/v1/crypto/assets?direction=deposit', 'Catalogue crypto pour dépôts', 'crypto'],
  ['GET', '/api/integration/v1/crypto/assets?direction=payout', 'Catalogue crypto pour retraits', 'crypto'],
  ['GET', '/api/integration/v1/exchanges/quote?from_currency=XOF&to_currency=XAF&amount=1000', 'Obtenir un devis d’échange', 'other-operations'],
];

const COMMON_ERRORS = [
  { status: 400, description: 'Requête ou valeur incorrecte.' },
  { status: 401, description: 'Clés absentes, invalides ou de deux environnements différents.' },
  { status: 403, description: 'Compte, environnement, autorisation ou configuration non éligible.' },
  { status: 409, description: 'Idempotency-Key déjà utilisée avec un corps différent.' },
  { status: 422, description: 'Champ invalide, clé d’idempotence absente ou limite dépassée.' },
  { status: 429, description: 'Limite de 120 requêtes par minute pour cette clé.' },
  { status: 502, description: 'Biz-transPay n’a pas confirmé le démarrage; vérifiez l’opération avant toute nouvelle tentative.' },
  { status: 503, description: 'Service ou configuration Biz-transPay temporairement indisponible.' },
];

function curlGet(path) {
  const target = path.replaceAll('{id}', '$BIZ_RESOURCE_ID');
  return [
    `curl -sS "${API_BASE_URL}${target}" \\`,
    '  -H "Authorization: Bearer $BIZ_SECRET_KEY" \\',
    '  -H "X-Public-Key: $BIZ_PUBLIC_KEY"',
  ].join('\n');
}

function curlPost(path, body) {
  return [
    `curl -sS -X POST "${API_BASE_URL}${path}" \\`,
    '  -H "Authorization: Bearer $BIZ_SECRET_KEY" \\',
    '  -H "X-Public-Key: $BIZ_PUBLIC_KEY" \\',
    '  -H "Idempotency-Key: $BIZ_IDEMPOTENCY_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    `  --data '${JSON.stringify(body)}'`,
  ].join('\n');
}

function readEndpoint([method, path, title, section]) {
  const isDetail = path.includes('{id}');
  const isList = !isDetail && !path.includes('?direction=') && !path.includes('/quote?');
  const parameters = isDetail
    ? [{ name: 'id', type: 'string', required: true, description: 'Identifiant Biz-transPay retourné à la création.' }]
    : isList
      ? [{ name: 'limit', type: 'integer', required: false, description: 'Nombre de résultats, de 1 à 500; valeur par défaut : 100.' }]
      : [];
  return {
    method,
    path,
    title,
    section,
    description: path.endsWith('/deposits') || path.endsWith('/payouts')
      ? 'Retourne les opérations du compte marchand associé aux clés. Utilisez l’endpoint de détail pour suivre le statut à jour.'
      : path.includes('/mobile-money/operators')
        ? 'Retourne uniquement les routes disponibles dans la configuration active de production. Utilisez le champ code comme valeur operator lors de la création.'
        : path.includes('/crypto/assets')
          ? 'Retourne les actifs disponibles dans le catalogue de la direction demandée.'
          : path.includes('/exchanges/quote')
            ? 'Paramètres obligatoires : from_currency, to_currency et amount.'
            : 'Les données sont limitées au compte marchand associé aux clés.',
    auth: READ_AUTH,
    ...(parameters.length ? { parameters } : {}),
    code_examples: { curl: curlGet(path) },
  };
}

const WRITE_ENDPOINTS = [
  {
    method: 'POST',
    path: '/api/integration/v1/deposits/quote',
    title: 'Calculer le montant d’un dépôt',
    section: 'mobile-money',
    risk_notice: 'Cette estimation ne déclenche aucun paiement et ne crée pas de dépôt.',
    description: 'Calcule les frais, le montant à payer et le code USSD final avant de démarrer un dépôt. Cette requête ne crée pas de transaction et ne contacte pas le téléphone. Envoyez le même pays, opérateur, montant et fee_bearer que pour le dépôt final.',
    scope: 'Clé Live avec deposits:write.',
    parameters: [
      { name: 'amount', type: 'integer', required: true, description: 'Montant de base à créditer ou demandé.' },
      { name: 'country', type: 'string', required: true, description: 'Code pays ISO à deux lettres.' },
      { name: 'operator', type: 'string', required: true, description: 'Code exact du catalogue direction=deposit.' },
      { name: 'currency', type: 'string', required: false, description: 'Devise du catalogue; si fournie, elle doit correspondre.' },
      { name: 'fee_bearer', type: 'string', required: false, description: 'sender: les frais sont ajoutés au montant payé; receiver: ils sont supportés par Biz-transPay et déduits du montant crédité. Valeur par défaut : receiver.' },
    ],
    request: {
      amount: 600,
      country: 'BF',
      operator: 'orange-bf',
      currency: 'XOF',
      fee_bearer: 'sender',
    },
    response: {
      amount: 600,
      charged_amount: 621,
      amount_net: 600,
      total_fee: 21,
      fee_bearer: 'sender',
      currency: 'XOF',
      code_to_enter: '*144*4*6*621#',
      payment_flow: {
        otp_required: true,
        ussd_template: '*144*4*6*{amount}#',
        ussd_code: '*144*4*6*621#',
      },
    },
    auth: `${WRITE_AUTH}\nScope requis : deposits:write`,
    errors: COMMON_ERRORS,
    code_examples: {
      curl: curlPost('/api/integration/v1/deposits/quote', {
        amount: 600,
        country: 'BF',
        operator: 'orange-bf',
        currency: 'XOF',
        fee_bearer: 'sender',
      }),
    },
  },
  {
    method: 'POST',
    path: '/api/integration/v1/deposits',
    title: 'Créer un dépôt Mobile Money',
    section: 'mobile-money',
    risk_notice: LIVE_WRITE_WARNING,
    description: 'Démarre le dépôt selon le catalogue actif; Biz-transPay choisit le traitement côté serveur et le conserve jusqu’à la fin de cette opération. amount est le montant de base. fee_bearer détermine si les frais sont ajoutés au montant payé ou déduits du montant crédité. La réponse donne charged_amount, total_fee et fee_bearer. Si payment_flow.ussd_template est fourni, {amount} représente charged_amount : le code affiché est ainsi calculé selon les frais. Une réponse « pending » signifie qu’une confirmation est encore attendue.',
    scope: 'Clé Live avec deposits:write.',
    parameters: [
      { name: 'amount', type: 'integer', required: true, description: 'Montant entier dans la devise du catalogue.' },
      { name: 'country', type: 'string', required: true, description: 'Code pays ISO à deux lettres, par exemple TG.' },
      { name: 'operator', type: 'string', required: true, description: 'Code exact du catalogue direction=deposit.' },
      { name: 'currency', type: 'string', required: false, description: 'Devise du catalogue; si fournie, elle doit correspondre.' },
      { name: 'phone_number', type: 'string', required: false, description: 'Téléphone du payeur, au format international recommandé.' },
      { name: 'fee_bearer', type: 'string', required: false, description: 'sender: le payeur ajoute les frais au montant; receiver: Biz-transPay/merchant supporte les frais, déduits du montant crédité. Valeur par défaut : receiver.' },
      { name: 'otp', type: 'string', required: false, description: 'Code de paiement requis lorsque payment_flow.otp_required=true; ne le journalisez pas.' },
      { name: 'request_otp', type: 'boolean', required: false, description: 'Si payment_flow.otp_request_before_submit=true, true demande un code et ne crée pas de dépôt. Réutilisez la même Idempotency-Key pour cette demande; créez le dépôt ensuite avec le code reçu et une nouvelle clé.' },
      { name: 'address', type: 'string', required: false, description: 'Adresse/ville demandée uniquement si payment_flow.address_required=true.' },
      { name: 'full_name', type: 'string', required: true, description: 'Nom du payeur, 2 à 160 caractères.' },
      { name: 'email', type: 'string', required: true, description: 'Adresse e-mail valide du payeur.' },
    ],
    request: {
      amount: 600,
      country: 'BF',
      operator: 'orange-bf',
      currency: 'XOF',
      fee_bearer: 'sender',
      phone_number: '+22670000000',
      full_name: 'Client Exemple',
      email: 'client@example.com',
    },
    response: {
      id: 'deposit-id',
      status: 'pending',
      deposit: {
        id: 'deposit-id',
        status: 'pending',
        amount: 600,
        charged_amount: 621,
        amount_net: 600,
        total_fee: 21,
        fee_bearer: 'sender',
        currency: 'XOF',
        payment_flow: {
          kind: 'ussd',
          otp_required: true,
          ussd_template: '*144*4*6*{amount}#',
        },
      },
    },
    otp_request_example: {
      headers: { 'Idempotency-Key': 'otp-request-unique-key' },
      body: {
        amount: 600,
        country: 'BF',
        operator: 'orange-bf',
        currency: 'XOF',
        fee_bearer: 'sender',
        phone_number: '+22670000000',
        full_name: 'Client Exemple',
        email: 'client@example.com',
        request_otp: true,
      },
    },
    otp_request_response: {
      otp_sent: true,
      amount: 600,
      charged_amount: 621,
      total_fee: 21,
      fee_bearer: 'sender',
      currency: 'XOF',
      payment_flow: {
        otp_required: true,
        otp_request_before_submit: true,
      },
      message: 'Le code a été demandé. Saisissez-le pour continuer.',
    },
    auth: `${WRITE_AUTH}\nScope requis : deposits:write`,
    errors: COMMON_ERRORS,
    code_examples: {
      curl: curlPost('/api/integration/v1/deposits', {
        amount: 600,
        country: 'BF',
        operator: 'orange-bf',
        currency: 'XOF',
        fee_bearer: 'sender',
        phone_number: '+22670000000',
        full_name: 'Client Exemple',
        email: 'client@example.com',
      }),
    },
  },
  {
    method: 'POST',
    path: '/api/integration/v1/payouts',
    title: 'Créer un retrait Mobile Money',
    section: 'mobile-money',
    risk_notice: LIVE_WRITE_WARNING,
    description: 'Démarre le retrait depuis le portefeuille du marchand. Le pays, la devise et l’opérateur doivent correspondre au catalogue de retrait actif. Le prestataire sélectionné côté serveur reste associé à ce retrait jusqu’au statut final; une nouvelle configuration ne reroute pas un retrait en cours.',
    scope: 'Clé Live avec payouts:write, autorisation explicite des retraits API et KYC marchand vérifié.',
    parameters: [
      { name: 'amount', type: 'integer', required: true, description: 'Montant entier à retirer.' },
      { name: 'currency', type: 'string', required: true, description: 'Devise associée au pays et à l’opérateur.' },
      { name: 'country', type: 'string', required: true, description: 'Code pays ISO à deux lettres.' },
      { name: 'operator', type: 'string', required: true, description: 'Code exact du catalogue direction=payout.' },
      { name: 'recipient', type: 'string', required: true, description: 'Numéro Mobile Money du bénéficiaire.' },
      { name: 'fee_bearer', type: 'string', required: false, description: 'sender ou receiver; sender par défaut.' },
    ],
    request: {
      amount: 500,
      currency: 'XOF',
      country: 'TG',
      operator: 'tmoney_tg',
      recipient: '+22891000000',
      fee_bearer: 'sender',
    },
    response: {
      id: 'payout-id',
      status: 'pending',
      payout: {
        id: 'payout-id',
        status: 'pending',
        amount: 500,
        currency: 'XOF',
      },
    },
    auth: `${WRITE_AUTH}\nScope requis : payouts:write; opt-in retrait et KYC vérifié`,
    errors: COMMON_ERRORS,
    code_examples: {
      curl: curlPost('/api/integration/v1/payouts', {
        amount: 500,
        currency: 'XOF',
        country: 'TG',
        operator: 'tmoney_tg',
        recipient: '+22891000000',
        fee_bearer: 'sender',
      }),
    },
  },
  {
    method: 'POST',
    path: '/api/integration/v1/crypto/deposits',
    title: 'Créer un dépôt crypto',
    section: 'crypto',
    risk_notice: LIVE_WRITE_WARNING,
    description: 'Crée une intention de dépôt pour un actif actif dans le catalogue. Renvoyez l’identifiant et les instructions retournées au client.',
    scope: 'Clé Live avec deposits:write.',
    parameters: [
      { name: 'amount', type: 'number', required: true, description: 'Montant positif, jusqu’à 6 décimales.' },
      { name: 'asset_code', type: 'string', required: true, description: 'Code actif retourné par le catalogue.' },
      { name: 'full_name', type: 'string', required: true, description: 'Nom du client.' },
      { name: 'email', type: 'string', required: true, description: 'E-mail valide.' },
      { name: 'refund_address', type: 'string', required: true, description: 'Adresse à utiliser si un remboursement est requis.' },
    ],
    request: {
      amount: 25.5,
      asset_code: '<asset_code_du_catalogue>',
      full_name: 'Client Exemple',
      email: 'client@example.com',
      refund_address: '<adresse_de_remboursement>',
    },
    response: { id: 'crypto-deposit-id', status: 'pending', deposit: { id: 'crypto-deposit-id', status: 'pending' } },
    auth: `${WRITE_AUTH}\nScope requis : deposits:write`,
    errors: COMMON_ERRORS,
    code_examples: {
      curl: curlPost('/api/integration/v1/crypto/deposits', {
        amount: 25.5,
        asset_code: '<asset_code_du_catalogue>',
        full_name: 'Client Exemple',
        email: 'client@example.com',
        refund_address: '<adresse_de_remboursement>',
      }),
    },
  },
  {
    method: 'POST',
    path: '/api/integration/v1/crypto/payouts',
    title: 'Créer un retrait crypto',
    section: 'crypto',
    risk_notice: LIVE_WRITE_WARNING,
    description: 'Crée un retrait vers une adresse compatible avec l’actif et le réseau actifs. Vérifiez soigneusement le réseau et l’adresse avant l’envoi.',
    scope: 'Clé Live avec payouts:write, autorisation explicite des retraits API et KYC marchand vérifié.',
    parameters: [
      { name: 'amount', type: 'number', required: true, description: 'Montant positif, jusqu’à 8 décimales.' },
      { name: 'asset_code', type: 'string', required: true, description: 'Actif retourné par le catalogue.' },
      { name: 'network_code', type: 'string', required: false, description: 'Réseau retourné par le catalogue.' },
      { name: 'wallet_address', type: 'string', required: true, description: 'Adresse de destination sur le réseau sélectionné.' },
      { name: 'destination_memo', type: 'string', required: false, description: 'Mémo/tag de destination si le réseau l’exige.' },
      { name: 'fee_bearer', type: 'string', required: false, description: 'sender ou receiver; sender par défaut.' },
    ],
    request: {
      amount: 10,
      asset_code: '<asset_code_du_catalogue>',
      network_code: '<network_code_du_catalogue>',
      wallet_address: '<adresse_de_destination>',
      fee_bearer: 'sender',
    },
    response: { id: 'crypto-payout-id', status: 'pending', payout: { id: 'crypto-payout-id', status: 'pending' } },
    auth: `${WRITE_AUTH}\nScope requis : payouts:write; opt-in retrait et KYC vérifié`,
    errors: COMMON_ERRORS,
    code_examples: {
      curl: curlPost('/api/integration/v1/crypto/payouts', {
        amount: 10,
        asset_code: '<asset_code_du_catalogue>',
        network_code: '<network_code_du_catalogue>',
        wallet_address: '<adresse_de_destination>',
        fee_bearer: 'sender',
      }),
    },
  },
  {
    method: 'POST',
    path: '/api/integration/v1/exchanges',
    title: 'Exécuter un échange',
    section: 'other-operations',
    risk_notice: LIVE_WRITE_WARNING,
    description: 'Exécute l’échange après validation du devis et des soldes disponibles.',
    scope: 'Clé Live avec exchanges:write.',
    parameters: [
      { name: 'from_currency', type: 'string', required: true, description: 'Code de la devise source.' },
      { name: 'to_currency', type: 'string', required: true, description: 'Code de la devise de destination, différente de la source.' },
      { name: 'amount', type: 'number', required: true, description: 'Montant positif dans la devise source.' },
    ],
    request: { from_currency: 'XOF', to_currency: 'XAF', amount: 1000 },
    response: { id: 'exchange-id', status: 'completed', exchange: { transaction: { id: 'exchange-id', status: 'completed' } } },
    auth: `${WRITE_AUTH}\nScope requis : exchanges:write`,
    errors: COMMON_ERRORS,
    code_examples: {
      curl: curlPost('/api/integration/v1/exchanges', {
        from_currency: 'XOF',
        to_currency: 'XAF',
        amount: 1000,
      }),
    },
  },
  {
    method: 'POST',
    path: '/api/integration/v1/links',
    title: 'Créer un lien de paiement',
    section: 'other-operations',
    risk_notice: LIVE_WRITE_WARNING,
    description: 'Crée un lien fixe ou à montant libre. Pour un montant libre, fournissez min_amount et max_amount; pour un lien fixe, fournissez amount.',
    scope: 'Clé Live avec links:write.',
    parameters: [
      { name: 'title', type: 'string', required: true, description: 'Nom du lien.' },
      { name: 'amount_type', type: 'string', required: false, description: 'fixed par défaut; ou free.' },
      { name: 'amount', type: 'number', required: false, description: 'Montant du lien fixed.' },
      { name: 'min_amount', type: 'number', required: false, description: 'Minimum requis pour un lien free.' },
      { name: 'max_amount', type: 'number', required: false, description: 'Maximum supérieur au minimum pour un lien free.' },
      { name: 'currency', type: 'string', required: false, description: 'Devise; UNIVERSAL par défaut.' },
      { name: 'description', type: 'string', required: false, description: 'Description facultative.' },
    ],
    request: {
      title: 'Commande 1042',
      amount_type: 'fixed',
      amount: 2500,
      currency: 'XOF',
      description: 'Paiement commande 1042',
    },
    response: { id: 'link-id', status: 'created', link: { id: 'link-id', slug: 'example-slug', title: 'Commande 1042' } },
    auth: `${WRITE_AUTH}\nScope requis : links:write`,
    errors: COMMON_ERRORS,
    code_examples: {
      curl: curlPost('/api/integration/v1/links', {
        title: 'Commande 1042',
        amount_type: 'fixed',
        amount: 2500,
        currency: 'XOF',
        description: 'Paiement commande 1042',
      }),
    },
  },
];

const ENDPOINTS = [
  ...READ_ROUTES.map(readEndpoint),
  ...WRITE_ENDPOINTS,
];

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
    `Base URL: ${API_BASE_URL}`,
    'Auth: Authorization Bearer + X-Public-Key; les deux cles doivent etre du meme environnement.',
    'Gardez la cle secrete sur votre serveur. Les ecritures financieres exigent des cles Live.',
    'Les exemples POST peuvent declencher des operations reelles : verifiez les donnees avant execution.',
    'Chaque POST exige Idempotency-Key (8-120 caracteres); reutilisez-la seulement pour retenter la meme operation.',
    'Les ecritures exigent deposits:write, payouts:write, exchanges:write ou links:write selon la route.',
    'Les retraits exigent payouts:write, opt-in API et KYC marchand verifie.',
    'Biz-transPay choisit cote serveur le traitement Mobile Money selon le pays, l operateur et le catalogue actif.',
    'Apres creation, chaque operation garde le meme traitement; le catalogue ne concerne que les nouvelles operations.',
    'POST /deposits/quote retourne charged_amount, total_fee et code_to_enter sans creer de transaction.',
    'Pour suivre un statut, consultez GET /deposits/{id} ou GET /payouts/{id}; ne recreez pas une operation pending.',
    'Pay-in Mobile Money: amount, country, operator, phone_number, full_name, email; fee_bearer sender ou receiver; otp selon payment_flow. charged_amount inclut les frais du payeur.',
    'Si payment_flow.ussd_template contient {amount}, remplacez-le par charged_amount avant affichage ou composition.',
    'request_otp=true demande le code sans créer le dépôt; utilisez une clé d’idempotence distincte pour le dépôt final.',
    'Pay-out Mobile Money: amount, currency, country, operator, recipient; fee_bearer: sender ou receiver.',
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
  offsets.slice(1).forEach(offset => {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'ascii');
}

function createIntegrationDocumentationRoutes() {
  const documentation = {
    title: 'Intégrer Biz-transPay',
    description: 'Guide d’intégration API marchand : authentification, catalogues, dépôts, retraits, suivi des statuts, échanges, crypto et liens de paiement.',
    base_url: API_BASE_URL,
    sections: SECTIONS,
    endpoints: ENDPOINTS,
  };

  async function handleRoute(req, res) {
    const path = String(req.url || '').split('?')[0];
    if (req.method === 'GET' && path === '/api/integration/documentation') {
      res.writeHead(200, {
        'Cache-Control': 'public, max-age=60',
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(JSON.stringify(documentation));
      return true;
    }
    if (req.method === 'GET' && path === '/api/integration/documentation.pdf') {
      res.writeHead(200, {
        'Cache-Control': 'public, max-age=60',
        'Content-Disposition': 'attachment; filename="biz-transpay-integration-docs.pdf"',
        'Content-Length': String(buildPdf().length),
        'Content-Type': 'application/pdf',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(buildPdf());
      return true;
    }
    return false;
  }

  return { handleRoute };
}

module.exports = { createIntegrationDocumentationRoutes };
