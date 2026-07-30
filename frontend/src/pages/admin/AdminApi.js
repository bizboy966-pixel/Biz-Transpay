import { useEffect, useState, useCallback } from 'react';
import { Search, Ban, RefreshCcw, Trash2, RefreshCw, Copy, Code2, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';

export default function AdminApi() {
  const [items, setItems] = useState([]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [confirmDel, setConfirmDel] = useState(null);
  const [confirmRegen, setConfirmRegen] = useState(null);

  const load = useCallback(() => {
    const p = {};
    if (q) p.q = q;
    if (status) p.status = status;
    api.get('/admin/api-keys', { params: p })
      .then(({ data }) => setItems(data))
      .catch(() => setItems([]));
  }, [q, status]);

  useEffect(() => { load(); }, [status, load]);
  useEffect(() => {
    const id = setTimeout(() => load(), 250);
    return () => clearTimeout(id);
  }, [q, load]);

  const doAction = async (uid, action, ok) => {
    try {
      await api.post(`/admin/api-keys/${uid}/action/${action}`);
      toast.success(ok);
      load();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Erreur'); }
  };

  const copy = (v) => { navigator.clipboard.writeText(v); toast.success('Copié'); };

  return (
    <div className="space-y-5" data-testid="admin-api-page">
      <div>
        <h1 className="font-cabinet text-3xl font-extrabold tracking-tighter text-slate-900">API de paiement</h1>
        <p className="text-slate-500 text-sm mt-1">Toutes les clés API des marchands · {items.length} au total</p>
      </div>

      <div className="bg-white border border-slate-100 rounded-2xl p-4 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[240px] flex items-center gap-2 px-3 border border-slate-200 rounded-xl">
          <Search className="w-4 h-4 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} data-testid="admin-api-search" placeholder="Email, nom, ID utilisateur, clé publique…" className="flex-1 py-2.5 outline-none text-sm bg-transparent" />
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value)} data-testid="admin-api-status" className="px-3 py-2 border border-slate-200 rounded-xl text-xs font-semibold">
          <option value="">Tous statuts</option>
          <option value="active">Actives</option>
          <option value="suspended">Suspendues</option>
        </select>
      </div>

      <div className="bg-white border border-slate-100 rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              <tr>
                <th className="text-left px-5 py-2.5">Propriétaire</th>
                <th className="text-left px-5 py-2.5">Compte</th>
                <th className="text-left px-5 py-2.5">Clé publique TEST</th>
                <th className="text-left px-5 py-2.5">Clé publique LIVE</th>
                <th className="text-center px-5 py-2.5">Statut</th>
                <th className="text-right px-5 py-2.5">Créé</th>
                <th className="text-center px-5 py-2.5">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr><td colSpan={7} className="p-10 text-center text-slate-400 text-sm" data-testid="admin-api-empty">
                  {q ? 'Aucune clé API trouvée.' : 'Aucun marchand n\'a encore activé l\'API.'}
                </td></tr>
              )}
              {items.map((it) => (
                <tr key={it.user_id} data-testid={`admin-api-row-${it.user_id}`} className="border-t border-slate-50 hover:bg-slate-50/60">
                  <td className="px-5 py-3">
                    <div className="text-xs font-semibold text-slate-900">{it.owner?.full_name || '—'}</div>
                    <div className="text-[11px] text-slate-500">{it.owner?.email}</div>
                  </td>
                  <td className="px-5 py-3">
                    <span className={`inline-flex px-1.5 py-0.5 rounded-full text-[10px] font-bold uppercase ${it.owner?.account_type === 'merchant' ? 'bg-purple-50 text-purple-700' : 'bg-slate-100 text-slate-600'}`}>
                      {it.owner?.account_type === 'merchant' ? 'Marchand' : 'Personnel'}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-1.5">
                      <code className="font-mono text-[10px] text-slate-700 truncate max-w-[160px]" title={it.test_public_key}>{it.test_public_key || '—'}</code>
                      {it.test_public_key && <button onClick={() => copy(it.test_public_key)} className="text-slate-400 hover:text-slate-700" data-testid={`copy-test-${it.user_id}`}><Copy className="w-3 h-3" /></button>}
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-1.5">
                      <code className="font-mono text-[10px] text-slate-700 truncate max-w-[160px]" title={it.live_public_key}>{it.live_public_key || '—'}</code>
                      {it.live_public_key && <button onClick={() => copy(it.live_public_key)} className="text-slate-400 hover:text-slate-700" data-testid={`copy-live-${it.user_id}`}><Copy className="w-3 h-3" /></button>}
                    </div>
                  </td>
                  <td className="px-5 py-3 text-center">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${!it.suspended ? 'bg-emerald-50 text-emerald-700' : 'bg-orange-50 text-orange-700'}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${!it.suspended ? 'bg-emerald-500' : 'bg-orange-500'}`} />
                      {!it.suspended ? 'Active' : 'Suspendue'}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right text-[11px] text-slate-500">{new Date(it.created_at).toLocaleDateString()}</td>
                  <td className="px-5 py-3">
                    <div className="flex items-center justify-center gap-1">
                      {!it.suspended ? (
                        <button onClick={() => doAction(it.user_id, 'suspend', 'API suspendue')} className="w-7 h-7 rounded-md hover:bg-orange-50 text-orange-600 inline-flex items-center justify-center" title="Suspendre" data-testid={`api-suspend-${it.user_id}`}><Ban className="w-3.5 h-3.5" /></button>
                      ) : (
                        <button onClick={() => doAction(it.user_id, 'reactivate', 'API réactivée')} className="w-7 h-7 rounded-md hover:bg-emerald-50 text-emerald-600 inline-flex items-center justify-center" title="Réactiver" data-testid={`api-reactivate-${it.user_id}`}><RefreshCcw className="w-3.5 h-3.5" /></button>
                      )}
                      <button onClick={() => setConfirmRegen(it)} className="w-7 h-7 rounded-md hover:bg-blue-50 text-[#2563EB] inline-flex items-center justify-center" title="Régénérer" data-testid={`api-regen-${it.user_id}`}><RefreshCw className="w-3.5 h-3.5" /></button>
                      <button onClick={() => setConfirmDel(it)} className="w-7 h-7 rounded-md hover:bg-red-50 text-red-600 inline-flex items-center justify-center" title="Supprimer" data-testid={`api-delete-${it.user_id}`}><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {confirmDel && (
        <ConfirmModal
          testId="api-delete-modal"
          icon={AlertTriangle}
          iconClass="bg-red-50 text-red-600"
          title="Supprimer les clés API"
          body={<>Les clés API de <b>{confirmDel.owner?.email}</b> seront <b>définitivement supprimées</b>. Le marchand devra en générer de nouvelles.</>}
          confirmLabel="Supprimer définitivement"
          confirmClass="bg-red-600 hover:bg-red-700"
          onCancel={() => setConfirmDel(null)}
          onConfirm={() => { doAction(confirmDel.user_id, 'delete', 'Clés API supprimées'); setConfirmDel(null); }}
        />
      )}
      {confirmRegen && (
        <ConfirmModal
          testId="api-regen-modal"
          icon={RefreshCw}
          iconClass="bg-blue-50 text-[#2563EB]"
          title="Régénérer les clés API"
          body={<>Les clés TEST et LIVE de <b>{confirmRegen.owner?.email}</b> seront rotées. Les anciennes clés seront invalidées immédiatement.</>}
          confirmLabel="Régénérer"
          confirmClass="bg-[#2563EB] hover:bg-[#1D4ED8]"
          onCancel={() => setConfirmRegen(null)}
          onConfirm={() => { doAction(confirmRegen.user_id, 'regenerate', 'Clés API régénérées'); setConfirmRegen(null); }}
        />
      )}
    </div>
  );
}

function ConfirmModal({ testId, icon: I, iconClass, title, body, confirmLabel, confirmClass, onCancel, onConfirm }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" data-testid={testId}>
      <div className="bg-white rounded-2xl w-full max-w-md p-5 shadow-2xl">
        <div className="flex items-center gap-2">
          <div className={`w-9 h-9 rounded-full flex items-center justify-center ${iconClass}`}><I className="w-4 h-4" /></div>
          <h3 className="font-cabinet font-extrabold text-sm text-slate-900">{title}</h3>
        </div>
        <p className="mt-3 text-xs text-slate-700">{body}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onCancel} data-testid={`${testId}-cancel`} className="px-4 py-2 rounded-lg border border-slate-200 text-xs font-semibold hover:bg-slate-50">Annuler</button>
          <button onClick={onConfirm} data-testid={`${testId}-confirm`} className={`px-4 py-2 rounded-lg text-white text-xs font-bold ${confirmClass}`}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
