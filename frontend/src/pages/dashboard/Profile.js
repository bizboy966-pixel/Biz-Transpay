import { useRef, useState } from 'react';
import { BriefcaseBusiness, Globe2, ImagePlus, Mail, Phone, ShieldCheck, Trash2, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';
import { useAuth } from '@/context/AuthContext';
import { COUNTRIES } from '@/constants/countries';
import Settings from './Settings';

export default function Profile() {
  const { user, refresh } = useAuth();
  const fileRef = useRef(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const country = COUNTRIES.find((c) => c.code === user?.country);
  const kycVerified = user?.kyc_status === 'verified';

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
            {user?.avatar_url ? (
              <img src={user.avatar_url} alt={`Photo de ${user?.full_name || 'profil'}`} className="w-14 h-14 rounded-2xl object-cover border border-slate-100" />
            ) : (
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[#3B82F6] to-[#1D4ED8] text-white flex items-center justify-center font-cabinet font-extrabold text-xl">
                {initials(user?.full_name)}
              </div>
            )}
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