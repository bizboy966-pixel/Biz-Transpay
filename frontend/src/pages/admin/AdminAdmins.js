import { useEffect, useState } from 'react';
import { UserPlus, ShieldCheck, Crown } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';
import { useAuth } from '@/context/AuthContext';

export default function AdminAdmins() {
  const { user } = useAuth();
  const [admins, setAdmins] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [username, setUsername] = useState('');
  const [role, setRole] = useState('admin');

  const load = () => api.get('/admin/admins').then(({ data }) => setAdmins(data)).catch(() => {});
  useEffect(() => { load(); }, []);

  const promote = async () => {
    try {
      // find user by username
      const { data: users } = await api.get('/admin/users', { params: { q: username } });
      const target = users.find((u) => u.username === username.toLowerCase() || u.email === username.toLowerCase());
      if (!target) { toast.error('Utilisateur introuvable'); return; }
      await api.patch(`/admin/users/${target.id}`, { role });
      toast.success(`${target.username} promu ${role}`);
      setShowModal(false); setUsername('');
      load();
    } catch (err) { toast.error(err.response?.data?.detail || 'Erreur'); }
  };

  const demote = async (id, uname) => {
    if (!window.confirm(`Retirer les droits admin de @${uname} ?`)) return;
    try {
      await api.patch(`/admin/users/${id}`, { role: 'user' });
      toast.success('Rôle retiré');
      load();
    } catch (err) { toast.error(err.response?.data?.detail || 'Erreur'); }
  };

  return (
    <div className="space-y-5" data-testid="admin-admins-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-cabinet font-bold text-slate-900 text-lg">Administrateurs</h1>
          <p className="text-xs text-slate-500 mt-0.5">Seul un super_admin peut modifier les rôles.</p>
        </div>
        {user?.role === 'super_admin' && (
          <button onClick={() => setShowModal(true)} data-testid="btn-promote-admin" className="inline-flex items-center gap-1.5 bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold px-4 py-2 rounded-full text-xs">
            <UserPlus className="w-3.5 h-3.5" /> Ajouter un administrateur
          </button>
        )}
      </div>

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
        {admins.map((a) => (
          <div key={a.id} data-testid={`admin-card-${a.id}`} className="bg-white border border-slate-100 rounded-2xl p-4">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-full bg-gradient-to-br from-[#3B82F6] to-[#1D4ED8] text-white flex items-center justify-center font-bold">{a.full_name?.[0]?.toUpperCase()}</div>
              <div className="flex-1 min-w-0">
                <div className="font-cabinet font-bold text-slate-900 text-sm truncate">{a.full_name}</div>
                <div className="text-[11px] text-slate-500 truncate">@{a.username}</div>
              </div>
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold inline-flex items-center gap-1 ${a.role === 'super_admin' ? 'bg-violet-50 text-violet-700' : 'bg-blue-50 text-[#2563EB]'}`}>
                {a.role === 'super_admin' ? <Crown className="w-3 h-3" /> : <ShieldCheck className="w-3 h-3" />}
                {a.role === 'super_admin' ? 'Super' : 'Admin'}
              </span>
            </div>
            <div className="mt-3 text-[11px] text-slate-500">{a.email}</div>
            {user?.role === 'super_admin' && a.role !== 'super_admin' && a.id !== user.id && (
              <button onClick={() => demote(a.id, a.username)} data-testid={`btn-demote-${a.id}`} className="mt-3 w-full text-xs font-semibold text-red-600 hover:text-red-700 py-1.5 border border-red-100 rounded-lg hover:bg-red-50">Retirer les droits</button>
            )}
          </div>
        ))}
      </div>

      {showModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setShowModal(false)}>
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl p-6 max-w-md w-full shadow-2xl">
            <h3 className="font-cabinet font-bold text-lg mb-3">Promouvoir un utilisateur</h3>
            <input value={username} onChange={(e) => setUsername(e.target.value)} data-testid="promote-username" placeholder="Nom d'utilisateur ou email" className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB]" />
            <select value={role} onChange={(e) => setRole(e.target.value)} data-testid="promote-role" className="mt-3 w-full px-3 py-2.5 border border-slate-200 rounded-xl font-semibold">
              <option value="admin">Admin</option><option value="super_admin">Super Admin</option>
            </select>
            <div className="mt-4 flex gap-2 justify-end">
              <button onClick={() => setShowModal(false)} className="px-4 py-2 rounded-full border border-slate-200 font-semibold text-sm">Annuler</button>
              <button onClick={promote} data-testid="btn-confirm-promote" disabled={!username} className="px-4 py-2 rounded-full bg-[#2563EB] text-white font-semibold text-sm disabled:opacity-60">Promouvoir</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
