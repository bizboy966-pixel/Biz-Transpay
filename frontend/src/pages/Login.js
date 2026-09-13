import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Mail, Lock, Eye, EyeOff, LogIn as LogInIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Logo } from '@/components/Logo';
import { useAuth } from '@/context/AuthContext';
import LanguageSwitcher from '@/components/LanguageSwitcher';

export default function Login() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const u = await login(email, password);
      toast.success('Connexion réussie');
      const role = u?.role || u?.user?.role;
      // Admins land directly on the admin panel; merchants on their dashboard.
      nav(role === 'admin' || role === 'super_admin' ? '/admin' : '/dashboard');
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Identifiants invalides');
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

          <div>
            <label className="text-sm font-semibold text-slate-700 mb-2 block text-center">{t('login.identifier')}</label>
            <div className="relative">
              <Mail className="w-5 h-5 text-slate-400 absolute left-4 top-1/2 -translate-y-1/2" />
              <input data-testid="input-identifier" type="text" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="john@example.com" className="bt-field pl-11 pr-4" />
            </div>
          </div>

          <div className="mt-4">
            <label className="text-sm font-semibold text-slate-700 mb-2 block text-center">{t('login.password')}</label>
            <div className="relative">
              <Lock className="w-5 h-5 text-slate-400 absolute left-4 top-1/2 -translate-y-1/2" />
              <input data-testid="input-password" type={showPwd ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" className="bt-field pl-11 pr-11" />
              <button type="button" onClick={() => setShowPwd((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-700" data-testid="toggle-pwd">
                {showPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <button type="submit" disabled={loading} data-testid="btn-login" className="bt-button-primary mt-7 w-full font-bold py-3.5 inline-flex items-center justify-center gap-2">
            {loading ? 'Connexion…' : <><LogInIcon className="w-5 h-5" /> {t('login.submit')}</>}
          </button>

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
