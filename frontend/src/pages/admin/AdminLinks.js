import { useEffect, useState, useCallback } from 'react';
import { Search, Ban, RefreshCcw, Trash2, Eye, Link2, ExternalLink, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';

export default function AdminLinks() {
  const [links, setLinks] = useState([]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [confirmDel, setConfirmDel] = useState(null);

  const load = useCallback(() => {
    const p = {};
    if (q) p.q = q;
    if (status) p.status = status;
    api.get('/admin/links', { params: p })
      .then(({ data }) => setLinks(data))
      .catch(() => setLinks([]));
  }, [q, status]);

  useEffect(() => { load(); }, [status, load]);
  useEffect(() => {
    const id = setTimeout(() => load(), 250);
    return () => clearTimeout(id);
  }, [q, load]);

  const doAction = async (link, action, ok) => {
    try {
      await api.post(`/admin/links/${link.id}/action/${action}`);
      toast.success(ok);
      load();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Erreur'); }
  };

  return (
    <div className="space-y-5" data-testid="admin-links-page">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-cabinet text-3xl font-extrabold tracking-tighter text-slate-900">Liens de paiement</h1>
          <p className="text-slate-500 text-sm mt-1">Tous les liens créés par les utilisateurs · {links.length} au total</p>
        </div>
      </div>

      <div className="bg-white border border-slate-100 rounded-2xl p-4 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[240px] flex items-center gap-2 px-3 border border-slate-200 rounded-xl">
          <Search className="w-4 h-4 text-slate-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            data-testid="admin-links-search"
            placeholder="ID, slug, titre, email propriétaire, nom…"
            className="flex-1 py-2.5 outline-none text-sm bg-transparent"
          />
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value)} data-testid="admin-links-status" className="px-3 py-2 border border-slate-200 rounded-xl text-xs font-semibold">
          <option value="">Tous statuts</option>
          <option value="active">Actifs</option>
          <option value="suspended">Suspendus</option>
        </select>
      </div>

      <div className="bg-white border border-slate-100 rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              <tr>
                <th className="text-left px-5 py-2.5">Lien</th>
                <th className="text-left px-5 py-2.5">Propriétaire</th>
                <th className="text-left px-5 py-2.5">Compte</th>
                <th className="text-right px-5 py-2.5">Montant</th>
                <th className="text-center px-5 py-2.5">Statut</th>
                <th className="text-right px-5 py-2.5">Créé</th>
                <th className="text-center px-5 py-2.5">Actions</th>
              </tr>
            </thead>
            <tbody>
              {links.length === 0 && (
                <tr><td colSpan={7} className="p-10 text-center text-slate-400 text-sm" data-testid="admin-links-empty">
                  {q ? 'Aucun lien trouvé.' : 'Aucun lien de paiement pour le moment.'}
                </td></tr>
              )}
              {links.map((l) => (
                <tr key={l.id} data-testid={`admin-link-row-${l.id}`} className="border-t border-slate-50 hover:bg-slate-50/60">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-lg bg-blue-50 text-[#2563EB] flex items-center justify-center"><Link2 className="w-3.5 h-3.5" /></div>
                      <div>
                        <div className="font-semibold text-xs text-slate-900">{l.title}</div>
                        <a href={`/pay/${l.slug}`} target="_blank" rel="noreferrer" className="text-[10px] text-[#2563EB] hover:underline font-mono inline-flex items-center gap-0.5">
                          /pay/{l.slug} <ExternalLink className="w-2.5 h-2.5" />
                        </a>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <div className="text-xs font-semibold text-slate-900">{l.owner?.full_name || '—'}</div>
                    <div className="text-[11px] text-slate-500">{l.owner?.email}</div>
                  </td>
                  <td className="px-5 py-3">
                    <span className={`inline-flex px-1.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${l.owner?.account_type === 'merchant' ? 'bg-purple-50 text-purple-700' : 'bg-slate-100 text-slate-600'}`}>
                      {l.owner?.account_type === 'merchant' ? 'Marchand' : 'Personnel'}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right text-xs font-bold">
                    {l.amount_type === 'free' ? `${l.min_amount}–${l.max_amount}` : Number(l.amount).toLocaleString(undefined, { maximumFractionDigits: l.currency === 'USDT' ? 6 : 0 })} <span className="opacity-70">{l.currency}</span>
                  </td>
                  <td className="px-5 py-3 text-center">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${l.active ? 'bg-emerald-50 text-emerald-700' : 'bg-orange-50 text-orange-700'}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${l.active ? 'bg-emerald-500' : 'bg-orange-500'}`} />
                      {l.active ? 'Actif' : 'Suspendu'}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right text-[11px] text-slate-500">{new Date(l.created_at).toLocaleDateString()}</td>
                  <td className="px-5 py-3">
                    <div className="flex items-center justify-center gap-1">
                      <a href={`/pay/${l.slug}`} target="_blank" rel="noreferrer" className="w-7 h-7 rounded-md hover:bg-slate-100 inline-flex items-center justify-center" title="Voir" data-testid={`link-view-${l.id}`}><Eye className="w-3.5 h-3.5 text-slate-500" /></a>
                      {l.active ? (
                        <button onClick={() => doAction(l, 'suspend', 'Lien suspendu')} className="w-7 h-7 rounded-md hover:bg-orange-50 text-orange-600 inline-flex items-center justify-center" title="Suspendre" data-testid={`link-suspend-${l.id}`}><Ban className="w-3.5 h-3.5" /></button>
                      ) : (
                        <button onClick={() => doAction(l, 'reactivate', 'Lien réactivé')} className="w-7 h-7 rounded-md hover:bg-emerald-50 text-emerald-600 inline-flex items-center justify-center" title="Réactiver" data-testid={`link-reactivate-${l.id}`}><RefreshCcw className="w-3.5 h-3.5" /></button>
                      )}
                      <button onClick={() => setConfirmDel(l)} className="w-7 h-7 rounded-md hover:bg-red-50 text-red-600 inline-flex items-center justify-center" title="Supprimer" data-testid={`link-delete-${l.id}`}><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {confirmDel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" data-testid="link-delete-modal">
          <div className="bg-white rounded-2xl w-full max-w-md p-5 shadow-2xl">
            <div className="flex items-center gap-2">
              <div className="w-9 h-9 rounded-full bg-red-50 flex items-center justify-center"><AlertTriangle className="w-4 h-4 text-red-600" /></div>
              <h3 className="font-cabinet font-extrabold text-sm text-slate-900">Supprimer définitivement</h3>
            </div>
            <p className="mt-3 text-xs text-slate-700">
              Le lien <b>{confirmDel.title}</b> (<span className="font-mono">/pay/{confirmDel.slug}</span>) sera supprimé ainsi que toutes ses tentatives de paiement.
              <br />Cette action est <b>irréversible</b>.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setConfirmDel(null)} data-testid="link-delete-cancel" className="px-4 py-2 rounded-lg border border-slate-200 text-xs font-semibold hover:bg-slate-50">Annuler</button>
              <button onClick={() => { doAction(confirmDel, 'delete', 'Lien supprimé'); setConfirmDel(null); }} data-testid="link-delete-confirm" className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-bold">Supprimer définitivement</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
