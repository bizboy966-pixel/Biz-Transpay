import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Plus, Copy, Trash2, Power, Link2, X, Share2, QrCode, Pencil, Upload, MessageCircle, Send, Mail, ArrowLeft, Info, CheckCircle2, Eye } from 'lucide-react';
import { QRCodeCanvas } from 'qrcode.react';
import { toast } from 'sonner';
import api from '@/api';
import LinkLogo from '@/components/LinkLogo';
import { SafeImage } from '@/components/SafeImage';
import ComplianceWarningModal from '@/components/ComplianceWarningModal';

const LINK_COPY = {
  general: 'Informations générales',
  logo: 'Logo / image',
  title: 'Nom du lien',
  description: 'Description',
  amount: 'Montant',
  minimum: 'Montant minimum',
  maximum: 'Montant maximum',
  amountConfig: 'Configuration du montant',
  fixed: 'Montant fixe',
  fixedDescription: 'Le client paie un montant exact',
  free: 'Montant libre',
  freeDescription: 'Le client choisit dans une plage',
  fees: 'Gestion des frais',
};

export default function Links() {
  const { t } = useTranslation();
  const [links, setLinks] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [showQr, setShowQr] = useState(null);
  const [showShare, setShowShare] = useState(null);
  const [showDetails, setShowDetails] = useState(null);
  const [showCompliance, setShowCompliance] = useState(false);
  const [searchParams] = useSearchParams();

  const load = () => api.get('/links').then(({ data }) => setLinks(data)).catch(() => {});
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (searchParams.get('create') === '1') {
      setEditing(null);
      setShowCompliance(true);
    }
  }, [searchParams]);

  const beginLinkCreation = () => {
    setEditing(null);
    setShowCompliance(true);
  };
  const confirmLinkCreation = () => {
    setShowCompliance(false);
    setEditing(null);
    setShowForm(true);
  };

  // Public share URL — always uses the OFFICIAL domain in production so the
  // preview host never leaks into merchant-facing share/copy actions.
  const OFFICIAL = process.env.REACT_APP_PUBLIC_DOMAIN || window.location.origin;
  const publicUrl = (slug) => `${OFFICIAL.replace(/\/$/, '')}/pay/${slug}`;

  const copy = (slug) => {
    navigator.clipboard.writeText(publicUrl(slug));
    toast.success(t('links.copied'));
  };

  const toggle = async (l) => {
    await api.patch(`/links/${l.id}`, { active: !l.active });
    load();
  };
  const remove = async (id) => {
    if (!window.confirm('Supprimer ce lien ? Cette action est irréversible.')) return;
    await api.delete(`/links/${id}`);
    toast.success('Lien supprimé');
    load();
  };

  const statusOf = (l) => {
    if (!l.active) return 'disabled';
    return 'active';
  };

  return (
    <div className="space-y-5" data-testid="page-links">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-cabinet text-2xl font-extrabold tracking-tighter text-slate-900">Liens de paiement</h1>
          <p className="text-slate-500 text-xs mt-1">Créez et gérez vos liens de paiement personnalisés.</p>
        </div>
        <button onClick={beginLinkCreation} data-testid="btn-open-new-link" className="inline-flex items-center gap-2 bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold px-4 py-2.5 rounded-full text-xs shadow-[0_8px_20px_-8px_rgba(37,99,235,0.5)]">
          <Plus className="w-3.5 h-3.5" /> Créer un lien de paiement
        </button>
      </div>

      {links.length === 0 && (
        <div className="bg-white border border-dashed border-slate-200 rounded-2xl p-14 text-center">
          <div className="w-14 h-14 mx-auto rounded-2xl bg-blue-50 flex items-center justify-center"><Link2 className="w-6 h-6 text-[#2563EB]" /></div>
          <p className="mt-4 text-sm text-slate-500">Aucun lien de paiement pour l'instant.</p>
          <button onClick={beginLinkCreation} className="mt-4 text-xs font-semibold text-[#2563EB]">Créer votre premier lien →</button>
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        {links.map((l) => {
          const st = statusOf(l);
          return (
            <div key={l.id} data-testid={`link-card-${l.id}`} className="min-w-0 w-full bg-white border border-slate-100 rounded-2xl p-5 shadow-[0_2px_10px_rgba(15,23,42,0.03)] hover:shadow-[0_8px_24px_rgba(37,99,235,0.08)] transition-shadow">
              <div className="flex min-w-0 items-start gap-3">
                <LinkLogo src={l.logo} alt={l.title} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="font-cabinet font-bold text-sm text-slate-900 truncate">{l.title}</div>
                  <div className="mt-0.5 space-y-0.5 font-cabinet font-extrabold text-[#2563EB]" data-testid={`link-prices-${l.id}`}>
                    <div className="text-base">
                      {l.amount_type === 'free'
                        ? `${Number(l.min_amount || 0).toLocaleString()} – ${Number(l.max_amount || 0).toLocaleString()}`
                        : Number(l.amount || 0).toLocaleString()}
                      <span className="ml-1 text-xs text-slate-500">FCFA</span>
                    </div>
                    <div className="text-sm">
                      {l.amount_type === 'free'
                        ? `${Number(l.crypto_min_amount ?? l.min_amount ?? 0).toLocaleString(undefined, { maximumFractionDigits: 6 })} – ${Number(l.crypto_max_amount ?? l.max_amount ?? 0).toLocaleString(undefined, { maximumFractionDigits: 6 })}`
                        : Number(l.crypto_amount ?? l.amount ?? 0).toLocaleString(undefined, { maximumFractionDigits: 6 })}
                      <span className="ml-1 text-xs text-slate-500">USDT</span>
                    </div>
                  </div>
                </div>
                <div className="shrink-0"><StatusBadge s={st} /></div>
              </div>
              {l.description && <p className="mt-2 text-xs text-slate-500 line-clamp-2">{l.description}</p>}

              <div className="mt-3 flex min-w-0 items-center gap-2 p-2 bg-slate-50 rounded-lg">
                <div className="min-w-0 flex-1 truncate text-[10px] text-slate-500 font-mono">{publicUrl(l.slug)}</div>
                <button onClick={() => copy(l.slug)} data-testid={`btn-copy-link-${l.id}`} title="Copier" className="shrink-0 w-7 h-7 rounded-md bg-white hover:bg-blue-50 flex items-center justify-center text-slate-600 hover:text-[#2563EB]"><Copy className="w-3 h-3" /></button>
                <button onClick={() => setShowShare(l)} data-testid={`btn-share-link-${l.id}`} title="Partager" className="shrink-0 w-7 h-7 rounded-md bg-white hover:bg-blue-50 flex items-center justify-center text-slate-600 hover:text-[#2563EB]"><Share2 className="w-3 h-3" /></button>
                <button onClick={() => setShowQr(l)} data-testid={`btn-qr-link-${l.id}`} title="QR Code" className="shrink-0 w-7 h-7 rounded-md bg-white hover:bg-blue-50 flex items-center justify-center text-slate-600 hover:text-[#2563EB]"><QrCode className="w-3 h-3" /></button>
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-slate-500">
                <span className="min-w-0 break-words">{l.payments_received} paiements · {(l.total_received || 0).toLocaleString()} {l.currency} reçus</span>
                <span className="shrink-0 text-slate-400">{new Date(l.created_at).toLocaleDateString()}</span>
              </div>
              <div className="mt-3 pt-3 border-t border-slate-50 flex flex-wrap items-center gap-x-3 gap-y-2 text-[11px]">
                <button onClick={() => setShowDetails(l)} data-testid={`btn-details-${l.id}`} className="inline-flex shrink-0 items-center gap-1 font-semibold text-slate-700 hover:text-[#2563EB]"><Eye className="w-3 h-3" /> Détails</button>
                <button onClick={() => { setEditing(l); setShowForm(true); }} data-testid={`btn-edit-${l.id}`} className="inline-flex shrink-0 items-center gap-1 font-semibold text-slate-700 hover:text-[#2563EB]"><Pencil className="w-3 h-3" /> Modifier</button>
                <button onClick={() => toggle(l)} data-testid={`btn-toggle-${l.id}`} className="inline-flex shrink-0 items-center gap-1 font-semibold text-slate-700 hover:text-[#2563EB]"><Power className="w-3 h-3" /> {l.active ? 'Désactiver' : 'Réactiver'}</button>
                <button onClick={() => remove(l.id)} data-testid={`btn-delete-${l.id}`} className="inline-flex shrink-0 items-center gap-1 font-semibold text-red-600 hover:text-red-700 sm:ml-auto"><Trash2 className="w-3 h-3" /> Supprimer</button>
              </div>
            </div>
          );
        })}
      </div>

      {showCompliance && <ComplianceWarningModal onConfirm={confirmLinkCreation} onCancel={() => setShowCompliance(false)} />}
      {showForm && <LinkForm initial={editing} onClose={() => { setShowForm(false); setEditing(null); }} onSaved={() => { setShowForm(false); setEditing(null); load(); }} />}
      {showQr && <QrModal link={showQr} url={publicUrl(showQr.slug)} onClose={() => setShowQr(null)} />}
      {showShare && <ShareModal url={publicUrl(showShare.slug)} title={showShare.title} onClose={() => setShowShare(null)} />}
      {showDetails && <DetailsModal link={showDetails} url={publicUrl(showDetails.slug)} onClose={() => setShowDetails(null)} />}
    </div>
  );
}

function StatusBadge({ s }) {
  const m = { active: { c: 'bg-emerald-50 text-emerald-700', l: 'Actif' }, disabled: { c: 'bg-slate-100 text-slate-600', l: 'Désactivé' }, expired: { c: 'bg-red-50 text-red-700', l: 'Expiré' } }[s];
  return <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full ${m.c}`}>{m.l}</span>;
}

// -------- Form (create + edit) --------
function LinkForm({ initial, onClose, onSaved }) {
  const isEdit = !!initial;
  const [form, setForm] = useState({
    title: initial?.title || '',
    description: initial?.description || '',
    logo: initial?.logo || '',
    amount_type: initial?.amount_type || 'fixed',
    amount: initial?.amount || '',
    crypto_amount: initial?.crypto_amount ?? initial?.amount ?? '',
    min_amount: initial?.min_amount || '',
    max_amount: initial?.max_amount || '',
    crypto_min_amount: initial?.crypto_min_amount ?? initial?.min_amount ?? '',
    crypto_max_amount: initial?.crypto_max_amount ?? initial?.max_amount ?? '',
    currency: initial?.currency || 'UNIVERSAL',
    fee_bearer: initial?.fee_bearer || 'customer',
  });
  const [pending, setPending] = useState(false);

  const previewAmount = form.amount_type === 'fixed' ? parseFloat(form.amount) || 0 : parseFloat(form.max_amount) || 0;

  const saveLink = async (payload) => {
    setPending(true);
    try {
      if (isEdit) {
        await api.patch(`/links/${initial.id}`, payload);
        toast.success('Lien mis à jour');
      } else {
        await api.post('/links', payload);
        toast.success('Lien créé avec succès');
      }
      onSaved();
    } catch (err) { toast.error(err.response?.data?.detail || 'Erreur'); }
    finally { setPending(false); }
  };
  const submit = (e) => {
    e.preventDefault();
    const payload = {
      title: form.title,
      currency: form.currency,
      description: form.description,
      logo: form.logo || null,
      amount_type: form.amount_type,
      amount: form.amount_type === 'fixed' ? parseFloat(form.amount) : 0,
      crypto_amount: form.amount_type === 'fixed' ? parseFloat(form.crypto_amount) : null,
      min_amount: form.amount_type === 'free' ? parseFloat(form.min_amount) : null,
      max_amount: form.amount_type === 'free' ? parseFloat(form.max_amount) : null,
      crypto_min_amount: form.amount_type === 'free' ? parseFloat(form.crypto_min_amount) : null,
      crypto_max_amount: form.amount_type === 'free' ? parseFloat(form.crypto_max_amount) : null,
      fee_bearer: form.fee_bearer,
    };
    saveLink(payload);
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl p-6 max-w-2xl w-full my-8 shadow-2xl" data-testid="link-form-modal">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="w-8 h-8 rounded-lg hover:bg-slate-100 flex items-center justify-center"><ArrowLeft className="w-4 h-4" /></button>
            <h2 className="font-cabinet text-lg font-extrabold">{isEdit ? 'Modifier le lien' : 'Créer un lien de paiement'}</h2>
          </div>
          <button type="button" onClick={onClose} data-testid="btn-close-form" className="w-8 h-8 rounded-lg hover:bg-slate-100 flex items-center justify-center"><X className="w-4 h-4" /></button>
        </div>

        {/* Informations générales */}
        <Section title={LINK_COPY.general}>
          <div className="grid sm:grid-cols-[auto_1fr] gap-4">
            <LogoUploader value={form.logo} onChange={(logo) => setForm((current) => ({ ...current, logo }))} />
            <div className="space-y-3">
              <div>
                <FormLabel>{LINK_COPY.title}</FormLabel>
                <input data-testid="link-title" required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Ex: Facture #001, Formation Web, T-shirt collector…" className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm" />
              </div>
              <div>
                <FormLabel>{LINK_COPY.description}</FormLabel>
                <textarea data-testid="link-desc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} placeholder="Décrivez brièvement le produit ou le service…" className="w-full px-3 py-2 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm resize-none" />
              </div>
            </div>
          </div>
        </Section>

        {/* Montant */}
        <Section title={LINK_COPY.amountConfig}>
          <div className="grid grid-cols-2 gap-2 mb-3">
            {[
              { v: 'fixed', l: LINK_COPY.fixed, d: LINK_COPY.fixedDescription },
              { v: 'free', l: LINK_COPY.free, d: LINK_COPY.freeDescription },
            ].map((o) => (
              <button key={o.v} type="button" onClick={() => setForm({ ...form, amount_type: o.v })} data-testid={`amount-type-${o.v}`} className={`p-3 rounded-xl border-2 text-left transition-colors ${form.amount_type === o.v ? 'border-[#2563EB] bg-blue-50/60' : 'border-slate-200 hover:border-slate-300'}`}>
                <div className="font-cabinet font-bold text-xs text-slate-900">{o.l}</div>
                <div className="text-[10px] text-slate-500 mt-0.5">{o.d}</div>
              </button>
            ))}
          </div>

          {form.amount_type === 'fixed' ? (
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <FormLabel>Montant fixe (FCFA)</FormLabel>
                <input data-testid="link-amount" type="number" required min="0.01" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="5000" className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm" />
              </div>
              <div>
                <FormLabel>Montant fixe (USDT)</FormLabel>
                <input data-testid="link-crypto-amount" type="number" required min="0.000001" step="0.000001" value={form.crypto_amount} onChange={(e) => setForm({ ...form, crypto_amount: e.target.value })} placeholder="8.50" className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm" />
              </div>
            </div>
          ) : (
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="rounded-xl border border-slate-200 p-3">
                <div className="mb-2 text-xs font-bold text-slate-700">Franc CFA</div>
                <div className="space-y-2">
                  <div>
                    <FormLabel>{LINK_COPY.minimum}</FormLabel>
                    <input data-testid="link-min" type="number" required min="0.01" step="0.01" value={form.min_amount} onChange={(e) => setForm({ ...form, min_amount: e.target.value })} placeholder="500" className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm" />
                  </div>
                  <div>
                    <FormLabel>{LINK_COPY.maximum}</FormLabel>
                    <input data-testid="link-max" type="number" required min="0.01" step="0.01" value={form.max_amount} onChange={(e) => setForm({ ...form, max_amount: e.target.value })} placeholder="50000" className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm" />
                  </div>
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 p-3">
                <div className="mb-2 text-xs font-bold text-slate-700">USDT</div>
                <div className="space-y-2">
                  <div>
                    <FormLabel>Montant minimum</FormLabel>
                    <input data-testid="link-crypto-min" type="number" required min="0.000001" step="0.000001" value={form.crypto_min_amount} onChange={(e) => setForm({ ...form, crypto_min_amount: e.target.value })} placeholder="1" className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm" />
                  </div>
                  <div>
                    <FormLabel>Montant maximum</FormLabel>
                    <input data-testid="link-crypto-max" type="number" required min="0.000001" step="0.000001" value={form.crypto_max_amount} onChange={(e) => setForm({ ...form, crypto_max_amount: e.target.value })} placeholder="100" className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm" />
                  </div>
                </div>
              </div>
            </div>
          )}
          <div className="mt-2 p-2.5 bg-blue-50 border border-blue-100 rounded-lg text-[10px] sm:text-[11px] text-blue-800 flex items-start gap-1.5">
            <Info className="w-3 h-3 mt-0.5 shrink-0" />
            <span>Définissez séparément le prix en <b>FCFA</b> et en <b>USDT</b>. Le client verra le montant correspondant au moyen de paiement choisi.</span>
          </div>
        </Section>

        {/* Fees */}
        <Section title={LINK_COPY.fees}>
          <div className="grid grid-cols-2 gap-2">
            {[
              { v: 'customer', l: 'Le client paie', d: 'Les frais s\'ajoutent au montant du client' },
              { v: 'owner', l: 'Vous prenez en charge', d: 'Les frais sont déduits de votre part' },
            ].map((o) => (
              <button key={o.v} type="button" onClick={() => setForm({ ...form, fee_bearer: o.v })} data-testid={`fee-bearer-${o.v}`} className={`p-3 rounded-xl border-2 text-left transition-colors ${form.fee_bearer === o.v ? 'border-[#2563EB] bg-blue-50/60' : 'border-slate-200'}`}>
                <div className="font-cabinet font-bold text-xs text-slate-900">{o.l}</div>
                <div className="text-[10px] text-slate-500 mt-0.5">{o.d}</div>
              </button>
            ))}
          </div>
          {previewAmount > 0 && (
            <div className="mt-3 p-3 bg-slate-50 rounded-xl text-xs text-slate-600 flex items-start gap-2" data-testid="fee-preview">
              <Info className="w-3.5 h-3.5 text-[#2563EB] mt-0.5 shrink-0" />
              <span>
                Les frais sont <b>calculés automatiquement</b> selon le moyen de paiement que votre client choisira (Mobile Money ou Crypto), en fonction des taux configurés dans l&apos;Admin Panel.
                {form.fee_bearer === 'customer'
                  ? <> Le client paiera <b>le montant + les frais</b> dans la devise qu&apos;il aura choisie.</>
                  : <> Les frais seront <b>déduits du montant</b> que vous recevrez.</>}
              </span>
            </div>
          )}
        </Section>

        <button type="submit" disabled={pending} data-testid="btn-generate-link" className="mt-4 w-full bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold py-3 rounded-xl disabled:opacity-60">
          {pending ? '…' : isEdit ? 'Enregistrer les modifications' : 'Créer le lien de paiement'}
        </button>
      </form>
    </div>
  );
}

function FormLabel({ children }) {
  return <label className="text-xs font-semibold text-slate-700 mb-1.5 block text-center">{children}</label>;
}

function LogoUploader({ value, onChange }) {
  const fileRef = useRef();

  const onFile = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      toast.error('Format non supporté (JPG, PNG, WebP uniquement)');
      return;
    }
    if (file.size > 1_500_000) {
      toast.error('Image trop grande (max 1.5 Mo)');
      return;
    }
    const reader = new FileReader();
    reader.onload = (result) => onChange(result.target.result);
    reader.readAsDataURL(file);
  };

  return (
    <div className="text-center">
      <FormLabel>{LINK_COPY.logo}</FormLabel>
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        className="relative mx-auto block w-24 h-24 rounded-xl border-2 border-dashed border-slate-200 hover:border-[#2563EB] cursor-pointer overflow-hidden group"
        data-testid="logo-uploader"
      >
        {value ? (
          <SafeImage
            src={value}
            alt="Aperçu du logo"
            className="w-full h-full object-contain bg-white p-1"
            fallback={(
              <span className="w-full h-full flex flex-col items-center justify-center bg-blue-50 text-[#2563EB]">
                <Link2 className="w-5 h-5" />
                <span className="mt-1 text-[10px]">Image invalide</span>
              </span>
            )}
            data-testid="logo-preview"
          />
        ) : (
          <span className="w-full h-full flex flex-col items-center justify-center text-slate-400">
            <Upload className="w-5 h-5" />
            <span className="text-[10px] mt-1">Téléverser</span>
          </span>
        )}
        {value && <span className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 flex items-center justify-center text-white text-[10px] font-semibold transition-opacity">Modifier</span>}
      </button>
      {value && <button type="button" onClick={() => onChange('')} className="mt-2 text-[10px] text-red-500 font-semibold">Retirer</button>}
      <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={onFile} className="hidden" data-testid="logo-input" />
    </div>
  );
}

function Section({ title, children, testId }) {
  return (
    <div className="mt-4" data-testid={testId}>
      <div className="text-center text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">{title}</div>
      {children}
    </div>
  );
}

function DetailsModal({ link, url, onClose }) {
  const currency = link.currency === 'UNIVERSAL' ? 'Devise au choix' : link.currency;
  const cfaAmount = link.amount_type === 'free'
    ? `${Number(link.min_amount || 0).toLocaleString()} – ${Number(link.max_amount || 0).toLocaleString()}`
    : Number(link.amount || 0).toLocaleString();
  const usdtAmount = link.amount_type === 'free'
    ? `${Number(link.crypto_min_amount ?? link.min_amount ?? 0).toLocaleString(undefined, { maximumFractionDigits: 6 })} – ${Number(link.crypto_max_amount ?? link.max_amount ?? 0).toLocaleString(undefined, { maximumFractionDigits: 6 })}`
    : Number(link.crypto_amount ?? link.amount ?? 0).toLocaleString(undefined, { maximumFractionDigits: 6 });

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl p-6 max-w-md w-full shadow-2xl" data-testid="link-details-modal">
        <div className="flex items-start gap-3">
          <LinkLogo src={link.logo} size="md" />
          <div className="min-w-0 flex-1">
            <h3 className="font-cabinet font-bold text-base text-slate-900">{link.title}</h3>
            <p className="text-xs text-slate-500 mt-0.5">{link.description || 'Aucune description'}</p>
          </div>
          <button type="button" onClick={onClose} className="w-8 h-8 rounded-lg hover:bg-slate-100 flex items-center justify-center"><X className="w-4 h-4" /></button>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-2 text-xs">
          <Detail label="Montant Mobile Money" value={`${cfaAmount} FCFA`} />
          <Detail label="Montant crypto" value={`${usdtAmount} USDT`} />
          <Detail label="Frais" value={link.fee_bearer === 'owner' ? 'Pris en charge par vous' : 'Payés par le client'} />
          <Detail label="Paiements reçus" value={`${link.payments_received || 0}`} />
          <Detail label="Total reçu" value={`${(link.total_received || 0).toLocaleString()} ${currency}`} />
          <Detail label="Statut" value={link.active ? 'Actif' : 'Désactivé'} />
        </div>
        <div className="mt-4 p-2.5 bg-slate-50 rounded-lg text-[10px] font-mono text-slate-600 break-all">{url}</div>
        <button type="button" onClick={onClose} className="mt-4 w-full bg-[#2563EB] text-white font-bold py-2.5 rounded-xl text-xs">Fermer</button>
      </div>
    </div>
  );
}

function Detail({ label, value }) {
  return <div className="p-2.5 bg-slate-50 rounded-lg"><div className="text-[10px] text-slate-400">{label}</div><div className="mt-0.5 font-semibold text-slate-700">{value}</div></div>;
}

// -------- QR Modal --------
function QrModal({ link, url, onClose }) {
  const canvasRef = useRef();
  const download = () => {
    const canvas = canvasRef.current?.querySelector('canvas');
    if (!canvas) return;
    const a = document.createElement('a');
    a.download = `qrcode-${link.slug}.png`;
    a.href = canvas.toDataURL();
    a.click();
  };
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl p-6 max-w-sm w-full" data-testid="qr-modal">
        <h3 className="font-cabinet font-bold text-base mb-1">{link.title}</h3>
        <p className="text-xs text-slate-500 mb-4">Scannez ce QR code pour ouvrir le lien.</p>
        <div ref={canvasRef} className="flex justify-center p-4 bg-white border border-slate-200 rounded-xl">
          <QRCodeCanvas value={url} size={220} level="H" includeMargin />
        </div>
        <div className="mt-3 p-2 bg-slate-50 rounded-lg text-[10px] font-mono text-slate-600 break-all text-center">{url}</div>
        <button onClick={download} data-testid="btn-download-qr" className="mt-4 w-full bg-[#2563EB] text-white font-bold py-2.5 rounded-full text-xs">Télécharger le QR Code</button>
      </div>
    </div>
  );
}

// -------- Share Modal --------
function ShareModal({ url, title, onClose }) {
  const encoded = encodeURIComponent(url);
  const text = encodeURIComponent(`${title} — ${url}`);
  const opts = [
    { l: 'WhatsApp', h: `https://wa.me/?text=${text}`, c: 'bg-emerald-500', I: MessageCircle },
    { l: 'Telegram', h: `https://t.me/share/url?url=${encoded}&text=${encodeURIComponent(title)}`, c: 'bg-blue-500', I: Send },
    { l: 'SMS', h: `sms:?body=${text}`, c: 'bg-violet-500', I: MessageCircle },
    { l: 'Email', h: `mailto:?subject=${encodeURIComponent(title)}&body=${text}`, c: 'bg-red-500', I: Mail },
  ];
  const [copied, setCopied] = useState(false);
  const doCopy = () => { navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl p-6 max-w-sm w-full" data-testid="share-modal">
        <h3 className="font-cabinet font-bold text-base mb-3">Partager le lien</h3>
        <div className="grid grid-cols-4 gap-3">
          {opts.map((o) => (
            <a key={o.l} href={o.h} target="_blank" rel="noreferrer" data-testid={`share-${o.l.toLowerCase()}`} className="flex flex-col items-center gap-1.5">
              <div className={`w-12 h-12 rounded-full ${o.c} text-white flex items-center justify-center shadow-lg hover:scale-105 transition-transform`}><o.I className="w-5 h-5" /></div>
              <span className="text-[10px] font-semibold text-slate-700">{o.l}</span>
            </a>
          ))}
        </div>
        <div className="mt-4 p-2 bg-slate-50 rounded-lg flex items-center gap-2">
          <div className="flex-1 text-[10px] font-mono text-slate-600 break-all">{url}</div>
          <button onClick={doCopy} data-testid="share-copy" className={`px-3 py-1.5 rounded-md text-[10px] font-bold ${copied ? 'bg-emerald-500 text-white' : 'bg-[#2563EB] text-white'}`}>
            {copied ? <><CheckCircle2 className="w-3 h-3 inline" /> Copié</> : 'Copier'}
          </button>
        </div>
      </div>
    </div>
  );
}
