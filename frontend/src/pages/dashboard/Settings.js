import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Save, Lock, Globe, Shield } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';
import { useAuth } from '@/context/AuthContext';
import i18n from '@/i18n';

export default function Settings({ embedded = false }) {
  const { t } = useTranslation();
  const { user, refresh } = useAuth();
  const [profile, setProfile] = useState({
    language: user?.language || 'fr',
    default_currency: user?.default_currency || 'XOF',
    two_fa_enabled: user?.two_fa_enabled || false,
  });
  const [pwd, setPwd] = useState({ current_password: '', new_password: '' });

  const saveProfile = async () => {
    await api.patch('/settings/profile', {
      language: profile.language,
      default_currency: profile.default_currency,
      two_fa_enabled: profile.two_fa_enabled,
    });
    if (profile.language !== i18n.language) { i18n.changeLanguage(profile.language); localStorage.setItem('btp_lang', profile.language); }
    toast.success(t('settings.saved'));
    refresh();
  };

  const savePwd = async () => {
    try {
      await api.post('/settings/password', pwd);
      toast.success('Mot de passe modifié');
      setPwd({ current_password: '', new_password: '' });
    } catch (err) { toast.error(err.response?.data?.detail || 'Erreur'); }
  };

  return (
    <div className="space-y-6" data-testid="page-settings">
      <div className={embedded ? 'pt-1' : ''}>
        <h2 className={`font-cabinet font-extrabold tracking-tighter text-slate-900 ${embedded ? 'text-xl' : 'text-3xl'}`}>{t('settings.title')}</h2>
        {embedded && <p className="text-slate-500 text-xs mt-1">Sécurité et préférences de votre espace.</p>}
      </div>

      <Section icon={Lock} title={t('settings.security_t')}>
        <Input label={t('settings.current_pwd')} type="password" value={pwd.current_password} onChange={(v) => setPwd({ ...pwd, current_password: v })} tid="set-current-pwd" />
        <Input label={t('settings.new_pwd')} type="password" value={pwd.new_password} onChange={(v) => setPwd({ ...pwd, new_password: v })} tid="set-new-pwd" />
        <button onClick={savePwd} data-testid="btn-change-pwd" className="inline-flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white font-bold px-6 py-3 rounded-full"><Lock className="w-4 h-4" /> {t('settings.change_pwd')}</button>

        <label className="mt-4 flex items-center gap-3 p-4 bg-slate-50 rounded-xl cursor-pointer">
          <input type="checkbox" data-testid="set-2fa" checked={profile.two_fa_enabled} onChange={(e) => setProfile({ ...profile, two_fa_enabled: e.target.checked })} className="w-5 h-5 accent-[#2563EB]" />
          <Shield className="w-5 h-5 text-[#2563EB]" />
          <span className="font-semibold text-slate-800">{t('settings.two_fa')}</span>
        </label>
      </Section>

      <Section icon={Globe} title={t('settings.preferences')}>
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="text-sm font-semibold text-slate-700 mb-2 block">{t('settings.language')}</label>
            <select value={profile.language} onChange={(e) => setProfile({ ...profile, language: e.target.value })} data-testid="set-lang" className="w-full px-4 py-3.5 border border-slate-200 rounded-xl font-semibold">
              <option value="fr">Français</option><option value="en">English</option>
            </select>
          </div>
          <div>
            <label className="text-sm font-semibold text-slate-700 mb-2 block">{t('settings.default_currency')}</label>
            <select value={profile.default_currency} onChange={(e) => setProfile({ ...profile, default_currency: e.target.value })} data-testid="set-currency" className="w-full px-4 py-3.5 border border-slate-200 rounded-xl font-semibold">
              <option value="XOF">XOF</option><option value="XAF">XAF</option>
            </select>
          </div>
        </div>
        <button onClick={saveProfile} data-testid="btn-save-prefs" className="inline-flex items-center gap-2 bg-[#2563EB] text-white font-bold px-6 py-3 rounded-full"><Save className="w-4 h-4" /> {t('settings.save')}</button>
      </Section>
    </div>
  );
}

function Section({ icon: I, title, children }) {
  return (
    <div className="bg-white border border-slate-100 rounded-[24px] p-6 sm:p-8">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-11 h-11 rounded-xl bg-blue-50 text-[#2563EB] flex items-center justify-center"><I className="w-5 h-5" /></div>
        <h2 className="font-cabinet font-bold text-xl text-slate-900">{title}</h2>
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function Input({ label, value, onChange, type = 'text', tid }) {
  return (
    <div>
      <label className="text-sm font-semibold text-slate-700 mb-2 block">{label}</label>
      <input data-testid={tid} type={type} value={value} onChange={(e) => onChange(e.target.value)} className="w-full px-4 py-3.5 border border-slate-200 rounded-xl focus:border-[#2563EB] focus:ring-2 focus:ring-blue-100 outline-none" />
    </div>
  );
}
