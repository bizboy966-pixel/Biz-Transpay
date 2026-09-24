import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LockKeyhole, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';
import { Logo } from '@/components/Logo';
import TurnstileWidget, { useTurnstileConfig } from '@/components/TurnstileWidget';

export default function ResetPassword() {
  const nav = useNavigate();
  const turnstile = useTurnstileConfig();
  const turnstileRef = useRef(null);
  const [token, setToken] = useState('');
  const [tokenLoading, setTokenLoading] = useState(true);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState('');

  useEffect(() => {
    const match = window.location.hash.match(/(?:^#|&)token=([^&]+)/);
    let value = '';
    try {
      value = match ? decodeURIComponent(match[1]) : '';
    } catch {
      value = '';
    }
    setToken(value);
    // The token is carried in the fragment, so it is not sent to the server.
    // Remove it from browser history as soon as the page reads it.
    window.history.replaceState(null, document.title, window.location.pathname);
    setTokenLoading(false);
  }, []);

  const submit = async (event) => {
    event.preventDefault();
    if (password !== confirm) {
      toast.error('Les mots de passe ne correspondent pas.');
      return;
    }
    if (password.length < 10 || password.length > 72 || !/[a-z]/.test(password)
      || !/[A-Z]/.test(password) || !/\d/.test(password)
      || !/[^A-Za-z0-9\s]/.test(password) || /\s/.test(password)) {
      toast.error('Le mot de passe doit contenir au moins 10 caractères, une majuscule, une minuscule, un chiffre et un caractère spécial, sans espace.');
      return;
    }
    if (!turnstile.enabled || !turnstileToken) {
      toast.error('Veuillez terminer la vérification anti-bot.');
      return;
    }
    setLoading(true);
    try {
      await api.post('/auth/password-reset/confirm', {
        token,
        new_password: password,
        turnstile_token: turnstileToken,
      });
      toast.success('Mot de passe réinitialisé. Connectez-vous de nouveau.');
      nav('/login');
    } catch (error) {
      setTurnstileToken('');
      turnstileRef.current?.reset();
      const detail = error.response?.data?.detail;
      toast.error(typeof detail === 'string' ? detail : 'Lien invalide ou expiré.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bt-auth-shell flex flex-col min-h-screen">
      <header className="bt-auth-header">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-20 flex items-center">
          <Logo />
        </div>
      </header>
      <main className="bt-auth-main flex-1 flex items-center justify-center px-4">
        <form onSubmit={submit} className="bt-auth-card p-7 sm:p-10 w-full max-w-md">
          <div className="text-center mb-8">
            <div className="mx-auto w-12 h-12 rounded-2xl bg-blue-50 text-[#2563EB] flex items-center justify-center">
              <ShieldCheck className="w-6 h-6" />
            </div>
            <h1 className="mt-4 font-cabinet text-3xl font-extrabold tracking-tight text-slate-900">
              Nouveau mot de passe
            </h1>
            <p className="mt-2 text-slate-600 text-sm">
              Le lien est à usage unique et expire après 30 minutes.
            </p>
          </div>
          {tokenLoading ? (
            <p className="text-center text-sm text-slate-500">Vérification du lien…</p>
          ) : !token ? (
            <div className="text-center text-sm text-slate-600">
              <p>Ce lien est invalide ou incomplet.</p>
              <Link to="/recover" className="mt-3 inline-block text-[#2563EB] font-semibold">
                Demander un nouveau lien
              </Link>
            </div>
          ) : (
            <>
              <label htmlFor="new-password" className="text-sm font-semibold text-slate-700 mb-2 block">
                Nouveau mot de passe
              </label>
              <div className="relative">
                <LockKeyhole className="w-4 h-4 text-slate-400 absolute left-4 top-1/2 -translate-y-1/2" />
                <input
                  id="new-password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                  required
                  maxLength={72}
                  className="bt-field pl-10 mb-4"
                />
              </div>
              <label htmlFor="confirm-password" className="text-sm font-semibold text-slate-700 mb-2 block">
                Confirmer le mot de passe
              </label>
              <input
                id="confirm-password"
                type="password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                autoComplete="new-password"
                required
                maxLength={72}
                className="bt-field"
              />
              <TurnstileWidget
                ref={turnstileRef}
                siteKey={turnstile.siteKey}
                action="password_reset_confirm"
                disabled={turnstile.loading || !turnstile.enabled}
                onToken={setTurnstileToken}
              />
              <button
                type="submit"
                disabled={loading}
                className="bt-button-primary mt-7 w-full font-bold py-3.5"
              >
                {loading ? 'Réinitialisation…' : 'Enregistrer le nouveau mot de passe'}
              </button>
            </>
          )}
          <p className="mt-6 text-center text-sm text-slate-500">
            <Link to="/recover/mfa" className="text-[#2563EB] font-semibold">
              Récupération par code MFA
            </Link>
          </p>
        </form>
      </main>
    </div>
  );
}