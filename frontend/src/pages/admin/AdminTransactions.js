import { useEffect, useState } from 'react';
import { Search, Download, ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';
import api from '@/api';

export default function AdminTransactions({ filterType }) {
  const [txs, setTxs] = useState([]);
  const [q, setQ] = useState('');
  const [type, setType] = useState(filterType || '');
  const [status, setStatus] = useState('');

  const load = () => {
    const p = {};
    if (q) p.q = q; if (type) p.type = type; if (status) p.status = status;
    api.get('/admin/transactions', { params: p }).then(({ data }) => setTxs(data)).catch(() => {});
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [type, status]);

  const exportCsv = () => {
    const rows = [['ID', 'Reference', 'User', 'Type', 'Direction', 'Amount', 'Currency', 'Status', 'Date']];
    txs.forEach((t) => rows.push([t.id, t.reference, t.user?.username, t.type, t.direction, t.amount, t.currency, t.status, t.created_at]));
    const csv = rows.map((r) => r.map((c) => `"${c ?? ''}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = 'transactions.csv'; a.click();
  };

  const statusColor = (s) => ({ completed: 'bg-emerald-50 text-emerald-700', pending: 'bg-amber-50 text-amber-700', failed: 'bg-red-50 text-red-700', cancelled: 'bg-slate-100 text-slate-600' }[s] || 'bg-slate-100 text-slate-600');

  return (
    <div className="space-y-5" data-testid="admin-transactions-page">
      <div className="bg-white border border-slate-100 rounded-2xl p-4 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[240px] flex items-center gap-2 px-3 border border-slate-200 rounded-xl">
          <Search className="w-4 h-4 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} data-testid="admin-tx-search" placeholder="Rechercher par ID, référence, destinataire…" className="flex-1 py-2.5 outline-none text-sm bg-transparent" />
        </div>
        {!filterType && (
          <select value={type} onChange={(e) => setType(e.target.value)} data-testid="admin-tx-type" className="px-3 py-2 border border-slate-200 rounded-xl text-xs font-semibold">
            <option value="">Tous types</option>
            <option value="deposit">Dépôts</option><option value="withdrawal">Retraits</option>
            <option value="transfer">Transferts</option><option value="exchange">Échanges</option>
            <option value="link_payment">Paiements lien</option>
          </select>
        )}
        <select value={status} onChange={(e) => setStatus(e.target.value)} data-testid="admin-tx-status" className="px-3 py-2 border border-slate-200 rounded-xl text-xs font-semibold">
          <option value="">Tous statuts</option><option value="completed">Réussies</option><option value="pending">En attente</option><option value="failed">Échouées</option>
        </select>
        <button onClick={exportCsv} data-testid="btn-export-tx" className="inline-flex items-center gap-1.5 px-3 py-2 border border-slate-200 rounded-xl text-xs font-semibold hover:bg-slate-50"><Download className="w-3.5 h-3.5" /> Exporter</button>
      </div>

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
              </tr>
            </thead>
            <tbody>
              {txs.length === 0 && <tr><td colSpan={6} className="p-10 text-center text-slate-400 text-sm">Aucune transaction</td></tr>}
              {txs.map((tx) => {
                const meta = tx.metadata || {};
                const coin = meta.coin;
                const network = meta.network;
                const txHash = meta.tx_hash;
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
                    {(coin || network) && <div className="mt-0.5 text-[10px] text-orange-700 font-semibold">{coin}{network ? ` · ${network}` : ''}</div>}
                  </td>
                  <td className={`px-5 py-3 text-right text-xs font-bold ${tx.direction === 'in' ? 'text-emerald-600' : 'text-slate-900'}`}>
                    {tx.direction === 'in' ? '+' : '-'}{tx.amount.toLocaleString(undefined, { maximumFractionDigits: tx.currency === 'USDT' ? 6 : 0 })} <span className="opacity-70">{tx.currency}</span>
                  </td>
                  <td className="px-5 py-3 text-center"><span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${statusColor(tx.status)}`}>{tx.status}</span></td>
                  <td className="px-5 py-3 text-[11px] text-slate-500">{new Date(tx.created_at).toLocaleString()}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
