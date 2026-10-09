import { useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Mail, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';
import { Logo } from '@/components/Logo';
import TurnstileWidget, { useTurnstileConfig } from '@/components/TurnstileWidget';

export default function RequestPasswordReset() {
  const location = useLocation();
  const pinMode = new URLSearchParams(location.search).get('mode') === 'pin';
  const turnstile = useTurnstileConfig();
  const turnstileRef = useRef(null);
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    if (!turnstile.enabled || !turnstileToken) {
      toast.error('Veuillez terminer la vérification anti-bot.');
      return;
    }
    setLoading(true);
    try {
      const { data } = await api.post(
        pinMode ? '/auth/user-pin/reset/request' : '/auth/password-reset/request', {
        email,
        turnstile_token: turnstileToken,
      });
      setSent(true);
      toast.success(data?.message || 'Si un compte correspond, un lien sera envoyé.');
    } catch (error) {
      setTurnstileToken('');
      turnstileRef.current?.reset();
      const detail = error.response?.data?.detail;
      toast.error(typeof detail === 'string' ? detail : 'Impossible de traiter la demande. Réessayez.');
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
              {sent ? <ShieldCheck className="w-6 h-6" /> : <Mail className="w-6 h-6" />}
            </div>
            <h1 className="mt-4 font-cabinet text-3xl font-extrabold tracking-tight text-slate-900">
              {sent ? 'Vérifiez votre boîte e-mail' : pinMode ? 'Réinitialiser le code PIN' : 'Réinitialiser le mot de passe'}
            </h1>
            <p className="mt-2 text-slate-600 text-sm">
              {sent
                ? 'Si cette adresse est liée à un compte, un lien à usage unique sera envoyé.'
                : pinMode
                  ? 'Nous enverrons un lien à usage unique à l’adresse e-mail du compte pour réinitialiser son code PIN.'
                  : 'Nous vous enverrons un lien à usage unique si un compte correspond à cette adresse.'}
            </p>
          </div>
          {!sent && (
            <>
              <label htmlFor="reset-email" className="text-sm font-semibold text-slate-700 mb-2 block">
                E-mail du compte
              </label>
              <input
                id="reset-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                required
                maxLength={254}
                className="bt-field"
              />
              <TurnstileWidget
                ref={turnstileRef}
                siteKey={turnstile.siteKey}
                action="password_reset"
                disabled={turnstile.loading || !turnstile.enabled}
                onToken={setTurnstileToken}
              />
              <button
                type="submit"
                disabled={loading}
                className="bt-button-primary mt-7 w-full font-bold py-3.5"
              >
                {loading ? 'Envoi de la demande…' : pinMode ? 'Recevoir un lien de réinitialisation du PIN' : 'Recevoir un lien'}
              </button>
            </>
          )}
          <div className="mt-6 space-y-3 text-center text-sm">
            {pinMode && (
              <p className="text-slate-500">
                <Link to="/recover" className="text-[#2563EB] font-semibold">
                  Réinitialiser plutôt mon mot de passe
                </Link>
              </p>
            )}
            <p className="text-slate-500">
              <Link to="/recover/mfa" className="text-[#2563EB] font-semibold">
                Utiliser plutôt un code de récupération MFA
              </Link>
            </p>
            <p className="text-slate-500">
              <Link to="/login" className="text-[#2563EB] font-semibold">Retour à la connexion</Link>
            </p>
          </div>
        </form>
      </main>
    </div>
  );
}