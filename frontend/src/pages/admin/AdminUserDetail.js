import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Lock, Unlock, UserX, UserCheck, ArrowUpFromLine, ArrowDownToLine, Plus, Minus, KeyRound, ShieldCheck, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';

export default function AdminUserDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [modal, setModal] = useState(null); // 'credit' | 'debit' | 'action' | 'reset'
  const [amount, setAmount] = useState('');
  const [walletId, setWalletId] = useState('XOF');
  const [wallets, setWallets] = useState([]);
  const [walletsLoading, setWalletsLoading] = useState(false);
  const [walletsError, setWalletsError] = useState(false);
  const [walletRetry, setWalletRetry] = useState(0);
  const [reason, setReason] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [pending, setPending] = useState(false);
  const [balanceActionId, setBalanceActionId] = useState(null);

  const load = () => api.get(`/admin/users/${id}`).then(({ data }) => setData(data)).catch(() => {});
  // `load` is intentionally recreated when the route id changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [id]);

  useEffect(() => {
    if (modal?.type !== 'credit' && modal?.type !== 'debit') return undefined;
    let active = true;
    setWallets([]);
    setWalletsLoading(true);
    setWalletsError(false);
    api.get(`/admin/users/${id}/balance-wallets`)
      .then(({ data: walletData }) => {
        if (!active) return;
        setWallets(Array.isArray(walletData?.wallets) ? walletData.wallets : []);
        setWalletsError(false);
      })
      .catch(() => {
        if (active) setWalletsError(true);
      })
      .finally(() => {
        if (active) setWalletsLoading(false);
      });
    return () => { active = false; };
  }, [id, modal?.type, walletRetry]);

  const confirmCriticalAction = (label) => (
    window.prompt(`${label}\nSaisissez CONFIRMER pour continuer.`)?.trim().toUpperCase() === 'CONFIRMER'
  );

  if (!data) return <div className="text-slate-500 text-sm">Chargement…</div>;
  const u = data.user;
  const fiatWallets = [
    { id: 'XOF', currency: 'XOF', balance: wallets.find((wallet) => wallet.id === 'XOF')?.balance ?? u.balance_xof ?? 0 },
    { id: 'XAF', currency: 'XAF', balance: wallets.find((wallet) => wallet.id === 'XAF')?.balance ?? u.balance_xaf ?? 0 },
  ];
  const cryptoWallets = wallets.filter((wallet) => wallet.asset_id && wallet.id && wallet.id !== 'XOF' && wallet.id !== 'XAF');
  const walletOptions = [...fiatWallets, ...cryptoWallets];
  const selectedWallet = walletOptions.find((wallet) => wallet.id === walletId) || fiatWallets[0];
  const walletLabel = (wallet) => {
    if (!wallet.asset_id) return wallet.currency;
    const coin = wallet.coin || wallet.currency;
    const network = wallet.network_name || wallet.network || wallet.id.split('.').slice(1).join('.');
    return network ? `${coin} · ${network}` : coin;
  };

  const doAction = async (action) => {
    setPending(true);
    try {
      await api.post(`/admin/users/${id}/action/${action}`, { reason });
      toast.success('Action effectuée');
      setModal(null); setReason('');
      load();
    } catch (err) { toast.error(err.response?.data?.detail || 'Erreur'); }
    finally { setPending(false); }
  };

  const doBalance = async (dir) => {
    const selectedWallet = walletOptions.find((wallet) => wallet.id === walletId);
    if (!selectedWallet || pending) return;
    if (!confirmCriticalAction(dir === 'credit' ? 'Confirmer le crédit administrateur ?' : 'Confirmer le débit administrateur ?')) return;
    setPending(true);
    try {
      const body = {
        amount: parseFloat(amount), currency: selectedWallet.currency, reason,
        confirmation: 'CONFIRMER', action_id: balanceActionId,
      };
      if (selectedWallet.asset_id) body.asset_id = selectedWallet.asset_id;
      await api.post(`/admin/users/${id}/${dir}`, body);
      toast.success(dir === 'credit' ? 'Compte crédité' : 'Compte débité');
      setModal(null); setAmount(''); setReason(''); setBalanceActionId(null);
      load();
    } catch (err) { toast.error(err.response?.data?.detail || 'Erreur'); }
    finally { setPending(false); }
  };

  const doReset = async () => {
    if (!confirmCriticalAction('Confirmer la réinitialisation du mot de passe ?')) return;
    setPending(true);
    try {
      await api.post(`/admin/users/${id}/reset-password`, { new_password: newPwd, confirmation: 'CONFIRMER' });
      toast.success('Mot de passe réinitialisé');
      setModal(null); setNewPwd('');
    } catch (err) { toast.error(err.response?.data?.detail || 'Erreur'); }
    finally { setPending(false); }
  };

  const actions = [
    { k: 'block', l: 'Bloquer le compte', I: Lock, c: 'bg-red-50 text-red-600', disabled: u.is_blocked },
    { k: 'unblock', l: 'Débloquer le compte', I: Unlock, c: 'bg-emerald-50 text-emerald-600', disabled: !u.is_blocked || u.is_banned },
    { k: 'ban', l: 'Bannir le compte', I: UserX, c: 'bg-red-50 text-red-600', disabled: u.is_banned },
    { k: 'unban', l: 'Débannir le compte', I: UserCheck, c: 'bg-emerald-50 text-emerald-600', disabled: !u.is_banned },
    { k: 'block_withdrawals', l: 'Bloquer les retraits', I: ShieldOff, c: 'bg-orange-50 text-orange-600', disabled: u.withdrawals_blocked },
    { k: 'unblock_withdrawals', l: 'Autoriser les retraits', I: ShieldCheck, c: 'bg-blue-50 text-[#2563EB]', disabled: !u.withdrawals_blocked },
  ];

  return (
    <div className="space-y-5" data-testid="admin-user-detail">
      <button onClick={() => nav('/admin/users')} className="inline-flex items-center gap-2 text-xs font-semibold text-slate-600 hover:text-[#2563EB]" data-testid="btn-back-admin-users">
        <ArrowLeft className="w-4 h-4" /> Retour aux utilisateurs
      </button>

      {/* User header */}
      <div className="bg-white border border-slate-100 rounded-2xl p-6">
        <div className="flex items-start gap-4">
          <div className="w-14 h-14 rounded-full bg-gradient-to-br from-[#3B82F6] to-[#1D4ED8] text-white flex items-center justify-center font-bold">{u.full_name?.[0]?.toUpperCase()}</div>
          <div className="flex-1">
            <div className="font-cabinet font-extrabold text-xl text-slate-900">{u.full_name}</div>
            <div className="text-sm text-slate-500">@{u.username} · {u.email} · {u.phone}</div>
            <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
              <span className="px-2 py-0.5 rounded-full bg-blue-50 text-[#2563EB] font-bold">{u.account_type === 'merchant' ? 'Marchand' : 'Personnel'}</span>
              <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 font-bold">{u.country}</span>
              <span className={`px-2 py-0.5 rounded-full font-bold ${u.role === 'super_admin' ? 'bg-violet-50 text-violet-700' : u.role === 'admin' ? 'bg-blue-50 text-[#2563EB]' : 'bg-slate-100 text-slate-600'}`}>
                {u.role === 'super_admin' ? 'Super Admin' : u.role === 'admin' ? 'Admin' : 'Utilisateur'}
              </span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-widest text-slate-400 font-bold">Inscrit le</div>
            <div className="text-sm font-semibold text-slate-800">{new Date(u.created_at).toLocaleDateString()}</div>
          </div>
        </div>
      </div>

      {/* Balances */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {[{ c: 'XOF', v: u.balance_xof }, { c: 'XAF', v: u.balance_xaf }, { c: 'USDT', label: 'USDT historique · sans réseau', v: u.balance_usdt }].map((b) => (
          <div key={b.c} className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-[#3B82F6] via-[#2563EB] to-[#1D4ED8] p-5 text-white">
            <div className="absolute -top-10 -right-10 w-32 h-32 rounded-full bg-white/10" />
            <div className="relative">
              <div className="text-[10px] uppercase tracking-widest text-white/80 font-semibold">Solde {b.label || b.c}</div>
              <div className="mt-1 font-cabinet font-extrabold text-2xl">{(b.v || 0).toLocaleString()} <span className="text-xs opacity-80">{b.c}</span></div>
            </div>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="bg-white border border-slate-100 rounded-2xl p-5">
        <div className="mb-4">
          <h2 className="font-cabinet font-bold text-slate-900">Actions sur l'utilisateur</h2>
          <p className="text-xs text-slate-500 mt-0.5">Gérer et effectuer des actions sur le compte sélectionné</p>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {actions.map((a) => (
            <button
              key={a.k}
              onClick={() => { setModal({ type: 'action', action: a.k, label: a.l }); }}
              disabled={a.disabled}
              data-testid={`user-action-${a.k}`}
              className={`flex items-center gap-2.5 p-3 border border-slate-200 rounded-xl hover:border-[#2563EB] hover:-translate-y-0.5 transition-transform text-left disabled:opacity-40 disabled:cursor-not-allowed disabled:transform-none`}
            >
              <div className={`w-9 h-9 rounded-lg ${a.c} flex items-center justify-center`}><a.I className="w-4 h-4" /></div>
              <div className="text-xs font-semibold text-slate-800">{a.l}</div>
            </button>
          ))}
            <button onClick={() => { setWalletId('XOF'); setBalanceActionId(crypto.randomUUID()); setModal({ type: 'credit' }); }} data-testid="user-action-credit" className="flex items-center gap-2.5 p-3 border border-slate-200 rounded-xl hover:border-[#2563EB] hover:-translate-y-0.5 transition-transform text-left">
            <div className="w-9 h-9 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center"><Plus className="w-4 h-4" /></div>
            <div className="text-xs font-semibold text-slate-800">Créditer le compte</div>
          </button>
            <button onClick={() => { setWalletId('XOF'); setBalanceActionId(crypto.randomUUID()); setModal({ type: 'debit' }); }} data-testid="user-action-debit" className="flex items-center gap-2.5 p-3 border border-slate-200 rounded-xl hover:border-[#2563EB] hover:-translate-y-0.5 transition-transform text-left">
            <div className="w-9 h-9 rounded-lg bg-red-50 text-red-600 flex items-center justify-center"><Minus className="w-4 h-4" /></div>
            <div className="text-xs font-semibold text-slate-800">Débiter le compte</div>
          </button>
          <button onClick={() => { setModal({ type: 'reset' }); }} data-testid="user-action-reset" className="flex items-center gap-2.5 p-3 border border-slate-200 rounded-xl hover:border-[#2563EB] hover:-translate-y-0.5 transition-transform text-left">
            <div className="w-9 h-9 rounded-lg bg-blue-50 text-[#2563EB] flex items-center justify-center"><KeyRound className="w-4 h-4" /></div>
            <div className="text-xs font-semibold text-slate-800">Réinitialiser le mot de passe</div>
          </button>
        </div>
        <div className="mt-4 flex items-center gap-2 text-[11px] text-blue-700 bg-blue-50 border border-blue-100 rounded-lg p-3">
          <ShieldCheck className="w-4 h-4" /> Les actions sont appliquées immédiatement et enregistrées dans le journal d'activités.
        </div>
      </div>

      {/* Recent transactions */}
      <div className="bg-white border border-slate-100 rounded-2xl">
        <div className="p-5 border-b border-slate-100 flex items-center justify-between">
          <h2 className="font-cabinet font-bold text-slate-900">Historique des transactions</h2>
          <span className="text-xs text-slate-500">{data.transactions_count} au total</span>
        </div>
        <div className="divide-y divide-slate-50">
          {data.recent_transactions.length === 0 && <div className="p-8 text-center text-slate-400 text-sm">Aucune transaction</div>}
          {data.recent_transactions.map((tx) => (
            <div key={tx.id} className="p-4 flex items-center gap-3">
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${tx.direction === 'in' ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}`}>
                {tx.direction === 'in' ? <ArrowDownToLine className="w-4 h-4" /> : <ArrowUpFromLine className="w-4 h-4" />}
              </div>
              <div className="flex-1">
                <div className="text-sm font-semibold text-slate-900">{tx.type} · {tx.reference}</div>
                <div className="text-[11px] text-slate-500">{new Date(tx.created_at).toLocaleString()}</div>
              </div>
              <div className={`font-bold text-sm ${tx.direction === 'in' ? 'text-emerald-600' : 'text-slate-900'}`}>
                {tx.direction === 'in' ? '+' : '-'}{tx.amount.toLocaleString()} <span className="text-xs opacity-70">{tx.currency}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Modals */}
      {modal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setModal(null)}>
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl p-6 max-w-md w-full shadow-2xl" data-testid="admin-modal">
            {modal.type === 'action' && (
              <>
                <h3 className="font-cabinet font-bold text-lg mb-3">{modal.label}</h3>
                <p className="text-sm text-slate-500 mb-4">Cette action sera enregistrée dans le journal d'audit. Ajoutez une raison si nécessaire.</p>
                <textarea value={reason} onChange={(e) => setReason(e.target.value)} data-testid="modal-reason" placeholder="Raison (optionnel)" rows={3} className="w-full px-3 py-2 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB]" />
                <div className="mt-4 flex gap-2 justify-end">
                  <button onClick={() => setModal(null)} className="px-4 py-2 rounded-full border border-slate-200 font-semibold text-sm">Annuler</button>
                  <button onClick={() => doAction(modal.action)} disabled={pending} data-testid="modal-confirm" className="px-4 py-2 rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-semibold text-sm disabled:opacity-60">Confirmer</button>
                </div>
              </>
            )}
            {(modal.type === 'credit' || modal.type === 'debit') && (
              <>
                <h3 className="font-cabinet font-bold text-lg mb-3">{modal.type === 'credit' ? 'Créditer le compte' : 'Débiter le compte'}</h3>
                <div className="space-y-3">
                  <div className="grid grid-cols-[1fr_auto] gap-2">
                    <input type="number" data-testid="modal-amount" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Montant" className="px-3 py-2.5 border border-slate-200 rounded-xl outline-none" />
                    <select value={walletId} onChange={(e) => setWalletId(e.target.value)} data-testid="modal-currency" className="px-3 py-2.5 border border-slate-200 rounded-xl font-semibold text-sm">
                      {walletOptions.map((wallet) => <option key={wallet.id} value={wallet.id}>{walletLabel(wallet)}</option>)}
                    </select>
                  </div>
                  <div className="flex items-center justify-between text-xs text-slate-500" data-testid="selected-wallet-balance">
                    <span>Solde actuel · {walletLabel(selectedWallet)}</span>
                    <span className="font-semibold text-slate-700">{Number(selectedWallet.balance || 0).toLocaleString()} {selectedWallet.currency}</span>
                  </div>
                  {walletsLoading && <p className="text-xs text-slate-500" role="status">Chargement des portefeuilles crypto…</p>}
                  {walletsError && (
                    <div className="flex items-center justify-between gap-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800" role="alert">
                      <span>Portefeuilles crypto indisponibles. XOF et XAF restent disponibles.</span>
                      <button type="button" onClick={() => setWalletRetry((retry) => retry + 1)} className="shrink-0 font-bold underline" data-testid="wallets-retry">Réessayer</button>
                    </div>
                  )}
                  <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Raison" rows={3} className="w-full px-3 py-2 border border-slate-200 rounded-xl outline-none" />
                </div>
                <div className="mt-4 flex gap-2 justify-end">
                  <button onClick={() => setModal(null)} className="px-4 py-2 rounded-full border border-slate-200 font-semibold text-sm">Annuler</button>
                  <button onClick={() => doBalance(modal.type)} disabled={pending || !amount} data-testid="modal-balance-confirm" className={`px-4 py-2 rounded-full text-white font-semibold text-sm disabled:opacity-60 ${modal.type === 'credit' ? 'bg-emerald-500 hover:bg-emerald-600' : 'bg-red-500 hover:bg-red-600'}`}>Confirmer</button>
                </div>
              </>
            )}
            {modal.type === 'reset' && (
              <>
                <h3 className="font-cabinet font-bold text-lg mb-3">Réinitialiser le mot de passe</h3>
                <input type="text" data-testid="modal-new-pwd" value={newPwd} onChange={(e) => setNewPwd(e.target.value)} placeholder="Nouveau mot de passe" className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none" />
                <div className="mt-4 flex gap-2 justify-end">
                  <button onClick={() => setModal(null)} className="px-4 py-2 rounded-full border border-slate-200 font-semibold text-sm">Annuler</button>
                  <button onClick={doReset} disabled={pending || newPwd.length < 10} data-testid="modal-reset-confirm" className="px-4 py-2 rounded-full bg-[#2563EB] text-white font-semibold text-sm disabled:opacity-60">Réinitialiser</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
