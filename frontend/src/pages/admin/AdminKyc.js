import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, Clock } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';

export default function AdminKyc() {
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState('pending');
  const [selected, setSelected] = useState(null);
  const [reason, setReason] = useState('');

  const load = () => api.get('/admin/kyc', { params: status ? { status } : {} }).then(({ data }) => setItems(data)).catch(() => {});
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [status]);

  const decide = async (approve) => {
    try {
      await api.post(`/admin/kyc/${selected.user_id}/decision`, { approve, reason });
      toast.success(approve ? 'KYC approuvé' : 'KYC rejeté');
      setSelected(null); setReason('');
      load();
    } catch (err) { toast.error(err.response?.data?.detail || 'Erreur'); }
  };

  return (
    <div className="space-y-5" data-testid="admin-kyc-page">
      <div className="flex gap-2">
        {[{ v: 'pending', l: 'En attente' }, { v: 'verified', l: 'Vérifiés' }, { v: 'rejected', l: 'Rejetés' }, { v: '', l: 'Tous' }].map((s) => (
          <button key={s.v} onClick={() => setStatus(s.v)} data-testid={`kyc-tab-${s.v || 'all'}`} className={`px-4 py-2 rounded-full text-xs font-bold ${status === s.v ? 'bg-[#2563EB] text-white' : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'}`}>{s.l}</button>
        ))}
      </div>

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
        {items.length === 0 && <div className="col-span-full p-10 text-center text-sm text-slate-400 bg-white border border-slate-100 rounded-2xl">Aucune demande</div>}
        {items.map((k) => (
          <div key={k.user_id} data-testid={`kyc-card-${k.user_id}`} className="bg-white border border-slate-100 rounded-2xl p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="font-cabinet font-bold text-slate-900 text-sm">{k.user?.full_name}</div>
                <div className="text-[11px] text-slate-500">@{k.user?.username} · {k.user?.country}</div>
              </div>
              <StatusChip s={k.status} />
            </div>
            <div className="text-xs text-slate-600 space-y-1">
              <div><b>Doc:</b> {k.document_type} — {k.document_number}</div>
              <div><b>Adresse:</b> {k.address}, {k.city}</div>
              <div className="text-[11px] text-slate-400">{new Date(k.submitted_at).toLocaleString()}</div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div className="h-20 rounded-lg bg-slate-100 flex items-center justify-center text-[10px] text-slate-500 font-semibold">Recto</div>
              <div className="h-20 rounded-lg bg-slate-100 flex items-center justify-center text-[10px] text-slate-500 font-semibold">Selfie</div>
            </div>
            <div className="mt-3 flex gap-2">
              <button onClick={() => { setSelected(k); }} data-testid={`btn-review-${k.user_id}`} className="flex-1 px-3 py-2 rounded-lg bg-[#2563EB] text-white text-xs font-bold">Examiner</button>
            </div>
          </div>
        ))}
      </div>

      {selected && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setSelected(null)}>
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl p-6 max-w-lg w-full shadow-2xl" data-testid="kyc-review-modal">
            <h3 className="font-cabinet font-bold text-lg mb-3">Examiner la demande KYC — @{selected.user?.username}</h3>
            <div className="text-sm text-slate-600 space-y-1 mb-4">
              <div><b>Nom:</b> {selected.user?.full_name}</div>
              <div><b>Document:</b> {selected.document_type} — {selected.document_number}</div>
              <div><b>Adresse:</b> {selected.address}, {selected.city}</div>
            </div>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} data-testid="kyc-reason" placeholder="Raison (obligatoire en cas de rejet)" rows={3} className="w-full px-3 py-2 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB]" />
            <div className="mt-4 flex gap-2 justify-end">
              <button onClick={() => setSelected(null)} className="px-4 py-2 rounded-full border border-slate-200 font-semibold text-sm">Annuler</button>
              <button onClick={() => decide(false)} disabled={!reason} data-testid="kyc-reject" className="px-4 py-2 rounded-full bg-red-500 hover:bg-red-600 text-white font-semibold text-sm disabled:opacity-50">Rejeter</button>
              <button onClick={() => decide(true)} data-testid="kyc-approve" className="px-4 py-2 rounded-full bg-emerald-500 hover:bg-emerald-600 text-white font-semibold text-sm">Approuver</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusChip({ s }) {
  const map = { verified: { c: 'bg-emerald-50 text-emerald-700', I: CheckCircle2, l: 'Vérifié' }, pending: { c: 'bg-amber-50 text-amber-700', I: Clock, l: 'En attente' }, rejected: { c: 'bg-red-50 text-red-700', I: XCircle, l: 'Rejeté' } };
  const x = map[s] || map.pending;
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${x.c}`}><x.I className="w-3 h-3" />{x.l}</span>;
}
