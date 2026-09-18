import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IdCard, Upload, CheckCircle2, Clock, XCircle, AlertTriangle, ShieldCheck, User, Phone, FileText, Briefcase } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';
import { useAuth } from '@/context/AuthContext';

const ACTIVITIES = [
  'Commerce en ligne',
  'Boutique physique',
  'Prestataire de services',
  'Développeur',
  'Entreprise',
  'Utilisation personnelle',
  'Autre',
];

const MAX_UPLOAD_BYTES = 3_000_000;
const MAX_IMAGE_DIMENSION = 1800;
const MAX_KYC_PAYLOAD_LENGTH = 8_000_000;

export default function Kyc() {
  const { t } = useTranslation();
  const { user, refresh } = useAuth();
  const [submission, setSubmission] = useState(null);
  const [status, setStatus] = useState('not_started');
  const [form, setForm] = useState({
    full_name: user?.full_name || '',
    phone: user?.phone || '',
    document_type: 'cni',
    document_number: '',
    activity_description: 'Commerce en ligne',
    document_front: '',
    document_back: '',
    selfie: '',
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.get('/kyc').then(({ data }) => {
      setStatus(data.status);
      if (data.submission?.user_id) {
        setSubmission(data.submission);
        setForm((f) => ({ ...f, ...data.submission, document_front: '', document_back: '', selfie: '' }));
      }
    }).catch(() => {});
  }, []);

  const readFile = (file, cb) => {
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/jpg'].includes(file.type)) {
      toast.error('Format non supporté (JPG, PNG, WebP uniquement)');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) { toast.error('Image trop grande (max 3 Mo)'); return; }
    const r = new FileReader();
    r.onerror = () => toast.error('Impossible de lire cette image. Réessayez avec une autre photo.');
    r.onload = (ev) => {
      const image = new Image();
      image.onerror = () => toast.error('Image illisible. Utilisez une photo JPG, PNG ou WebP.');
      image.onload = () => {
        try {
          const scale = Math.min(1, MAX_IMAGE_DIMENSION / image.naturalWidth, MAX_IMAGE_DIMENSION / image.naturalHeight);
          const width = Math.max(1, Math.round(image.naturalWidth * scale));
          const height = Math.max(1, Math.round(image.naturalHeight * scale));
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('canvas unavailable');
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, width, height);
          context.drawImage(image, 0, 0, width, height);
          let optimized = canvas.toDataURL('image/jpeg', 0.82);
          if (optimized.length > MAX_KYC_PAYLOAD_LENGTH / 3) {
            optimized = canvas.toDataURL('image/jpeg', 0.68);
          }
          if (optimized.length > MAX_KYC_PAYLOAD_LENGTH / 2) {
            toast.error('Image encore trop volumineuse après optimisation. Choisissez une photo plus légère.');
            return;
          }
          cb(optimized);
        } catch {
          toast.error('Impossible de préparer cette image. Réessayez avec une autre photo.');
        }
      };
      image.src = ev.target.result;
    };
    r.readAsDataURL(file);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!form.document_front || !form.selfie) { toast.error('Veuillez téléverser au moins le recto du document et le selfie'); return; }
    const imagePayloadLength = [form.document_front, form.document_back, form.selfie]
      .reduce((total, value) => total + String(value || '').length, 0);
    if (imagePayloadLength > MAX_KYC_PAYLOAD_LENGTH) {
      toast.error('Les images sont trop volumineuses. Retirez-les puis téléversez des photos moins lourdes.');
      return;
    }
    setLoading(true);
    try {
      await api.post('/kyc/submit', form);
      toast.success('Demande soumise. En attente de validation.');
      setStatus('pending');
      refresh();
    } catch (err) {
      const detail = err.response?.data?.detail;
      const message = typeof detail === 'string'
        ? detail
        : err.response?.status === 413
          ? 'Les images sont trop volumineuses. Utilisez des photos moins lourdes.'
          : err.response
            ? `Impossible de soumettre la vérification (${err.response.status}).`
            : 'Connexion impossible. Vérifiez votre réseau puis réessayez.';
      toast.error(message);
    } finally { setLoading(false); }
  };

  const badges = {
    not_started: { c: 'bg-slate-100 text-slate-600', I: IdCard, l: 'Non commencé' },
    pending: { c: 'bg-amber-50 text-amber-700', I: Clock, l: 'En attente de validation' },
    verified: { c: 'bg-emerald-50 text-emerald-700', I: CheckCircle2, l: 'Vérifiée' },
    rejected: { c: 'bg-red-50 text-red-700', I: XCircle, l: 'Refusée' },
    resubmit_requested: { c: 'bg-orange-50 text-orange-700', I: AlertTriangle, l: 'Nouvelle soumission demandée' },
  };
  const badge = badges[status] || badges.not_started;

  const canEdit = status === 'not_started' || status === 'rejected' || status === 'resubmit_requested';
  const needsBack = form.document_type === 'cni' || form.document_type === 'driver_license';

  return (
    <div className="space-y-5" data-testid="page-kyc">
      <div>
        <h1 className="font-cabinet text-2xl font-extrabold tracking-tighter text-slate-900">Vérification KYC</h1>
        <p className="text-slate-500 text-xs mt-1">Complétez votre identité pour débloquer toutes les fonctionnalités (retraits, liens, API avancée).</p>
      </div>

      {/* Status card */}
      <div className="bg-white border border-slate-100 rounded-2xl p-5 flex items-center gap-4">
        <div className={`w-12 h-12 rounded-2xl ${badge.c} flex items-center justify-center`}>
          <badge.I className="w-5 h-5" />
        </div>
        <div className="flex-1">
          <div className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Statut</div>
          <div className="font-cabinet font-extrabold text-lg text-slate-900" data-testid="kyc-status">{badge.l}</div>
          {submission?.reject_reason && (status === 'rejected' || status === 'resubmit_requested') && (
            <div className="mt-1 text-xs text-red-600"><b>Motif :</b> {submission.reject_reason}</div>
          )}
        </div>
        {status === 'verified' && <ShieldCheck className="w-8 h-8 text-emerald-500" />}
      </div>

      {status === 'pending' && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
          <Clock className="w-4 h-4 text-amber-600 mt-0.5" />
          <div className="text-xs text-amber-900">
            <b>Votre demande est en cours d'examen.</b> Nos équipes vérifient vos documents et vous serez notifié dès qu'une décision sera prise.
          </div>
        </div>
      )}

      {canEdit && (
        <form onSubmit={submit} className="bg-white border border-slate-100 rounded-2xl p-5 sm:p-6 space-y-5">
          {/* Section 1 - Informations personnelles */}
          <Section title="Informations personnelles">
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="Nom complet (tel que sur le document)" icon={User}>
                <input data-testid="kyc-full-name" required value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} placeholder="KOTOKOU Kossi Emmanuel" className="w-full pl-9 pr-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm" />
              </Field>
              <Field label="Numéro de téléphone" icon={Phone}>
                <input data-testid="kyc-phone" required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+228 90 00 00 00" className="w-full pl-9 pr-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm" />
              </Field>
            </div>
          </Section>

          {/* Section 2 - Document */}
          <Section title="Type de document d'identité">
            <div className="grid grid-cols-3 gap-2 mb-3">
              {[
                { v: 'cni', l: 'Carte nationale d\'identité' },
                { v: 'passport', l: 'Passeport' },
                { v: 'driver_license', l: 'Permis de conduire' },
              ].map((o) => (
                <button key={o.v} type="button" onClick={() => setForm({ ...form, document_type: o.v })} data-testid={`doc-type-${o.v}`} className={`p-3 rounded-xl border-2 text-center transition-colors ${form.document_type === o.v ? 'border-[#2563EB] bg-blue-50/60' : 'border-slate-200 hover:border-slate-300'}`}>
                  <IdCard className={`w-4 h-4 mx-auto ${form.document_type === o.v ? 'text-[#2563EB]' : 'text-slate-400'}`} />
                  <div className="mt-1 font-cabinet font-bold text-[11px] text-slate-900 leading-tight">{o.l}</div>
                </button>
              ))}
            </div>
            <Field label="Numéro du document" icon={FileText}>
              <input data-testid="kyc-doc-number" required value={form.document_number} onChange={(e) => setForm({ ...form, document_number: e.target.value })} placeholder="Ex: 123456789" className="w-full pl-9 pr-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm" />
            </Field>
          </Section>

          {/* Section 3 - Activity */}
          <Section title="Description de l'activité">
            <Field label="Type d'activité" icon={Briefcase}>
              <select data-testid="kyc-activity" value={form.activity_description} onChange={(e) => setForm({ ...form, activity_description: e.target.value })} className="w-full pl-9 pr-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm font-semibold">
                {ACTIVITIES.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </Field>
          </Section>

          {/* Section 4 - Uploads */}
          <Section title="Téléversement des documents">
            <div className={`grid ${needsBack ? 'grid-cols-3' : 'grid-cols-2'} gap-3`}>
              <UploadTile label="Recto du document" value={form.document_front} onChange={(v) => setForm({ ...form, document_front: v })} onFile={(f) => readFile(f, (v) => setForm((prev) => ({ ...prev, document_front: v })))} testid="kyc-front" />
              {needsBack && (
                <UploadTile label="Verso du document" value={form.document_back} onChange={(v) => setForm({ ...form, document_back: v })} onFile={(f) => readFile(f, (v) => setForm((prev) => ({ ...prev, document_back: v })))} testid="kyc-back" />
              )}
              <UploadTile label="Selfie + document en main" value={form.selfie} onChange={(v) => setForm({ ...form, selfie: v })} onFile={(f) => readFile(f, (v) => setForm((prev) => ({ ...prev, selfie: v })))} testid="kyc-selfie" />
            </div>
            <div className="mt-2 text-[10px] text-slate-500">Formats acceptés : JPG, PNG, WebP · 3 Mo max par fichier. Les photos sont automatiquement optimisées avant l’envoi.</div>
          </Section>

          <button type="submit" disabled={loading} data-testid="btn-submit-kyc" className="w-full bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold py-3.5 rounded-xl disabled:opacity-60 text-sm">
            {loading ? '…' : 'Soumettre la demande de vérification'}
          </button>
        </form>
      )}

      {status === 'verified' && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-6 flex items-center gap-4">
          <CheckCircle2 className="w-10 h-10 text-emerald-600 shrink-0" />
          <div>
            <div className="font-cabinet font-bold text-emerald-900">Compte vérifié !</div>
            <p className="text-xs text-emerald-800 mt-0.5">Toutes les fonctionnalités sont désormais accessibles : retraits, liens de paiement, API avancée, transferts KYC.</p>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">{title}</div>
      {children}
    </div>
  );
}
function Field({ label, icon: I, children }) {
  return (
    <div>
      <label className="text-xs font-semibold text-slate-700 mb-1.5 block">{label}</label>
      <div className="relative">
        <I className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        {children}
      </div>
    </div>
  );
}
function UploadTile({ label, value, onChange, onFile, testid }) {
  const ref = useRef();
  return (
    <div>
      <label className="text-xs font-semibold text-slate-700 mb-1.5 block">{label}</label>
      <div onClick={() => ref.current?.click()} className="relative aspect-[4/3] rounded-xl border-2 border-dashed border-slate-200 hover:border-[#2563EB] cursor-pointer overflow-hidden bg-slate-50">
        {value ? (
          <>
            <img src={value} alt={label} className="w-full h-full object-cover" data-testid={`${testid}-preview`} />
            <div className="absolute inset-0 bg-black/40 opacity-0 hover:opacity-100 flex items-center justify-center text-white text-[10px] font-bold transition-opacity">Modifier</div>
          </>
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-slate-400">
            <Upload className="w-5 h-5" />
            <span className="text-[10px] mt-1 font-semibold">Téléverser</span>
          </div>
        )}
      </div>
      {value && <button type="button" onClick={(e) => { e.stopPropagation(); onChange(''); }} className="mt-1 text-[10px] text-red-500 font-semibold">Retirer</button>}
      <input ref={ref} type="file" accept="image/jpeg,image/jpg,image/png,image/webp" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} className="hidden" data-testid={testid} />
    </div>
  );
}
