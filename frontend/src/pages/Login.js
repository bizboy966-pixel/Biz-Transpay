import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Mail, Lock, Eye, EyeOff, LogIn as LogInIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Logo } from '@/components/Logo';
import { useAuth } from '@/context/AuthContext';

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
          <Link to="/register" data-testid="link-to-register" className="text-sm font-semibold text-[#2563EB]">
            {t('login.no_account')} <span className="underline underline-offset-4">{t('login.register')}</span>
          </Link>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center py-12 px-4 relative">

        <form onSubmit={submit} className="bt-auth-card p-7 sm:p-10" data-testid="login-form">
          <div className="text-center mb-9">
            <div className="mx-auto w-14 h-14 rounded-2xl bg-[#EFF6FF] border border-[#D8E7FF] flex items-center justify-center">
              <LogInIcon className="w-7 h-7 text-[#2563EB]" strokeWidth={1.75} />
            </div>
            <div className="bt-kicker mt-5">Biz-transPay</div>
            <h1 className="mt-2 font-cabinet text-3xl font-extrabold tracking-tight text-slate-900">{t('login.title')}</h1>
            <p className="mt-2 text-slate-600 text-sm">{t('login.subtitle')}</p>
          </div>

          <div>
            <label className="text-sm font-semibold text-slate-700 mb-2 block">{t('login.identifier')}</label>
            <div className="relative">
              <Mail className="w-5 h-5 text-slate-400 absolute left-4 top-1/2 -translate-y-1/2" />
              <input data-testid="input-identifier" type="text" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="john@example.com" className="bt-field pl-11 pr-4" />
            </div>
          </div>

          <div className="mt-4">
            <label className="text-sm font-semibold text-slate-700 mb-2 block">{t('login.password')}</label>
            <div className="relative">
              <Lock className="w-5 h-5 text-slate-400 absolute left-4 top-1/2 -translate-y-1/2" />
              <input data-testid="input-password" type={showPwd ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" className="bt-field pl-11 pr-11" />
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
      </main>
    </div>
  );
}
