import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BadgeCheck, BriefcaseBusiness, Copy, Globe2, ImagePlus, Mail, Phone, Share2, ShieldCheck, Trash2, UserRound, Users, WalletCards } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';
import { useAuth } from '@/context/AuthContext';
import { COUNTRIES } from '@/constants/countries';
import { SafeImage } from '@/components/SafeImage';
import Settings from './Settings';

export default function Profile() {
  const { user, refresh } = useAuth();
  const { hash } = useLocation();
  const referralSectionRef = useRef(null);
  useEffect(() => {
    if (hash === '#referral') {
      referralSectionRef.current?.scrollIntoView({ block: 'start' });
    }
  }, [hash]);
  const fileRef = useRef(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const {
    data: referral,
    isPending: referralLoading,
    isError: referralError,
    refetch: loadReferral,
  } = useQuery({
    queryKey: ['referral', 'me', user?.id],
    queryFn: async () => {
      const { data } = await api.get('/referrals/me');
      return data;
    },
    staleTime: 10_000,
    retry: false,
  });
  const country = COUNTRIES.find((c) => c.code === user?.country);
  const kycVerified = user?.kyc_status === 'verified';

  const referralLink = referral?.code
    ? `${window.location.origin}/register?ref=${encodeURIComponent(referral.code)}`
    : '';
  const copyReferralLink = async () => {
    if (!referralLink) return;
    try {
      await navigator.clipboard.writeText(referralLink);
      toast.success('Lien de parrainage copié.');
    } catch {
      toast.error('Impossible de copier le lien. Sélectionnez-le pour le copier manuellement.');
    }
  };
  const shareReferralLink = async () => {
    if (!referralLink) return;
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Mon lien de parrainage Biz-transPay',
          text: 'Inscrivez-vous sur Biz-transPay avec mon lien de parrainage.',
          url: referralLink,
        });
      } catch (error) {
        if (error.name !== 'AbortError') toast.error('Le partage a échoué.');
      }
      return;
    }
    await copyReferralLink();
  };

  return (
    <div className="max-w-3xl mx-auto space-y-5" data-testid="page-profile">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="font-cabinet text-2xl sm:text-3xl font-extrabold tracking-tighter text-slate-900">Profil</h1>
          <p className="text-slate-500 text-xs sm:text-sm mt-1">Vos informations personnelles et votre statut de compte.</p>
        </div>
      </div>

      <div className="bg-white border border-slate-100 rounded-2xl p-5 sm:p-6 shadow-[0_4px_20px_rgba(15,23,42,0.04)]">
        <div className="flex items-center gap-4 pb-5 border-b border-slate-100">
          <div className="relative shrink-0">
            <SafeImage
              src={user?.avatar_url}
              alt={`Photo de ${user?.full_name || 'profil'}`}
              className="h-14 w-14 rounded-2xl border border-slate-100 object-cover"
              fallback={(
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-[#3B82F6] to-[#1D4ED8] text-xl font-extrabold text-white">
                  {initials(user?.full_name)}
                </div>
              )}
            />
            <button type="button" onClick={() => fileRef.current?.click()} disabled={avatarBusy} title="Importer une photo"
              className="absolute -right-2 -bottom-2 w-7 h-7 rounded-full bg-[#2563EB] text-white flex items-center justify-center border-2 border-white shadow-sm disabled:opacity-50" data-testid="btn-upload-avatar">
              <ImagePlus className="w-3.5 h-3.5" />
            </button>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" data-testid="input-avatar"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (!file) return;
                if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
                  toast.error('Choisissez une image PNG, JPG ou WebP.');
                  return;
                }
                if (file.size > 2 * 1024 * 1024) {
                  toast.error('La photo ne doit pas dépasser 2 Mo.');
                  return;
                }
                setAvatarBusy(true);
                const reader = new FileReader();
                reader.onload = async () => {
                  try {
                    await api.patch('/settings/profile', { avatar_url: reader.result });
                    await refresh();
                    toast.success('Photo de profil mise à jour.');
                  } catch (err) {
                    toast.error(err.response?.data?.detail || 'Impossible de mettre à jour la photo.');
                  } finally {
                    setAvatarBusy(false);
                  }
                };
                reader.onerror = () => {
                  setAvatarBusy(false);
                  toast.error('Impossible de lire cette image.');
                };
                reader.readAsDataURL(file);
              }}
            />
          </div>
          <div className="min-w-0">
            <h2 className="font-cabinet font-extrabold text-lg text-slate-900 truncate">{user?.full_name || '—'}</h2>
            <p className="text-sm text-slate-500">@{user?.username || '—'}</p>
          </div>
          <div className={`ml-auto shrink-0 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold ${kycVerified ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
            <ShieldCheck className="w-3.5 h-3.5" /> {kycVerified ? 'Vérifié' : 'KYC à compléter'}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 pt-3">
          <button type="button" onClick={() => fileRef.current?.click()} disabled={avatarBusy}
            className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 px-3 py-1.5 text-[11px] font-bold text-slate-700 hover:border-blue-200 hover:text-[#2563EB] disabled:opacity-50" data-testid="btn-change-avatar">
            <ImagePlus className="w-3.5 h-3.5" /> {avatarBusy ? 'Enregistrement…' : 'Importer une photo'}
          </button>
          {user?.avatar_url && (
            <button type="button" disabled={avatarBusy} onClick={async () => {
              setAvatarBusy(true);
              try {
                await api.patch('/settings/profile', { avatar_url: '' });
                await refresh();
                toast.success('Photo de profil supprimée.');
              } catch (err) {
                toast.error(err.response?.data?.detail || 'Impossible de supprimer la photo.');
              } finally {
                setAvatarBusy(false);
              }
            }} className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold text-red-600 hover:bg-red-50 disabled:opacity-50" data-testid="btn-remove-avatar">
              <Trash2 className="w-3.5 h-3.5" /> Supprimer la photo
            </button>
          )}
          <span className="text-[10px] text-slate-400">PNG, JPG ou WebP · 2 Mo maximum</span>
        </div>

        <div className="grid sm:grid-cols-2 gap-3 pt-5">
          <Info icon={UserRound} label="Nom complet" value={user?.full_name} />
          <Info icon={Mail} label="Adresse e-mail" value={user?.email} />
          <Info icon={Phone} label="Téléphone" value={user?.phone} />
          <Info icon={Globe2} label="Pays" value={country ? `${country.flag} ${country.name}` : user?.country} />
          <Info icon={BriefcaseBusiness} label="Type de compte" value={user?.account_type === 'merchant' ? 'Marchand' : 'Personnel'} />
          <Info icon={ShieldCheck} label="Statut KYC" value={kycVerified ? 'Vérifié' : 'Non vérifié'} />
        </div>
      </div>

      <section id="referral" ref={referralSectionRef} className="scroll-mt-24 overflow-hidden rounded-2xl border border-blue-100 bg-white shadow-[0_4px_20px_rgba(15,23,42,0.04)]" aria-labelledby="referral-title" data-testid="profile-referral">
        <div className="border-b border-blue-100 bg-blue-50/60 px-5 py-5 sm:px-6">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#2563EB] text-white">
              <Users className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <h2 id="referral-title" className="font-cabinet text-lg font-extrabold text-slate-900">Mon parrainage</h2>
              <p className="mt-1 text-sm text-slate-600">Suivez les inscriptions qualifiées et votre commission, en toute transparence.</p>
            </div>
          </div>
        </div>
        {referralLoading ? (
          <div className="space-y-3 p-5 sm:p-6" aria-label="Chargement du parrainage">
            <div className="h-4 w-40 animate-pulse rounded bg-slate-100" />
            <div className="h-12 animate-pulse rounded-xl bg-slate-100" />
            <div className="h-20 animate-pulse rounded-xl bg-slate-100" />
          </div>
        ) : referralError ? (
          <div className="p-5 sm:p-6" role="alert">
            <p className="text-sm font-semibold text-slate-800">Vos informations de parrainage ne sont pas disponibles.</p>
            <p className="mt-1 text-xs text-slate-500">Réessayez dans quelques instants.</p>
            <button type="button" onClick={() => loadReferral()} className="mt-3 rounded-full border border-slate-200 px-4 py-2 text-xs font-bold text-slate-700 hover:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-500">Réessayer</button>
          </div>
        ) : (
          <div className="space-y-5 p-5 sm:p-6">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <div className="min-w-0">
                <label htmlFor="referral-link" className="mb-1.5 block text-xs font-bold text-slate-600">Votre lien personnel</label>
                <input id="referral-link" readOnly value={referralLink} className="w-full min-w-0 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                <p className="mt-2 text-xs text-slate-500">Code personnel : <span className="font-mono font-bold text-slate-800">{referral?.code || '—'}</span></p>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={copyReferralLink} disabled={!referralLink} className="inline-flex min-h-10 flex-1 items-center justify-center gap-2 rounded-full bg-[#2563EB] px-4 py-2 text-xs font-bold text-white hover:bg-[#1D4ED8] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50">
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" /> Copier
                </button>
                <button type="button" onClick={shareReferralLink} disabled={!referralLink} className="inline-flex min-h-10 flex-1 items-center justify-center gap-2 rounded-full border border-slate-200 px-4 py-2 text-xs font-bold text-slate-700 hover:border-blue-300 hover:text-[#2563EB] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50">
                  <Share2 className="h-3.5 w-3.5" aria-hidden="true" /> Partager
                </button>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-slate-100 bg-slate-50/80 p-4">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500"><Users className="h-4 w-4 text-[#2563EB]" /> Inscriptions reçues</div>
                <p className="mt-2 font-cabinet text-2xl font-extrabold text-slate-900">{referral?.invited_count ?? 0}</p>
                <p className="mt-1 text-xs text-slate-500">Le détail des personnes invitées reste privé.</p>
              </div>
              <div className="rounded-xl border border-blue-100 bg-blue-50/50 p-4">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500"><BadgeCheck className="h-4 w-4 text-[#2563EB]" /> Inscriptions qualifiées</div>
                <p className="mt-2 font-cabinet text-2xl font-extrabold text-slate-900">{referral?.qualified_count ?? 0}<span className="ml-1 text-sm font-semibold text-slate-500">/ {referral?.required_count ?? 5}</span></p>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-blue-100" role="progressbar" aria-label="Progression des inscriptions qualifiées" aria-valuemin="0" aria-valuemax={referral?.required_count ?? 5} aria-valuenow={Math.min(referral?.qualified_count ?? 0, referral?.required_count ?? 5)}>
                  <div className="h-full rounded-full bg-[#2563EB] transition-[width]" style={{ width: `${Math.min(100, Math.max(0, ((referral?.qualified_count ?? 0) / Math.max(1, referral?.required_count ?? 5)) * 100))}%` }} />
                </div>
                <p className="mt-2 text-xs text-slate-600">{Math.max(0, (referral?.required_count ?? 5) - (referral?.qualified_count ?? 0))} inscription(s) qualifiée(s) avant le seuil.</p>
              </div>
            </div>

            <div className="flex items-start gap-3 rounded-xl border border-slate-100 p-4">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-700"><WalletCards className="h-4 w-4" /></div>
              <div className="min-w-0">
                <h3 className="text-sm font-bold text-slate-900">Commission unique</h3>
                {referral?.commission ? (
                  <>
                    <p className="mt-1 text-sm text-slate-700">
                      {formatAmount(referral.commission.amount, referral.commission.currency)}
                      {referral.commission.rate_percent != null && <span className="text-slate-500"> · {referral.commission.rate_percent}%</span>}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">Statut : {commissionStatus(referral.commission.status)}</p>
                  </>
                ) : (
                  <p className="mt-1 text-xs leading-relaxed text-slate-600">
                    {((referral?.qualified_count ?? 0) >= (referral?.required_count ?? 5))
                      ? 'Votre seuil est atteint. La commission est en attente de confirmation.'
                      : `Une seule commission sera attribuée après ${referral?.required_count ?? 5} inscriptions qualifiées. Progression : ${referral?.qualified_count ?? 0} sur ${referral?.required_count ?? 5}.`}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
      </section>

      <Settings embedded />
    </div>
  );
}

function Info({ icon: Icon, label, value }) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-slate-50 p-3">
      <div className="w-9 h-9 rounded-lg bg-white text-[#2563EB] flex items-center justify-center shrink-0">
        <Icon className="w-4 h-4" />
      </div>
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">{label}</div>
        <div className="mt-0.5 text-sm font-semibold text-slate-800 truncate">{value || '—'}</div>
      </div>
    </div>
  );
}

function initials(name = '') {
  return name.split(' ').filter(Boolean).map((part) => part[0]).slice(0, 2).join('').toUpperCase() || 'U';
}

function formatAmount(amount, currency) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return `${amount ?? '—'} ${currency || ''}`.trim();
  try {
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: currency || 'XOF', maximumFractionDigits: 2 }).format(numeric);
  } catch {
    return `${numeric.toLocaleString('fr-FR')} ${currency || ''}`.trim();
  }
}

function commissionStatus(status) {
  const labels = {
    pending: 'En attente',
    approved: 'Validée',
    paid: 'Payée',
    cancelled: 'Annulée',
    rejected: 'Refusée',
  };
  return labels[String(status || '').toLowerCase()] || status || 'En attente';
}