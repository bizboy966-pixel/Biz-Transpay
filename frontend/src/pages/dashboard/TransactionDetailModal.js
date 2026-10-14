import { useEffect, useState } from 'react';
import {
  ArrowDownLeft, ArrowUpRight, CalendarDays, Check, Copy, Download,
  ExternalLink, FileText, Hash, Mail, MapPin, Phone, Receipt,
  UserRound, WalletCards, X,
} from 'lucide-react';
import { CountryBadge, OperatorLogo } from '@/components/PaymentBrand';
import WalletBalanceSnapshot from '@/components/WalletBalanceSnapshot';

const EXPLORER = {
  TRC20: 'https://tronscan.org/#/transaction/',
  BEP20: 'https://bscscan.com/tx/',
  ERC20: 'https://etherscan.io/tx/',
  SOLANA: 'https://solscan.io/tx/',
  BTC: 'https://mempool.space/tx/',
};

const COUNTRIES = {
  BJ: 'Bénin', CI: "Côte d’Ivoire", TG: 'Togo', CM: 'Cameroun',
  SN: 'Sénégal', BF: 'Burkina Faso', ML: 'Mali', NE: 'Niger',
};

function money(value, currency) {
  if (value === null || value === undefined || value === '') return '—';
  const digits = ['USDT', 'BTC', 'ETH'].includes(String(currency).toUpperCase())
    ? 6 : (Number.isInteger(Number(value)) ? 0 : 2);
  return `${Number(value).toLocaleString('fr-FR', { maximumFractionDigits: digits })} ${currency || ''}`.trim();
}

function dateLabel(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('fr-FR', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function first(meta, keys) {
  return keys.map((key) => meta?.[key]).find((value) => value !== null && value !== undefined && value !== '');
}

function typeLabel(tx) {
  const metadata = tx.metadata || {};
  const source = String(
    metadata.payment_source || metadata.source || '',
  ).trim().toLowerCase();
  if (
    tx.history_type === 'payment'
    || (['deposit', 'deposit_in', 'payin'].includes(String(tx.type).toLowerCase())
      && (
        ['api', 'integration_api', 'merchant_api'].includes(source)
        || String(metadata.idempotency_key || '').startsWith('btpi_')
        || Boolean(metadata.integration_reference || metadata.merchant_payment_id)
      ))
  ) return 'Paiement reçu (API)';
  const labels = {
    deposit: tx.direction === 'in' ? 'Dépôt reçu' : 'Dépôt',
    withdrawal: tx.direction === 'out' ? 'Retrait envoyé' : 'Retrait',
    transfer: tx.direction === 'out' ? 'Transfert envoyé' : 'Transfert reçu',
    link_payment: 'Paiement reçu (lien)',
    payment: 'Paiement reçu (API)',
    exchange: 'Conversion',
    referral_commission: 'Commission de parrainage',
  };
  return labels[tx.type] || tx.type || 'Transaction';
}

function methodLabel(meta) {
  if (meta?.coin || meta?.network || meta?.tx_hash || meta?.txid) {
    return `Crypto${meta.coin ? ` · ${meta.coin}` : ''}${meta.network ? ` · ${meta.network}` : ''}`;
  }
  if (meta?.method === 'mobile_money' || meta?.operator || meta?.phone_number) return 'Mobile Money';
  if (meta?.provider === 'paydunya') return 'Paiement mobile';
  if (meta?.provider === 'izipay' || meta?.izipay_intent_id) return 'IziChangePay';
  if (meta?.link_id || meta?.link_payment_id) return 'Lien de paiement';
  return 'Solde Biz-transPay';
}

function Party({ icon: Icon, label, name, phone, email }) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-500">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
        <div className="truncate text-sm font-bold text-slate-900" title={name || ''}>{name || '—'}</div>
        {phone && <div className="truncate text-xs text-slate-500"><Phone className="mr-1 inline h-3 w-3" />{phone}</div>}
        {email && <div className="truncate text-xs text-slate-500"><Mail className="mr-1 inline h-3 w-3" />{email}</div>}
      </div>
    </div>
  );
}

function safeExternalUrl(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    const url = new URL(value, window.location.origin);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function InfoRow({ icon: Icon, label, value, content, copyable = false, external = false, onCopy }) {
  if (value === null || value === undefined || value === '') {
    if (content === null || content === undefined) return null;
  }
  return (
    <div className="flex min-w-0 items-start gap-3 border-b border-slate-100 py-3 last:border-b-0">
      {Icon && <Icon className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />}
      <span className="w-32 shrink-0 text-xs text-slate-500 sm:w-40">{label}</span>
      <span className="min-w-0 flex-1 break-words text-right text-xs font-semibold text-slate-800">{content !== undefined ? content : value}</span>
      {copyable && <button type="button" onClick={() => onCopy(value)} className="shrink-0 text-slate-400 hover:text-[#2563EB]" aria-label={`Copier ${label}`}><Copy className="h-3.5 w-3.5" /></button>}
      {external && <a href={external} target="_blank" rel="noreferrer" className="shrink-0 text-[#2563EB]" aria-label={`Ouvrir ${label}`}><ExternalLink className="h-3.5 w-3.5" /></a>}
    </div>
  );
}

export default function TransactionDetailModal({ tx, onClose }) {
  const [copied, setCopied] = useState('');
  const meta = tx?.metadata || {};

  useEffect(() => {
    const onKeyDown = (event) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const detail = (() => {
    const incoming = tx.direction === 'in';
    const senderName = first(meta, ['customer_name', 'full_name', 'sender_name'])
      || (incoming ? 'Expéditeur Mobile Money' : 'Votre wallet');
    const recipientName = first(meta, ['recipient_name', 'recipient', 'beneficiary_name'])
      || (!incoming ? tx.counterparty : 'Votre wallet');
    const senderPhone = first(meta, ['customer_phone', 'phone_number', 'sender_phone']);
    const recipientPhone = first(meta, ['recipient_phone', 'beneficiary_phone']);
    const senderEmail = first(meta, ['customer_email', 'email', 'sender_email']);
    const recipientEmail = first(meta, ['recipient_email', 'beneficiary_email']);
    const fee = meta.fee !== undefined
      ? meta.fee
      : (meta.gateway_fee !== undefined || meta.platform_fee !== undefined
        ? Number(meta.gateway_fee || 0) + Number(meta.platform_fee || 0) : null);
    const gross = first(meta, ['charged_amount', 'amount_gross', 'total_debit']);
    const net = incoming
      ? tx.amount
      : first(meta, ['recipient_gets', 'amount_net']) ?? tx.amount;
    const providerReference = first(meta, [
      'provider_reference', 'paydunya_reference', 'izipay_payout_id', 'provider_id',
    ]);
    const externalReference = first(meta, [
      'external_id', 'external_reference', 'merchant_payment_id',
      'link_payment_id', 'payment_id', 'izipay_intent_id',
    ]);
    const txid = first(meta, ['tx_hash', 'txid', 'tx_id']);
    const explorer = meta.network && EXPLORER[String(meta.network).toUpperCase()];
    const countryCode = first(meta, ['country_code', 'country']);
    const operator = first(meta, ['operator', 'operator_code']);
    const operatorName = first(meta, ['operator_name', 'operator_label', 'operator']);
    return {
      incoming, senderName, recipientName, senderPhone, recipientPhone,
      senderEmail, recipientEmail, fee, gross, net, providerReference,
      externalReference, txid, explorer: explorer && txid ? `${explorer}${txid}` : null,
      countryCode,
      country: COUNTRIES[String(countryCode || '').toUpperCase()] || countryCode,
      operator,
      operatorName,
    };
  })();

  if (!tx) return null;

  const copyValue = async (value) => {
    try {
      await navigator.clipboard.writeText(String(value));
      setCopied(String(value));
      window.setTimeout(() => setCopied(''), 1400);
    } catch (error) {
      // Clipboard access is optional; the value remains visible for manual copy.
    }
  };

  const statusLabel = { completed: 'Validée', pending: 'En attente', failed: 'Échouée', cancelled: 'Annulée' }[tx.status] || tx.status;
  const statusColor = {
    completed: 'bg-emerald-100 text-emerald-700',
    pending: 'bg-amber-100 text-amber-700',
    failed: 'bg-red-100 text-red-700',
    cancelled: 'bg-slate-100 text-slate-600',
  }[tx.status] || 'bg-slate-100 text-slate-600';
  const currency = tx.currency;

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-slate-950/45 p-0 sm:items-center sm:p-5" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="flex max-h-[94dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-[24px] bg-white shadow-2xl sm:max-h-[90dvh] sm:rounded-[24px]" role="dialog" aria-modal="true" aria-labelledby="transaction-detail-title" data-testid="transaction-detail">
        <header className="flex shrink-0 items-center gap-3 border-b border-slate-100 px-4 py-3 sm:px-6">
          <button type="button" onClick={onClose} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl hover:bg-slate-100 sm:hidden" aria-label="Fermer"><X className="h-5 w-5" /></button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-semibold text-slate-500">Détail de la transaction</div>
            <h2 id="transaction-detail-title" className="truncate text-lg font-extrabold text-slate-900">{typeLabel(tx)}</h2>
          </div>
          <button type="button" onClick={onClose} className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-xl hover:bg-slate-100 sm:flex" aria-label="Fermer"><X className="h-5 w-5" /></button>
        </header>

        <div className="min-h-0 overflow-y-auto px-4 pb-6 sm:px-6">
          <div className={`my-4 rounded-2xl border p-5 text-center ${detail.incoming ? 'border-emerald-100 bg-emerald-50/60' : 'border-blue-100 bg-blue-50/60'}`}>
            <div className={`mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full ${detail.incoming ? 'bg-emerald-100 text-emerald-600' : 'bg-blue-100 text-blue-600'}`}>
              {detail.operatorName
                 ? <OperatorLogo operator={detail.operator} name={detail.operatorName} country={detail.countryCode} logoUrl={meta.operator_logo || meta.logo_url} size="lg" />
                : detail.countryCode
                  ? <CountryBadge code={detail.countryCode} />
                  : (detail.incoming ? <ArrowDownLeft className="h-6 w-6" /> : <ArrowUpRight className="h-6 w-6" />)}
            </div>
            <div className="text-sm font-semibold text-slate-600">{typeLabel(tx)}</div>
            <div className={`mt-1 text-3xl font-extrabold tracking-tight ${detail.incoming ? 'text-emerald-600' : 'text-slate-900'}`}>
              {detail.incoming ? '+' : '-'}{money(tx.amount, currency)}
            </div>
            <span className={`mt-3 inline-flex rounded-full px-3 py-1 text-xs font-bold ${statusColor}`}>{statusLabel}</span>
            <div className="mt-2 text-xs text-slate-500">Transaction {tx.status === 'completed' ? 'réussie' : 'enregistrée'}</div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-slate-100 bg-white p-4">
              <div className="mb-3 text-sm font-extrabold text-slate-900">Expéditeur</div>
              <Party icon={UserRound} label={detail.incoming ? 'From' : 'Compte Biz-transPay'} name={detail.senderName} phone={detail.senderPhone} email={detail.senderEmail} />
            </div>
            <div className="rounded-2xl border border-slate-100 bg-white p-4">
              <div className="mb-3 text-sm font-extrabold text-slate-900">Destinataire</div>
              <Party icon={WalletCards} label={detail.incoming ? 'Compte Biz-transPay' : 'To'} name={detail.recipientName} phone={detail.recipientPhone} email={detail.recipientEmail} />
            </div>
          </div>

          <div className="mt-3 rounded-2xl border border-slate-100 bg-white px-4">
            <h3 className="pt-4 text-sm font-extrabold text-slate-900">Informations générales</h3>
            <InfoRow icon={CalendarDays} label="Date et heure" value={dateLabel(tx.created_at)} />
            <InfoRow icon={Receipt} label="Statut" value={statusLabel} />
            <InfoRow icon={FileText} label="Type" value={typeLabel(tx)} />
            <InfoRow icon={WalletCards} label="Méthode" value={methodLabel(meta)} />
            <InfoRow icon={MapPin} label="Pays" value={detail.country} content={<CountryBadge code={detail.countryCode} label={detail.country} />} />
            <InfoRow icon={FileText} label="Opérateur" value={detail.operatorName} content={detail.operatorName && (
              <span className="inline-flex items-center justify-end gap-2">
                 <OperatorLogo operator={detail.operator} name={detail.operatorName} country={detail.countryCode} logoUrl={meta.operator_logo || meta.logo_url} size="sm" />
                <span>{detail.operatorName}</span>
              </span>
            )} />
          </div>

          <div className="mt-3 rounded-2xl border border-slate-100 bg-white px-4">
            <h3 className="pt-4 text-sm font-extrabold text-slate-900">Détails financiers</h3>
            <InfoRow icon={WalletCards} label={detail.incoming ? 'Montant total payé' : 'Montant débité'} value={money(detail.gross ?? tx.amount, currency)} />
            <InfoRow icon={Receipt} label="Frais prélevés" value={detail.fee === null ? '0' : money(detail.fee, currency)} />
            <InfoRow icon={WalletCards} label={detail.incoming ? 'Montant crédité' : 'Montant reçu'} value={money(detail.net, currency)} />
            {meta.rate !== undefined && <InfoRow icon={Receipt} label="Taux de conversion" value={String(meta.rate)} />}
            <InfoRow icon={WalletCards} label="Devise" value={currency} />
          </div>
          <WalletBalanceSnapshot transaction={tx} />

          <div className="mt-3 rounded-2xl border border-slate-100 bg-white px-4">
            <h3 className="pt-4 text-sm font-extrabold text-slate-900">Références de rapprochement</h3>
            <InfoRow icon={Hash} label="Référence Biz-transPay" value={tx.reference || tx.id} copyable onCopy={copyValue} />
            <InfoRow icon={Hash} label="Identifiant externe" value={detail.externalReference} copyable onCopy={copyValue} />
            <InfoRow icon={Hash} label="Référence prestataire" value={detail.providerReference || first(meta, ['paydunya_token'])} copyable onCopy={copyValue} />
            <InfoRow icon={Hash} label="TXID crypto" value={detail.txid} copyable external={detail.explorer} onCopy={copyValue} />
            <InfoRow icon={FileText} label="Description" value={tx.description} />
          </div>

           {safeExternalUrl(meta.receipt_url) && (
            <a href={safeExternalUrl(meta.receipt_url)} target="_blank" rel="noreferrer" className="mt-4 flex min-h-12 items-center justify-center gap-2 rounded-xl border border-slate-200 px-4 text-sm font-bold text-[#2563EB] hover:bg-blue-50" data-testid={`detail-receipt-${tx.id}`}>
              <Download className="h-4 w-4" /> Télécharger le reçu
            </a>
          )}
          {copied && <div className="mt-3 flex items-center justify-center gap-2 text-xs font-semibold text-emerald-600"><Check className="h-3.5 w-3.5" /> Référence copiée</div>}
        </div>
      </section>
    </div>
  );
}