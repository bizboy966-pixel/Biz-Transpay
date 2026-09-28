import { useEffect, useState } from 'react';
import { Download, X } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import {
  getPwaInstallState,
  markPwaInstalled,
  requestPwaInstall,
  subscribePwaInstall,
} from '../lib/pwaInstall';

export default function PwaInstallPrompt() {
  const location = useLocation();
  const [installState, setInstallState] = useState(getPwaInstallState);
  const [dismissed, setDismissed] = useState(false);
  const [installError, setInstallError] = useState('');
  const [installHelpOpen, setInstallHelpOpen] = useState(false);

  useEffect(() => subscribePwaInstall(setInstallState), []);

  if (
    location.pathname !== '/dashboard'
    || dismissed
    || installState.installed
  ) {
    return null;
  }

  const install = async () => {
    setInstallError('');
    try {
      const outcome = await requestPwaInstall();
      if (outcome === 'accepted') {
        setInstallState(getPwaInstallState());
      } else {
        setInstallState(getPwaInstallState());
        setInstallHelpOpen(true);
        setInstallError("Impossible d'installer l'application Web");
      }
    } catch {
      setInstallHelpOpen(true);
      setInstallError("Impossible d'installer l'application Web");
    }
  };
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const isAppleMobile = /iPhone|iPad|iPod/i.test(userAgent)
    || (typeof navigator !== 'undefined'
      && navigator.platform === 'MacIntel'
      && navigator.maxTouchPoints > 1);

  return (
    <section
      role="region"
      aria-label="Installer Biz-transPay"
      aria-live="polite"
      data-testid="pwa-install-prompt"
      className="mb-5 flex flex-col gap-4 rounded-2xl border border-blue-200 bg-gradient-to-r from-blue-50 to-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-5"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-100 text-[#2563EB]">
          <Download className="h-5 w-5" aria-hidden="true" />
        </div>
        <div>
          <h2 className="font-bold text-slate-900">Installez Biz-transPay</h2>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Accédez plus rapidement à votre compte depuis l’écran d’accueil de votre appareil.
          </p>
          {(!installState.canPrompt || installHelpOpen) && (
            <p
              className="mt-2 text-xs leading-relaxed text-slate-500"
              data-testid="pwa-install-instructions"
              aria-live="polite"
            >
              {isAppleMobile
                ? 'Sur iPhone ou iPad : touchez Partager, puis « Sur l’écran d’accueil » et « Ajouter ».'
                : 'Dans le menu de votre navigateur, choisissez « Installer l’application » ou « Ajouter à l’écran d’accueil ».'
              }
            </p>
          )}
          {installError && (
            <p role="alert" className="mt-2 text-xs font-medium text-red-700">
              {installError}
            </p>
          )}
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
        <button
          type="button"
          onClick={() => setDismissed(true)}
          data-testid="btn-dismiss-pwa-prompt"
          className="inline-flex min-h-10 items-center justify-center gap-1 rounded-xl px-3 py-2 text-sm font-semibold text-slate-600 transition hover:bg-slate-100"
        >
          <X className="h-4 w-4" aria-hidden="true" />
          Plus tard
        </button>
        <button
          type="button"
          onClick={markPwaInstalled}
          data-testid="btn-confirm-pwa-installed"
          className="inline-flex min-h-10 items-center justify-center rounded-xl border border-blue-200 bg-white px-4 py-2 text-sm font-semibold text-[#2563EB] transition hover:bg-blue-50"
        >
          J’ai installé l’application
        </button>
        <button
          type="button"
          onClick={install}
          data-testid="btn-install-pwa"
          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-[#2563EB] px-4 py-2 text-sm font-bold text-white transition hover:bg-[#1D4ED8]"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          Installer l’application
        </button>
      </div>
    </section>
  );
}