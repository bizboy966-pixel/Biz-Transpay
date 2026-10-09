import { useEffect, useState } from 'react';
import { KeyRound, ShieldCheck } from 'lucide-react';

export default function UserPinPrompt({ open, onConfirm, onCancel }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) {
      setPin('');
      setError('');
      setLoading(false);
    }
  }, [open]);

  if (!open) return null;

  const confirm = async (event) => {
    event.preventDefault();
    if (!/^\d{6}$/.test(pin)) {
      setError('Saisissez votre code PIN à six chiffres.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await onConfirm(pin);
      if (result?.ok === false) setError(result.message || 'Vérifiez votre code PIN et réessayez.');
      setPin('');
    } catch {
      setError('Impossible de confirmer cette opération. Réessayez.');
      setPin('');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/45 px-4 py-6 backdrop-blur-sm"
      data-testid="user-pin-prompt-backdrop"
    >
      <form
        onSubmit={confirm}
        role="dialog"
        aria-modal="true"
        aria-labelledby="user-pin-prompt-title"
        className="w-full max-w-sm rounded-3xl border border-white/70 bg-white p-6 shadow-[0_28px_80px_rgba(15,23,42,0.28)] sm:p-8"
        data-testid="user-pin-prompt"
      >
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-50 text-[#2563EB]">
          <ShieldCheck className="h-7 w-7" />
        </div>
        <h2 id="user-pin-prompt-title" className="mt-4 text-center font-cabinet text-xl font-extrabold text-slate-900">
          Confirmez avec votre code PIN
        </h2>
        <p className="mt-2 text-center text-sm leading-relaxed text-slate-600">
          Saisissez votre code PIN pour autoriser ce retrait ou ce transfert.
        </p>
        <label htmlFor="user-pin-transfer" className="mt-6 block text-sm font-semibold text-slate-700">
          Code PIN à six chiffres
        </label>
        <div className="relative mt-2">
          <KeyRound className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            id="user-pin-transfer"
            data-testid="input-user-pin-transfer"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={pin}
            onChange={(event) => {
              setPin(event.target.value.replace(/\D/g, ''));
              setError('');
            }}
            placeholder="••••••"
            className="bt-field pl-11 text-center tracking-[0.45em]"
            autoFocus
          />
        </div>
        {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
        <div className="mt-6 grid grid-cols-2 gap-3">
          <button type="button" onClick={() => { setPin(''); setError(''); onCancel(); }} disabled={loading}
            className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            Annuler
          </button>
          <button type="submit" disabled={loading || pin.length !== 6} className="bt-button-primary w-full">
            {loading ? 'Vérification…' : 'Confirmer'}
          </button>
        </div>
      </form>
    </div>
  );
}
