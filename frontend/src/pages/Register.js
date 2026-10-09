import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { User, AtSign, Globe, Phone, Mail, Lock, Eye, EyeOff, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';
import { Logo } from '@/components/Logo';
import { useAuth } from '@/context/AuthContext';
import { COUNTRIES } from '@/constants/countries';
import LanguageSwitcher from '@/components/LanguageSwitcher';
import TurnstileWidget, { useTurnstileConfig } from '@/components/TurnstileWidget';

export default function Register() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const location = useLocation();
  const { register, login } = useAuth();
  const turnstile = useTurnstileConfig();
  const turnstileRef = useRef(null);
  const [form, setForm] = useState({
    full_name: '', username: '', country: 'TG',
    phone: '', email: '', password: '', confirm: '',
    terms: false,
  });
  const [errors, setErrors] = useState({});
  const [showPwd, setShowPwd] = useState(false);
  const [showPwd2, setShowPwd2] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pinSetupToken, setPinSetupToken] = useState('');
  const [userPin, setUserPin] = useState('');
  const [userPinConfirmation, setUserPinConfirmation] = useState('');
  const referralCode = new URLSearchParams(location.search).get('ref')?.trim() || '';
  const [referral, setReferral] = useState({ status: 'idle', username: '' });

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const country = COUNTRIES.find((c) => c.code === form.country) || COUNTRIES[0];

  useEffect(() => {
    let active = true;
    if (!referralCode) {
      setReferral({ status: 'idle', username: '' });
      return () => { active = false; };
    }
    setReferral({ status: 'loading', username: '' });
    api.get(`/referrals/invite/${encodeURIComponent(referralCode)}`)
      .then(({ data }) => {
        if (active && data?.username) setReferral({ status: 'valid', username: data.username });
        else if (active) setReferral({ status: 'invalid', username: '' });
      })
      .catch((error) => {
        if (active) {
          setReferral({
            status: error.response?.status === 404 ? 'invalid' : 'error',
            username: '',
          });
        }
      });
    return () => { active = false; };
  }, [referralCode]);

  const validate = () => {
    const e = {};
    if (referralCode && referral.status !== 'valid') {
      e.referral = referral.status === 'loading'
        ? 'Vérification du code de parrainage en cours.'
        : referral.status === 'error'
          ? 'Impossible de vérifier le code de parrainage. Réessayez avant de créer votre compte.'
          : 'Ce lien de parrainage est invalide. Vérifiez le lien avant de créer votre compte.';
    }
    if (!form.full_name) e.full_name = t('register.errors.required');
    if (!form.username) e.username = t('register.errors.required');
    else if (form.username.length < 6) e.username = '6 caractères minimum.';
    if (!form.phone) e.phone = t('register.errors.required');
    if (!form.email) e.email = t('register.errors.required');
    const passwordStrong = form.password.length >= 6
      && /[a-z]/.test(form.password)
      && /[A-Z]/.test(form.password)
      && /\d/.test(form.password)
      && /[^A-Za-z0-9\s]/.test(form.password)
      && !/\s/.test(form.password);
    if (!passwordStrong) e.password = '6 caractères minimum, avec majuscule, minuscule, chiffre et caractère spécial.';
    if (form.password !== form.confirm) e.confirm = t('register.errors.mismatch');
    if (!turnstile.enabled || !turnstileToken) e.robot = 'Veuillez terminer la vérification anti-bot.';
    if (!form.terms) e.terms = t('register.errors.terms');
    setErrors(e);
    return Object.keys(e).length === 0;
  };
  const [turnstileToken, setTurnstileToken] = useState('');

  const onSubmit = async (ev) => {
    ev.preventDefault();
    if (referralCode && referral.status !== 'valid') {
      setErrors((current) => ({
        ...current,
        referral: referral.status === 'loading'
          ? 'Vérification du code de parrainage en cours.'
          : referral.status === 'error'
            ? 'Impossible de vérifier le code de parrainage. Réessayez avant de créer votre compte.'
            : 'Ce lien de parrainage est invalide. Vérifiez le lien avant de créer votre compte.',
      }));
      return;
    }
    if (!validate()) return;
    setLoading(true);
    try {
      const data = await register({
        full_name: form.full_name, username: form.username,
        account_type: 'merchant', country: form.country,
        phone: `${country.dial} ${form.phone}`, email: form.email,
        password: form.password,
        turnstile_token: turnstileToken,
        ...(referralCode ? { referral_code: referralCode } : {}),
      });
      toast.success('Compte créé avec succès !');
      if (data?.user_pin_setup_required && data.pin_setup_token) {
        setPinSetupToken(data.pin_setup_token);
        toast.info('Activez votre PIN obligatoire pour terminer la création du compte.');
      } else if (data?.mfa_setup_required) {
        toast.success('Compte créé. Connectez-vous pour activer la sécurité administrateur.');
        nav('/login');
      } else {
        nav('/dashboard');
      }
    } catch (err) {
      setTurnstileToken('');
      turnstileRef.current?.reset();
      toast.error(err.response?.data?.detail || 'Erreur lors de la création du compte');
    } finally {
      setLoading(false);
    }
  };

  const activateUserPin = async () => {
    if (!/^\d{6}$/.test(userPin) || userPin !== userPinConfirmation) {
      toast.error('Saisissez le même code PIN à six chiffres dans les deux champs.');
      return;
    }
    setLoading(true);
    try {
      const data = await login(form.email, form.password, {
        pin_setup_token: pinSetupToken,
        pin: userPin,
        pin_confirmation: userPinConfirmation,
      });
      if (!data?.user) {
        throw new Error('La configuration du code PIN a expiré. Recommencez la connexion.');
      }
      toast.success('Code PIN activé. Votre compte est prêt.');
      nav('/dashboard');
    } catch (err) {
      const detail = err.response?.data?.detail;
      toast.error(typeof detail === 'string' ? detail : detail?.message || err.message || 'Impossible d’activer le code PIN.');
      if ([401, 409].includes(err.response?.status)) {
        setPinSetupToken('');
        nav('/login');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bt-auth-shell flex flex-col" data-testid="register-page">
      <header className="bt-auth-header">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-20 flex items-center justify-between">
          <Logo />
            <LanguageSwitcher compact />
        </div>
      </header>

      <main className="bt-auth-main flex-1">
        <div className="bt-auth-stage">
          <aside className="bt-auth-visual" aria-label={t('auth.title')}>
            <Logo dark />
            <div className="bt-auth-visual-content">
              <div className="bt-kicker text-white/80">{t('auth.eyebrow')}</div>
              <h2 className="bt-auth-visual-title">{t('auth.title')}</h2>
              <p className="bt-auth-visual-copy">{t('auth.body')}</p>
              <div className="bt-auth-visual-points">
                <span className="bt-auth-visual-point">{t('auth.point_1')}</span>
                <span className="bt-auth-visual-point">{t('auth.point_2')}</span>
                <span className="bt-auth-visual-point">{t('auth.point_3')}</span>
              </div>
            </div>
          </aside>

          <div className="bt-auth-form-column">
        <form onSubmit={onSubmit} className="bt-auth-card bt-auth-card--wide max-w-2xl mx-auto p-7 sm:p-11" data-testid="register-form">
          {pinSetupToken ? (
            <section className="space-y-5 text-center" data-testid="register-pin-setup">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-50 text-2xl">🔐</div>
              <div>
                <h1 className="font-cabinet text-2xl font-extrabold tracking-tight text-slate-900">Nouvelle fonctionnalité disponible</h1>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">Activez maintenant votre code PIN à six chiffres. Il est obligatoire pour terminer la création de votre compte.</p>
              </div>
              <label className="block text-left text-sm font-semibold text-slate-700" htmlFor="register-user-pin">Code PIN</label>
              <input id="register-user-pin" type="password" inputMode="numeric" autoComplete="new-password"
                maxLength={6} value={userPin} onChange={(e) => setUserPin(e.target.value.replace(/\D/g, ''))}
                placeholder="••••••" className="bt-field text-center tracking-[0.4em]" />
              <label className="block text-left text-sm font-semibold text-slate-700" htmlFor="register-user-pin-confirm">Confirmer le code PIN</label>
              <input id="register-user-pin-confirm" type="password" inputMode="numeric" autoComplete="new-password"
                maxLength={6} value={userPinConfirmation} onChange={(e) => setUserPinConfirmation(e.target.value.replace(/\D/g, ''))}
                placeholder="••••••" className="bt-field text-center tracking-[0.4em]" />
              <button type="button" onClick={activateUserPin}
                disabled={loading || userPin.length !== 6 || userPinConfirmation.length !== 6 || userPin !== userPinConfirmation}
                className="bt-button-primary w-full font-bold py-3.5 disabled:cursor-not-allowed">
                {loading ? 'Activation…' : 'Activer le code PIN'}
              </button>
            </section>
          ) : <>
          <div className="text-center mb-9">
            <div className="flex justify-center">
              <Logo />
            </div>
            <h1 className="mt-2 font-cabinet text-3xl sm:text-4xl font-extrabold tracking-tight text-slate-900">{t('register.title')}</h1>
            <p className="mt-2 text-slate-600">{t('register.subtitle')}</p>
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
             <Field label={t('register.full_name')} htmlFor="register-full-name" labelClassName="text-center" icon={User} error={errors.full_name}>
               <input id="register-full-name" data-testid="input-full-name" type="text" autoComplete="name" value={form.full_name} onChange={(e) => set('full_name', e.target.value)} placeholder={t('register.full_name_ph')} className="bt-field pl-11 pr-4" />
            </Field>
             <Field label={t('register.username')} labelClassName="text-center" icon={AtSign} error={errors.username}>
                <input data-testid="input-username" type="text" minLength={6} maxLength={50} autoComplete="username" value={form.username} onChange={(e) => set('username', e.target.value.toLowerCase().replace(/\s+/g, ''))} placeholder={t('register.username_ph')} className="bt-field pl-11 pr-4" />
            </Field>
          </div>

          <div className="mt-5">
            <label className="text-sm font-semibold text-slate-700 mb-2 block text-center">{t('register.country')}</label>
            <div className="relative">
              <Globe className="w-5 h-5 text-slate-400 absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" />
              <select data-testid="select-country" value={form.country} onChange={(e) => set('country', e.target.value)} className="w-full pl-11 pr-4 py-3.5 border border-slate-200 rounded-xl focus:border-[#2563EB] focus:ring-2 focus:ring-blue-100 outline-none bg-white appearance-none">
                {COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>{c.flag} {c.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-4 mt-5">
            <div>
              <label className="text-sm font-semibold text-slate-700 mb-2 block text-center">{t('register.phone')}</label>
              <div className="relative">
                <Phone className="w-5 h-5 text-slate-400 absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" />
                <div className="absolute left-11 top-1/2 -translate-y-1/2 flex items-center gap-1.5 pr-2 border-r border-slate-200 h-7">
                   <span className="text-[10px] font-bold tracking-wider text-slate-500">{country.code}</span>
                  <span className="text-sm font-semibold text-slate-700">{country.dial}</span>
                </div>
               <input data-testid="input-phone" type="tel" autoComplete="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder={t('register.phone_ph')} className="bt-field pl-[110px] pr-4" />
              </div>
              {errors.phone && <p className="mt-1 text-xs text-red-500">{errors.phone}</p>}
            </div>
             <Field label={t('register.email')} labelClassName="text-center" icon={Mail} error={errors.email}>
               <input data-testid="input-email" type="email" value={form.email} onChange={(e) => set('email', e.target.value)} placeholder={t('register.email_ph')} className="bt-field pl-11 pr-4" />
            </Field>
          </div>

           <Field label={t('register.password')} labelClassName="text-center" icon={Lock} error={errors.password} extra="mt-5">
              <input data-testid="input-password" type={showPwd ? 'text' : 'password'} minLength={6} maxLength={72} autoComplete="new-password" value={form.password} onChange={(e) => set('password', e.target.value)} placeholder={t('register.password_ph')} className="bt-field pl-11 pr-11" />
            <button type="button" onClick={() => setShowPwd((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-700" data-testid="toggle-pwd-1">
              {showPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </Field>

           <Field label={t('register.confirm')} labelClassName="text-center" icon={Lock} error={errors.confirm} extra="mt-5">
             <input data-testid="input-confirm-password" type={showPwd2 ? 'text' : 'password'} autoComplete="new-password" value={form.confirm} onChange={(e) => set('confirm', e.target.value)} placeholder={t('register.confirm_ph')} className="bt-field pl-11 pr-11" />
            <button type="button" onClick={() => setShowPwd2((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-700" data-testid="toggle-pwd-2">
              {showPwd2 ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </Field>

          {/* Cloudflare Turnstile is verified again by the backend. */}
          <div className="mt-6">
            <TurnstileWidget
              ref={turnstileRef}
              siteKey={turnstile.siteKey}
              action="register"
              disabled={turnstile.loading || !turnstile.enabled}
              onToken={setTurnstileToken}
            />
            {errors.robot && <p className="mt-1 text-xs text-red-500">{errors.robot}</p>}
          </div>

          <div className="mt-4">
            <label className="flex items-start gap-3 cursor-pointer">
              <input data-testid="check-terms" type="checkbox" checked={form.terms} onChange={(e) => set('terms', e.target.checked)} className="w-4 h-4 mt-0.5 accent-[#2563EB]" />
              <span className="text-sm text-slate-600 leading-relaxed">
                {t('register.terms_1')} <a href="#" className="text-[#2563EB] font-semibold">{t('register.terms_link_1')}</a> {t('register.terms_and')} <a href="#" className="text-[#2563EB] font-semibold">{t('register.terms_link_2')}</a> {t('register.terms_end')}
              </span>
            </label>
            {errors.terms && <p className="mt-1 text-xs text-red-500">{errors.terms}</p>}
          </div>

          {referralCode && (
            <div
              className={`mt-5 rounded-xl border px-4 py-3 text-sm ${
                ['invalid', 'error'].includes(referral.status)
                  ? 'border-red-200 bg-red-50 text-red-800'
                  : 'border-blue-100 bg-blue-50/70 text-slate-700'
              }`}
              role={['invalid', 'error'].includes(referral.status) ? 'alert' : 'status'}
              aria-live="polite"
              data-testid="register-referral-status"
            >
              {referral.status === 'loading' && 'Vérification du lien de parrainage…'}
              {referral.status === 'valid' && (
                <span><strong>Invité par :</strong> {referral.username}</span>
              )}
              {referral.status === 'invalid' && (
                <span><strong>Code de parrainage invalide.</strong> Votre attribution ne sera pas supprimée : corrigez le lien avant de continuer.</span>
              )}
              {referral.status === 'error' && (
                <span><strong>Vérification indisponible.</strong> Le code ne sera pas ignoré. Réessayez lorsque la connexion sera rétablie.</span>
              )}
              {errors.referral && referral.status !== 'invalid' && (
                <span className="block mt-1 text-xs">{errors.referral}</span>
              )}
            </div>
          )}

          {turnstileToken ? (
            <button
              type="submit"
              disabled={loading || (referralCode && referral.status !== 'valid')}
              data-testid="btn-submit-register"
              className="bt-button-primary mt-8 w-full font-bold py-3.5 inline-flex items-center justify-center gap-2 disabled:cursor-not-allowed"
            >
              {loading ? 'Création en cours…' : <><UserPlus className="w-5 h-5" /> {t('register.submit')}</>}
            </button>
          ) : null}

          <p className="mt-6 text-center text-sm text-slate-500">
            {t('register.have_account')} <Link to="/login" className="text-[#2563EB] font-semibold hover:underline" data-testid="link-login">{t('register.login')}</Link>
          </p>
          </>}
        </form>
          </div>
        </div>
      </main>
    </div>
  );
}

function Field({ label, icon: Icon, error, children, extra = '', htmlFor, labelClassName = '' }) {
  return (
    <div className={extra}>
      <label htmlFor={htmlFor} className={`text-sm font-semibold text-slate-700 mb-2 block ${labelClassName}`}>{label}</label>
      <div className="relative">
        <Icon className="w-5 h-5 text-slate-400 absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" />
        {children}
      </div>
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </div>
  );
}
