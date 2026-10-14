function walletCurrency(field, fallback) {
  if (field && String(field).startsWith('balance_')) {
    return String(field).slice('balance_'.length).replace(/_/g, '.').toUpperCase();
  }
  return fallback || 'XOF';
}

function formatBalance(value, currency) {
  const decimals = ['XOF', 'XAF'].includes(String(currency).toUpperCase()) ? 0 : 6;
  return new Intl.NumberFormat('fr-FR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  }).format(Number(value));
}

export default function WalletBalanceSnapshot({ transaction }) {
  const meta = transaction?.metadata || {};
  const before = Number(meta.wallet_balance_before);
  const after = Number(meta.wallet_balance_after);
  const hasSnapshot = meta.wallet_balance_before !== null
    && meta.wallet_balance_before !== undefined
    && meta.wallet_balance_after !== null
    && meta.wallet_balance_after !== undefined
    && Number.isFinite(before) && Number.isFinite(after);
  const beforeByWallet = meta.wallet_balances_before || {};
  const afterByWallet = meta.wallet_balances_after || {};
  const refund = meta.refund_wallet_snapshot || {};
  const refundBefore = Number(refund.wallet_balance_before);
  const refundAfter = Number(refund.wallet_balance_after);
  const hasRefundSnapshot = refund.wallet_balance_before !== null
    && refund.wallet_balance_before !== undefined
    && refund.wallet_balance_after !== null
    && refund.wallet_balance_after !== undefined
    && Number.isFinite(refundBefore) && Number.isFinite(refundAfter);
  const walletFields = [
    meta.wallet_field,
    meta.to_wallet_field,
  ].filter((field, index, all) => field && all.indexOf(field) === index);
  const exchangeRows = walletFields
    .filter((field) => beforeByWallet[field] !== null
      && beforeByWallet[field] !== undefined
      && afterByWallet[field] !== null
      && afterByWallet[field] !== undefined
      && Number.isFinite(Number(beforeByWallet[field]))
      && Number.isFinite(Number(afterByWallet[field])))
    .map((field, index) => {
      const currency = walletCurrency(
        field,
        index === 0 ? meta.from_currency : meta.to_currency,
      );
      return {
        field,
        currency,
        before: Number(beforeByWallet[field]),
        after: Number(afterByWallet[field]),
      };
    });

  return (
    <section
      className="mt-3 rounded-2xl border border-blue-100 bg-gradient-to-br from-blue-50 to-white p-4"
      data-testid="wallet-balance-snapshot"
      aria-label="Soldes avant et après la transaction"
    >
      <h3 className="text-sm font-extrabold text-slate-900">Impact réel sur le solde</h3>
      {hasSnapshot ? (
        <div className="mt-3 grid grid-cols-3 items-center gap-2 text-center">
          <div className="min-w-0 rounded-xl bg-white/80 p-3">
            <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Avant</div>
            <div className="mt-1 break-words text-base font-extrabold text-slate-800">
              {formatBalance(before, meta.wallet_balance_currency)}
            </div>
            <div className="text-[10px] text-slate-500">{meta.wallet_balance_currency || transaction?.currency}</div>
          </div>
          <div className="min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">
              {meta.wallet_operation_direction === 'credit' ? 'Crédité'
                : meta.wallet_operation_direction === 'debit' ? 'Débité' : 'Transféré'}
            </div>
            <div className="mt-1 break-words text-sm font-bold text-blue-700">
              {formatBalance(
                Number(meta.wallet_operation_amount ?? Math.abs(after - before)),
                meta.wallet_balance_currency || transaction?.currency,
              )}
            </div>
            <div className="text-[10px] text-slate-500">{meta.wallet_balance_currency || transaction?.currency}</div>
          </div>
          <div className="min-w-0 rounded-xl bg-white/80 p-3">
            <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Après</div>
            <div className="mt-1 break-words text-base font-extrabold text-emerald-700">
              {formatBalance(after, meta.wallet_balance_currency)}
            </div>
            <div className="text-[10px] text-slate-500">{meta.wallet_balance_currency || transaction?.currency}</div>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-xs leading-relaxed text-slate-600">
          Le solde avant et après n’a pas été enregistré pour cette ancienne transaction.
        </p>
      )}

      {exchangeRows.length > 1 && (
        <div className="mt-3 space-y-2 border-t border-blue-100 pt-3">
          {exchangeRows.map((row) => (
            <div key={row.field} className="flex items-center justify-between gap-3 text-xs">
              <span className="font-semibold text-slate-600">{row.currency}</span>
              <span className="text-slate-600">
                {formatBalance(row.before, row.currency)}
                <span className="mx-2 text-slate-400">→</span>
                <strong className="text-slate-900">{formatBalance(row.after, row.currency)}</strong>
              </span>
            </div>
          ))}
        </div>
      )}

      {meta.refunded && (
        <div className="mt-3 rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs">
          <div className="font-bold text-emerald-800">Remboursement effectué</div>
          {hasRefundSnapshot ? (
            <div className="mt-1 text-emerald-900">
              Solde : {formatBalance(refundBefore, refund.wallet_balance_currency)}
              <span className="mx-2 text-emerald-600">→</span>
              <strong>{formatBalance(refundAfter, refund.wallet_balance_currency)}</strong>
              {' '}{refund.wallet_balance_currency || transaction?.currency}
            </div>
          ) : (
            <div className="mt-1 text-emerald-800">
              Le détail du solde du remboursement n’est pas disponible.
            </div>
          )}
        </div>
      )}
    </section>
  );
}
