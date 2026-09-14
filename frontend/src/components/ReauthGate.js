import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';
import { useAuth } from '@/context/AuthContext';

export default function ReauthGate() {
  const { user } = useAuth();
  const [request, setRequest] = useState(null);
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const onRequired = (event) => {
      if (!user) {
        event.detail.reject(new Error('Authentication required'));
        return;
      }
      setRequest(event.detail);
      setPassword('');
      setOtp('');
    };
    window.addEventListener('btp-reauth-required', onRequired);
    return () => window.removeEventListener('btp-reauth-required', onRequired);
  }, [user]);

  if (!request) return null;

  const confirm = async (event) => {
    event.preventDefault();
    setLoading(true);
    try {
      await api.post('/auth/reauth', { current_password: password, otp: otp || undefined });
      const response = await api.request({ ...request.config, _reauthRetry: true });
      request.resolve(response);
      setRequest(null);
      toast.success('Réauthentification réussie');
    } catch (error) {
      if (error.config?._reauthRetry) {
        request.reject(error);
        setRequest(null);
      }
      else toast.error(error.response?.data?.detail || 'Réauthentification impossible');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/50 p-4">
      <form onSubmit={confirm} className="w-full max-w-md rounded-3xl bg-white p-7 shadow-2xl">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-50 text-[#2563EB]">
          <ShieldCheck className="h-6 w-6" />
        </div>
        <h2 className="text-center font-cabinet text-2xl font-extrabold text-slate-900">Confirmez votre identité</h2>
        <p className="mt-2 text-center text-sm text-slate-500">Une nouvelle authentification est requise pour cette opération sensible.</p>
        <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" placeholder="Mot de passe actuel" required className="bt-field mt-5" />
        {user?.two_fa_enabled && <input value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, ''))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="Code 2FA" required className="bt-field mt-3 text-center tracking-[0.35em]" />}
        <button type="submit" disabled={loading} className="bt-button-primary mt-5 w-full">{loading ? 'Vérification…' : 'Confirmer et continuer'}</button>
      </form>
    </div>
  );
}