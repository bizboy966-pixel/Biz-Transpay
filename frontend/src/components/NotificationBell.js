import { useEffect, useRef, useState } from 'react';
import { Bell, CheckCheck, Trash2, ArrowUpFromLine, ShieldCheck, ShieldAlert, ShieldX } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';

const ICONS = {
  deposit_success: { I: Bell, cls: 'bg-emerald-50 text-emerald-600' },
  withdrawal_success: { I: ArrowUpFromLine, cls: 'bg-emerald-50 text-emerald-600' },
  withdrawal_failed: { I: ArrowUpFromLine, cls: 'bg-red-50 text-red-600' },
  withdrawal_pending: { I: ArrowUpFromLine, cls: 'bg-amber-50 text-amber-600' },
  kyc_verified: { I: ShieldCheck, cls: 'bg-emerald-50 text-emerald-600' },
  kyc_rejected: { I: ShieldX, cls: 'bg-red-50 text-red-600' },
  kyc_resubmit_requested: { I: ShieldAlert, cls: 'bg-amber-50 text-amber-600' },
};

const BRANDED_TITLES = {
  deposit_success: 'Dépôt Biz-transPay confirmé',
  withdrawal_pending: 'Retrait Biz-transPay en cours',
  withdrawal_success: 'Retrait Biz-transPay confirmé',
  withdrawal_failed: 'Retrait Biz-transPay échoué',
  withdrawal_manual_review: 'Retrait Biz-transPay en attente',
  exchange_success: 'Échange Biz-transPay confirmé',
  transfer_success: 'Transfert Biz-transPay confirmé',
  payment_success: 'Paiement Biz-transPay confirmé',
  kyc_verified: 'Vérification Biz-transPay confirmée',
  kyc_rejected: 'Vérification Biz-transPay refusée',
  kyc_resubmit_requested: 'Documents Biz-transPay à compléter',
};

function notificationTitle(notification) {
  if (BRANDED_TITLES[notification?.type]) return BRANDED_TITLES[notification.type];
  const title = String(notification?.title || '').trim();
  return !title || ['notification', 'biztranspay notification'].includes(title.toLowerCase())
    ? 'Biz-transPay'
    : title;
}

function formatRelative(iso) {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "à l'instant";
  if (diff < 3600) return `il y a ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `il y a ${Math.floor(diff / 3600)} h`;
  return d.toLocaleDateString();
}

export default function NotificationBell({ compact = false }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const esRef = useRef(null);
  const wrapRef = useRef(null);
  const initialLoadStartedRef = useRef(false);
  const lastLoadAtRef = useRef(0);

  const load = () => {
    lastLoadAtRef.current = Date.now();
    api.get('/notifications', { params: { limit: 20 } })
      .then(({ data }) => setItems(data || [])).catch(() => {});
    api.get('/notifications/unread-count')
      .then(({ data }) => setUnread(data?.count || 0)).catch(() => {});
  };

  useEffect(() => {
    if (!initialLoadStartedRef.current) {
      initialLoadStartedRef.current = true;
      load();
    }
    // The browser sends the HttpOnly session cookie with this same-origin stream.
    const url = `${process.env.REACT_APP_BACKEND_URL || ''}/api/notifications/stream`;
    const es = new EventSource(url, { withCredentials: true });
    esRef.current = es;
    es.addEventListener('notification', (ev) => {
      try {
        const doc = JSON.parse(ev.data);
        setItems((prev) => [doc, ...prev].slice(0, 20));
        setUnread((n) => n + 1);
        // Toast pop-up for immediate feedback.
        toast(notificationTitle(doc), { description: doc.body, duration: 6000 });
      } catch (e) { /* ignore parse errors */ }
    });
    es.onerror = () => {
      // Browser will auto-reconnect. Nothing to do here.
    };
    return () => { es.close(); esRef.current = null; };
  }, []);

  // Close dropdown on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const markOne = async (id) => {
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    setUnread((n) => Math.max(0, n - 1));
    try { await api.post(`/notifications/${id}/read`); } catch (e) { /* ignore */ }
  };

  const markAll = async () => {
    const previousItems = items;
    const previousUnread = unread;
    setItems([]);
    setUnread(0);
    try {
      await api.post('/notifications/read-all');
    } catch (e) {
      // Restore the local view if the server could not persist the action.
      setItems(previousItems);
      setUnread(previousUnread);
    }
  };

  const deleteAll = async () => {
    if (!items.length) return;
    const confirmed = window.confirm(
      'Supprimer toutes les notifications ? Cette action est irréversible.'
    );
    if (!confirmed) return;

    const previousItems = items;
    const previousUnread = unread;
    setItems([]);
    setUnread(0);
    try {
      await api.delete('/notifications/all');
    } catch (e) {
      setItems(previousItems);
      setUnread(previousUnread);
      toast.error('Les notifications n’ont pas pu être supprimées.');
    }
  };

  return (
    <div className="relative" ref={wrapRef}>
      <button
        data-testid="btn-notifications"
        onClick={() => {
          setOpen((v) => !v);
          if (!open && Date.now() - lastLoadAtRef.current > 30_000) load();
        }}
        aria-expanded={open}
        className={`relative rounded-lg hover:bg-slate-100 flex items-center justify-center transition-colors ${compact ? 'h-8 w-8' : 'h-10 w-10'}`}
      >
        <Bell className={`${compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} text-slate-600`} strokeWidth={1.75} />
        {unread > 0 && (
          <span
            data-testid="notif-badge"
            className="absolute top-1 right-1 min-w-[16px] h-[16px] px-1 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center"
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          data-testid="notif-dropdown"
          className="fixed left-3 right-3 top-[76px] z-50 max-h-[calc(100dvh-88px)] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl sm:absolute sm:left-auto sm:right-0 sm:top-auto sm:mt-2 sm:max-h-none sm:w-[360px] sm:max-w-[92vw]"
        >
          <div className="flex min-w-0 items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
            <div className="min-w-0">
              <div className="font-cabinet font-extrabold text-sm text-slate-900">Notifications</div>
              <div className="text-[10px] text-slate-500">{unread} non lue{unread > 1 ? 's' : ''}</div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {items.some((n) => !n.read) && (
                <button
                  data-testid="btn-mark-all-read"
                  onClick={markAll}
                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#2563EB] hover:underline"
                >
                  <CheckCheck className="w-3.5 h-3.5" /> Tout marquer lu
                </button>
              )}
              {items.length > 0 && (
                <button
                  type="button"
                  data-testid="btn-delete-all-notifications"
                  onClick={deleteAll}
                  aria-label="Supprimer toutes les notifications"
                  title="Supprimer toutes les notifications"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600"
                >
                  <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} />
                </button>
              )}
            </div>
          </div>
          <div className="max-h-[calc(100dvh-160px)] overflow-y-auto sm:max-h-[420px]">
            {items.length === 0 && (
              <div className="p-8 text-center text-xs text-slate-400" data-testid="notif-empty">
                Vous n&apos;avez encore aucune notification.
              </div>
            )}
            {items.map((n) => {
              const meta = ICONS[n.type] || { I: Bell, cls: 'bg-blue-50 text-[#2563EB]' };
              const I = meta.I;
              return (
                <button
                  key={n.id}
                  data-testid={`notif-row-${n.id}`}
                  onClick={() => !n.read && markOne(n.id)}
                  className={`w-full text-left px-4 py-3 flex items-start gap-3 border-t border-slate-50 hover:bg-slate-50/70 transition-colors ${!n.read ? 'bg-blue-50/30' : ''}`}
                >
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${meta.cls}`}>
                    <I className="w-4 h-4" strokeWidth={1.75} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <img
                        src="/logo-mark.png"
                        alt=""
                        aria-hidden="true"
                        className="h-4 w-4 shrink-0 rounded object-contain"
                      />
                      <div className="text-xs font-semibold text-slate-900 truncate">{notificationTitle(n)}</div>
                      {!n.read && <span className="w-1.5 h-1.5 rounded-full bg-[#2563EB] shrink-0" />}
                    </div>
                    <div className="mt-0.5 break-words text-[11px] leading-snug text-slate-600 [overflow-wrap:anywhere] whitespace-pre-line">{n.body}</div>
                    <div className="text-[10px] text-slate-400 mt-1">{formatRelative(n.created_at)}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
