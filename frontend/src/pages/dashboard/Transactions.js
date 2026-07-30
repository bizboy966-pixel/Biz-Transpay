import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search, ArrowDownLeft, ArrowUpRight, Download, ExternalLink } from 'lucide-react';
import api from '@/api';

const TYPES = ['all', 'deposit', 'transfer', 'link_payment', 'exchange', 'withdrawal'];
const STATUSES = ['all', 'completed', 'pending', 'failed'];

// Public block explorers to build a link for tx_hash inspection.
const EXPLORER = {
  TRC20: 'https://tronscan.org/#/transaction/',
  BEP20: 'https://bscscan.com/tx/',
  ERC20: 'https://etherscan.io/tx/',
  SOLANA: 'https://solscan.io/tx/',
  BTC: 'https://mempool.space/tx/',
};

export default function Transactions() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get('q') || '');
  const [type, setType] = useState('all');
  const [status, setStatus] = useState('all');
  const [txs, setTxs] = useState([]);

  const load = () => {
    const p = {};
    if (q) p.q = q;
    if (type !== 'all') p.type = type;
    if (status !== 'all') p.status = status;
    api.get('/transactions', { params: p }).then(({ data }) => setTxs(data)).catch(() => {});
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [type, status]);

  // Debounced live search — triggers on typing/paste, no button click needed.
  useEffect(() => {
    const id = setTimeout(() => { load(); }, 250);
    return () => clearTimeout(id);
    /* eslint-disable-next-line */
  }, [q]);

  const exportCsv = () => {
    const rows = [['ID', 'Type', 'Direction', 'Amount', 'Currency', 'Status', 'Reference', 'Date']];
    txs.forEach((t) => rows.push([t.id, t.type, t.direction, t.amount, t.currency, t.status, t.reference, t.created_at]));
    const csv = rows.map((r) => r.join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = 'transactions.csv'; a.click();
  };

  const statusColor = (s) => ({ completed: 'bg-emerald-50 text-emerald-700', pending: 'bg-amber-50 text-amber-700', failed: 'bg-red-50 text-red-700', cancelled: 'bg-slate-100 text-slate-600' }[s] || 'bg-slate-100 text-slate-600');

  return (
    <div className="space-y-6" data-testid="page-transactions">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="font-cabinet text-3xl font-extrabold tracking-tighter text-slate-900">{t('dashboard.transactions')}</h1>
          <p className="text-slate-500 text-sm mt-1">{t('dashboard.history')}</p>
        </div>
        <button onClick={exportCsv} data-testid="btn-export" className="inline-flex items-center gap-2 border border-slate-200 rounded-full px-5 py-2.5 text-sm font-semibold hover:bg-slate-50">
          <Download className="w-4 h-4" /> Exporter
        </button>
      </div>

      <div className="bg-white border border-slate-100 rounded-[20px] p-4 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[200px] flex items-center gap-2 px-3 border border-slate-200 rounded-xl">
          <Search className="w-4 h-4 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} data-testid="tx-search" placeholder="ID, référence, email, adresse wallet, hash…" className="flex-1 py-2.5 outline-none text-sm bg-transparent" />
        </div>
        <select value={type} onChange={(e) => setType(e.target.value)} data-testid="tx-filter-type" className="px-4 py-2.5 border border-slate-200 rounded-xl text-sm font-semibold">
          {TYPES.map((tt) => <option key={tt} value={tt}>{tt === 'all' ? 'Tous types' : tt}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} data-testid="tx-filter-status" className="px-4 py-2.5 border border-slate-200 rounded-xl text-sm font-semibold">
          {STATUSES.map((s) => <option key={s} value={s}>{s === 'all' ? 'Tous statuts' : s}</option>)}
        </select>
      </div>

      <div className="bg-white border border-slate-100 rounded-[20px] overflow-hidden">
        <div className="grid grid-cols-[auto_1fr_auto_auto] gap-4 px-6 py-3 bg-slate-50 text-[11px] font-bold uppercase tracking-wider text-slate-500">
          <div>Type</div><div>Détails</div><div>Statut</div><div className="text-right">Montant</div>
        </div>
        {txs.length === 0 && <div className="p-10 text-center text-slate-400 text-sm" data-testid="tx-empty">{q ? 'Aucune transaction trouvée.' : 'Aucune transaction'}</div>}
        {txs.map((tx) => {
          const meta = tx.metadata || {};
          const coin = meta.coin;
          const network = meta.network;
          const txHash = meta.tx_hash;
          const explorer = network && EXPLORER[network];
          return (
          <div key={tx.id} data-testid={`tx-row-${tx.id}`} className="grid grid-cols-[auto_1fr_auto_auto] gap-4 items-center px-6 py-4 border-t border-slate-50 hover:bg-slate-50/50">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${tx.direction === 'in' ? 'bg-emerald-50 text-emerald-600' : 'bg-blue-50 text-blue-600'}`}>
              {tx.direction === 'in' ? <ArrowDownLeft className="w-5 h-5" /> : <ArrowUpRight className="w-5 h-5" />}
            </div>
            <div>
              <div className="font-semibold text-slate-900 text-sm">{tx.type}{tx.counterparty && ` → ${tx.counterparty}`}</div>
              <div className="text-xs text-slate-500">
                {tx.reference} · {new Date(tx.created_at).toLocaleString()}
                {(coin || network) && <span className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-orange-50 text-orange-700 font-semibold text-[10px]">{coin}{network ? ` · ${network}` : ''}</span>}
              </div>
              {txHash && (
                <div className="mt-1 text-[10px] text-slate-500 flex items-center gap-1">
                  <span className="font-mono truncate max-w-[240px] sm:max-w-[380px]" title={txHash}>{txHash}</span>
                  {explorer && (
                    <a href={`${explorer}${txHash}`} target="_blank" rel="noreferrer" className="text-[#2563EB] hover:underline inline-flex items-center gap-0.5" data-testid={`tx-explorer-${tx.id}`}>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>
              )}
              {(meta.amount_gross != null || meta.fee != null) && (
                <div className="mt-1 text-[10px] text-slate-500">
                  {meta.amount_gross != null && <span>Brut: <b className="text-slate-700">{Number(meta.amount_gross).toLocaleString(undefined,{maximumFractionDigits:6})}</b></span>}
                  {meta.fee != null && <span className="ml-2">Frais {meta.fee_pct ? `(${meta.fee_pct}%)` : ''}: <b className="text-red-600">−{Number(meta.fee).toLocaleString(undefined,{maximumFractionDigits:6})}</b></span>}
                  {meta.amount_net != null && <span className="ml-2">Net: <b className="text-emerald-600">{Number(meta.amount_net).toLocaleString(undefined,{maximumFractionDigits:6})}</b></span>}
                </div>
              )}
            </div>
            <span className={`px-2.5 py-1 rounded-full text-[11px] font-bold ${statusColor(tx.status)}`}>{tx.status}</span>
            <div className={`text-right font-bold ${tx.direction === 'in' ? 'text-emerald-600' : 'text-slate-900'}`}>
              {tx.direction === 'in' ? '+' : '-'}{tx.amount.toLocaleString(undefined, { maximumFractionDigits: tx.currency === 'USDT' ? 6 : 0 })} <span className="text-xs opacity-70">{tx.currency}</span>
            </div>
          </div>
          );
        })}
      </div>
    </div>
  );
}
