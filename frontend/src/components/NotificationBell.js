import { useEffect, useRef, useState } from 'react';
import { Bell, CheckCheck, ArrowUpFromLine, ShieldCheck, ShieldAlert, ShieldX } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';

const ICONS = {
  withdrawal_success: { I: ArrowUpFromLine, cls: 'bg-emerald-50 text-emerald-600' },
  withdrawal_failed: { I: ArrowUpFromLine, cls: 'bg-red-50 text-red-600' },
  kyc_verified: { I: ShieldCheck, cls: 'bg-emerald-50 text-emerald-600' },
  kyc_rejected: { I: ShieldX, cls: 'bg-red-50 text-red-600' },
  kyc_resubmit_requested: { I: ShieldAlert, cls: 'bg-amber-50 text-amber-600' },
};

function formatRelative(iso) {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "à l'instant";
  if (diff < 3600) return `il y a ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `il y a ${Math.floor(diff / 3600)} h`;
  return d.toLocaleDateString();
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const esRef = useRef(null);
  const wrapRef = useRef(null);

  const load = () => {
    api.get('/notifications', { params: { limit: 20 } })
      .then(({ data }) => setItems(data || [])).catch(() => {});
    api.get('/notifications/unread-count')
      .then(({ data }) => setUnread(data?.count || 0)).catch(() => {});
  };

  useEffect(() => {
    load();
    // Open SSE stream. EventSource cannot send Authorization headers,
    // so we pass the JWT as a query param — the backend validates it.
    const token = localStorage.getItem('btp_token');
    if (!token) return;
    const url = `${process.env.REACT_APP_BACKEND_URL || ''}/api/notifications/stream?token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);
    esRef.current = es;
    es.addEventListener('notification', (ev) => {
      try {
        const doc = JSON.parse(ev.data);
        setItems((prev) => [doc, ...prev].slice(0, 20));
        setUnread((n) => n + 1);
        // Toast pop-up for immediate feedback.
        toast(doc.title, { description: doc.body, duration: 6000 });
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
    setItems((prev) => prev.map((n) => ({ ...n, read: true })));
    setUnread(0);
    try { await api.post('/notifications/read-all'); } catch (e) { /* ignore */ }
  };

  return (
    <div className="relative" ref={wrapRef}>
      <button
        data-testid="btn-notifications"
        onClick={() => { setOpen((v) => !v); if (!open) load(); }}
        className="relative w-10 h-10 rounded-lg hover:bg-slate-100 flex items-center justify-center transition-colors"
      >
        <Bell className="w-4 h-4 text-slate-600" strokeWidth={1.75} />
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
          className="absolute right-0 mt-2 w-[360px] max-w-[92vw] bg-white border border-slate-200 rounded-xl shadow-xl overflow-hidden z-50"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
            <div>
              <div className="font-cabinet font-extrabold text-sm text-slate-900">Notifications</div>
              <div className="text-[10px] text-slate-500">{unread} non lue{unread > 1 ? 's' : ''}</div>
            </div>
            {items.some((n) => !n.read) && (
              <button
                data-testid="btn-mark-all-read"
                onClick={markAll}
                className="text-[11px] font-semibold text-[#2563EB] hover:underline inline-flex items-center gap-1"
              >
                <CheckCheck className="w-3.5 h-3.5" /> Tout marquer lu
              </button>
            )}
          </div>
          <div className="max-h-[420px] overflow-y-auto">
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
                      <div className="text-xs font-semibold text-slate-900 truncate">{n.title}</div>
                      {!n.read && <span className="w-1.5 h-1.5 rounded-full bg-[#2563EB] shrink-0" />}
                    </div>
                    <div className="text-[11px] text-slate-600 leading-snug mt-0.5 whitespace-pre-line">{n.body}</div>
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
