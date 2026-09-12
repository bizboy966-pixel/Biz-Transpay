import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  X, CheckCircle2, XCircle, User as UserIcon, Mail, MapPin, Phone,
  Wallet, Hash, Calendar, Clock, DollarSign, Percent, Copy,
  ExternalLink, ShieldAlert, RefreshCw,
} from 'lucide-react';
import api from '@/api';

/* Compact key/value row used inside the modal to display any detail. */
function KV({ icon: I, label, value, mono, copyable, testid }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div className="flex items-start gap-3 py-2" data-testid={testid}>
      {I && <div className="mt-0.5 shrink-0 w-7 h-7 rounded-lg bg-slate-100 text-slate-500 flex items-center justify-center"><I className="w-3.5 h-3.5" /></div>}
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-0.5">{label}</div>
        <div className={`text-sm ${mono ? 'font-mono' : ''} text-slate-800 break-all`}>
          {value}
          {copyable && (
            <button onClick={() => { navigator.clipboard.writeText(String(value)); toast.success('Copié'); }}
              className="ml-2 text-slate-400 hover:text-slate-700 inline-flex items-center align-middle">
              <Copy className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const STATUS_COLOR = {
  pending: 'bg-amber-100 text-amber-800 border-amber-200',
  completed: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  failed: 'bg-red-100 text-red-800 border-red-200',
  cancelled: 'bg-slate-100 text-slate-700 border-slate-200',
  canceled: 'bg-slate-100 text-slate-700 border-slate-200',
};

const STATUS_LABEL = {
  pending: 'En attente',
  completed: 'Validé',
  failed: 'Rejeté',
  cancelled: 'Annulé',
  canceled: 'Annulé',
};

export default function AdminTxDetailModal({ txId, open, onClose, onUpdated }) {
  const [tx, setTx] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(null); // 'approve' | 'reject'
  const [showReject, setShowReject] = useState(false);
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!open || !txId) return;
    setLoading(true); setTx(null); setShowReject(false); setReason('');
    api.get(`/admin/transactions/${txId}`)
      .then(({ data }) => setTx(data))
      .catch(() => toast.error('Erreur de chargement'))
      .finally(() => setLoading(false));
  }, [open, txId]);

  if (!open) return null;

  const meta = tx?.metadata || {};
  const user = tx?.user || {};
  const isDeposit = tx?.type === 'deposit';
  const isWithdrawal = tx?.type === 'withdrawal' || (tx?.type === 'transfer' && tx?.direction === 'out');
  const isCrypto = (tx?.currency || '').toUpperCase() === 'USDT'
                    || meta.izipay_intent_id || meta.coin
                    || meta.transfer_type === 'biz_to_crypto';

  const unit = isCrypto ? 'USDT' : (tx?.currency || 'XOF');
  const amount = Number(tx?.amount || 0);
  const feeVal = Number(meta.fee ?? meta.fee_amount ?? 0);
  const netVal = Number(meta.amount_net ?? meta.net_amount ?? (isDeposit ? amount - feeVal : amount - feeVal));

  const approve = async () => {
    if (!window.confirm(`Confirmer la validation de cette ${isDeposit ? 'entrée' : 'sortie'} ?`)) return;
    setBusy('approve');
    try {
      await api.post(`/admin/transactions/${tx.id}/approve`);
      toast.success('Transaction validée');
      onUpdated?.();
      onClose();
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Erreur lors de la validation');
    } finally { setBusy(null); }
  };

  const refresh = async () => {
    setBusy('refresh');
    try {
      const { data } = await api.post(`/admin/transactions/${tx.id}/refresh`);
      if (data?.tx?.status === 'completed') {
        toast.success('Transaction validée automatiquement (déjà exécutée côté passerelle)');
      } else if (data?.tx?.status === 'failed') {
        toast.warning('Retrait échoué côté passerelle — solde recrédité');
      } else {
        toast.info(`Statut passerelle : ${data?.upstream_status || 'inchangé'}`);
      }
      onUpdated?.();
      onClose();
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Erreur lors du rafraîchissement');
    } finally { setBusy(null); }
  };

  const reject = async () => {
    setBusy('reject');
    try {
      await api.post(`/admin/transactions/${tx.id}/reject`, { reason: reason.trim() || null });
      toast.success(isWithdrawal ? 'Rejeté — solde recrédité' : 'Rejeté');
      onUpdated?.();
      onClose();
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Erreur lors du rejet');
    } finally { setBusy(null); }
  };

  const dateObj = tx?.created_at ? new Date(tx.created_at) : null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4"
         data-testid="admin-tx-modal">
      <div className="w-full max-w-2xl max-h-[90vh] overflow-hidden bg-white rounded-2xl shadow-2xl border border-slate-200 flex flex-col">
        {/* Header */}
        <div className="p-5 border-b border-slate-100 flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="font-cabinet font-extrabold text-lg text-slate-900">
                {isDeposit ? 'Dépôt' : isWithdrawal ? 'Retrait' : (tx?.type || 'Transaction')}
                <span className="text-slate-400 font-normal"> · {isCrypto ? 'Crypto' : 'Mobile Money'}</span>
              </div>
              {tx?.status && (
                <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold border ${STATUS_COLOR[tx.status] || 'bg-slate-100 text-slate-700'}`}>
                  {STATUS_LABEL[tx.status] || tx.status}
                </span>
              )}
            </div>
            {tx?.reference && (
              <div className="mt-1 text-[11px] text-slate-500 font-mono">Réf. {tx.reference}</div>
            )}
          </div>
          <button onClick={onClose} data-testid="btn-close-modal" className="w-8 h-8 rounded-lg text-slate-400 hover:text-slate-800 hover:bg-slate-100">
            <X className="w-4 h-4 mx-auto" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading || !tx ? (
            <div className="p-10 text-center text-sm text-slate-500">Chargement…</div>
          ) : (
            <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-x-6">
              {/* User block */}
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">Utilisateur</div>
                <KV icon={UserIcon} label="Nom complet" value={user.full_name || user.username} testid="kv-full-name" />
                <KV icon={Mail} label="Email" value={user.email} testid="kv-email" copyable />
                <KV icon={Phone} label="Téléphone" value={user.phone} testid="kv-phone" />
                <KV icon={MapPin} label="Pays" value={user.country} testid="kv-country" />
                <KV icon={UserIcon} label="ID utilisateur" value={user.id} mono copyable testid="kv-user-id" />
              </div>

              {/* Transaction block */}
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">Transaction</div>
                {isCrypto ? (
                  <>
                    <KV icon={DollarSign} label="Cryptomonnaie" value={meta.coin || (isCrypto ? 'USDT' : null)} testid="kv-coin" />
                    <KV icon={Wallet} label="Réseau" value={meta.network || meta.asset_code} testid="kv-network" />
                    <KV icon={Wallet} label={isDeposit ? 'Adresse de dépôt' : 'Adresse du portefeuille destinataire'}
                        value={meta.wallet_address || meta.deposit_address || meta.destination_address || tx.counterparty}
                        mono copyable testid="kv-address" />
                    <KV icon={Hash} label="Hash de transaction" value={meta.tx_hash || meta.txid} mono copyable testid="kv-hash" />
                  </>
                ) : (
                  <>
                    <KV icon={Wallet} label="Opérateur" value={meta.operator} testid="kv-operator" />
                    <KV icon={Phone} label={isDeposit ? 'Numéro utilisé' : 'Numéro du bénéficiaire'}
                        value={meta.phone_number || meta.recipient || tx.counterparty}
                        mono copyable testid="kv-msisdn" />
                    {meta.recipient_name && <KV icon={UserIcon} label="Nom bénéficiaire" value={meta.recipient_name} testid="kv-recipient-name" />}
                  </>
                )}
                <KV icon={DollarSign} label={isDeposit ? 'Montant reçu' : 'Montant demandé'}
                    value={`${amount.toLocaleString(undefined, { maximumFractionDigits: isCrypto ? 6 : 0 })} ${unit}`}
                    testid="kv-amount" />
                {feeVal > 0 && <KV icon={Percent} label="Frais appliqués" value={`${feeVal.toLocaleString(undefined, { maximumFractionDigits: isCrypto ? 6 : 0 })} ${unit}`} testid="kv-fee" />}
                {netVal > 0 && netVal !== amount && (
                  <KV icon={DollarSign} label={isDeposit ? 'Montant crédité' : 'Montant net envoyé'}
                      value={`${netVal.toLocaleString(undefined, { maximumFractionDigits: isCrypto ? 6 : 0 })} ${unit}`}
                      testid="kv-net" />
                )}
                <KV icon={Hash} label="Identifiant interne" value={tx.id} mono copyable testid="kv-tx-id" />
                {(meta.izipay_intent_id || meta.izipay_payout_id) && (
                  <KV icon={Hash} label="ID passerelle" value={meta.izipay_intent_id || meta.izipay_payout_id} mono copyable testid="kv-provider-id" />
                )}
                {dateObj && (
                  <>
                    <KV icon={Calendar} label="Date" value={dateObj.toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' })} testid="kv-date" />
                    <KV icon={Clock} label="Heure" value={dateObj.toLocaleTimeString('fr-FR')} testid="kv-time" />
                  </>
                )}
              </div>

              {/* Additional info spanning full width */}
              {(tx.description || meta.rejection_reason || tx.rejection_reason) && (
                <div className="md:col-span-2 mt-3 pt-3 border-t border-slate-100">
                  {tx.description && <KV label="Description" value={tx.description} testid="kv-description" />}
                  {(tx.rejection_reason || meta.rejection_reason) && (
                    <div className="mt-2 p-3 rounded-lg bg-red-50 border border-red-200 text-[13px] text-red-800 flex items-start gap-2">
                      <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" />
                      <div>
                        <div className="font-semibold">Motif du rejet</div>
                        <div>{tx.rejection_reason || meta.rejection_reason}</div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Reject reason input */}
              {showReject && (
                <div className="md:col-span-2 mt-4 p-4 rounded-xl bg-red-50 border border-red-200">
                  <div className="text-sm font-semibold text-red-900 mb-2">Motif du rejet (recommandé)</div>
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    data-testid="input-reject-reason"
                    rows={3}
                    placeholder="Ex : Adresse invalide, KYC incomplet, montant suspect…"
                    className="w-full px-3 py-2 rounded-lg border border-red-300 bg-white focus:outline-none focus:ring-2 focus:ring-red-500/20 text-sm resize-none"
                  />
                  <div className="mt-2 flex justify-end gap-2">
                    <button onClick={() => { setShowReject(false); setReason(''); }} data-testid="btn-cancel-reject" className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-700 hover:bg-white">Annuler</button>
                    <button onClick={reject} disabled={busy === 'reject'} data-testid="btn-confirm-reject" className="px-3 py-1.5 rounded-lg bg-red-600 text-white text-xs font-semibold hover:bg-red-700 disabled:opacity-40 inline-flex items-center gap-1">
                      <XCircle className="w-3.5 h-3.5" />
                      {busy === 'reject' ? 'Rejet…' : 'Confirmer le rejet'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer with actions */}
        {tx && tx.status === 'pending' && !showReject && (
          <div className="p-4 border-t border-slate-100 bg-slate-50 flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:justify-end">
            {isWithdrawal && isCrypto && meta?.izipay_payout_id && (
              <button
                onClick={refresh}
                disabled={busy === 'refresh'}
                data-testid="btn-refresh-tx"
                className="px-4 py-2 rounded-lg border border-blue-200 bg-white text-blue-700 font-semibold text-sm hover:bg-blue-50 inline-flex items-center justify-center gap-1.5">
                <RefreshCw className={`w-4 h-4 ${busy === 'refresh' ? 'animate-spin' : ''}`} />
                {busy === 'refresh' ? 'Vérification…' : 'Rafraîchir statut passerelle'}
              </button>
            )}
            <button
              onClick={() => setShowReject(true)}
              data-testid="btn-reject"
              className="px-4 py-2 rounded-lg border border-red-200 bg-white text-red-700 font-semibold text-sm hover:bg-red-50 inline-flex items-center justify-center gap-1.5">
              <XCircle className="w-4 h-4" /> Rejeter
            </button>
            <button
              onClick={approve}
              disabled={busy === 'approve'}
              data-testid="btn-approve"
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-sm disabled:opacity-40 inline-flex items-center justify-center gap-1.5">
              <CheckCircle2 className="w-4 h-4" />
              {busy === 'approve' ? 'Validation…' : 'Valider'}
            </button>
          </div>
        )}
        {tx && tx.status !== 'pending' && (
          <div className="p-4 border-t border-slate-100 bg-slate-50 flex items-center justify-between text-[11px] text-slate-500">
            <span>Transaction déjà {STATUS_LABEL[tx.status] || tx.status}{tx.approved_by ? ` par @${tx.approved_by}` : tx.rejected_by ? ` par @${tx.rejected_by}` : ''}.</span>
            <a href={`/admin/transactions?q=${tx.reference || tx.id}`} className="inline-flex items-center gap-1 font-semibold text-slate-700 hover:text-slate-900">
              Voir dans l'historique <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
