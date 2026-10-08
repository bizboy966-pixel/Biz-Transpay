import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { BellRing, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import api from '../api';
import { useAuth } from '../context/AuthContext';
import {
  currentPushToken,
  enableBrowserPush,
  PUSH_OPT_IN_DISMISSED_KEY,
  startBrowserPush,
} from '../lib/pushNotifications';

export default function PushOptInPrompt() {
  const { t } = useTranslation();
  const { user, loading } = useAuth();
  const { pathname } = useLocation();
  const userId = user?.id;
  const isAuthenticatedArea = pathname === '/dashboard'
    || pathname.startsWith('/dashboard/')
    || pathname === '/admin'
    || pathname.startsWith('/admin/');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setOpen(false);
    setError('');

    if (loading || !userId || !isAuthenticatedArea) {
      return () => { active = false; };
    }
    const NotificationAPI = window.Notification;
    if (!NotificationAPI || !navigator.serviceWorker) {
      return () => { active = false; };
    }
    if (sessionStorage.getItem(PUSH_OPT_IN_DISMISSED_KEY)) {
      return () => { active = false; };
    }

    const checkPushStatus = async () => {
      const permission = NotificationAPI.permission;
      if (permission === 'granted' && currentPushToken()) {
        try {
          // A saved browser permission or token alone is not proof of an
          // active subscription. Refresh the FCM token and confirm the API
          // accepted its registration before suppressing the reminder.
          const token = await startBrowserPush();
          if (!active) return;
          if (token) {
            sessionStorage.removeItem(PUSH_OPT_IN_DISMISSED_KEY);
            setOpen(false);
            return;
          }
        } catch {
          // A failed registration is treated as not enabled; show the prompt
          // only if both sides of Firebase push are configured.
        }
      }

      try {
        const { data } = await api.get('/push/config');
        if (!active || !data?.configured || !data?.server_configured) return;
        if (NotificationAPI.permission === 'denied') setError(t('push.blocked'));
        setOpen(true);
      } catch {
        // The prompt cannot enable push until the server is reachable.
      }
    };
    checkPushStatus();

    return () => { active = false; };
  }, [isAuthenticatedArea, loading, t, userId]);

  const dismiss = () => {
    sessionStorage.setItem(PUSH_OPT_IN_DISMISSED_KEY, '1');
    setOpen(false);
  };

  const activate = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await enableBrowserPush();
      sessionStorage.removeItem(PUSH_OPT_IN_DISMISSED_KEY);
      setOpen(false);
      toast.success(t('push.enabled'));
    } catch {
      setError(window.Notification?.permission === 'denied'
        ? t('push.blocked')
        : t('push.error'));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
      data-testid="push-opt-in-backdrop"
    >
      <section
        className="w-full max-w-md overflow-hidden rounded-[28px] border border-blue-100 bg-white shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="push-opt-in-title"
        aria-describedby="push-opt-in-description"
        data-testid="push-opt-in-modal"
      >
        <div className="h-1.5 bg-gradient-to-r from-[#2563EB] to-[#60A5FA]" />
        <div className="p-6 sm:p-8">
          <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-50 text-[#2563EB]">
            <BellRing className="h-7 w-7" aria-hidden="true" />
          </div>
          <h2 id="push-opt-in-title" className="font-cabinet text-2xl font-extrabold tracking-tight text-slate-900">
            {t('push.title')}
          </h2>
          <p id="push-opt-in-description" className="mt-3 text-sm leading-6 text-slate-600">
            {t('push.body')}
          </p>
          {error && <p className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900" role="alert">{error}</p>}
          <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={dismiss}
              data-testid="push-opt-in-later"
              className="rounded-full px-5 py-3 text-sm font-semibold text-slate-600 transition hover:bg-slate-100"
            >
              {t('push.later')}
            </button>
            <button
              type="button"
              onClick={activate}
              disabled={busy}
              data-testid="push-opt-in-enable"
              className="inline-flex items-center justify-center gap-2 rounded-full bg-[#2563EB] px-5 py-3 text-sm font-bold text-white shadow-lg shadow-blue-600/20 transition hover:bg-blue-700 disabled:cursor-wait disabled:opacity-70"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {t('push.allow')}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}