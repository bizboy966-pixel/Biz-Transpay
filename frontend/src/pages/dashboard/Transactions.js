import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowDownLeft, ArrowUpRight, Download, Search, SlidersHorizontal } from 'lucide-react';
import api from '@/api';
import TransactionDetailModal from './TransactionDetailModal';

const TYPES = ['all', 'deposit', 'transfer', 'link_payment', 'payment', 'exchange', 'withdrawal'];
const STATUSES = ['all', 'completed', 'pending', 'failed', 'cancelled'];

const TYPE_LABELS = {
  deposit: 'Dépôt',
  transfer: 'Transfert',
  link_payment: 'Paiement par lien',
  payment: 'Paiement API',
  exchange: 'Conversion',
  withdrawal: 'Retrait',
};

const STATUS_LABELS = {
  completed: 'Validée',
  pending: 'En attente',
  failed: 'Échouée',
  cancelled: 'Annulée',
};

function money(value, currency) {
  const digits = ['USDT', 'BTC', 'ETH'].includes(String(currency).toUpperCase()) ? 6 : 0;
  return `${Number(value || 0).toLocaleString('fr-FR', { maximumFractionDigits: digits })} ${currency || ''}`.trim();
}


function dateLabel(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
}

function typeLabel(tx) {
  if (tx.type === 'deposit' && tx.direction === 'in') return 'Dépôt reçu';
  if (tx.type === 'withdrawal' && tx.direction === 'out') return 'Retrait envoyé';
  if (tx.type === 'transfer') return tx.direction === 'out' ? 'Transfert envoyé' : 'Transfert reçu';
  return TYPE_LABELS[tx.type] || tx.type || 'Transaction';
}

function partyLabel(tx) {
  const meta = tx.metadata || {};
  if (tx.direction === 'in') {
    return meta.customer_name || meta.full_name || meta.customer_email || meta.phone_number || tx.counterparty || 'Expéditeur externe';
  }
  return meta.recipient_name || meta.recipient || meta.beneficiary_name || tx.counterparty || 'Destinataire';
}

function partyContact(tx) {
  const meta = tx.metadata || {};
  if (tx.direction === 'in') return meta.customer_phone || meta.phone_number || meta.customer_email || '';
  return meta.recipient_phone || meta.phone_number || meta.beneficiary_email || '';
}

function methodLabel(tx) {
  const meta = tx.metadata || {};
  if (meta.coin || meta.network || meta.tx_hash || meta.txid) return `${meta.coin || 'Crypto'}${meta.network ? ` · ${meta.network}` : ''}`;
  if (meta.operator_name || meta.operator || meta.phone_number || meta.method === 'mobile_money') return meta.operator_name || meta.operator || 'Mobile Money';
  if (meta.link_id || meta.link_payment_id) return 'Lien de paiement';
  if (meta.merchant_payment_id || tx.type === 'payment') return 'API';
  return '';
}

function statusColor(status) {
  return {
    completed: 'bg-emerald-50 text-emerald-700',
    pending: 'bg-amber-50 text-amber-700',
    failed: 'bg-red-50 text-red-700',
    cancelled: 'bg-slate-100 text-slate-600',
  }[status] || 'bg-slate-100 text-slate-600';
}

function csvValue(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export default function Transactions() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get('q') || '');
  const [type, setType] = useState('all');
  const [status, setStatus] = useState('all');
  const [txs, setTxs] = useState([]);
  const [selectedTx, setSelectedTx] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = () => {
    const query = {};
    if (q.trim()) query.q = q.trim();
    if (type !== 'all') query.type = type;
    if (status !== 'all') query.status = status;
    setLoading(true);
    api.get('/transactions', { params: query })
      .then(({ data }) => setTxs(Array.isArray(data) ? data : []))
      .catch(() => setTxs([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [type, status]);
  useEffect(() => {
    const timer = setTimeout(load, 250);
    return () => clearTimeout(timer);
    /* eslint-disable-next-line */
  }, [q]);

  const exportCsv = () => {
    const rows = [['Référence Biz-transPay', 'Type', 'Direction', 'Montant', 'Devise', 'Statut', 'Identifiant externe', 'Référence prestataire', 'TXID', 'Date']];
    txs.forEach((tx) => {
      const meta = tx.metadata || {};
      rows.push([
        tx.reference || tx.id, typeLabel(tx), tx.direction, tx.amount, tx.currency, STATUS_LABELS[tx.status] || tx.status,
        meta.external_id || meta.external_reference || meta.merchant_payment_id || meta.link_payment_id || '',
        meta.provider_reference || meta.paydunya_reference || meta.izipay_intent_id || '',
        meta.tx_hash || meta.txid || '',
        tx.created_at,
      ]);
    });
    const csv = rows.map((row) => row.map(csvValue).join(';')).join('\n');
    const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'transactions-biz-transpay.csv';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-w-0 max-w-full space-y-5 overflow-x-hidden" data-testid="page-transactions">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-cabinet text-3xl font-extrabold tracking-tighter text-slate-900">{t('dashboard.transactions')}</h1>
          <p className="mt-1 text-sm text-slate-500">{t('dashboard.history')}</p>
        </div>
        <button type="button" onClick={exportCsv} data-testid="btn-export" className="inline-flex shrink-0 items-center gap-2 rounded-full border border-slate-200 px-4 py-2.5 text-sm font-semibold hover:bg-slate-50">
          <Download className="h-4 w-4" /> Exporter
        </button>
      </div>

      <div className="rounded-[20px] border border-slate-100 bg-white p-3 sm:p-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <div className="flex min-w-0 flex-1 basis-full items-center gap-2 rounded-xl border border-slate-200 px-3 sm:basis-[280px]">
            <Search className="h-4 w-4 shrink-0 text-slate-400" />
            <input
              value={q}
              onChange={(event) => setQ(event.target.value)}
              data-testid="tx-search"
              placeholder="Référence, téléphone, e-mail, montant, ID externe, TXID…"
              className="min-w-0 flex-1 bg-transparent py-2.5 text-sm outline-none"
              aria-label="Rechercher une transaction"
            />
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <SlidersHorizontal className="hidden h-4 w-4 text-slate-400 sm:block" />
            <select value={type} onChange={(event) => setType(event.target.value)} data-testid="tx-filter-type" className="min-w-0 max-w-[48%] rounded-xl border border-slate-200 px-2.5 py-2.5 text-xs font-semibold sm:px-4 sm:text-sm">
              {TYPES.map((value) => <option key={value} value={value}>{value === 'all' ? 'Tous types' : TYPE_LABELS[value]}</option>)}
            </select>
            <select value={status} onChange={(event) => setStatus(event.target.value)} data-testid="tx-filter-status" className="min-w-0 max-w-[48%] rounded-xl border border-slate-200 px-2.5 py-2.5 text-xs font-semibold sm:px-4 sm:text-sm">
              {STATUSES.map((value) => <option key={value} value={value}>{value === 'all' ? 'Tous statuts' : STATUS_LABELS[value]}</option>)}
            </select>
          </div>
        </div>
        <p className="mt-2 truncate text-[11px] text-slate-400">Recherche par référence Biz-transPay, téléphone, e-mail, montant, identifiant externe, prestataire ou TXID crypto.</p>
      </div>

      <div className="min-w-0 overflow-hidden rounded-[20px] border border-slate-100 bg-white">
        <div className="hidden grid-cols-[auto_minmax(0,1fr)_auto_auto] gap-4 bg-slate-50 px-5 py-3 text-[11px] font-bold uppercase tracking-wider text-slate-500 sm:grid lg:px-6">
          <div>Type</div><div>From / To</div><div>Statut</div><div className="text-right">Montant</div>
        </div>
        {loading && txs.length === 0 && <div className="p-10 text-center text-sm text-slate-400">Chargement de l’historique…</div>}
        {!loading && txs.length === 0 && <div className="p-10 text-center text-sm text-slate-400" data-testid="tx-empty">{q ? 'Aucune transaction trouvée.' : 'Aucune transaction'}</div>}
        {txs.map((tx) => {
          const incoming = tx.direction === 'in';
          const meta = tx.metadata || {};
          const contact = partyContact(tx);
          return (
            <button
              type="button"
              key={tx.id}
              data-testid={`tx-row-${tx.id}`}
              onClick={() => setSelectedTx(tx)}
              className="grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-t border-slate-50 px-3 py-3.5 text-left transition-colors hover:bg-slate-50 focus:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[#2563EB] sm:gap-4 sm:px-5 lg:px-6"
              aria-label={`Ouvrir ${typeLabel(tx)} ${money(tx.amount, tx.currency)}`}
            >
              <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${incoming ? 'bg-emerald-50 text-emerald-600' : 'bg-blue-50 text-blue-600'}`}>
                {incoming ? <ArrowDownLeft className="h-5 w-5" /> : <ArrowUpRight className="h-5 w-5" />}
              </span>
              <span className="min-w-0">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-bold text-slate-900">{typeLabel(tx)}</span>
                  {methodLabel(tx) && <span className="hidden shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 sm:inline">{methodLabel(tx)}</span>}
                </span>
                <span className="mt-0.5 block truncate text-xs text-slate-600" title={`${incoming ? 'From' : 'To'}: ${partyLabel(tx)}${contact ? ` · ${contact}` : ''}`}>
                  <span className="font-semibold text-slate-400">{incoming ? 'From' : 'To'}:</span> {partyLabel(tx)}{contact ? ` · ${contact}` : ''}
                </span>
                <span className="mt-0.5 block truncate text-[10px] text-slate-400">
                  {tx.reference || tx.id}
                  {meta.operator_name || meta.operator ? ` · ${meta.operator_name || meta.operator}` : ''}
                </span>
                <span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold sm:hidden ${statusColor(tx.status)}`}>{STATUS_LABELS[tx.status] || tx.status}</span>
              </span>
              <span className="flex min-w-[92px] shrink-0 flex-col items-end text-right">
                <span className={`whitespace-nowrap text-sm font-extrabold ${incoming ? 'text-emerald-600' : 'text-slate-900'}`}>{incoming ? '+' : '-'}{money(tx.amount, tx.currency)}</span>
                <span className="mt-1 whitespace-nowrap text-[10px] text-slate-400">{dateLabel(tx.created_at)}</span>
              </span>
              <span className={`hidden shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold sm:inline-flex ${statusColor(tx.status)}`}>{STATUS_LABELS[tx.status] || tx.status}</span>
            </button>
          );
        })}
      </div>

      {selectedTx && <TransactionDetailModal tx={selectedTx} onClose={() => setSelectedTx(null)} />}
    </div>
  );
}