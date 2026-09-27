import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Mail, Lock, Eye, EyeOff, LogIn as LogInIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Logo } from '@/components/Logo';
import { useAuth } from '@/context/AuthContext';
import LanguageSwitcher from '@/components/LanguageSwitcher';
import TurnstileWidget, { useTurnstileConfig } from '@/components/TurnstileWidget';

export default function Login() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { login, confirmTwoFactor } = useAuth();
  const turnstile = useTurnstileConfig();
  const turnstileRef = useRef(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState('password');
  const [otp, setOtp] = useState('');
  const [mfaToken, setMfaToken] = useState('');
  const [setup, setSetup] = useState(null);
  const [setupCode, setSetupCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState([]);
  const [challenge, setChallenge] = useState(null);
  const [challengeSolution, setChallengeSolution] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');

  const errorDetail = (err) => {
    const detail = err.response?.data?.detail || err.response?.data?.message;
    return typeof detail === 'string' ? detail : detail?.message || 'Identifiants invalides';
  };

  const solveChallenge = async (item) => {
    if (!item?.nonce) return '';
    let attempt = 0;
    const prefix = '0'.repeat(Number(item.difficulty || 4));
    while (attempt < 2000000) {
      const input = `${item.nonce}${attempt}`;
      const bytes = new TextEncoder().encode(input);
      const digest = await window.crypto.subtle.digest('SHA-256', bytes);
      const hash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
      if (hash.startsWith(prefix)) return String(attempt);
      attempt += 1;
    }
    throw new Error('challenge_failed');
  };

  const completeLogin = (data) => {
    if (data.mfa_required) {
      setMfaToken(data.mfa_token);
      setStep('mfa');
      setChallenge(null);
      setChallengeSolution('');
      toast.success('Entrez le code actuel de votre application d’authentification');
      return;
    }
    if (data.mfa_setup_required) {
      setSetup(data.mfa_setup);
      setStep('setup');
      toast.success('Configurez la double authentification obligatoire');
      return;
    }
    const u = data.user;
    toast.success('Connexion réussie');
    const role = u?.role || u?.user?.role;
    nav(role === 'admin' || role === 'super_admin' ? '/admin' : '/dashboard');
  };

  const attemptLogin = async (security) => {
    try {
      return await login(email, password, security);
    } catch (err) {
      const detail = err.response?.data?.detail;
      if (detail?.code !== 'AUTH_CHALLENGE_REQUIRED' || !detail.challenge) throw err;
      setChallenge(detail.challenge);
      toast.info('Vérification de sécurité automatique…');
      const solved = await solveChallenge(detail.challenge);
      setChallengeSolution(solved);
      return login(email, password, {
        ...security,
        challenge_id: detail.challenge.id,
        challenge_solution: solved,
      });
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (step === 'password' && (!turnstile.enabled || !turnstileToken)) {
      toast.error('Veuillez terminer la vérification anti-bot.');
      return;
    }
    setLoading(true);
    try {
      let solved = challengeSolution;
      if (challenge && !solved) {
        solved = await solveChallenge(challenge);
        setChallengeSolution(solved);
      }
      const data = await attemptLogin({
        otp: step === 'mfa' ? otp : undefined,
        mfa_token: step === 'mfa' ? mfaToken : undefined,
        challenge_id: challenge?.id,
        challenge_solution: solved || undefined,
        turnstile_token: step === 'password' ? turnstileToken : undefined,
      });
      completeLogin(data);
    } catch (err) {
      setTurnstileToken('');
      turnstileRef.current?.reset();
      const detail = err.response?.data?.detail;
      if (err.message === 'challenge_failed') {
        toast.error('La vérification automatique a échoué. Réessayez.');
      } else {
        toast.error(typeof detail === 'string' ? detail : errorDetail(err));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bt-auth-shell flex flex-col" data-testid="login-page">
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
            <form onSubmit={submit} className="bt-auth-card p-7 sm:p-10" data-testid="login-form">
          <div className="text-center mb-9">
            <div className="flex justify-center">
              <Logo />
            </div>
            <h1 className="mt-2 font-cabinet text-3xl font-extrabold tracking-tight text-slate-900">{t('login.title')}</h1>
            <p className="mt-2 text-slate-600 text-sm">{t('login.subtitle')}</p>
          </div>

          {step === 'setup' ? (
            <div className="space-y-4">
              <h2 className="font-cabinet font-bold text-xl text-slate-900">Activez la double authentification</h2>
              <p className="text-sm text-slate-600">Ajoutez cette clé dans votre application d’authentification, puis saisissez le code à 6 chiffres.</p>
              <div className="rounded-xl bg-slate-50 p-3 font-mono text-xs break-all select-all">{setup?.secret}</div>
              <input value={setupCode} onChange={(e) => setSetupCode(e.target.value)} inputMode="numeric" maxLength={6} placeholder="Code à 6 chiffres" className="bt-field" />
              <button type="button" className="bt-button-primary w-full" disabled={loading || setupCode.length !== 6} onClick={async () => {
                setLoading(true);
                try {
                  const result = await confirmTwoFactor(setupCode, setup?.setup_token);
                  setRecoveryCodes(result.recovery_codes || []);
                  setStep('recovery');
                  toast.success('Double authentification activée');
                } catch (err) { toast.error(errorDetail(err)); }
                finally { setLoading(false); }
              }}>Confirmer l’activation</button>
            </div>
          ) : step === 'recovery' ? (
            <div className="space-y-4">
              <h2 className="font-cabinet font-bold text-xl text-slate-900">Codes de récupération</h2>
              <p className="text-sm text-slate-600">Conservez ces codes dans un endroit sûr. Chaque code ne peut être utilisé qu’une seule fois.</p>
              <div className="grid grid-cols-2 gap-2 rounded-xl bg-slate-50 p-4 font-mono text-xs">{recoveryCodes.map((code) => <span key={code}>{code}</span>)}</div>
              <button type="button" className="bt-button-primary w-full" onClick={() => { setStep('mfa'); setMfaToken(''); }}>Continuer vers la connexion</button>
            </div>
          ) : step === 'mfa' ? (
            <div>
               <label className="text-sm font-semibold text-slate-700 mb-2 block text-center">Code 2FA de l’application d’authentification</label>
              <input data-testid="input-login-otp" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} placeholder="••••••" className="bt-field text-center tracking-[0.4em]" />
               <p className="mt-2 text-xs text-slate-500 text-center">Réservé aux administrateurs. Utilisez le code à 6 chiffres affiché actuellement dans Google Authenticator, Microsoft Authenticator ou une application compatible. Ce n’est pas un code fixe choisi par vous.</p>
            </div>
          ) : (
          <div>
            <label className="text-sm font-semibold text-slate-700 mb-2 block text-center">{t('login.identifier')}</label>
            <div className="relative">
              <Mail className="w-5 h-5 text-slate-400 absolute left-4 top-1/2 -translate-y-1/2" />
              <input data-testid="input-identifier" type="text" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="john@example.com" className="bt-field pl-11 pr-4" />
            </div>
          </div>
          )}

          {step === 'password' && <div className="mt-4">
            <label className="text-sm font-semibold text-slate-700 mb-2 block text-center">{t('login.password')}</label>
            <div className="relative">
              <Lock className="w-5 h-5 text-slate-400 absolute left-4 top-1/2 -translate-y-1/2" />
              <input data-testid="input-password" type={showPwd ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" className="bt-field pl-11 pr-11" />
              <button type="button" onClick={() => setShowPwd((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-700" data-testid="toggle-pwd">
                {showPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>}

          {step === 'password' && <div className="mt-3 text-right">
            <Link to="/recover" className="text-xs font-semibold text-[#2563EB]">Mot de passe oublié ?</Link>
          </div>}

          {step === 'password' && (
            <TurnstileWidget
              ref={turnstileRef}
              siteKey={turnstile.siteKey}
              action="login"
              disabled={turnstile.loading || !turnstile.enabled}
              onToken={setTurnstileToken}
            />
          )}

          {(step === 'password' || step === 'mfa') && <button type="submit" disabled={loading || (step === 'mfa' && otp.length !== 6)} data-testid="btn-login" className="bt-button-primary mt-7 w-full font-bold py-3.5 inline-flex items-center justify-center gap-2">
            {loading
              ? <><span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />Connexion…</>
              : <><LogInIcon className="w-5 h-5" /> {t('login.submit')}</>}
          </button>}

          <p className="mt-6 text-center text-sm text-slate-500">
            {t('login.no_account')} <Link to="/register" className="text-[#2563EB] font-semibold" data-testid="link-register">{t('login.register')}</Link>
          </p>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}
