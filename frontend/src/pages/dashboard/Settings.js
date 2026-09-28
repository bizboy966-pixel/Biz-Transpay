import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Save, Lock, Globe, Shield } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';
import { useAuth } from '@/context/AuthContext';
import i18n from '@/i18n';
import { enableBrowserPush, disableBrowserPush, currentPushToken } from '@/lib/pushNotifications';

export default function Settings({ embedded = false }) {
  const { t } = useTranslation();
  const { user, refresh } = useAuth();
  const [profile, setProfile] = useState({
    language: user?.language || 'fr',
    default_currency: user?.default_currency || 'XOF',
  });
  const [pwd, setPwd] = useState({ current_password: '', new_password: '', otp: '' });
  const [mfaSetup, setMfaSetup] = useState(null);
  const [mfaCode, setMfaCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState([]);
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';
  const [pushEnabled, setPushEnabled] = useState(Boolean(currentPushToken()));
  const [pushConfigured, setPushConfigured] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);

  useEffect(() => {
    let active = true;
    api.get('/push/config')
      .then(({ data }) => { if (active) setPushConfigured(Boolean(data.configured)); })
      .catch(() => { if (active) setPushConfigured(false); });
    return () => { active = false; };
  }, []);

  const togglePush = async () => {
    setPushBusy(true);
    try {
      if (pushEnabled) await disableBrowserPush();
      else await enableBrowserPush();
      setPushEnabled(!pushEnabled);
      toast.success(!pushEnabled ? 'Notifications push activées' : 'Notifications push désactivées');
    } catch (err) { toast.error(err.message || 'Impossible de modifier les notifications push'); }
    finally { setPushBusy(false); }
  };

  const saveProfile = async () => {
    await api.patch('/settings/profile', {
      language: profile.language,
      default_currency: profile.default_currency,
    });
    if (profile.language !== i18n.language) { i18n.changeLanguage(profile.language); localStorage.setItem('btp_lang', profile.language); }
    toast.success(t('settings.saved'));
    refresh();
  };

  const savePwd = async () => {
    try {
      await api.post('/settings/password', pwd);
      toast.success('Mot de passe modifié');
      setPwd({ current_password: '', new_password: '', otp: '' });
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
        {isAdmin && user?.two_fa_enabled && <Input label="Code 2FA" value={pwd.otp} onChange={(v) => setPwd({ ...pwd, otp: v.replace(/\D/g, '') })} tid="set-password-otp" />}
        <button onClick={savePwd} data-testid="btn-change-pwd" className="inline-flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white font-bold px-6 py-3 rounded-full"><Lock className="w-4 h-4" /> {t('settings.change_pwd')}</button>

        {isAdmin && <div className="mt-4 p-4 bg-slate-50 rounded-xl">
          <div className="flex items-center gap-3">
            <Shield className="w-5 h-5 text-[#2563EB]" />
            <div className="flex-1">
              <div className="font-semibold text-slate-800">{t('settings.two_fa')}</div>
              <div className="text-xs text-slate-500">{user?.two_fa_enabled ? 'Activée : les codes sont demandés à chaque connexion.' : 'Ajoutez une protection supplémentaire à votre compte.'}</div>
            </div>
            {!user?.two_fa_enabled && <button type="button" onClick={async () => {
              try { const { data } = await api.post('/auth/2fa/setup'); setMfaSetup(data); }
              catch (err) { toast.error(err.response?.data?.detail || 'Configuration 2FA impossible'); }
            }} className="px-4 py-2 rounded-full bg-[#2563EB] text-white text-sm font-bold">Activer</button>}
          </div>
          {mfaSetup && !user?.two_fa_enabled && <div className="mt-4 space-y-3">
            <p className="text-xs text-slate-600">Saisissez cette clé dans votre application d’authentification :</p>
            <div className="font-mono text-xs bg-white rounded-lg p-3 break-all select-all">{mfaSetup.secret}</div>
            <div className="flex gap-2">
              <input value={mfaCode} onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))} maxLength={6} inputMode="numeric" placeholder="Code à 6 chiffres" className="flex-1 px-3 py-2 rounded-lg border border-slate-200" />
              <button type="button" disabled={mfaCode.length !== 6} onClick={async () => {
                try {
                  const { data } = await api.post('/auth/2fa/confirm', { code: mfaCode });
                  setRecoveryCodes(data.recovery_codes || []);
                  setMfaSetup(null);
                  setMfaCode('');
                  await refresh();
                  toast.success('Double authentification activée');
                } catch (err) { toast.error(err.response?.data?.detail || 'Code 2FA invalide'); }
              }} className="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-bold">Confirmer</button>
            </div>
          </div>}
          {recoveryCodes.length > 0 && <div className="mt-3 p-3 bg-white rounded-lg">
            <p className="text-xs text-slate-600 mb-2">Conservez vos codes de récupération :</p>
            <div className="grid grid-cols-2 gap-1 font-mono text-xs">{recoveryCodes.map((code) => <span key={code}>{code}</span>)}</div>
          </div>}
        </div>}
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
      <Section icon={Shield} title="Notifications navigateur">
        <div className="flex flex-col sm:flex-row sm:items-center gap-4 justify-between">
          <div>
            <p className="font-semibold text-slate-800">Recevoir les notifications push</p>
            <p className="text-sm text-slate-500 mt-1">
              {pushConfigured
                ? 'Seuls les navigateurs ayant activé les notifications push reçoivent les messages.'
                : 'Le service sera disponible après la configuration Firebase.'}
            </p>
          </div>
          <button type="button" onClick={togglePush} disabled={pushBusy || (!pushEnabled && !pushConfigured)} aria-pressed={pushEnabled} data-testid="toggle-push"
            className={`px-5 py-2.5 rounded-full font-bold text-sm ${pushEnabled ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-700'} disabled:opacity-50`}>
            {pushBusy ? 'Patientez…' : pushEnabled ? 'Activées' : 'Activer'}
          </button>
        </div>
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
