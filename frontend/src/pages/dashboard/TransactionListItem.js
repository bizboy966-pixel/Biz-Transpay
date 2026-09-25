import { ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { CountryBadge, findCountry, OperatorLogo } from '@/components/PaymentBrand';

export const TYPE_LABELS = {
  deposit: 'Dépôt',
  transfer: 'Transfert',
  link_payment: 'Paiement par lien',
  payment: 'Paiement API',
  exchange: 'Conversion',
  withdrawal: 'Retrait',
  referral_commission: 'Commission de parrainage',
};

export const STATUS_LABELS = {
  completed: 'Validée',
  pending: 'En attente',
  failed: 'Échouée',
  cancelled: 'Annulée',
};

export function money(value, currency) {
  const digits = ['USDT', 'BTC', 'ETH'].includes(String(currency).toUpperCase())
    ? 6 : (Number.isInteger(Number(value)) ? 0 : 2);
  return `${Number(value || 0).toLocaleString('fr-FR', { maximumFractionDigits: digits })} ${currency || ''}`.trim();
}

export function dateLabel(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function typeLabel(tx) {
  if (tx.type === 'deposit' && tx.direction === 'in') return 'Dépôt reçu';
  if (tx.type === 'withdrawal' && tx.direction === 'out') return 'Retrait envoyé';
  if (tx.type === 'transfer') return tx.direction === 'out' ? 'Transfert envoyé' : 'Transfert reçu';
  return TYPE_LABELS[tx.type] || tx.type || 'Transaction';
}

export function partyLabel(tx) {
  const meta = tx.metadata || {};
  if (tx.type === 'referral_commission') return 'Biz-transPay';
  if (tx.direction === 'in') {
    return meta.customer_name || meta.full_name || meta.customer_email || meta.phone_number || tx.counterparty || 'Expéditeur externe';
  }
  return meta.recipient_name || meta.recipient || meta.beneficiary_name || tx.counterparty || 'Destinataire';
}

export function partyContact(tx) {
  const meta = tx.metadata || {};
  if (tx.direction === 'in') return meta.customer_phone || meta.phone_number || meta.customer_email || '';
  return meta.recipient_phone || meta.phone_number || meta.beneficiary_email || '';
}

export function methodLabel(tx) {
  const meta = tx.metadata || {};
  if (meta.coin || meta.network || meta.tx_hash || meta.txid) return `${meta.coin || 'Crypto'}${meta.network ? ` · ${meta.network}` : ''}`;
  if (meta.operator_name || meta.operator || meta.phone_number || meta.method === 'mobile_money') return meta.operator_name || meta.operator || 'Mobile Money';
  if (meta.link_id || meta.link_payment_id) return 'Lien de paiement';
  if (meta.merchant_payment_id || tx.type === 'payment') return 'API';
  return '';
}

export function statusColor(status) {
  return {
    completed: 'bg-emerald-50 text-emerald-700',
    pending: 'bg-amber-50 text-amber-700',
    failed: 'bg-red-50 text-red-700',
    cancelled: 'bg-slate-100 text-slate-600',
  }[status] || 'bg-slate-100 text-slate-600';
}

export default function TransactionListItem({ tx, onClick, hidden = false, testId }) {
  const incoming = tx.direction === 'in';
  const meta = tx.metadata || {};
  const contact = partyContact(tx);
  const operatorValue = meta.operator;
  const operator = meta.operator_name
    || (typeof operatorValue === 'object'
      ? operatorValue.name || operatorValue.label || operatorValue.code || operatorValue.operator
      : operatorValue);
  const operatorCode = typeof operatorValue === 'object'
    ? operatorValue.code || operatorValue.operator || operator
    : operatorValue;
  const countryCode = meta.country_code || meta.country;
  const country = findCountry(countryCode);
  const row = (
    <>
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${incoming ? 'bg-emerald-50 text-emerald-600' : 'bg-blue-50 text-blue-600'}`}>
        {operator
          ? <OperatorLogo
              operator={operatorCode}
              name={operator}
              country={countryCode}
              logoUrl={meta.operator_logo || meta.logo_url}
              size="md"
            />
          : country
            ? <CountryBadge code={country.code} />
            : (incoming ? <ArrowDownLeft className="h-5 w-5" /> : <ArrowUpRight className="h-5 w-5" />)}
      </span>
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-bold text-slate-900">{typeLabel(tx)}</span>
          {methodLabel(tx) && <span className="hidden shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 sm:inline">{methodLabel(tx)}</span>}
        </span>
        <span className="mt-0.5 block truncate text-xs text-slate-600" title={`${incoming ? 'From' : 'To'}: ${partyLabel(tx)}${contact ? ` · ${contact}` : ''}`}>
          <span className="font-semibold text-slate-400">{incoming ? 'From' : 'To'}:</span> {partyLabel(tx)}{contact ? ` · ${contact}` : ''}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-[10px] text-slate-400">
          {tx.reference || tx.id}
           {country && <CountryBadge code={country.code} className="ml-1" />}
           {operator && <span className="truncate">· {operator}</span>}
        </span>
        <span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold sm:hidden ${statusColor(tx.status)}`}>{STATUS_LABELS[tx.status] || tx.status}</span>
      </span>
      <span className="flex min-w-[92px] shrink-0 flex-col items-end text-right">
        <span className={`whitespace-nowrap text-sm font-extrabold ${incoming ? 'text-emerald-600' : 'text-slate-900'}`}>{incoming ? '+' : '-'}{hidden ? '•••' : money(tx.amount, tx.currency)}</span>
        <span className="mt-1 whitespace-nowrap text-[10px] text-slate-400">{dateLabel(tx.created_at)}</span>
      </span>
      <span className={`hidden shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold sm:inline-flex ${statusColor(tx.status)}`}>{STATUS_LABELS[tx.status] || tx.status}</span>
    </>
  );

  return (
    <button
      type="button"
      key={tx.id}
      data-testid={testId || `tx-row-${tx.id}`}
      onClick={onClick}
      className="grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-t border-slate-50 px-3 py-3.5 text-left transition-colors hover:bg-slate-50 focus:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[#2563EB] sm:gap-4 sm:px-5 lg:px-6"
      aria-label={`Ouvrir ${typeLabel(tx)} ${money(tx.amount, tx.currency)}`}
    >
      {row}
    </button>
  );
}