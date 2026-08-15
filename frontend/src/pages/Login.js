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
    <div className="min-h-screen bg-gradient-to-b from-white to-slate-50 flex flex-col" data-testid="login-page">
      <header className="border-b border-slate-200/70 bg-white/80 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-20 flex items-center justify-between">
          <Logo />
          <Link to="/register" data-testid="link-to-register" className="text-sm font-semibold text-[#2563EB]">
            {t('login.no_account')} <span className="underline underline-offset-4">{t('login.register')}</span>
          </Link>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center py-12 px-4 relative overflow-hidden">
        <div className="absolute top-10 left-10 w-72 h-72 rounded-full bg-blue-100/40 blur-3xl pointer-events-none" />
        <div className="absolute bottom-10 right-10 w-72 h-72 rounded-full bg-blue-100/40 blur-3xl pointer-events-none" />

        <form onSubmit={submit} className="relative w-full max-w-md bg-white border border-slate-100 rounded-[28px] shadow-[0_20px_60px_-20px_rgba(15,23,42,0.15)] p-8 sm:p-10" data-testid="login-form">
          <div className="text-center mb-8">
            <div className="mx-auto w-16 h-16 rounded-2xl bg-blue-50 flex items-center justify-center">
              <LogInIcon className="w-7 h-7 text-[#2563EB]" strokeWidth={1.75} />
            </div>
            <h1 className="mt-4 font-cabinet text-3xl font-extrabold tracking-tighter text-slate-900">{t('login.title')}</h1>
            <p className="mt-2 text-slate-600 text-sm">{t('login.subtitle')}</p>
          </div>

          <div>
            <label className="text-sm font-semibold text-slate-700 mb-2 block">{t('login.identifier')}</label>
            <div className="relative">
              <Mail className="w-5 h-5 text-slate-400 absolute left-4 top-1/2 -translate-y-1/2" />
              <input data-testid="input-identifier" type="text" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="john@example.com" className="w-full pl-11 pr-4 py-3.5 border border-slate-200 rounded-xl focus:border-[#2563EB] focus:ring-2 focus:ring-blue-100 outline-none" />
            </div>
          </div>

          <div className="mt-4">
            <label className="text-sm font-semibold text-slate-700 mb-2 block">{t('login.password')}</label>
            <div className="relative">
              <Lock className="w-5 h-5 text-slate-400 absolute left-4 top-1/2 -translate-y-1/2" />
              <input data-testid="input-password" type={showPwd ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" className="w-full pl-11 pr-11 py-3.5 border border-slate-200 rounded-xl focus:border-[#2563EB] focus:ring-2 focus:ring-blue-100 outline-none" />
              <button type="button" onClick={() => setShowPwd((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-700" data-testid="toggle-pwd">
                {showPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <button type="submit" disabled={loading} data-testid="btn-login" className="mt-6 w-full bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold py-4 rounded-xl shadow-[0_10px_30px_-8px_rgba(37,99,235,0.6)] hover:-translate-y-0.5 transition-transform inline-flex items-center justify-center gap-2 disabled:opacity-70">
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
