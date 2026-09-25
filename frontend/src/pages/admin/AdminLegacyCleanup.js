import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import api from '@/api';

const ENDPOINT = '/admin/maintenance/legacy-merchant-api';
const REQUIRED_PHRASE = 'RETIRER_ANCIENNE_API';

function getErrorMessage(error, fallback) {
  const detail = error.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  if (detail?.message) return detail.message;
  return fallback;
}

function Counts({ counts }) {
  const entries = Object.entries(counts || {});
  if (!entries.length) return <p className="text-sm text-slate-500">Aucun élément recensé.</p>;
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {entries.map(([collection, count]) => (
        <div key={collection} className="rounded-xl bg-slate-50 border border-slate-200 p-3">
          <dt className="text-xs text-slate-500 break-all">{collection}</dt>
          <dd className="mt-1 font-bold text-slate-900">{count}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function AdminLegacyCleanup() {
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [executing, setExecuting] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [fingerprintInput, setFingerprintInput] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const loadPreview = async () => {
    setLoading(true);
    setError('');
    setResult(null);
    setPhrase('');
    setFingerprintInput('');
    try {
      const { data } = await api.get(ENDPOINT);
      setPreview(data);
    } catch (err) {
      setPreview(null);
      setError(getErrorMessage(err, 'Impossible de charger l’aperçu. Vérifiez vos droits, votre authentification récente et le MFA.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPreview();
  }, []);

  const canExecute = !loading
    && !executing
    && !result
    && Number(preview?.total) > 0
    && phrase === REQUIRED_PHRASE
    && fingerprintInput === preview?.fingerprint;

  const executeCleanup = async (event) => {
    event.preventDefault();
    if (!canExecute) return;
    setExecuting(true);
    setError('');
    try {
      const { data } = await api.post(ENDPOINT, {
        confirmation: REQUIRED_PHRASE,
        fingerprint: preview.fingerprint,
      });
      setResult(data);
      setPreview(null);
      setPhrase('');
      setFingerprintInput('');
    } catch (err) {
      setError(getErrorMessage(err, 'La suppression a échoué. Rien ne doit être considéré comme supprimé ; rechargez l’aperçu avant toute nouvelle tentative.'));
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div className="max-w-4xl space-y-6" data-testid="admin-legacy-cleanup-page">
      <header>
        <h1 className="font-cabinet font-extrabold text-xl text-slate-900">Nettoyage de l’ancienne API marchande</h1>
        <p className="mt-1 text-sm text-slate-500">
          Outil de maintenance temporaire — l’aperçu ne supprime aucune donnée.
        </p>
      </header>

      <section className="rounded-2xl border border-red-200 bg-red-50 p-4 sm:p-5" role="alert">
        <div className="flex gap-3">
          <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
          <div className="text-sm leading-relaxed text-red-950">
            <h2 className="font-bold">Suppression irréversible — à effectuer après publication uniquement</h2>
            <p className="mt-2">
              Cette action supprime définitivement les données de l’ancienne API marchande, y compris les opérations
              en attente ou dont le résultat est incertain. Elles ne pourront pas faire l’objet d’une réconciliation
              ultérieure. Cette suppression ne modifie aucun solde.
            </p>
            <p className="mt-2 font-semibold">
              L’exécution est réservée au propriétaire et requiert une authentification récente et le MFA ; le serveur
              vérifie ces conditions. Vérifiez soigneusement l’aperçu avant de confirmer.
            </p>
          </div>
        </div>
      </section>

      {error && (
        <div className="rounded-xl border border-red-200 bg-white p-4 text-sm text-red-800" role="alert" data-testid="legacy-cleanup-error">
          <span className="font-bold">Erreur : </span>{error}
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-sm text-slate-500" data-testid="legacy-cleanup-loading">
          <Loader2 className="w-4 h-4 animate-spin" /> Chargement de l’aperçu…
        </div>
      )}

      {!loading && preview && (
        <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 space-y-4" data-testid="legacy-cleanup-preview">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-cabinet font-bold text-base text-slate-900">Aperçu des données concernées</h2>
              <p className="mt-1 text-xs text-slate-500">Aucune donnée n’a été supprimée à ce stade.</p>
            </div>
            <button
              type="button"
              onClick={loadPreview}
              disabled={executing}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              data-testid="legacy-cleanup-refresh"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Actualiser l’aperçu
            </button>
          </div>
          <div className="rounded-xl bg-slate-900 p-4 text-white">
            <div className="text-xs text-slate-300">Total à supprimer</div>
            <div className="mt-1 text-3xl font-extrabold" data-testid="legacy-cleanup-total">{preview.total}</div>
          </div>
          <div>
            <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Détail par collection</h3>
            <Counts counts={preview.counts} />
          </div>
          <div>
            <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-500">Empreinte de cet aperçu</h3>
            <code className="block rounded-lg bg-slate-100 p-3 text-xs text-slate-800 break-all" data-testid="legacy-cleanup-fingerprint">
              {preview.fingerprint}
            </code>
          </div>

          {Number(preview.total) > 0 ? (
            <form onSubmit={executeCleanup} className="space-y-4 border-t border-slate-200 pt-4">
              <p className="text-sm font-semibold text-slate-800">
                Pour confirmer, saisissez exactement la phrase et l’empreinte affichées ci-dessus.
              </p>
              <label className="block text-xs font-semibold text-slate-700">
                Phrase de confirmation
                <input
                  value={phrase}
                  onChange={(event) => setPhrase(event.target.value)}
                  autoComplete="off"
                  spellCheck="false"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-100"
                  placeholder={REQUIRED_PHRASE}
                  data-testid="legacy-cleanup-confirmation"
                />
              </label>
              <label className="block text-xs font-semibold text-slate-700">
                Empreinte de l’aperçu
                <input
                  value={fingerprintInput}
                  onChange={(event) => setFingerprintInput(event.target.value)}
                  autoComplete="off"
                  spellCheck="false"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-100"
                  data-testid="legacy-cleanup-fingerprint-confirmation"
                />
              </label>
              <button
                type="submit"
                disabled={!canExecute}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-red-700 px-4 py-2.5 text-sm font-bold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-40"
                data-testid="legacy-cleanup-execute"
              >
                {executing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                {executing ? 'Suppression en cours…' : 'Supprimer définitivement ces données'}
              </button>
            </form>
          ) : (
            <p className="rounded-lg bg-emerald-50 p-3 text-sm font-semibold text-emerald-800">
              Aucun élément à supprimer. L’exécution est désactivée.
            </p>
          )}
        </section>
      )}

      {result && (
        <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 space-y-3" role="status" data-testid="legacy-cleanup-result">
          <div className="flex items-center gap-2 font-bold text-emerald-900">
            <CheckCircle2 className="w-5 h-5" /> Suppression terminée
          </div>
          <p className="text-sm text-emerald-900">
            {result.deleted} élément(s) supprimé(s). Aucun solde n’a été modifié.
          </p>
          <p className="text-xs font-semibold text-emerald-900">Détail retourné par le serveur</p>
          <Counts counts={result.counts} />
          <p className="text-xs text-emerald-800">Total retourné : {result.total}</p>
        </section>
      )}
    </div>
  );
}