import { Check, Clock3, LoaderCircle, X } from 'lucide-react';

const STATUS_CONTENT = {
  success: {
    title: 'Retrait réussi',
    Icon: Check,
    iconClass: 'bg-emerald-50 text-emerald-600',
  },
  failed: {
    title: 'Retrait échoué',
    Icon: X,
    iconClass: 'bg-red-50 text-red-600',
  },
  pending: {
    title: 'Retrait toujours en cours',
    Icon: Clock3,
    iconClass: 'bg-amber-50 text-amber-600',
  },
};

function WithdrawalStatusModal({ status, onClose }) {
  const isProcessing = status === 'processing';
  const content = STATUS_CONTENT[status] || STATUS_CONTENT.pending;
  const Icon = isProcessing ? LoaderCircle : content.Icon;

  return (
    <div
      className="fixed inset-0 z-[60] flex min-h-[100dvh] items-center justify-center bg-slate-900/45 p-4 backdrop-blur-sm"
      role="presentation"
    >
      <section
        aria-labelledby="withdrawal-status-title"
        aria-modal="true"
        aria-live="assertive"
        className="w-full max-w-[26rem] rounded-2xl bg-white px-6 py-7 text-center shadow-[0_18px_60px_rgba(15,23,42,0.18)] sm:px-8 sm:py-8"
        role="dialog"
        data-testid="withdrawal-status-modal"
      >
        <div
          className={`mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full ${
            isProcessing ? 'bg-blue-50 text-[#2563EB]' : content.iconClass
          }`}
        >
          <Icon
            aria-hidden="true"
            className={isProcessing ? 'h-7 w-7 animate-spin' : 'h-7 w-7'}
            strokeWidth={isProcessing ? 2.25 : 2.5}
          />
        </div>

        <h2
          className="font-cabinet text-lg font-bold leading-snug text-slate-900 sm:text-xl"
          id="withdrawal-status-title"
        >
          {isProcessing ? 'Traitement en cours' : content.title}
        </h2>

        {isProcessing && (
          <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-slate-500">
            Veuillez patienter pendant le traitement de votre retrait…
          </p>
        )}

        {!isProcessing && (
          <button
            className="mt-6 w-full rounded-full bg-[#2563EB] px-5 py-3 text-sm font-bold text-white transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2"
            onClick={onClose}
            type="button"
          >
            Fermer
          </button>
        )}
      </section>
    </div>
  );
}

export default WithdrawalStatusModal;
