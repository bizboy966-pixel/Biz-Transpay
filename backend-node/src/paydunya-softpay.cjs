'use strict';

const T_MONEY_TOGO = Object.freeze({
  endpoint: 't-money-togo',
  nameField: 'name_t_money',
  emailField: 'email_t_money',
  phoneField: 'phone_t_money',
  tokenField: 'payment_token',
});

// Only expose a direct route after its official endpoint and field names are verified.
function resolvePaydunyaSoftpayOperator(endpointSlug, country) {
  const slug = String(endpointSlug || '').trim().toLowerCase();
  const countryCode = String(country || '').trim().toUpperCase();
  if (countryCode !== 'TG') return null;
  return ['t-money-togo', 't-money', 'tmoney-togo', 'tmoney_tg'].includes(slug)
    ? T_MONEY_TOGO : null;
}

function softpayError(status, message, options = {}) {
  const error = new Error(message);
  error.status = status;
  error.safePublicMessage = true;
  Object.assign(error, options);
  return error;
}

function localPhone(country, phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (String(country || '').toUpperCase() === 'TG'
      && digits.startsWith('228') && digits.length === 11) {
    digits = digits.slice(3);
  }
  return digits;
}

async function submitPaydunyaSoftpay({
  mode, endpointSlug, country, fullName, email, phone, paymentToken,
  credentials, fetchImpl = globalThis.fetch,
}) {
  const profile = resolvePaydunyaSoftpayOperator(endpointSlug, country);
  if (!profile) {
    throw softpayError(
      503,
      'Le parcours PayDunya Mobile Money de cet opérateur n’est pas disponible.',
    );
  }
  if (mode !== 'live') {
    throw softpayError(
      503,
      'Le mode Sandbox PayDunya ne peut pas envoyer une demande T-Money réelle. Passez en mode Production.',
    );
  }

  const body = {
    [profile.nameField]: String(fullName || '').trim().slice(0, 120),
    [profile.emailField]: String(email || '').trim().toLowerCase().slice(0, 254),
    [profile.phoneField]: localPhone(country, phone),
    [profile.tokenField]: String(paymentToken || '').trim(),
  };
  if (!body[profile.nameField] || !body[profile.emailField]
      || !body[profile.phoneField] || !body[profile.tokenField]) {
    throw softpayError(422, 'Les informations nécessaires au paiement PayDunya sont incomplètes.');
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
    throw softpayError(
      400,
      'PayDunya a refusé la demande. Vérifiez le numéro et l’opérateur.',
      { providerRejected: true },
    );
  }
  if (payload?.success !== true) {
    throw softpayError(
      502,
      'La réponse de PayDunya n’a pas confirmé l’envoi. Vérifiez le statut avant toute nouvelle tentative.',
      { outcomeUnknown: true },
    );
  }
  return { accepted: true };
}

module.exports = {
  resolvePaydunyaSoftpayOperator,
  submitPaydunyaSoftpay,
};
