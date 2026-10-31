import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Mail, Save, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';
import { useAuth } from '@/context/AuthContext';

const EVENT_OPTIONS = [
  { id: 'deposit_confirmed', label: 'Dépôt confirmé' },
  { id: 'withdrawal_success', label: 'Retrait réussi uniquement' },
  { id: 'exchange_success', label: 'Échange réussi' },
  { id: 'payment_final', label: 'Paiement ou transfert initié par ce compte et réussi' },
  { id: 'kyc_verified', label: 'Vérification KYC validée' },
  { id: 'kyc_rejected', label: 'Vérification KYC rejetée' },
  { id: 'kyc_resubmit_requested', label: 'Nouveaux documents KYC demandés' },
];

const CONTENT_OPTIONS = [
  { id: 'event_status', label: 'Type et statut' },
  { id: 'amount_currency', label: 'Montant et devise' },
  { id: 'fee', label: 'Frais déduits' },
  { id: 'reference', label: 'Référence Biz-transPay' },
  { id: 'event_time', label: 'Date et heure' },
];

const EMPTY_SETTINGS = {
  enabled: false,
  withdrawal_otp_enabled: false,
  withdrawal_otp_active: false,
  sender_email: '',
  recipient_type: 'transaction_user',
  event_types: EVENT_OPTIONS.map((item) => item.id),
  content_fields: CONTENT_OPTIONS.map((item) => item.id),
  resend_configured: false,
  sender_configured: false,
  ready_to_send: false,
  active: false,
  password_reset_ready: false,
};

function toggle(values, value) {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value];
}

export default function AdminEmailNotifications() {
  const { user } = useAuth();
  const [settings, setSettings] = useState(null);
  const [senderEmail, setSenderEmail] = useState('');
  const [events, setEvents] = useState(EMPTY_SETTINGS.event_types);
  const [contentFields, setContentFields] = useState(EMPTY_SETTINGS.content_fields);
  const [enabled, setEnabled] = useState(false);
  const [withdrawalOtpEnabled, setWithdrawalOtpEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const canEdit = user?.permissions?.includes('*')
    || user?.permissions?.includes('settings:write');

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/admin/email-notifications');
      setSettings(data);
      setSenderEmail(data.sender_email || '');
      setEvents(data.event_types || []);
      setContentFields(data.content_fields || []);
      setEnabled(Boolean(data.enabled));
      setWithdrawalOtpEnabled(Boolean(data.withdrawal_otp_enabled));
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Impossible de charger les réglages e-mail.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const canActivate = Boolean(
    settings?.resend_configured
    && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(senderEmail.trim()),
  );

  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      const { data } = await api.put('/admin/email-notifications', {
        enabled,
        withdrawal_otp_enabled: withdrawalOtpEnabled,
        sender_email: senderEmail.trim() || null,
        event_types: events,
        content_fields: contentFields,
      });
      setSettings(data);
      setSenderEmail(data.sender_email || '');
      setEnabled(Boolean(data.enabled));
      setWithdrawalOtpEnabled(Boolean(data.withdrawal_otp_enabled));
      toast.success('Réglages e-mail enregistrés.');
    } catch (error) {
      const detail = error.response?.data?.detail;
      toast.error(typeof detail === 'string' ? detail : 'Impossible d’enregistrer les réglages.');
    } finally {
      setSaving(false);
    }
  };

  if (loading || !settings) {
    return <div className="text-sm text-slate-500">Chargement…</div>;
  }

  return (
    <div className="space-y-6" data-testid="admin-email-notifications">
      <div>
        <div className="flex items-center gap-2">
          <Mail className="w-5 h-5 text-blue-600" />
           <h1 className="font-cabinet font-extrabold text-slate-900 text-xl">Notifications par e-mail</h1>
        </div>
        <p className="mt-2 text-sm text-slate-500">
          Sélectionnez les événements et les informations envoyés par e-mail. Les décisions KYC sont notifiées dès leur enregistrement.
        </p>
      </div>

      <form onSubmit={save} className="space-y-5">
        <section className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-4">
          <h2 className="font-bold text-slate-900">Destinataire</h2>
          <div className="rounded-xl bg-blue-50 border border-blue-100 p-4 text-sm text-blue-900">
            <b>Adresse e-mail du compte concerné</b>
            <p className="mt-1 text-blue-800">
              Les e-mails de transaction vont à la personne qui a lancé l’opération. Les décisions KYC vont à la personne dont le dossier a été examiné.
            </p>
          </div>
        </section>

        <section className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-3">
          <h2 className="font-bold text-slate-900">Événements</h2>
          {EVENT_OPTIONS.map((item) => (
            <label key={item.id} className="flex items-center gap-3 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={events.includes(item.id)}
                disabled={!canEdit}
                onChange={() => setEvents((current) => toggle(current, item.id))}
                className="w-4 h-4 accent-blue-600"
              />
              {item.label}
            </label>
          ))}
          <p className="text-xs text-slate-500">
            Les retraits échoués, refusés ou remboursés ne déclenchent aucun e-mail. Les décisions KYC sont envoyées au compte concerné.
          </p>
        </section>

        <section className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-3">
          <h2 className="font-bold text-slate-900">Informations incluses</h2>
          {CONTENT_OPTIONS.map((item) => (
            <label key={item.id} className="flex items-center gap-3 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={contentFields.includes(item.id)}
                disabled={!canEdit}
                onChange={() => setContentFields((current) => toggle(current, item.id))}
                className="w-4 h-4 accent-blue-600"
              />
              {item.label}
            </label>
          ))}
          <p className="text-xs text-slate-500">
            Les motifs de rejet ou de resoumission sont inclus dans les e-mails KYC. Aucun document d’identité ni détail fournisseur n’est joint.
          </p>
        </section>

        <section className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-4">
          <div>
            <h2 className="font-bold text-slate-900">Expéditeur Resend</h2>
            <p className="mt-1 text-xs text-slate-500">
              Saisissez une adresse sur un domaine validé dans Resend.
            </p>
          </div>
          <input
            type="email"
            value={senderEmail}
            onChange={(event) => setSenderEmail(event.target.value)}
            disabled={!canEdit}
            maxLength={254}
            placeholder="notifications@biz-transpay.com"
            className="bt-field"
          />
          {!settings.resend_configured && (
            <div className="flex gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <p>
                Le serveur Plesk ne détecte pas Resend. Ajoutez <code>RESEND_API_KEY</code> dans
                Plesk &gt; Node.js &gt; Environment Variables, enregistrez, puis redémarrez
                l’application. Ne collez jamais cette clé dans ce panneau.
              </p>
            </div>
          )}
          {settings.resend_configured && !settings.sender_configured && (
            <div className="flex gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <p>Saisissez une adresse d’expédition valide appartenant à un domaine vérifié dans Resend.</p>
            </div>
          )}
          {settings.resend_configured && settings.sender_configured && (
            <p className="text-xs text-slate-500">
              Vérifiez aussi dans Resend que le domaine de cette adresse est confirmé. Le format seul ne prouve pas que le domaine est validé.
            </p>
          )}
          {!settings.password_reset_ready && (
            <p className="text-xs text-slate-500">
              Le lien de réinitialisation par e-mail nécessite aussi une URL publique configurée côté serveur.
            </p>
          )}
        </section>

        <section className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 flex items-start justify-between gap-4">
          <div className="flex gap-3">
            <ShieldCheck className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
            <div>
              <h2 className="font-bold text-slate-900">Code OTP pour les transferts sortants</h2>
              <p className="mt-1 text-xs text-slate-500">
                Demande un code envoyé à l’e-mail du compte avant tout retrait ou transfert Biz-à-Biz.
                Le code est à usage unique et expire au plus tard après 10 minutes. Aucun mouvement
                n’est exécuté si le code ne peut pas être envoyé.
              </p>
              {!canActivate && (
                <p className="mt-2 text-xs text-amber-700">
                  Configurez Resend et confirmez l’adresse d’expédition pour activer cette protection.
                </p>
              )}
            </div>
          </div>
          <label className={`relative inline-flex items-center shrink-0 ${canEdit && (canActivate || withdrawalOtpEnabled) ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}>
            <input
              type="checkbox"
              checked={withdrawalOtpEnabled}
              disabled={!canEdit || (!canActivate && !withdrawalOtpEnabled)}
              onChange={(event) => setWithdrawalOtpEnabled(event.target.checked)}
              className="sr-only peer"
              aria-label="Activer le code OTP pour les transferts sortants"
            />
            <span className="w-12 h-6 rounded-full bg-slate-300 peer-checked:bg-emerald-500 after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:w-5 after:h-5 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-6" />
          </label>
        </section>

        <section className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 flex items-center justify-between gap-4">
          <div>
            <h2 className="font-bold text-slate-900">Activer les notifications</h2>
            <p className="mt-1 text-xs text-slate-500">
              Aucun envoi n’est activé tant que l’adresse d’expédition et Resend ne sont pas configurés.
            </p>
          </div>
          <label className={`relative inline-flex items-center ${canEdit && (canActivate || enabled) ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}>
            <input
              type="checkbox"
              checked={enabled}
              disabled={!canEdit || (!canActivate && !enabled)}
              onChange={(event) => setEnabled(event.target.checked)}
              className="sr-only peer"
            />
            <span className="w-12 h-6 rounded-full bg-slate-300 peer-checked:bg-emerald-500 after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:w-5 after:h-5 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-6" />
          </label>
        </section>

        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <button
            type="submit"
            disabled={!canEdit || saving}
            className="bt-button-primary inline-flex items-center justify-center gap-2 px-5 py-3 disabled:opacity-50"
          >
            <Save className="w-4 h-4" />
            {saving ? 'Enregistrement…' : 'Enregistrer'}
          </button>
          <span className={`inline-flex items-center gap-2 text-sm ${settings.active ? 'text-emerald-700' : 'text-slate-500'}`}>
            {settings.active ? <Check className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
            {settings.active
              ? 'Notifications actives'
              : settings.withdrawal_otp_active
                ? 'Confirmation OTP active'
                : 'Notifications désactivées'}
          </span>
        </div>
      </form>
    </div>
  );
}