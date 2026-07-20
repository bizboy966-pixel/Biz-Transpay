import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Search, Filter, Download, MoreHorizontal } from 'lucide-react';
import api from '@/api';

const flags = { CI: '🇨🇮', SN: '🇸🇳', TG: '🇹🇬', ML: '🇲🇱', BF: '🇧🇫', CM: '🇨🇲', BJ: '🇧🇯' };

export default function AdminUsers() {
  const [users, setUsers] = useState([]);
  const [q, setQ] = useState('');
  const [kyc, setKyc] = useState('');
  const [status, setStatus] = useState('');
  const nav = useNavigate();

  const load = () => {
    const p = {};
    if (q) p.q = q; if (kyc) p.kyc = kyc; if (status) p.status = status;
    api.get('/admin/users', { params: p }).then(({ data }) => setUsers(data)).catch(() => {});
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [kyc, status]);

  const exportCsv = () => {
    const rows = [['ID', 'Name', 'Username', 'Email', 'Phone', 'Country', 'KYC', 'XOF', 'XAF', 'Status', 'Created']];
    users.forEach((u) => rows.push([u.id, u.full_name, u.username, u.email, u.phone, u.country, u.kyc_status, u.balance_xof, u.balance_xaf, u.is_banned ? 'banned' : u.is_blocked ? 'blocked' : 'active', u.created_at]));
    const csv = rows.map((r) => r.map((c) => `"${c}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = 'users.csv'; a.click();
  };

  return (
    <div className="space-y-5" data-testid="admin-users-page">
      <div className="bg-white border border-slate-100 rounded-2xl p-4 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[200px] flex items-center gap-2 px-3 border border-slate-200 rounded-xl">
          <Search className="w-4 h-4 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} data-testid="user-search" placeholder="Rechercher par nom, email, téléphone…" className="flex-1 py-2.5 outline-none text-sm bg-transparent" />
        </div>
        <select value={kyc} onChange={(e) => setKyc(e.target.value)} data-testid="filter-kyc" className="px-3 py-2 border border-slate-200 rounded-xl text-xs font-semibold">
          <option value="">Tous KYC</option><option value="verified">Vérifié</option><option value="pending">En attente</option><option value="rejected">Rejeté</option><option value="not_started">Non commencé</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} data-testid="filter-status" className="px-3 py-2 border border-slate-200 rounded-xl text-xs font-semibold">
          <option value="">Tous statuts</option><option value="active">Actif</option><option value="blocked">Suspendu</option><option value="banned">Banni</option>
        </select>
        <button data-testid="btn-filters" className="inline-flex items-center gap-1.5 px-3 py-2 border border-slate-200 rounded-xl text-xs font-semibold hover:bg-slate-50"><Filter className="w-3.5 h-3.5" /> Filtres</button>
        <button onClick={exportCsv} data-testid="btn-export-users" className="inline-flex items-center gap-1.5 px-3 py-2 border border-slate-200 rounded-xl text-xs font-semibold hover:bg-slate-50"><Download className="w-3.5 h-3.5" /> Exporter</button>
      </div>

      <div className="bg-white border border-slate-100 rounded-2xl overflow-hidden">
        <div className="p-5 flex items-center justify-between border-b border-slate-100">
          <div>
            <h2 className="font-cabinet font-bold text-slate-900">Tous les utilisateurs</h2>
            <p className="text-xs text-slate-500 mt-0.5">Affichage 1 à {users.length} sur {users.length} utilisateurs</p>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              <tr>
                <th className="text-left px-5 py-2.5">Utilisateur</th>
                <th className="text-left px-5 py-2.5">Email / Téléphone</th>
                <th className="text-left px-5 py-2.5">Pays</th>
                <th className="text-left px-5 py-2.5">KYC</th>
                <th className="text-right px-5 py-2.5">Solde XOF</th>
                <th className="text-right px-5 py-2.5">Solde XAF</th>
                <th className="text-center px-5 py-2.5">Statut</th>
                <th className="text-center px-5 py-2.5">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} data-testid={`user-row-${u.id}`} className="border-t border-slate-50 hover:bg-slate-50/60">
                  <td className="px-5 py-3">
                    <Link to={`/admin/users/${u.id}`} className="flex items-center gap-2.5">
                      <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#3B82F6] to-[#1D4ED8] text-white flex items-center justify-center font-bold text-xs">{u.full_name?.[0]?.toUpperCase() || 'U'}</div>
                      <div>
                        <div className="font-semibold text-slate-900 text-xs">{u.full_name}</div>
                        <div className="text-[11px] text-slate-500">@{u.username}</div>
                      </div>
                    </Link>
                  </td>
                  <td className="px-5 py-3">
                    <div className="text-xs text-slate-800">{u.email}</div>
                    <div className="text-[11px] text-slate-500">{u.phone}</div>
                  </td>
                  <td className="px-5 py-3 text-lg">{flags[u.country] || '🌍'}</td>
                  <td className="px-5 py-3"><KycBadge status={u.kyc_status} /></td>
                  <td className="px-5 py-3 text-right font-semibold text-xs">{(u.balance_xof || 0).toLocaleString()}</td>
                  <td className="px-5 py-3 text-right font-semibold text-xs">{(u.balance_xaf || 0).toLocaleString()}</td>
                  <td className="px-5 py-3 text-center"><StatusBadge blocked={u.is_blocked} banned={u.is_banned} /></td>
                  <td className="px-5 py-3 text-center">
                    <button onClick={() => nav(`/admin/users/${u.id}`)} data-testid={`row-actions-${u.id}`} className="w-8 h-8 rounded-lg border border-slate-200 hover:bg-slate-50 inline-flex items-center justify-center">
                      <MoreHorizontal className="w-4 h-4 text-slate-500" />
                    </button>
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr><td colSpan={8} className="p-10 text-center text-slate-400 text-sm">Aucun utilisateur</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function KycBadge({ status }) {
  const s = ({ verified: { c: 'bg-emerald-50 text-emerald-700', l: 'Vérifié' }, pending: { c: 'bg-amber-50 text-amber-700', l: 'En attente' }, rejected: { c: 'bg-red-50 text-red-700', l: 'Rejeté' }, not_started: { c: 'bg-slate-100 text-slate-600', l: 'Non commencé' } })[status] || { c: 'bg-slate-100 text-slate-600', l: status };
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${s.c}`}><span className="w-1.5 h-1.5 rounded-full bg-current" />{s.l}</span>;
}
function StatusBadge({ blocked, banned }) {
  if (banned) return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-50 text-red-700"><span className="w-1.5 h-1.5 rounded-full bg-red-500" />Banni</span>;
  if (blocked) return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-orange-50 text-orange-700"><span className="w-1.5 h-1.5 rounded-full bg-orange-500" />Suspendu</span>;
  return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />Actif</span>;
}
