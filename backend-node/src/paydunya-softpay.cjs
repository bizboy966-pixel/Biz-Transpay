'use strict';

const PROFILE_ROWS = [
  {
    country: 'SN', aliases: ['orange-sn', 'orange_senegal', 'orange-money-senegal', 'new-orange-money-senegal'],
    endpoint: 'new-orange-money-senegal', nameField: 'customer_name',
    emailField: 'customer_email', phoneField: 'phone_number', tokenField: 'invoice_token',
    redirect: true, redirectLabel: 'Orange Money',
  },
  {
    country: 'SN', aliases: ['free-sn', 'free_senegal', 'free-money-senegal'],
    endpoint: 'free-money-senegal', nameField: 'customer_name',
    emailField: 'customer_email', phoneField: 'phone_number', tokenField: 'payment_token',
  },
  {
    country: 'SN', aliases: ['expresso-sn', 'expresso_senegal', 'expresso-senegal'],
    endpoint: 'expresso-senegal', nameField: 'expresso_sn_fullName',
    emailField: 'expresso_sn_email', phoneField: 'expresso_sn_phone',
    tokenField: 'payment_token',
  },
  {
    country: 'SN', aliases: ['wave-sn', 'wave_senegal', 'wave-senegal'],
    endpoint: 'wave-senegal', nameField: 'wave_senegal_fullName',
    emailField: 'wave_senegal_email', phoneField: 'wave_senegal_phone',
    tokenField: 'wave_senegal_payment_token', redirect: true, redirectLabel: 'Wave',
  },
  {
    country: 'SN', aliases: ['wizall-sn', 'wizall_senegal', 'wizall', 'wizall-money-senegal'],
    endpoint: 'wizall-money-senegal', nameField: 'customer_name',
    emailField: 'customer_email', phoneField: 'phone_number', tokenField: 'invoice_token',
    confirmationEndpoint: 'wizall-money-senegal/confirm',
  },
  {
    country: 'CI', aliases: ['orange-ci', 'orange_ci', 'orange-money-ci'],
    endpoint: 'orange-money-ci', nameField: 'orange_money_ci_customer_fullname',
    emailField: 'orange_money_ci_email', phoneField: 'orange_money_ci_phone_number',
    otpField: 'orange_money_ci_otp', tokenField: 'payment_token',
    ussdCode: '#144*82#',
  },
  {
    country: 'CI', aliases: ['mtn-ci', 'mtn_ci', 'mtn-money-ci'],
    endpoint: 'mtn-ci', nameField: 'mtn_ci_customer_fullname',
    emailField: 'mtn_ci_email', phoneField: 'mtn_ci_phone_number',
    tokenField: 'payment_token', walletProviderField: 'mtn_ci_wallet_provider',
    walletProvider: 'MTNCI',
  },
  {
    country: 'CI', aliases: ['moov-ci', 'moov_ci', 'moov-money-ci'],
    endpoint: 'moov-ci', nameField: 'moov_ci_customer_fullname',
    emailField: 'moov_ci_email', phoneField: 'moov_ci_phone_number',
    tokenField: 'payment_token',
  },
  {
    country: 'CI', aliases: ['wave-ci', 'wave_ci', 'wave-ci-djamo'],
    endpoint: 'wave-ci', nameField: 'wave_ci_fullName',
    emailField: 'wave_ci_email', phoneField: 'wave_ci_phone',
    tokenField: 'wave_ci_payment_token', redirect: true, redirectLabel: 'Wave',
  },
  {
    country: 'BF', aliases: ['orange-bf', 'orange_bf', 'orange-burkina', 'orange-money-burkina'],
    endpoint: 'orange-money-burkina', nameField: 'name_bf',
    emailField: 'email_bf', phoneField: 'phone_bf', otpField: 'otp_code',
    tokenField: 'payment_token', ussdCode: '*144*4*6*{amount}#',
  },
  {
    country: 'BF', aliases: ['moov-bf', 'moov_bf', 'moov-burkina', 'moov-burkina-faso'],
    endpoint: 'moov-burkina', nameField: 'moov_burkina_faso_fullName',
    emailField: 'moov_burkina_faso_email', phoneField: 'moov_burkina_faso_phone_number',
    tokenField: 'moov_burkina_faso_payment_token', postSubmitUssd: '*555*6#',
  },
  {
    country: 'BJ', aliases: ['moov-bj', 'moov_bj', 'moov-benin'],
    endpoint: 'moov-benin', nameField: 'moov_benin_customer_fullname',
    emailField: 'moov_benin_email', phoneField: 'moov_benin_phone_number',
    tokenField: 'payment_token',
  },
  {
    country: 'BJ', aliases: ['mtn-bj', 'mtn_bj', 'mtn-benin'],
    endpoint: 'mtn-benin', nameField: 'mtn_benin_customer_fullname',
    emailField: 'mtn_benin_email', phoneField: 'mtn_benin_phone_number',
    tokenField: 'payment_token', walletProviderField: 'mtn_benin_wallet_provider',
    walletProvider: 'MTNBENIN',
  },
  {
    country: 'BJ', aliases: ['celtiis-bj', 'celtiis_bj', 'celtiis-cash'],
    endpoint: 'celtiis-cash', nameField: 'celtiis_cash_customer_fullname',
    emailField: 'celtiis_cash_customer_email', phoneField: 'celtiis_cash_phone_number',
    tokenField: 'payment_token',
  },
  {
    country: 'TG', aliases: ['t-money-togo', 't-money', 'tmoney-togo', 'tmoney_tg', 't-money-tg'],
    endpoint: 't-money-togo', nameField: 'name_t_money',
    emailField: 'email_t_money', phoneField: 'phone_t_money',
    tokenField: 'payment_token',
  },
  {
    country: 'TG', aliases: ['moov-tg', 'moov_tg', 'moov-togo'],
    endpoint: 'moov-togo', nameField: 'moov_togo_customer_fullname',
    emailField: 'moov_togo_email', phoneField: 'moov_togo_phone_number',
    addressField: 'moov_togo_customer_address', tokenField: 'payment_token',
    addressRequired: true,
  },
  {
    country: 'ML', aliases: ['orange-ml', 'orange_ml', 'orange-mali', 'orange-money-mali'],
    endpoint: 'orange-money-mali', nameField: 'orange_money_mali_customer_fullname',
    emailField: 'orange_money_mali_email', phoneField: 'orange_money_mali_phone_number',
    addressField: 'orange_money_mali_customer_address', tokenField: 'payment_token',
    addressRequired: true,
  },
  {
    country: 'ML', aliases: ['moov-ml', 'moov_ml', 'moov-mali'],
    endpoint: 'moov-mali', nameField: 'moov_ml_customer_fullname',
    emailField: 'moov_ml_email', phoneField: 'moov_ml_phone_number',
    addressField: 'moov_ml_customer_address', tokenField: 'payment_token',
    addressRequired: true,
  },
  {
    country: 'CM', aliases: ['mtn-cm', 'mtn_cm', 'mtn-cameroun', 'mtn-cameroon'],
    endpoint: 'mtn-cameroun', nameField: 'mtn_cameroun_customer_fullname',
    emailField: 'mtn_cameroun_email', phoneField: 'mtn_cameroun_phone_number',
    tokenField: 'payment_token', walletProviderField: 'mtn_cameroun_wallet_provider',
    walletProvider: 'MTNCAMEROUN',
  },
  {
    country: 'SN', aliases: ['djamo', 'djamo-sn', 'djamo_sn', 'djamo-senegal'],
    endpoint: 'djamo', nameField: 'djamo_fullName', emailField: 'djamo_email',
    phoneField: 'djamo_phone', tokenField: 'djamo_payment_token',
    countryField: 'code_country', countryValue: 'sn',
    redirect: true, redirectLabel: 'Djamo',
  },
  {
    country: 'CI', aliases: ['djamo', 'djamo-ci', 'djamo_ci', 'djamo-cote-divoire'],
    endpoint: 'djamo', nameField: 'djamo_fullName', emailField: 'djamo_email',
    phoneField: 'djamo_phone', tokenField: 'djamo_payment_token',
    countryField: 'code_country', countryValue: 'ci',
    redirect: true, redirectLabel: 'Djamo',
  },
].map(profile => Object.freeze({
  ...profile,
  aliases: Object.freeze(profile.aliases.map(normalizeSlug)),
}));

function normalizeSlug(value) {
  return String(value || '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/_/g, '-').replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function resolvePaydunyaSoftpayOperator(endpointSlug, country) {
  const slug = normalizeSlug(endpointSlug);
  const countryCode = String(country || '').trim().toUpperCase();
  return PROFILE_ROWS.find(profile => profile.country === countryCode
    && profile.aliases.includes(slug)) || null;
}

function paydunyaSoftpayPaymentFlow(endpointSlug, country) {
  const profile = resolvePaydunyaSoftpayOperator(endpointSlug, country);
  if (!profile) return null;
  const address = profile.addressRequired ? {
    address_required: true,
    address_label: 'Ville ou adresse du client',
  } : {};
  if (profile.otpField) {
    return {
      kind: profile.ussdCode ? 'ussd' : 'phone_confirmation',
      before_submit: true,
      otp_required: true,
      otp_label: 'Code OTP Orange Money',
      ...(profile.ussdCode ? { ussd_template: profile.ussdCode } : {}),
      steps: profile.ussdCode ? [
        'Composez le code affiché ci-dessous sur le téléphone lié au numéro de paiement.',
        'Il contient le montant dû, calculé selon le choix de prise en charge des frais. Saisissez ensuite le code généré dans le champ ci-dessous.',
      ] : [
        'Biz-transPay demande un code de paiement pour cet opérateur.',
        'Suivez la procédure officielle de votre opérateur pour obtenir le code, puis saisissez-le ici.',
      ],
      ...address,
    };
  }
  if (profile.confirmationEndpoint) {
    return {
      kind: 'otp',
      before_submit: false,
      otp_required: true,
      otp_label: 'Code d’autorisation Wizall',
      steps: [
        'Après la demande, saisissez le code d’autorisation fourni pour cette transaction.',
        'Appuyez sur « Valider le code » pour confirmer le même dépôt.',
      ],
      ...address,
    };
  }
  if (profile.redirect) {
    return {
      kind: 'redirect',
      before_submit: false,
      steps: [
        `Après le démarrage, vous serez redirigé vers le paiement sécurisé ${profile.redirectLabel}.`,
        'Terminez le paiement sur cette page ou dans l’application, puis revenez ici pour le suivi du statut.',
      ],
      ...address,
    };
  }
  if (profile.ussdCode) {
    return {
      kind: 'ussd',
      before_submit: true,
      otp_required: true,
      otp_label: 'Code de paiement Orange Money',
      ussd_template: profile.ussdCode,
      steps: [
        'Composez le code affiché ci-dessous sur le téléphone lié au numéro de paiement.',
        'Saisissez le code généré dans le champ ci-dessous avant de lancer le dépôt.',
      ],
      ...address,
    };
  }
  if (profile.postSubmitUssd) {
    return {
      kind: 'ussd_confirmation',
      before_submit: false,
      ussd_code: profile.postSubmitUssd,
      steps: [
        `Après l’envoi de la demande, composez ${profile.postSubmitUssd} sur votre téléphone pour confirmer.`,
        'Le statut du dépôt sera vérifié automatiquement après la confirmation.',
      ],
      ...address,
    };
  }
  return {
    kind: 'phone_confirmation',
    before_submit: false,
    steps: [
      'La demande sera transmise au réseau de paiement sélectionné.',
      'Suivez les instructions affichées sur votre téléphone et revenez ici pour vérifier le statut.',
    ],
    ...address,
  };
}

function isPaydunyaSoftpayFlowSpecific(flow) {
  return Boolean(flow && typeof flow === 'object'
    && (flow.otp_required === true || flow.kind === 'redirect' || Boolean(flow.ussd_code)));
}

function mergePaydunyaSoftpayPaymentFlow(documentedFlow, configuredFlow) {
  if (!configuredFlow || typeof configuredFlow !== 'object'
      || Array.isArray(configuredFlow)) return documentedFlow || {};
  if (!documentedFlow || isPaydunyaSoftpayFlowSpecific(documentedFlow)) {
    return documentedFlow || configuredFlow;
  }
  if (!documentedFlow.address_required) return configuredFlow;
  const steps = [
    ...(Array.isArray(configuredFlow.steps) ? configuredFlow.steps : []),
    ...(Array.isArray(documentedFlow.steps) ? documentedFlow.steps : []),
  ].filter((value, index, all) => typeof value === 'string' && all.indexOf(value) === index);
  return {
    ...configuredFlow,
    address_required: true,
    address_label: documentedFlow.address_label,
    ...(steps.length ? { steps } : {}),
  };
}

function softpayError(status, message, options = {}) {
  const error = new Error(message);
  error.status = status;
  error.safePublicMessage = true;
  Object.assign(error, options);
  return error;
}

const COUNTRY_CALLING_CODES = Object.freeze({
  BJ: '229', BF: '226', CM: '237', CI: '225', ML: '223', SN: '221', TG: '228',
});

function localPhone(country, phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  const callingCode = COUNTRY_CALLING_CODES[String(country || '').toUpperCase()];
  if (callingCode && digits.startsWith(callingCode) && digits.length > callingCode.length + 6) {
    digits = digits.slice(callingCode.length);
  }
  return digits;
}

function safePaydunyaRedirect(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    const allowed = ['app.paydunya.com', 'pay.wave.com', 'p.djamo.com'];
    return allowed.some(domain => host === domain || host.endsWith(`.${domain}`))
      ? url.toString() : null;
  } catch {
    return null;
  }
}

async function submitPaydunyaSoftpay({
  mode, endpointSlug, country, fullName, email, phone, address, otp, paymentToken,
  credentials, fetchImpl = globalThis.fetch,
}) {
  const profile = resolvePaydunyaSoftpayOperator(endpointSlug, country);
  if (!profile) {
    throw softpayError(503, 'Le parcours PayDunya Mobile Money de cet opérateur n’est pas disponible.');
  }
  if (mode !== 'live') {
    throw softpayError(
      503,
      'Le mode Sandbox PayDunya ne peut pas envoyer une demande Mobile Money réelle. Passez en mode Production.',
    );
  }

  const body = {
    [profile.nameField]: String(fullName || '').trim().slice(0, 120),
    [profile.emailField]: String(email || '').trim().toLowerCase().slice(0, 254),
    [profile.phoneField]: localPhone(country, phone),
    [profile.tokenField]: String(paymentToken || '').trim(),
  };
  if (profile.otpField) body[profile.otpField] = String(otp || '').trim();
  if (profile.addressField) body[profile.addressField] = String(address || '').trim().slice(0, 180);
  if (profile.walletProviderField) body[profile.walletProviderField] = profile.walletProvider;
  if (profile.countryField) body[profile.countryField] = profile.countryValue;
  if (!body[profile.nameField] || !body[profile.emailField]
      || !body[profile.phoneField] || !body[profile.tokenField]) {
    throw softpayError(422, 'Les informations nécessaires au paiement PayDunya sont incomplètes.');
  }
  if (profile.otpField && !body[profile.otpField]) {
    throw softpayError(422, 'Saisissez le code de paiement demandé avant de continuer.');
  }
  if (profile.addressRequired && !body[profile.addressField]) {
    throw softpayError(422, 'Saisissez la ville ou l’adresse demandée par cet opérateur.');
  }

  let response;
  try {
    response = await fetchImpl(
      `https://app.paydunya.com/api/v1/softpay/${profile.endpoint}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'PAYDUNYA-MASTER-KEY': credentials.master_key,
          'PAYDUNYA-PRIVATE-KEY': credentials.private_key,
          'PAYDUNYA-TOKEN': credentials.token,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
        redirect: 'error',
      },
    );
  } catch {
    throw softpayError(
      502,
      'La réponse de PayDunya n’a pas confirmé l’envoi. Vérifiez le statut avant toute nouvelle tentative.',
      { outcomeUnknown: true },
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw softpayError(
      502,
      'La réponse de PayDunya n’a pas confirmé l’envoi. Vérifiez le statut avant toute nouvelle tentative.',
      { outcomeUnknown: true },
    );
  }
  if (!response.ok) {
    const rejected = response.status >= 400 && response.status < 500;
    throw softpayError(
      rejected ? 400 : 502,
      rejected
        ? 'PayDunya a refusé la demande. Vérifiez le numéro et l’opérateur.'
        : 'La réponse de PayDunya n’a pas confirmé l’envoi. Vérifiez le statut avant toute nouvelle tentative.',
      { providerRejected: rejected, outcomeUnknown: !rejected },
    );
  }
  if (payload?.success === false) {
    throw softpayError(400, 'PayDunya a refusé la demande. Vérifiez le numéro et l’opérateur.', {
      providerRejected: true,
    });
  }
  if (payload?.success !== true) {
    throw softpayError(
      502,
      'La réponse de PayDunya n’a pas confirmé l’envoi. Vérifiez le statut avant toute nouvelle tentative.',
      { outcomeUnknown: true },
    );
  }
  const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
  const providerReference = String(
    data.TransactionID || data.transaction_id || data.reference || data.payment_id || '',
  ).trim().slice(0, 160);
  const redirectUrl = safePaydunyaRedirect(payload.url || data.url);
  if (profile.redirect && !redirectUrl) {
    throw softpayError(
      502,
      'PayDunya a accepté la demande mais n’a pas retourné de lien sécurisé exploitable. Vérifiez le statut avant toute nouvelle tentative.',
      { outcomeUnknown: true },
    );
  }
  if (profile.confirmationEndpoint && !providerReference) {
    throw softpayError(
      502,
      'PayDunya n’a pas retourné la référence nécessaire à la confirmation. Vérifiez le statut avant toute nouvelle tentative.',
      { outcomeUnknown: true },
    );
  }
  return {
    accepted: true,
    ...(redirectUrl ? { redirect_url: redirectUrl } : {}),
    ...(providerReference ? { provider_reference: providerReference } : {}),
    ...(profile.confirmationEndpoint ? { auth_mode: 'otp', otp_required: true } : {}),
  };
}

module.exports = {
  resolvePaydunyaSoftpayOperator,
  paydunyaSoftpayPaymentFlow,
  isPaydunyaSoftpayFlowSpecific,
  mergePaydunyaSoftpayPaymentFlow,
  submitPaydunyaSoftpay,
  safePaydunyaRedirect,
  localPhone,
};
