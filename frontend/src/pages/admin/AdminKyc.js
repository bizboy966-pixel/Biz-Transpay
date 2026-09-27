import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, Clock, AlertTriangle, ExternalLink, User, Phone, IdCard, FileText, Briefcase } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';

const DOC_TYPE_LABEL = { cni: 'CNI', passport: 'Passeport', driver_license: 'Permis de conduire', id_card: 'CNI' };

export default function AdminKyc() {
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState('pending');
  const [selected, setSelected] = useState(null);
  const [reason, setReason] = useState('');
  const [viewImg, setViewImg] = useState(null);

  const load = () => api.get('/admin/kyc', { params: status ? { status } : {} }).then(({ data }) => setItems(data)).catch(() => {});
  // `load` is intentionally recreated with the selected status.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [status]);

  const decide = async (kind) => {
    try {
      const body = { approve: kind === 'approve', reason, request_resubmit: kind === 'resubmit' };
      await api.post(`/admin/kyc/${selected.user_id}/decision`, body);
      toast.success({ approve: 'KYC approuvé', reject: 'KYC rejeté', resubmit: 'Nouvelle soumission demandée' }[kind]);
      setSelected(null); setReason('');
      load();
    } catch (err) { toast.error(err.response?.data?.detail || 'Erreur'); }
  };

  return (
    <div className="space-y-5" data-testid="admin-kyc-page">
      <div className="flex gap-2 flex-wrap">
        {[
          { v: 'pending', l: 'En attente', I: Clock },
          { v: 'verified', l: 'Vérifiés', I: CheckCircle2 },
          { v: 'rejected', l: 'Rejetés', I: XCircle },
          { v: 'resubmit_requested', l: 'À resoumettre', I: AlertTriangle },
          { v: '', l: 'Tous', I: null },
        ].map((s) => (
          <button key={s.v} onClick={() => setStatus(s.v)} data-testid={`kyc-tab-${s.v || 'all'}`} className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-bold ${status === s.v ? 'bg-[#2563EB] text-white' : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'}`}>
            {s.I && <s.I className="w-3.5 h-3.5" />} {s.l}
          </button>
        ))}
      </div>

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
        {items.length === 0 && <div className="col-span-full p-10 text-center text-sm text-slate-400 bg-white border border-slate-100 rounded-2xl">Aucune demande</div>}
        {items.map((k) => (
          <div key={k.user_id} data-testid={`kyc-card-${k.user_id}`} className="bg-white border border-slate-100 rounded-2xl p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="font-cabinet font-bold text-slate-900 text-sm">{k.full_name || k.user?.full_name}</div>
                <div className="text-[11px] text-slate-500">@{k.user?.username} · {k.user?.country}</div>
              </div>
              <StatusChip s={k.status} />
            </div>
            <div className="text-xs text-slate-600 space-y-1">
              <div className="flex items-center gap-1.5"><IdCard className="w-3 h-3 text-slate-400" /> {DOC_TYPE_LABEL[k.document_type] || k.document_type} — {k.document_number}</div>
              <div className="flex items-center gap-1.5"><Phone className="w-3 h-3 text-slate-400" /> {k.phone}</div>
              <div className="flex items-center gap-1.5"><Briefcase className="w-3 h-3 text-slate-400" /> {k.activity_description}</div>
                <div className="line-clamp-2 pt-1 text-[11px] text-slate-600">{k.activity_details || 'Description détaillée non renseignée'}</div>
                <div className="pt-1 text-[11px] font-semibold text-slate-700">{k.platform_status === 'available' ? 'Plateforme disponible' : 'Plateforme en préparation — demande soumise'}</div>
              <div className="text-[10px] text-slate-400 pt-1">Soumis le {new Date(k.submitted_at).toLocaleString()}</div>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-1.5">
              <DocThumb src={k.document_front} label="Recto" onClick={() => setViewImg({ src: k.document_front, label: 'Recto' })} />
              <DocThumb src={k.document_back} label="Verso" onClick={() => setViewImg({ src: k.document_back, label: 'Verso' })} />
              <DocThumb src={k.selfie} label="Selfie" onClick={() => setViewImg({ src: k.selfie, label: 'Selfie' })} />
            </div>
            <button onClick={() => { setSelected(k); }} data-testid={`btn-review-${k.user_id}`} className="mt-3 w-full px-3 py-2 rounded-lg bg-[#2563EB] text-white text-xs font-bold">Examiner</button>
          </div>
        ))}
      </div>

      {selected && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto" onClick={() => setSelected(null)}>
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl p-6 max-w-2xl w-full my-8 shadow-2xl" data-testid="kyc-review-modal">
            <h3 className="font-cabinet font-bold text-lg mb-1">Examiner la demande — @{selected.user?.username}</h3>
            <p className="text-xs text-slate-500 mb-4">Vérifiez soigneusement les documents avant de prendre une décision.</p>
            <div className="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm mb-4">
              <Row I={User} l="Nom complet" v={selected.full_name || selected.user?.full_name} />
              <Row I={Phone} l="Téléphone" v={selected.phone} />
              <Row I={IdCard} l="Document" v={`${DOC_TYPE_LABEL[selected.document_type] || selected.document_type} — ${selected.document_number}`} />
              <Row I={Briefcase} l="Activité" v={selected.activity_description} />
            </div>
            <div className="mb-4 space-y-3">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Description détaillée de l’activité</div>
                <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-slate-800">{selected.activity_details || 'Non renseignée'}</p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Plateforme</div>
                <div className="mt-1 text-sm text-slate-800">{selected.platform_status === 'available' ? 'Déjà disponible' : 'Pas encore disponible — demande de validation soumise'}</div>
                {selected.platform_status === 'available' && selected.platform_url && (
                  <a href={selected.platform_url} target="_blank" rel="noreferrer" className="mt-1 inline-flex max-w-full items-center gap-1 break-all text-sm font-semibold text-blue-700 underline underline-offset-2">
                    {selected.platform_url}<ExternalLink className="h-3.5 w-3.5 shrink-0" />
                  </a>
                )}
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 mb-4">
              <DocThumb src={selected.document_front} label="Recto" onClick={() => setViewImg({ src: selected.document_front, label: 'Recto' })} big />
              <DocThumb src={selected.document_back} label="Verso" onClick={() => setViewImg({ src: selected.document_back, label: 'Verso' })} big />
              <DocThumb src={selected.selfie} label="Selfie" onClick={() => setViewImg({ src: selected.selfie, label: 'Selfie' })} big />
            </div>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} data-testid="kyc-reason" placeholder="Motif détaillé (obligatoire en cas de rejet ou de nouvelle soumission)" rows={3} className="w-full px-3 py-2 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm" />
            <div className="mt-4 flex flex-wrap gap-2 justify-end">
              <button onClick={() => setSelected(null)} className="px-4 py-2 rounded-full border border-slate-200 font-semibold text-xs">Annuler</button>
              <button onClick={() => decide('resubmit')} disabled={!reason} data-testid="kyc-resubmit" className="px-4 py-2 rounded-full bg-orange-500 hover:bg-orange-600 text-white font-semibold text-xs disabled:opacity-50">Demander une nouvelle soumission</button>
              <button onClick={() => decide('reject')} disabled={!reason} data-testid="kyc-reject" className="px-4 py-2 rounded-full bg-red-500 hover:bg-red-600 text-white font-semibold text-xs disabled:opacity-50">Rejeter</button>
              <button onClick={() => decide('approve')} data-testid="kyc-approve" className="px-4 py-2 rounded-full bg-emerald-500 hover:bg-emerald-600 text-white font-semibold text-xs">Valider</button>
            </div>
          </div>
        </div>
      )}

      {viewImg?.src && (
        <div className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-6" onClick={() => setViewImg(null)}>
          <div onClick={(e) => e.stopPropagation()} className="max-w-4xl max-h-full">
            <div className="mb-2 text-white text-sm font-semibold flex items-center gap-2">{viewImg.label} <button onClick={() => setViewImg(null)} className="ml-auto text-xs opacity-70 hover:opacity-100">Fermer ✕</button></div>
            <img src={viewImg.src} alt={viewImg.label} className="max-w-full max-h-[80vh] rounded-xl" />
          </div>
        </div>
      )}
    </div>
  );
}

function DocThumb({ src, label, onClick, big }) {
  return (
    <button type="button" onClick={onClick} disabled={!src} className={`relative rounded-lg overflow-hidden border border-slate-200 hover:border-[#2563EB] transition-colors ${big ? 'aspect-[4/3]' : 'aspect-square'} disabled:opacity-40 disabled:cursor-not-allowed group`}>
      {src ? (
        <>
          <img src={src} alt={label} className="w-full h-full object-cover" />
          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center text-white transition-opacity">
            <ExternalLink className="w-4 h-4" />
          </div>
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent text-white text-[9px] font-bold uppercase p-1">{label}</div>
        </>
      ) : (
        <div className="w-full h-full flex items-center justify-center text-slate-400 text-[10px] font-semibold">{label} manquant</div>
      )}
    </button>
  );
}
function Row({ I, l, v }) {
  return (
    <div className="flex items-start gap-2">
      <I className="w-3.5 h-3.5 text-slate-400 mt-0.5" />
      <div>
        <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{l}</div>
        <div className="text-sm text-slate-800">{v || '—'}</div>
      </div>
    </div>
  );
}
function StatusChip({ s }) {
  const map = {
    verified: { c: 'bg-emerald-50 text-emerald-700', I: CheckCircle2, l: 'Vérifié' },
    pending: { c: 'bg-amber-50 text-amber-700', I: Clock, l: 'En attente' },
    rejected: { c: 'bg-red-50 text-red-700', I: XCircle, l: 'Rejeté' },
    resubmit_requested: { c: 'bg-orange-50 text-orange-700', I: AlertTriangle, l: 'À resoumettre' },
  };
  const x = map[s] || map.pending;
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${x.c}`}><x.I className="w-3 h-3" />{x.l}</span>;
}
