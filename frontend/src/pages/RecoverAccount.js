import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LockKeyhole, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';
import { Logo } from '@/components/Logo';
import TurnstileWidget, { useTurnstileConfig } from '@/components/TurnstileWidget';

export default function RecoverAccount() {
  const nav = useNavigate();
  const turnstile = useTurnstileConfig();
  const turnstileRef = useRef(null);
  const [form, setForm] = useState({ identifier: '', recovery_code: '', new_password: '', confirm: '' });
  const [loading, setLoading] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState('');
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event) => {
    event.preventDefault();
    if (form.new_password !== form.confirm) {
      toast.error('Les mots de passe ne correspondent pas.');
      return;
    }
    if (form.new_password.length < 10 || !/[a-z]/.test(form.new_password)
      || !/[A-Z]/.test(form.new_password) || !/\d/.test(form.new_password)
      || !/[^A-Za-z0-9\s]/.test(form.new_password) || /\s/.test(form.new_password)) {
      toast.error('Le nouveau mot de passe doit être fort : 10 caractères, majuscule, minuscule, chiffre et caractère spécial.');
      return;
    }
    if (!turnstile.enabled || !turnstileToken) {
      toast.error('Veuillez terminer la vérification anti-bot.');
      return;
    }
    setLoading(true);
    try {
      await api.post('/auth/recover', {
        identifier: form.identifier,
        recovery_code: form.recovery_code,
        new_password: form.new_password,
        turnstile_token: turnstileToken,
      });
      toast.success('Mot de passe réinitialisé. Vous pouvez vous connecter.');
      nav('/login');
    } catch (err) {
      setTurnstileToken('');
      turnstileRef.current?.reset();
      const detail = err.response?.data?.detail;
      toast.error(typeof detail === 'string' ? detail : detail?.message || 'Informations de récupération invalides');
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
            <h1 className="mt-4 font-cabinet text-3xl font-extrabold tracking-tight text-slate-900">Récupérer le compte</h1>
            <p className="mt-2 text-slate-600 text-sm">Utilisez un code de récupération MFA à usage unique.</p>
          </div>
          <label className="text-sm font-semibold text-slate-700 mb-2 block">E-mail ou identifiant</label>
          <input value={form.identifier} onChange={(e) => set('identifier', e.target.value)} autoComplete="username" required className="bt-field mb-4" />
          <label className="text-sm font-semibold text-slate-700 mb-2 block">Code de récupération</label>
          <input value={form.recovery_code} onChange={(e) => set('recovery_code', e.target.value)} autoComplete="one-time-code" required className="bt-field mb-4 font-mono" />
          <label className="text-sm font-semibold text-slate-700 mb-2 block">Nouveau mot de passe</label>
          <div className="relative">
            <LockKeyhole className="w-4 h-4 text-slate-400 absolute left-4 top-1/2 -translate-y-1/2" />
            <input type="password" value={form.new_password} onChange={(e) => set('new_password', e.target.value)} autoComplete="new-password" required className="bt-field pl-10 mb-4" />
          </div>
          <label className="text-sm font-semibold text-slate-700 mb-2 block">Confirmer le mot de passe</label>
          <input type="password" value={form.confirm} onChange={(e) => set('confirm', e.target.value)} autoComplete="new-password" required className="bt-field" />
          <TurnstileWidget
            ref={turnstileRef}
            siteKey={turnstile.siteKey}
            action="recover"
            disabled={turnstile.loading || !turnstile.enabled}
            onToken={setTurnstileToken}
          />
          <button type="submit" disabled={loading} className="bt-button-primary mt-7 w-full font-bold py-3.5">{loading ? 'Réinitialisation…' : 'Réinitialiser le mot de passe'}</button>
          <p className="mt-6 text-center text-sm text-slate-500"><Link to="/login" className="text-[#2563EB] font-semibold">Retour à la connexion</Link></p>
        </form>
      </main>
    </div>
  );
}