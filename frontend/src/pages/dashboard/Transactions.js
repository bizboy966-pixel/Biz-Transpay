import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Download, Search, SlidersHorizontal } from 'lucide-react';
import api from '@/api';
import TransactionDetailModal from './TransactionDetailModal';
import TransactionListItem, { money, typeLabel, TYPE_LABELS, STATUS_LABELS } from './TransactionListItem';

const TYPES = ['all', 'deposit', 'transfer', 'link_payment', 'payment', 'exchange', 'withdrawal'];
const STATUSES = ['all', 'completed', 'pending', 'failed', 'cancelled'];

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

  // `load` is intentionally recreated with the active filters.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [type, status]);
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
        {txs.map((tx) => <TransactionListItem key={tx.id} tx={tx} onClick={() => setSelectedTx(tx)} />)}
      </div>

      {selectedTx && <TransactionDetailModal tx={selectedTx} onClose={() => setSelectedTx(null)} />}
    </div>
  );
}