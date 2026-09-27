import { AlertTriangle } from 'lucide-react';

export default function ComplianceWarningModal({ onConfirm, onCancel, busy = false }) {
  return (
    <div onClick={(event) => event.stopPropagation()} className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="compliance-warning-title" data-testid="compliance-warning-modal">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-amber-200 bg-white shadow-2xl">
        <div className="flex items-start gap-3 border-b border-amber-100 bg-amber-50 p-5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-800">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="compliance-warning-title" className="font-cabinet text-lg font-extrabold text-slate-900">
              Activité surveillée et contrôle automatique
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-700">
              En utilisant les services de collecte de Biz-transPay — lien de paiement, API, encaissement, boutique ou transaction — vous confirmez que vos activités respectent nos conditions d’utilisation et les règlements en vigueur.
            </p>
          </div>
        </div>

        <div className="space-y-4 overflow-y-auto p-5 text-xs leading-relaxed text-slate-700">
          <section>
            <h3 className="font-bold text-slate-900">Activités strictement interdites</h3>
            <p className="mt-1">
              Il est strictement interdit d’utiliser la plateforme pour une arnaque, une fausse vente ou une escroquerie, un système Ponzi ou un investissement frauduleux, un jeu d’argent illégal, un produit ou service interdit, une activité trompeuse ou non autorisée, une usurpation d’identité, la revente frauduleuse de services financiers, une collecte non déclarée ou suspecte, un compte partagé ou un accès piraté, ou tout contenu ou service illégal ou non autorisé.
            </p>
          </section>
          <section className="rounded-xl border border-red-100 bg-red-50 p-3 text-red-950">
            <h3 className="font-bold">Contrôles et mesures possibles</h3>
            <p className="mt-1">
              Toutes les transactions sont analysées automatiquement et peuvent être contrôlées manuellement par notre équipe de conformité et de sécurité. En cas de violation, votre compte peut être suspendu immédiatement, vos fonds peuvent être temporairement bloqués, vos services peuvent être désactivés sans préavis, et vos informations peuvent être transmises aux autorités compétentes ou à nos partenaires financiers.
            </p>
          </section>
          <p className="font-semibold text-slate-900">
            Assurez-vous que votre activité est légale, transparente et conforme avant de continuer.
          </p>
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-slate-100 bg-slate-50 p-4 sm:flex-row sm:justify-end">
          <button type="button" onClick={onCancel} disabled={busy} data-testid="compliance-cancel" className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-bold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50">
            Annuler
          </button>
          <button type="button" onClick={onConfirm} disabled={busy} data-testid="compliance-confirm" className="rounded-xl bg-[#2563EB] px-4 py-2.5 text-xs font-bold text-white hover:bg-[#1D4ED8] disabled:cursor-not-allowed disabled:opacity-50">
            {busy ? 'Traitement…' : 'Je confirme être conforme'}
          </button>
        </div>
      </div>
    </div>
  );
}