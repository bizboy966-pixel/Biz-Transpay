function formatAmount(value) {
  return Number(value).toLocaleString('fr-FR', { maximumFractionDigits: 0 });
}

export function getMobileMoneyWithdrawalBlockers({
  operator,
  currency,
  phone,
  amount,
  min,
  max,
  recipientGets,
  totalDebit,
  balance,
}) {
  const blockers = [];
  const amountNumber = Number(amount);
  const debitNumber = Number(totalDebit);
  const availableBalance = Number(balance) || 0;

  if (!operator || !currency) blockers.push('Sélectionnez un opérateur disponible.');
  if (!String(phone || '').trim()) blockers.push('Saisissez le numéro Mobile Money du bénéficiaire.');

  if (!Number.isSafeInteger(amountNumber) || amountNumber <= 0) {
    blockers.push(`Saisissez un montant entier valide en ${currency || 'devise locale'}.`);
  } else {
    if (amountNumber < Number(min)) {
      blockers.push(`Le montant minimum est ${formatAmount(min)} ${currency}.`);
    }
    if (amountNumber > Number(max)) {
      blockers.push(`Le montant maximum est ${formatAmount(max)} ${currency}.`);
    }
  }

  if (!Number.isFinite(Number(recipientGets)) || Number(recipientGets) <= 0) {
    blockers.push('Le montant reçu après frais doit être supérieur à zéro.');
  }

  if (Number.isFinite(debitNumber) && debitNumber > availableBalance) {
    blockers.push(
      `Solde insuffisant : ${formatAmount(availableBalance)} ${currency} disponibles, `
      + `${formatAmount(debitNumber)} ${currency} requis. Choisissez « Le bénéficiaire paie » `
      + 'ou ajoutez du solde.',
    );
  }

  return blockers;
}
