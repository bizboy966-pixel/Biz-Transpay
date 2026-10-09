import { useId, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';

export default function AdminPinSettings({ enabled, onSaved }) {
  const id = useId();
  const [mode, setMode] = useState(null);
  const [values, setValues] = useState({ pin: '', confirmation: '', password: '', code: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const close = () => {
    setMode(null);
    setValues({ pin: '', confirmation: '', password: '', code: '' });
    setError('');
  };
  const change = (key, value) => setValues((current) => ({ ...current, [key]: value }));
  const save = async () => {
    if (mode !== 'remove' && (!/^[0-9]{6}$/.test(values.pin) || values.pin !== values.confirmation)) {
      setError('Saisissez deux fois le même PIN à six chiffres.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.post('/auth/admin-pin', {
        current_password: values.password,
        code: values.code,
        pin: mode === 'remove' ? null : values.pin,
      });
      const removing = mode === 'remove';
      close();
      toast.success(removing ? 'PIN supprimé' : 'PIN enregistré');
      await onSaved();
    } catch (err) {
      const detail = err.response?.data?.detail;
      setError(typeof detail === 'string' ? detail : detail?.message || 'Impossible de modifier le PIN.');
    } finally { setBusy(false); }
  };
  const field = (key, label, numeric = false) => (
    <div>
      <label htmlFor={`${id}-${key}`} className="mb-1 block text-sm font-semibold text-slate-700">{label}</label>
      <input id={`${id}-${key}`} data-testid={`admin-pin-${key}`} type="password"
        value={values[key]} onChange={(e) => change(key, numeric ? e.target.value.replace(/[^0-9]/g, '') : e.target.value)}
        inputMode={numeric ? 'numeric' : undefined} maxLength={numeric ? 6 : 72}
        autoComplete={key === 'password' ? 'current-password' : key === 'code' ? 'one-time-code' : 'new-password'}
        className="bt-field" disabled={busy} />
    </div>
  );
  return (
    <div className="mt-4 rounded-xl bg-slate-50 p-4" data-testid="admin-pin-settings">
      <div className="flex items-start gap-3">
        <KeyRound className="mt-1 h-5 w-5 shrink-0 text-[#2563EB]" />
        <div>
          <h3 className="font-semibold text-slate-800">Code PIN administrateur</h3>
          <p className="mt-1 text-xs text-slate-500">
            {enabled ? 'Activé : vous pouvez choisir le PIN à la connexion.' : 'Définissez un PIN personnel à six chiffres pour vous connecter après votre mot de passe.'}
          </p>
          <p className="mt-2 text-xs text-slate-500">Le PIN est moins sûr que la double authentification. L’authentificateur reste nécessaire pour modifier le PIN et pour les actions sensibles.</p>
        </div>
      </div>
      {!mode ? <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={() => setMode('save')} data-testid="admin-pin-open"
          className="rounded-full bg-[#2563EB] px-4 py-2 text-sm font-bold text-white">{enabled ? 'Modifier le PIN' : 'Définir mon PIN'}</button>
        {enabled && <button type="button" onClick={() => setMode('remove')} data-testid="admin-pin-remove"
          className="rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600">Supprimer le PIN</button>}
      </div> : <div className="mt-4 space-y-3">
        {mode !== 'remove' && <>
          {field('pin', 'Nouveau PIN à six chiffres', true)}
          {field('confirmation', 'Confirmez votre PIN', true)}
        </>}
        {mode === 'remove' && <p className="text-sm text-slate-700">Vous utiliserez uniquement l’authentificateur pour vous connecter.</p>}
        {field('password', 'Mot de passe actuel')}
        {field('code', 'Code actuel de l’authentificateur', true)}
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={save} data-testid="admin-pin-save"
            disabled={busy || !values.password || values.code.length !== 6 ||
              (mode !== 'remove' && (values.pin.length !== 6 || values.pin !== values.confirmation))}
            className="rounded-full bg-[#2563EB] px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
            {busy ? 'Validation…' : mode === 'remove' ? 'Confirmer la suppression' : 'Enregistrer le PIN'}
          </button>
          <button type="button" disabled={busy} onClick={close} className="rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600">Annuler</button>
        </div>
      </div>}
    </div>
  );
}
