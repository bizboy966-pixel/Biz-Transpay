import { useEffect, useState } from 'react';
import { UserPlus, ShieldCheck, Users, ArrowRightLeft, KeyRound, Lock, Unlock, UserX, UserCheck } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';
import { useAuth } from '@/context/AuthContext';

export default function AdminLogs() {
  const [logs, setLogs] = useState([]);

  useEffect(() => {
    api.get('/admin/logs').then(({ data }) => setLogs(data)).catch(() => {});
  }, []);

  const iconFor = (a) => ({
    credit: { c: 'bg-emerald-50 text-emerald-600', I: ArrowRightLeft },
    debit: { c: 'bg-red-50 text-red-600', I: ArrowRightLeft },
    block: { c: 'bg-orange-50 text-orange-600', I: Lock },
    unblock: { c: 'bg-emerald-50 text-emerald-600', I: Unlock },
    ban: { c: 'bg-red-50 text-red-600', I: UserX },
    unban: { c: 'bg-emerald-50 text-emerald-600', I: UserCheck },
    kyc_approve: { c: 'bg-emerald-50 text-emerald-600', I: ShieldCheck },
    kyc_reject: { c: 'bg-red-50 text-red-600', I: UserX },
    reset_password: { c: 'bg-blue-50 text-[#2563EB]', I: KeyRound },
  })[a] || { c: 'bg-slate-100 text-slate-600', I: Users };

  const labelFor = (a) => ({
    credit: 'Crédit du compte', debit: 'Débit du compte', block: 'Compte bloqué', unblock: 'Compte débloqué',
    ban: 'Compte banni', unban: 'Bannissement levé', block_withdrawals: 'Retraits bloqués',
    unblock_withdrawals: 'Retraits réactivés', kyc_approve: 'KYC approuvé', kyc_reject: 'KYC rejeté',
    update_user: 'Compte modifié', reset_password: 'Mot de passe réinitialisé',
  })[a] || a;

  return (
    <div className="space-y-5" data-testid="admin-logs-page">
      <div className="bg-white border border-slate-100 rounded-2xl overflow-hidden">
        <div className="p-5 border-b border-slate-100">
          <h2 className="font-cabinet font-bold text-slate-900">Journal d'activités administratives</h2>
          <p className="text-xs text-slate-500 mt-0.5">Toutes les actions effectuées par les administrateurs sont tracées ici.</p>
        </div>
        <div className="divide-y divide-slate-50">
          {logs.length === 0 && <div className="p-10 text-center text-sm text-slate-400">Aucune activité</div>}
          {logs.map((l) => {
            const { c, I } = iconFor(l.action);
            return (
              <div key={l.id} data-testid={`log-row-${l.id}`} className="p-4 flex items-center gap-3">
                <div className={`w-10 h-10 rounded-full ${c} flex items-center justify-center`}><I className="w-4 h-4" /></div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-slate-900">
                    {labelFor(l.action)} {l.target_username && <span className="text-slate-600">de @{l.target_username}</span>}
                  </div>
                  <div className="text-[11px] text-slate-500">Par <b>@{l.admin_username}</b>{l.details?.reason && ` — Raison : ${l.details.reason}`}</div>
                </div>
                <div className="text-right">
                  {l.details?.amount && <div className={`font-bold text-sm ${l.action === 'credit' ? 'text-emerald-600' : 'text-red-500'}`}>{l.action === 'credit' ? '+' : '-'}{l.details.amount?.toLocaleString()} {l.details.currency}</div>}
                  <div className="text-[10px] text-slate-400">{new Date(l.created_at).toLocaleString()}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
