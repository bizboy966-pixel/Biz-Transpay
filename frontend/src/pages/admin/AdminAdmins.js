import { useEffect, useState } from 'react';
import { UserPlus, ShieldCheck, Crown, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';
import { useAuth } from '@/context/AuthContext';

const ADMIN_ROLES = [
  { value: 'general', label: 'Administrateur général', description: 'Accès administratif polyvalent' },
  { value: 'finance', label: 'Administrateur finances', description: 'Dépôts, retraits et frais' },
  { value: 'operations', label: 'Administrateur opérations', description: 'Utilisateurs et transactions' },
  { value: 'support', label: 'Administrateur support', description: 'Support et accompagnement' },
  { value: 'compliance', label: 'Administrateur conformité', description: 'KYC et contrôles' },
];

const roleLabel = (role) => (
  ADMIN_ROLES.find((item) => item.value === role)?.label || 'Administrateur général'
);

export default function AdminAdmins() {
  const { user } = useAuth();
  const [admins, setAdmins] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [editingAdmin, setEditingAdmin] = useState(null);
  const [mode, setMode] = useState('existing');
  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [adminRole, setAdminRole] = useState('general');

  const load = () => api.get('/admin/admins').then(({ data }) => setAdmins(data)).catch(() => {});
  useEffect(() => { load(); }, []);

  const closeModal = () => {
    setShowModal(false);
    setEditingAdmin(null);
    setMode('existing');
    setUsername('');
    setFullName('');
    setNewUsername('');
    setEmail('');
    setPassword('');
    setAdminRole('general');
  };

  const saveAdmin = async () => {
    try {
      if (!editingAdmin && mode === 'new') {
        if (window.prompt('Confirmer la création d’un compte administrateur ?\nSaisissez CONFIRMER pour continuer.')?.trim().toUpperCase() !== 'CONFIRMER') return;
        const { data: created } = await api.post('/admin/admins', {
          full_name: fullName.trim(),
          username: newUsername.trim(),
          email: email.trim(),
          password,
          admin_role: adminRole,
          confirmation: 'CONFIRMER',
        });
        toast.success(`${created.username} est maintenant administrateur`);
        closeModal();
        load();
        return;
      }
      let target = editingAdmin;
      if (!target) {
        const { data: users } = await api.get('/admin/users', { params: { q: username.trim() } });
        const query = username.trim().toLowerCase();
        target = users.find((u) => u.username?.toLowerCase() === query || u.email?.toLowerCase() === query);
      }
      if (!target) { toast.error('Utilisateur introuvable'); return; }
      if (window.prompt('Confirmer l’attribution des droits administrateur ?\nSaisissez CONFIRMER pour continuer.')?.trim().toUpperCase() !== 'CONFIRMER') return;
      await api.patch(`/admin/users/${target.id}`, { role: 'admin', admin_role: adminRole, confirmation: 'CONFIRMER' });
      toast.success(editingAdmin ? 'Rôle administrateur mis à jour' : `${target.username} est maintenant administrateur`);
      closeModal();
      load();
    } catch (err) { toast.error(err.response?.data?.detail || 'Erreur'); }
  };

  const demote = async (id, uname) => {
    if (window.prompt(`Retirer les droits admin de @${uname} ?\nSaisissez CONFIRMER pour continuer.`)?.trim().toUpperCase() !== 'CONFIRMER') return;
    try {
      await api.patch(`/admin/users/${id}`, { role: 'user', confirmation: 'CONFIRMER' });
      toast.success('Droits administrateur retirés');
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
           <button onClick={() => { setEditingAdmin(null); setMode('existing'); setUsername(''); setAdminRole('general'); setShowModal(true); }} data-testid="btn-promote-admin" className="inline-flex items-center gap-1.5 bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold px-4 py-2 rounded-full text-xs">
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
                {a.role === 'super_admin' ? 'Administrateur principal' : roleLabel(a.admin_role)}
              </span>
            </div>
            <div className="mt-3 text-[11px] text-slate-500">{a.email}</div>
            {user?.role === 'super_admin' && a.role !== 'super_admin' && a.id !== user.id && (
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  onClick={() => {
                    setEditingAdmin(a);
                    setUsername(a.username || a.email || '');
                    setAdminRole(a.admin_role || 'general');
                    setShowModal(true);
                  }}
                  data-testid={`btn-edit-admin-${a.id}`}
                  className="text-xs font-semibold text-[#2563EB] hover:text-[#1D4ED8] py-1.5 border border-blue-100 rounded-lg hover:bg-blue-50 inline-flex items-center justify-center gap-1"
                >
                  <Pencil className="w-3 h-3" /> Modifier
                </button>
                <button onClick={() => demote(a.id, a.username)} data-testid={`btn-demote-${a.id}`} className="text-xs font-semibold text-red-600 hover:text-red-700 py-1.5 border border-red-100 rounded-lg hover:bg-red-50">Retirer</button>
              </div>
            )}
          </div>
        ))}
      </div>

      {showModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={closeModal}>
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl p-6 max-w-md w-full shadow-2xl">
            <h3 className="font-cabinet font-bold text-lg mb-1">{editingAdmin ? 'Modifier le rôle administrateur' : 'Ajouter un administrateur'}</h3>
            <p className="text-xs text-slate-500 mb-4">
              {editingAdmin ? 'Mettez à jour la responsabilité de cet administrateur.' : 'Sélectionnez un utilisateur déjà inscrit, puis attribuez-lui une responsabilité.'}
            </p>
            {!editingAdmin && (
              <div className="grid grid-cols-2 gap-2 mb-3">
                <button type="button" onClick={() => setMode('existing')} className={`py-2 rounded-lg text-xs font-semibold border ${mode === 'existing' ? 'bg-blue-50 border-blue-200 text-[#2563EB]' : 'border-slate-200 text-slate-500'}`}>Utilisateur existant</button>
                <button type="button" onClick={() => setMode('new')} className={`py-2 rounded-lg text-xs font-semibold border ${mode === 'new' ? 'bg-blue-50 border-blue-200 text-[#2563EB]' : 'border-slate-200 text-slate-500'}`}>Nouveau compte</button>
              </div>
            )}
            {!editingAdmin && mode === 'new' ? (
              <div className="space-y-2.5">
                <input value={fullName} onChange={(e) => setFullName(e.target.value)} data-testid="new-admin-full-name" placeholder="Nom complet" className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB]" />
                <input value={newUsername} onChange={(e) => setNewUsername(e.target.value.toLowerCase().replace(/\s+/g, ''))} data-testid="new-admin-username" placeholder="Nom d'utilisateur" className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB]" />
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="new-admin-email" placeholder="Adresse e-mail" className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB]" />
                 <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="new-admin-password" placeholder="Mot de passe admin (14 caractères minimum)" className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB]" />
              </div>
            ) : (
              <input value={username} onChange={(e) => setUsername(e.target.value)} disabled={Boolean(editingAdmin)} data-testid="promote-username" placeholder="Nom d'utilisateur ou email" className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] disabled:bg-slate-50 disabled:text-slate-500" />
            )}
            <select value={adminRole} onChange={(e) => setAdminRole(e.target.value)} data-testid="admin-role" className="mt-3 w-full px-3 py-2.5 border border-slate-200 rounded-xl font-semibold">
              {ADMIN_ROLES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
            <div className="mt-2 text-[11px] text-slate-500">
              {ADMIN_ROLES.find((item) => item.value === adminRole)?.description}
            </div>
            <div className="mt-4 flex gap-2 justify-end">
              <button onClick={closeModal} className="px-4 py-2 rounded-full border border-slate-200 font-semibold text-sm">Annuler</button>
         <button onClick={saveAdmin} data-testid="btn-confirm-promote" disabled={editingAdmin ? !username.trim() : mode === 'existing' ? !username.trim() : !fullName.trim() || !newUsername.trim() || !email.trim() || password.length < 14} className="px-4 py-2 rounded-full bg-[#2563EB] text-white font-semibold text-sm disabled:opacity-60">{editingAdmin ? 'Enregistrer' : 'Ajouter'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
