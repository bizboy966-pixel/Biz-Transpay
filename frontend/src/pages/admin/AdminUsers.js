import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Search, Filter, Download, MoreHorizontal,
  Eye, Pencil, ShieldCheck, Ban, RefreshCcw, KeyRound, Trash2, X, AlertTriangle, UserCog,
} from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';

const flags = { CI: '🇨🇮', SN: '🇸🇳', TG: '🇹🇬', ML: '🇲🇱', BF: '🇧🇫', CM: '🇨🇲', BJ: '🇧🇯' };

export default function AdminUsers() {
  const [users, setUsers] = useState([]);
  const [q, setQ] = useState('');
  const [kyc, setKyc] = useState('');
  const [status, setStatus] = useState('');
  const [me, setMe] = useState(null);
  const nav = useNavigate();

  const load = () => {
    const p = {};
    if (q) p.q = q; if (kyc) p.kyc = kyc; if (status) p.status = status;
    api.get('/admin/users', { params: p }).then(({ data }) => setUsers(data)).catch(() => {});
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [kyc, status]);
  useEffect(() => { api.get('/auth/me').then(({ data }) => setMe(data)).catch(() => {}); }, []);

  const exportCsv = () => {
    const rows = [['ID', 'Name', 'Username', 'Email', 'Phone', 'Country', 'KYC', 'XOF', 'XAF', 'USDT', 'Status', 'Created']];
    users.forEach((u) => rows.push([u.id, u.full_name, u.username, u.email, u.phone, u.country, u.kyc_status, u.balance_xof, u.balance_xaf, u.balance_usdt, u.is_banned ? 'banned' : u.is_blocked ? 'blocked' : 'active', u.created_at]));
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
                    <UserActionsMenu user={u} me={me} onChanged={load} onNav={nav} />
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

// -------------------- Row actions dropdown + modals --------------------
function UserActionsMenu({ user, me, onChanged, onNav }) {
  const [open, setOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [pwdOpen, setPwdOpen] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [confirmTypeSwitch, setConfirmTypeSwitch] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const isSuperAdmin = user.role === 'super_admin';
  const isSelf = me && me.id === user.id;
  const suspended = user.is_blocked || user.is_banned;
  const currentType = user.account_type || 'personal';
  const nextType = currentType === 'merchant' ? 'personal' : 'merchant';

  const doAction = async (action, ok) => {
    try {
      await api.post(`/admin/users/${user.id}/action/${action}`, { reason: '' });
      toast.success(ok);
      setOpen(false); onChanged();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Erreur'); }
  };

  const doKycApprove = async () => {
    try {
      await api.post(`/admin/kyc/${user.id}/decision`, { approve: true });
      toast.success('KYC approuvé');
      setOpen(false); onChanged();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Erreur'); }
  };

  const switchAccountType = async () => {
    try {
      await api.patch(`/admin/users/${user.id}`, { account_type: nextType });
      toast.success(`Compte converti en ${nextType === 'merchant' ? 'Marchand' : 'Personnel'}`);
      setConfirmTypeSwitch(false);
      onChanged();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Erreur'); }
  };

  return (
    <div className="relative inline-block" ref={wrapRef}>
      <button
        data-testid={`row-actions-${user.id}`}
        onClick={() => setOpen((v) => !v)}
        className="w-8 h-8 rounded-lg border border-slate-200 hover:bg-slate-50 inline-flex items-center justify-center"
      >
        <MoreHorizontal className="w-4 h-4 text-slate-500" />
      </button>

      {open && (
        <div
          data-testid={`actions-menu-${user.id}`}
          className="absolute right-0 mt-1 w-56 bg-white border border-slate-200 rounded-xl shadow-xl z-30 overflow-hidden"
        >
          <MenuItem I={Eye} label="Voir le profil" onClick={() => { setOpen(false); onNav(`/admin/users/${user.id}`); }} testId={`act-view-${user.id}`} />
          <MenuItem I={Pencil} label="Modifier les informations" onClick={() => { setOpen(false); setEditOpen(true); }} testId={`act-edit-${user.id}`} />
          <MenuItem I={ShieldCheck} label="Vérifier le KYC" onClick={doKycApprove} disabled={user.kyc_status === 'verified'} testId={`act-kyc-${user.id}`} />
          <MenuItem
            I={UserCog}
            label={nextType === 'merchant' ? 'Convertir en Marchand' : 'Convertir en Personnel'}
            onClick={() => { setOpen(false); setConfirmTypeSwitch(true); }}
            testId={`act-account-type-${user.id}`}
          />
          {suspended ? (
            <MenuItem I={RefreshCcw} label="Réactiver le compte" onClick={() => doAction('unblock', 'Compte réactivé')} testId={`act-reactivate-${user.id}`} />
          ) : (
            <MenuItem I={Ban} label="Suspendre le compte" onClick={() => doAction('block', 'Compte suspendu')} disabled={isSelf || isSuperAdmin} testId={`act-suspend-${user.id}`} />
          )}
          <MenuItem I={KeyRound} label="Réinitialiser le mot de passe" onClick={() => { setOpen(false); setPwdOpen(true); }} testId={`act-reset-${user.id}`} />
          <div className="border-t border-slate-100" />
          <MenuItem
            I={Trash2}
            label="Supprimer définitivement"
            onClick={() => { setOpen(false); setConfirmDel(true); }}
            danger
            disabled={isSelf || isSuperAdmin}
            testId={`act-delete-${user.id}`}
          />
        </div>
      )}

      {editOpen && (
        <EditUserModal user={user} onClose={() => setEditOpen(false)} onSaved={() => { setEditOpen(false); onChanged(); }} />
      )}
      {pwdOpen && (
        <ResetPasswordModal user={user} onClose={() => setPwdOpen(false)} />
      )}
      {confirmDel && (
        <DeleteUserModal user={user} onClose={() => setConfirmDel(false)} onDeleted={() => { setConfirmDel(false); onChanged(); }} />
      )}
      {confirmTypeSwitch && (
        <ModalShell title="Modifier le type de compte" onClose={() => setConfirmTypeSwitch(false)} testId={`switch-type-modal-${user.id}`}>
          <p className="text-xs text-slate-700">
            Vous êtes sur le point de convertir <b>{user.full_name}</b> (<span className="font-mono">@{user.username}</span>)
            de <b>{currentType === 'merchant' ? 'Marchand' : 'Personnel'}</b> vers <b>{nextType === 'merchant' ? 'Marchand' : 'Personnel'}</b>.
          </p>
          <div className="mt-3 rounded-xl bg-blue-50 border border-blue-100 p-3 text-[11px] text-slate-700 leading-relaxed">
            {nextType === 'merchant' ? (
              <>Cet utilisateur aura immédiatement accès aux outils marchands : <b>API de paiement</b>, gestion des clés API, configuration des webhooks. Les clés API seront auto-générées.</>
            ) : (
              <>Cet utilisateur perdra immédiatement l&apos;accès aux outils marchands (API, webhooks). Ses clés API existantes restent en base mais ne seront plus utilisables.</>
            )}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => setConfirmTypeSwitch(false)} className="px-4 py-2 rounded-lg border border-slate-200 text-xs font-semibold hover:bg-slate-50" data-testid="switch-type-cancel">Annuler</button>
            <button onClick={switchAccountType} className="px-4 py-2 rounded-lg bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-xs font-bold" data-testid="switch-type-submit">Confirmer la conversion</button>
          </div>
        </ModalShell>
      )}
    </div>
  );
}

function MenuItem({ I, label, onClick, disabled, danger, testId }) {
  return (
    <button
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition-colors ${danger ? 'text-red-600 hover:bg-red-50' : 'text-slate-700 hover:bg-slate-50'} disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent`}
    >
      <I className="w-3.5 h-3.5" strokeWidth={1.75} /> {label}
    </button>
  );
}

function ModalShell({ title, onClose, children, testId }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" data-testid={testId}>
      <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
          <h3 className="font-cabinet font-bold text-slate-900 text-sm">{title}</h3>
          <button onClick={onClose} className="w-8 h-8 rounded-lg hover:bg-slate-100 inline-flex items-center justify-center" data-testid="modal-close">
            <X className="w-4 h-4 text-slate-500" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function EditUserModal({ user, onClose, onSaved }) {
  const [form, setForm] = useState({
    full_name: user.full_name || '',
    username: user.username || '',
    email: user.email || '',
    phone: user.phone || '',
    country: user.country || '',
  });
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.patch(`/admin/users/${user.id}`, form);
      toast.success('Informations mises à jour');
      onSaved();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Erreur'); }
    finally { setSaving(false); }
  };

  return (
    <ModalShell title={`Modifier ${user.username}`} onClose={onClose} testId={`edit-user-modal-${user.id}`}>
      <div className="space-y-3">
        {[
          ['full_name', 'Nom complet'],
          ['username', 'Nom d\'utilisateur'],
          ['email', 'Email'],
          ['phone', 'Téléphone'],
          ['country', 'Pays (code ISO)'],
        ].map(([k, l]) => (
          <div key={k}>
            <label className="text-[11px] font-semibold text-slate-700 mb-1 block">{l}</label>
            <input value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} data-testid={`edit-${k}`} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs outline-none focus:border-[#2563EB]" />
          </div>
        ))}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-200 text-xs font-semibold hover:bg-slate-50" data-testid="edit-cancel">Annuler</button>
        <button onClick={save} disabled={saving} data-testid="edit-save" className="px-4 py-2 rounded-lg bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-xs font-bold disabled:opacity-50">{saving ? 'Enregistrement…' : 'Enregistrer'}</button>
      </div>
    </ModalShell>
  );
}

function ResetPasswordModal({ user, onClose }) {
  const [pwd, setPwd] = useState('');
  const [saving, setSaving] = useState(false);

  const genRandom = () => setPwd(Math.random().toString(36).slice(-10) + 'A9!');

  const submit = async () => {
    if (pwd.length < 6) { toast.error('6 caractères minimum'); return; }
    setSaving(true);
    try {
      await api.post(`/admin/users/${user.id}/reset-password`, { new_password: pwd });
      await navigator.clipboard.writeText(pwd).catch(() => {});
      toast.success('Mot de passe réinitialisé (copié dans le presse-papier)');
      onClose();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Erreur'); }
    finally { setSaving(false); }
  };

  return (
    <ModalShell title={`Réinitialiser mot de passe · ${user.username}`} onClose={onClose} testId={`reset-pwd-modal-${user.id}`}>
      <p className="text-xs text-slate-500 mb-3">Le mot de passe sera copié dans votre presse-papier après validation. Communiquez-le à l&apos;utilisateur par un canal sûr.</p>
      <div className="flex gap-2">
        <input value={pwd} onChange={(e) => setPwd(e.target.value)} placeholder="Nouveau mot de passe (min. 6 caractères)" data-testid="reset-pwd-input" className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-xs outline-none focus:border-[#2563EB]" />
        <button onClick={genRandom} data-testid="reset-pwd-gen" className="px-3 py-2 rounded-lg border border-slate-200 text-[11px] font-semibold hover:bg-slate-50">Générer</button>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-200 text-xs font-semibold hover:bg-slate-50" data-testid="reset-pwd-cancel">Annuler</button>
        <button onClick={submit} disabled={saving} data-testid="reset-pwd-submit" className="px-4 py-2 rounded-lg bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-xs font-bold disabled:opacity-50">{saving ? 'Réinitialisation…' : 'Réinitialiser'}</button>
      </div>
    </ModalShell>
  );
}

function DeleteUserModal({ user, onClose, onDeleted }) {
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const expected = user.username || user.email;

  const doDelete = async () => {
    if (confirm !== expected) { toast.error('Confirmation incorrecte'); return; }
    setSaving(true);
    try {
      const { data } = await api.delete(`/admin/users/${user.id}`);
      toast.success(`Utilisateur supprimé (${Object.values(data.deleted || {}).reduce((a, b) => a + b, 0)} enregistrements)`);
      onDeleted();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Erreur'); }
    finally { setSaving(false); }
  };

  return (
    <ModalShell title="Supprimer définitivement" onClose={onClose} testId={`delete-user-modal-${user.id}`}>
      <div className="rounded-xl bg-red-50 border border-red-100 p-3 flex items-start gap-2 mb-3">
        <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
        <div className="text-[11px] text-red-800 leading-relaxed">
          <b>Cette action est irréversible.</b> Le compte, ses transactions, son KYC, ses liens de paiement, clés API, tickets et notifications seront <b>définitivement supprimés</b>.
        </div>
      </div>
      <p className="text-xs text-slate-700">Vous êtes sur le point de supprimer <b>{user.full_name}</b> (<span className="font-mono">@{user.username}</span>).</p>
      <p className="text-xs text-slate-500 mt-3 mb-1">Pour confirmer, tapez <span className="font-mono font-bold text-red-600">{expected}</span> ci-dessous :</p>
      <input value={confirm} onChange={(e) => setConfirm(e.target.value)} data-testid="delete-confirm-input" className="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs outline-none focus:border-red-500" placeholder={expected} />
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-200 text-xs font-semibold hover:bg-slate-50" data-testid="delete-cancel">Annuler</button>
        <button onClick={doDelete} disabled={saving || confirm !== expected} data-testid="delete-confirm-submit" className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed">{saving ? 'Suppression…' : 'Supprimer définitivement'}</button>
      </div>
    </ModalShell>
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
