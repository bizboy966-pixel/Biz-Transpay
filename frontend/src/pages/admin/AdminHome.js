import { useEffect, useState } from 'react';
import { Users, ShieldCheck, UserCheck, UserX, ArrowDownToLine, ArrowUpFromLine, Wallet, Layers, TrendingUp, TrendingDown } from 'lucide-react';
import api from '@/api';
import { useNavigate, Link } from 'react-router-dom';

function StatCard({ icon: I, iconBg, iconColor, label, value, sub, trend, trendPositive = true }) {
  return (
    <div className="bg-white border border-slate-100 rounded-2xl p-5 shadow-[0_2px_10px_rgba(15,23,42,0.03)]">
      <div className="flex items-start justify-between mb-4">
        <div className={`w-11 h-11 rounded-2xl ${iconBg} ${iconColor} flex items-center justify-center`}>
          <I className="w-5 h-5" strokeWidth={1.75} />
        </div>
        <div className="text-right">
          <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{label}</div>
        </div>
      </div>
      <div className="font-cabinet font-extrabold text-2xl sm:text-3xl text-slate-900">{value}</div>
      {sub && <div className="mt-1 text-xs text-slate-500">{sub}</div>}
      {trend != null && (
        <div className={`mt-3 inline-flex items-center gap-1 text-xs font-bold ${trendPositive ? 'text-emerald-600' : 'text-red-500'}`}>
          {trendPositive ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
          {trend}
          <span className="text-slate-400 font-medium ml-1">depuis le mois dernier</span>
        </div>
      )}
    </div>
  );
}

export default function AdminHome() {
  const [stats, setStats] = useState(null);
  const [period, setPeriod] = useState('month');
  const [users, setUsers] = useState([]);
  const [logs, setLogs] = useState([]);
  const nav = useNavigate();

  useEffect(() => {
    api.get('/admin/stats', { params: { period } }).then(({ data }) => setStats(data)).catch(() => {});
  }, [period]);

  useEffect(() => {
    api.get('/admin/users', { params: { limit: 5 } }).then(({ data }) => setUsers(data)).catch(() => {});
    api.get('/admin/logs', { params: { limit: 5 } }).then(({ data }) => setLogs(data)).catch(() => {});
  }, []);

  if (!stats) return <div className="text-slate-500 text-sm">Chargement…</div>;

  const flag = (code) => ({ CI: '🇨🇮', SN: '🇸🇳', TG: '🇹🇬', ML: '🇲🇱', BF: '🇧🇫', CM: '🇨🇲', BJ: '🇧🇯' }[code] || '🌍');

  return (
    <div className="space-y-6" data-testid="admin-home">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500">Utilisateurs</div>
        <select value={period} onChange={(e) => setPeriod(e.target.value)} data-testid="period-filter" className="px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-semibold bg-white">
          <option value="day">Aujourd'hui</option>
          <option value="week">Cette semaine</option>
          <option value="month">Ce mois</option>
          <option value="year">Cette année</option>
        </select>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4" data-testid="user-stats-cards">
        <StatCard icon={Users} iconBg="bg-blue-50" iconColor="text-[#2563EB]" label="Utilisateurs inscrits" value={stats.users.total.toLocaleString()} sub="Total des comptes créés" trend="+12.5%" />
        <StatCard icon={ShieldCheck} iconBg="bg-emerald-50" iconColor="text-emerald-600" label="Utilisateurs vérifiés (KYC)" value={stats.users.verified.toLocaleString()} sub="Comptes avec KYC validé" trend="+15.3%" />
        <StatCard icon={UserCheck} iconBg="bg-violet-50" iconColor="text-violet-600" label="Utilisateurs actifs" value={stats.users.active.toLocaleString()} sub="Ayant effectué ≥ 1 transaction" trend="+18.7%" />
        <StatCard icon={UserX} iconBg="bg-orange-50" iconColor="text-orange-600" label="Comptes suspendus" value={stats.users.suspended.toLocaleString()} sub="Comptes bloqués ou suspendus" trend="+2.1%" trendPositive={false} />
      </div>

      <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500 pt-2">Transactions</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4" data-testid="tx-stats-cards">
        <StatCard icon={ArrowDownToLine} iconBg="bg-blue-50" iconColor="text-[#2563EB]" label="Dépôts totaux (Entrées)" value={stats.transactions.total_deposits.toLocaleString() + ' XOF'} sub="Total des dépôts effectués" trend="+10.4%" />
        <StatCard icon={ArrowUpFromLine} iconBg="bg-emerald-50" iconColor="text-emerald-600" label="Retraits totaux (Sorties)" value={stats.transactions.total_withdrawals.toLocaleString() + ' XOF'} sub="Total des retraits effectués" trend="+9.8%" />
        <StatCard icon={Wallet} iconBg="bg-violet-50" iconColor="text-violet-600" label="Volume total" value={(stats.transactions.total_deposits + stats.transactions.total_withdrawals).toLocaleString() + ' XOF'} sub="Dépôts + Retraits" trend="+11.2%" />
        <StatCard icon={Layers} iconBg="bg-blue-50" iconColor="text-[#2563EB]" label="Nombre total de tx" value={stats.transactions.count.toLocaleString()} sub={`${stats.transactions.succeeded} réussies · ${stats.transactions.pending} en attente · ${stats.transactions.failed} échouées`} trend="+14.6%" />
      </div>

      {/* Users management preview */}
      <div className="bg-white border border-slate-100 rounded-2xl shadow-[0_2px_10px_rgba(15,23,42,0.03)]">
        <div className="p-5 flex items-center justify-between flex-wrap gap-3 border-b border-slate-100">
          <div>
            <h2 className="font-cabinet font-bold text-slate-900">Gestion des utilisateurs</h2>
          </div>
          <Link to="/admin/users" data-testid="btn-manage-users" className="text-xs font-semibold text-[#2563EB]">Voir tout →</Link>
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
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} data-testid={`admin-user-row-${u.id}`} onClick={() => nav(`/admin/users/${u.id}`)} className="border-t border-slate-50 hover:bg-slate-50/70 cursor-pointer">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2.5">
                      <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#3B82F6] to-[#1D4ED8] text-white flex items-center justify-center font-bold text-xs">{u.full_name?.[0]?.toUpperCase() || 'U'}</div>
                      <div>
                        <div className="font-semibold text-slate-900 text-xs">{u.full_name}</div>
                        <div className="text-[11px] text-slate-500">@{u.username}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <div className="text-xs text-slate-800">{u.email}</div>
                    <div className="text-[11px] text-slate-500">{u.phone}</div>
                  </td>
                  <td className="px-5 py-3 text-lg">{flag(u.country)}</td>
                  <td className="px-5 py-3">
                    <KycBadge status={u.kyc_status} />
                  </td>
                  <td className="px-5 py-3 text-right font-semibold text-xs">{(u.balance_xof || 0).toLocaleString()}</td>
                  <td className="px-5 py-3 text-right font-semibold text-xs">{(u.balance_xaf || 0).toLocaleString()}</td>
                  <td className="px-5 py-3 text-center">
                    <StatusBadge blocked={u.is_blocked} banned={u.is_banned} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recent activity */}
      <div className="bg-white border border-slate-100 rounded-2xl shadow-[0_2px_10px_rgba(15,23,42,0.03)]">
        <div className="p-5 flex items-center justify-between border-b border-slate-100">
          <h2 className="font-cabinet font-bold text-slate-900">Activité récente</h2>
          <Link to="/admin/logs" data-testid="link-all-logs" className="text-xs font-semibold text-[#2563EB]">Voir tout →</Link>
        </div>
        <div className="divide-y divide-slate-50">
          {logs.length === 0 && <div className="p-8 text-center text-sm text-slate-400">Aucune activité pour l'instant</div>}
          {logs.map((l) => (
            <div key={l.id} className="p-4 flex items-center gap-3">
              <ActionIcon action={l.action} />
              <div className="flex-1">
                <div className="text-sm font-semibold text-slate-900">{humanizeAction(l.action)} {l.target_username && `de @${l.target_username}`}</div>
                <div className="text-[11px] text-slate-500">Par {l.admin_username}</div>
              </div>
              <div className="text-[11px] text-slate-400 text-right">
                {l.details?.amount && <div className="font-bold text-slate-800">{l.action === 'credit' ? '+' : l.action === 'debit' ? '-' : ''}{l.details.amount?.toLocaleString()} {l.details.currency}</div>}
                <div>{new Date(l.created_at).toLocaleString()}</div>
              </div>
            </div>
          ))}
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

function humanizeAction(a) {
  const map = {
    credit: 'Crédit du compte', debit: 'Débit du compte', block: 'Compte bloqué', unblock: 'Compte débloqué',
    ban: 'Compte banni', unban: 'Bannissement levé', block_withdrawals: 'Retraits bloqués',
    unblock_withdrawals: 'Retraits réactivés', kyc_approve: 'KYC approuvé', kyc_reject: 'KYC rejeté',
    update_user: 'Compte modifié', reset_password: 'Mot de passe réinitialisé',
  };
  return map[a] || a;
}
function ActionIcon({ action }) {
  const map = {
    credit: { c: 'bg-emerald-50 text-emerald-600', I: TrendingUp },
    debit: { c: 'bg-red-50 text-red-600', I: TrendingDown },
    block: { c: 'bg-orange-50 text-orange-600', I: UserX },
    unblock: { c: 'bg-emerald-50 text-emerald-600', I: UserCheck },
    ban: { c: 'bg-red-50 text-red-600', I: UserX },
    kyc_approve: { c: 'bg-emerald-50 text-emerald-600', I: ShieldCheck },
    kyc_reject: { c: 'bg-red-50 text-red-600', I: UserX },
  };
  const { c, I } = map[action] || { c: 'bg-slate-100 text-slate-600', I: Users };
  return <div className={`w-9 h-9 rounded-full ${c} flex items-center justify-center`}><I className="w-4 h-4" strokeWidth={1.75} /></div>;
}
