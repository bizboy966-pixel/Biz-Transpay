import { useCallback, useEffect, useRef, useState } from 'react';
import { BellRing, CalendarDays, Check, ExternalLink, Loader2, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../context/AuthContext';
import './PersistentNotificationModal.css';

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(date);
}

function safeInternalPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/')
    || value.startsWith('//') || value.includes('\\')) return null;
  return value;
}

export default function PersistentNotificationModal() {
  const { user, loading: authLoading } = useAuth();
  const userId = user?.id;
  const [queue, setQueue] = useState({ ownerId: null, items: [], error: '' });
  const [saving, setSaving] = useState(false);
  const requestId = useRef(0);
  const dismissed = useRef({ ownerId: null, ids: new Set() });
  const confirmButton = useRef(null);
  const dialog = useRef(null);
  const notification = queue.ownerId === userId ? queue.items[0] : null;

  const loadPending = useCallback(async (ownerId = userId) => {
    if (!ownerId) return;
    const request = ++requestId.current;
    try {
      const { data } = await api.get('/notifications/pending-confirmation', {
        params: { limit: 100 },
      });
      if (request !== requestId.current) return;
      const saved = dismissed.current.ownerId === ownerId
        ? dismissed.current.ids : new Set();
      setQueue((previous) => {
        const current = previous.ownerId === ownerId ? previous.items : [];
        const byId = new Map();
        [...(Array.isArray(data) ? data : []), ...current].forEach((item) => {
          if (item?.id && item.user_id === ownerId && !item.read
            && !saved.has(item.id) && !byId.has(item.id)) {
            byId.set(item.id, item);
          }
        });
        return { ownerId, items: [...byId.values()], error: '' };
      });
    } catch {
      if (request === requestId.current) {
        setQueue((previous) => ({
          ownerId,
          items: previous.ownerId === ownerId ? previous.items : [],
          error: 'Impossible de charger ce message. Vérifiez votre connexion, puis réessayez.',
        }));
      }
    }
  }, [userId]);

  useEffect(() => {
    if (authLoading) return undefined;
    if (!userId) {
      requestId.current += 1;
      dismissed.current = { ownerId: null, ids: new Set() };
      setQueue({ ownerId: null, items: [], error: '' });
      setSaving(false);
      return undefined;
    }

    dismissed.current = { ownerId: userId, ids: new Set() };
    setQueue({ ownerId: userId, items: [], error: '' });
    loadPending(userId);
    return undefined;
  }, [authLoading, userId, loadPending]);

  useEffect(() => {
    if (!userId) return undefined;
    const onNotification = (event) => {
      const item = event.detail;
      if (!item?.id || item.user_id !== userId || !item.requires_confirmation || item.read) return;
      if (dismissed.current.ownerId === userId && dismissed.current.ids.has(item.id)) {
        if (!item.force) return;
        dismissed.current.ids.delete(item.id);
      }
      setQueue((previous) => {
        const items = previous.ownerId === userId ? previous.items : [];
        if (items.some((current) => current.id === item.id)) return previous;
        return { ownerId: userId, items: [item, ...items], error: '' };
      });
    };
    const onForegroundPush = (event) => {
      if (event.detail?.campaignId) loadPending(userId);
    };
    window.addEventListener('btp-notification-created', onNotification);
    window.addEventListener('btp-foreground-push', onForegroundPush);
    return () => {
      window.removeEventListener('btp-notification-created', onNotification);
      window.removeEventListener('btp-foreground-push', onForegroundPush);
    };
  }, [userId, loadPending]);

  const dismissCurrent = useCallback(() => {
    if (!notification || saving) return;
    if (dismissed.current.ownerId !== userId) {
      dismissed.current = { ownerId: userId, ids: new Set() };
    }
    dismissed.current.ids.add(notification.id);
    setQueue((previous) => ({
      ...previous,
      items: previous.items.filter((item) => item.id !== notification.id),
    }));
  }, [notification, saving, userId]);

  useEffect(() => {
    if (!notification) return undefined;
    const previousFocus = document.activeElement;
    const focusConfirm = () => confirmButton.current?.focus();
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(focusConfirm);
    } else {
      focusConfirm();
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !saving) {
        event.preventDefault();
        dismissCurrent();
      }
      if (event.key !== 'Tab' || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll(
        'button:not(:disabled), a[href]',
      )];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [notification, saving, dismissCurrent]);

  const confirmRead = async () => {
    if (!notification || saving) return;
    setSaving(true);
    setQueue((previous) => ({ ...previous, error: '' }));
    try {
      await api.post(`/notifications/${notification.id}/read`);
      setQueue((previous) => ({
        ...previous,
        items: previous.items.filter((item) => item.id !== notification.id),
      }));
      window.dispatchEvent(new CustomEvent('btp-notification-read', {
        detail: { id: notification.id },
      }));
    } catch {
      setQueue((previous) => ({
        ...previous,
        error: 'La confirmation n’a pas été enregistrée. Réessayez.',
      }));
    } finally {
      setSaving(false);
    }
  };

  if (!notification) return null;
  const date = formatDate(notification.created_at);
  const path = safeInternalPath(notification.data?.url);
  const extra = notification.data?.information || notification.data?.details;
  const extraText = typeof extra === 'string' ? extra.trim() : '';

  return (
    <div
      className="bt-persistent-notification-backdrop"
      role="presentation"
      data-testid="persistent-notification-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismissCurrent();
      }}
    >
      <section
        ref={dialog}
        className="bt-persistent-notification-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="persistent-notification-title"
        aria-describedby="persistent-notification-body"
        data-testid="persistent-notification-modal"
      >
        <button
          type="button"
          className="bt-persistent-notification-close"
          aria-label="Fermer sans marquer comme lu"
          data-testid="persistent-notification-dismiss"
          disabled={saving}
          onClick={dismissCurrent}
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </button>

        <div className="bt-persistent-notification-accent" />
        <div className="bt-persistent-notification-content">
          <div className="bt-persistent-notification-icon" aria-hidden="true">
            <BellRing className="h-7 w-7" strokeWidth={1.8} />
          </div>
          <div className="bt-persistent-notification-label">
            Notification importante
          </div>
          <h2 id="persistent-notification-title">
            {notification.title || 'Biz-transPay'}
          </h2>
          <p
            id="persistent-notification-body"
            className="bt-persistent-notification-message"
            data-testid="persistent-notification-message"
          >
            {notification.body}
          </p>

          {date && (
            <div className="bt-persistent-notification-date">
              <CalendarDays className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>Envoyée le {date}</span>
            </div>
          )}
          {extraText && (
            <div className="bt-persistent-notification-extra">
              {extraText}
            </div>
          )}
          {path && (
            <Link className="bt-persistent-notification-link" to={path}>
              Voir l’information
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          )}

          {queue.error && (
            <div className="bt-persistent-notification-error" role="alert">
              {queue.error}
            </div>
          )}

          <button
            ref={confirmButton}
            type="button"
            className="bt-persistent-notification-confirm"
            data-testid="persistent-notification-confirm"
            onClick={confirmRead}
            disabled={saving}
          >
            {saving
              ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              : <Check className="h-4 w-4" aria-hidden="true" />}
            J&apos;ai lu
          </button>
          <p className="bt-persistent-notification-footnote">
            Vous pourrez retrouver ce message dans vos notifications.
          </p>
        </div>
      </section>
    </div>
  );
}
