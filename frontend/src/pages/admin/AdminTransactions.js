import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search, Download, ArrowDownToLine, ArrowUpFromLine, Eye, Bitcoin, Smartphone, RefreshCw } from 'lucide-react';
import api from '@/api';
import AdminTxDetailModal from './AdminTxDetailModal';

/* Robust channel classifier — matches the backend logic in admin_stats. */
function txChannel(tx) {
  const meta = tx?.metadata || {};
  const cur = (tx?.currency || '').toUpperCase();
  const isCrypto = cur === 'USDT'
    || meta.transfer_type === 'biz_to_crypto'
    || Boolean(meta.crypto || meta.coin || meta.izipay_intent_id);
  return isCrypto ? 'crypto' : 'mobile_money';
}

export default function AdminTransactions({ filterType }) {
  const [txs, setTxs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [searchParams, setSearchParams] = useSearchParams();
  const [type, setType] = useState(filterType || searchParams.get('type') || '');
  const [status, setStatus] = useState(searchParams.get('status') || '');
  const [channel, setChannel] = useState(searchParams.get('channel') || '');
  const [selectedId, setSelectedId] = useState(null);

  const load = () => {
    const p = {};
    if (q) p.q = q; if (type) p.type = type; if (status) p.status = status;
    setLoading(true);
    // Clear the table right away so the admin sees the filter took effect,
    // rather than staring at stale rows while the request is in flight.
    setTxs([]);
    api.get('/admin/transactions', { params: p })
      .then(({ data }) => setTxs(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [type, status]);
  useEffect(() => {
    const id = setTimeout(() => { load(); }, 250);
    return () => clearTimeout(id);
    /* eslint-disable-next-line */
  }, [q]);

  // Persist filters in URL so links from AdminHome (e.g. "?type=deposit&channel=crypto&status=pending") land here.
  useEffect(() => {
    const np = new URLSearchParams();
    if (type) np.set('type', type);
    if (status) np.set('status', status);
    if (channel) np.set('channel', channel);
    setSearchParams(np, { replace: true });
    /* eslint-disable-next-line */
  }, [type, status, channel]);

  // Client-side channel filter (backend doesn't yet support it as a query).
  const filtered = useMemo(() => {
    if (!channel) return txs;
    return txs.filter((t) => txChannel(t) === channel);
  }, [txs, channel]);

  const pendingCount = useMemo(() => filtered.filter(t => t.status === 'pending').length, [filtered]);

  const exportCsv = () => {
    const rows = [['ID', 'Reference', 'User', 'Email', 'Type', 'Direction', 'Channel', 'Amount', 'Currency', 'Status', 'Date']];
    filtered.forEach((t) => rows.push([t.id, t.reference, t.user?.username, t.user?.email, t.type, t.direction, txChannel(t), t.amount, t.currency, t.status, t.created_at]));
    const csv = rows.map((r) => r.map((c) => `"${c ?? ''}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = 'transactions.csv'; a.click();
  };

  const statusColor = (s) => ({
    completed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    pending: 'bg-amber-50 text-amber-700 border-amber-200',
    failed: 'bg-red-50 text-red-700 border-red-200',
    cancelled: 'bg-slate-100 text-slate-600 border-slate-200',
    canceled: 'bg-slate-100 text-slate-600 border-slate-200',
  }[s] || 'bg-slate-100 text-slate-600 border-slate-200');

  const statusLabel = (s) => ({ completed: 'Validé', pending: 'En attente', failed: 'Rejeté' }[s] || s);

  return (
    <div className="space-y-5" data-testid="admin-transactions-page">
      {/* Filters */}
      <div className="bg-white border border-slate-100 rounded-2xl p-4 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[240px] flex items-center gap-2 px-3 border border-slate-200 rounded-xl">
          <Search className="w-4 h-4 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} data-testid="admin-tx-search"
                 placeholder="ID, référence, email, adresse wallet, hash, TXID…"
                 className="flex-1 py-2.5 outline-none text-sm bg-transparent" />
        </div>
        {!filterType && (
          <select value={type} onChange={(e) => setType(e.target.value)} data-testid="admin-tx-type"
                  className="px-3 py-2 border border-slate-200 rounded-xl text-xs font-semibold">
            <option value="">Tous types</option>
            <option value="deposit">Dépôts</option>
            <option value="withdrawal">Retraits</option>
            <option value="transfer">Transferts</option>
            <option value="exchange">Conversions</option>
            <option value="link_payment">Paiements lien</option>
            <option value="payment">Paiements API</option>
          </select>
        )}
        <select value={channel} onChange={(e) => setChannel(e.target.value)} data-testid="admin-tx-channel"
                className="px-3 py-2 border border-slate-200 rounded-xl text-xs font-semibold">
          <option value="">Tous canaux</option>
          <option value="crypto">Crypto</option>
          <option value="mobile_money">Mobile Money</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} data-testid="admin-tx-status"
                className="px-3 py-2 border border-slate-200 rounded-xl text-xs font-semibold">
          <option value="">Tous statuts</option>
          <option value="completed">Validés</option>
          <option value="pending">En attente</option>
          <option value="failed">Rejetés</option>
        </select>
        <button onClick={load} data-testid="btn-refresh" className="inline-flex items-center gap-1.5 px-3 py-2 border border-slate-200 rounded-xl text-xs font-semibold hover:bg-slate-50">
          <RefreshCw className="w-3.5 h-3.5" /> Actualiser
        </button>
        <button onClick={exportCsv} data-testid="btn-export-tx" className="inline-flex items-center gap-1.5 px-3 py-2 border border-slate-200 rounded-xl text-xs font-semibold hover:bg-slate-50">
          <Download className="w-3.5 h-3.5" /> Exporter
        </button>
      </div>

      {/* Pending banner */}
      {pendingCount > 0 && status !== 'pending' && (
        <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 flex items-center gap-3 text-sm text-amber-900">
          <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
          <span><strong>{pendingCount}</strong> transaction{pendingCount > 1 ? 's' : ''} en attente de traitement.</span>
          <button onClick={() => setStatus('pending')} data-testid="btn-focus-pending" className="ml-auto text-[12px] font-bold hover:underline">
            Afficher uniquement les en-attente →
          </button>
        </div>
      )}

      {/* Table */}
      <div className="bg-white border border-slate-100 rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              <tr>
                <th className="text-left px-5 py-2.5">Référence</th>
                <th className="text-left px-5 py-2.5">Utilisateur</th>
                <th className="text-left px-5 py-2.5">Type</th>
                <th className="text-right px-5 py-2.5">Montant</th>
                <th className="text-center px-5 py-2.5">Statut</th>
                <th className="text-left px-5 py-2.5">Date</th>
                <th className="text-right px-5 py-2.5">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={7} className="p-10 text-center text-slate-500 text-sm" data-testid="admin-tx-loading">
                  <div className="inline-flex items-center gap-2">
                    <RefreshCw className="w-4 h-4 animate-spin" /> Chargement…
                  </div>
                </td></tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={7} className="p-10 text-center text-slate-400 text-sm" data-testid="admin-tx-empty">
                  {q ? 'Aucune transaction trouvée.' : 'Aucune transaction'}
                </td></tr>
              )}
              {!loading && filtered.map((tx) => {
                const meta = tx.metadata || {};
                const coin = meta.coin;
                const network = meta.network;
                const txHash = meta.tx_hash;
                const ch = txChannel(tx);
                return (
                  <tr key={tx.id} data-testid={`admin-tx-row-${tx.id}`} className="border-t border-slate-50 hover:bg-slate-50/50">
                    <td className="px-5 py-3 font-mono text-xs text-slate-700">
                      <div>{tx.reference}</div>
                      {txHash && <div className="text-[10px] text-slate-400 truncate max-w-[180px]" title={txHash}>{txHash}</div>}
                    </td>
                    <td className="px-5 py-3">
                      <div className="text-xs font-semibold text-slate-900">{tx.user?.full_name || '—'}</div>
                      <div className="text-[11px] text-slate-500">@{tx.user?.username}</div>
                    </td>
                    <td className="px-5 py-3">
                      <span className="inline-flex items-center gap-1.5 text-xs">
                        {tx.direction === 'in' ? <ArrowDownToLine className="w-3.5 h-3.5 text-emerald-600" /> : <ArrowUpFromLine className="w-3.5 h-3.5 text-red-500" />}
                        {tx.type}
                      </span>
                      <div className="mt-0.5 flex items-center gap-1 text-[10px] font-semibold">
                        {ch === 'crypto'
                          ? <Bitcoin className="w-3 h-3 text-amber-600" />
                          : <Smartphone className="w-3 h-3 text-blue-600" />}
                        <span className={ch === 'crypto' ? 'text-amber-700' : 'text-blue-700'}>
                          {coin || (ch === 'crypto' ? 'Crypto' : 'Mobile Money')}
                          {network ? ` · ${network}` : ''}
                        </span>
                      </div>
                    </td>
                    <td className={`px-5 py-3 text-right text-xs font-bold ${tx.direction === 'in' ? 'text-emerald-600' : 'text-slate-900'}`}>
                      {tx.direction === 'in' ? '+' : '-'}{tx.amount.toLocaleString(undefined, { maximumFractionDigits: tx.currency === 'USDT' ? 6 : 0 })} <span className="opacity-70">{tx.currency}</span>
                    </td>
                    <td className="px-5 py-3 text-center">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${statusColor(tx.status)}`}>{statusLabel(tx.status)}</span>
                    </td>
                    <td className="px-5 py-3 text-[11px] text-slate-500">{new Date(tx.created_at).toLocaleString('fr-FR')}</td>
                    <td className="px-5 py-3 text-right">
                      <button
                        onClick={() => setSelectedId(tx.id)}
                        data-testid={`btn-view-${tx.id}`}
                        className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold ${tx.status === 'pending' ? 'bg-amber-500 hover:bg-amber-600 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100'}`}>
                        <Eye className="w-3 h-3" />
                        {tx.status === 'pending' ? 'Traiter' : 'Détails'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <AdminTxDetailModal
        txId={selectedId}
        open={!!selectedId}
        onClose={() => setSelectedId(null)}
        onUpdated={() => load()}
      />
    </div>
  );
}
