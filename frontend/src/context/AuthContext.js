import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import api, { refreshBrowserSession } from '../api';
import { ACTIVE_MOMO_DEPOSIT_KEY } from '../constants/payment';
import {
  currentPushToken,
  PUSH_OPT_IN_DISMISSED_KEY,
  startBrowserPush,
} from '../lib/pushNotifications';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const userId = user?.id;

  const loadMe = useCallback(async () => {
    try {
      const { data } = await api.get('/auth/me');
      setUser(data);
    } catch { setUser(null); }
    setLoading(false);
  }, []);

  const initialLoadStarted = useRef(false);
  useEffect(() => {
    if (initialLoadStarted.current) return;
    initialLoadStarted.current = true;
    loadMe();
  }, [loadMe]);
  useEffect(() => {
    // A saved token means this browser explicitly opted in before. Browser
    // permission alone is not enough: disabling push leaves it granted.
    if (userId && currentPushToken()) startBrowserPush().catch(() => {});
  }, [userId]);

  const login = useCallback(async (email, password, security = {}) => {
    const { data } = await api.post('/auth/login', {
      email, password, ...security,
    });
    if (data.user && data.token !== undefined) {
      sessionStorage.removeItem(PUSH_OPT_IN_DISMISSED_KEY);
      setUser(data.user);
    }
    return data;
  }, []);

  const register = useCallback(async (payload) => {
    const { data } = await api.post('/auth/register', payload);
    if (data.user && data.token !== undefined) {
      sessionStorage.removeItem(PUSH_OPT_IN_DISMISSED_KEY);
      setUser(data.user);
    }
    return data;
  }, []);

  const logout = useCallback(async (redirectTo = '/') => {
    // Keep the opted-in browser registered so push notifications still work
    // while the user is signed out and do not need to be enabled again.
    await api.post('/auth/logout').catch(() => {});
    sessionStorage.removeItem(ACTIVE_MOMO_DEPOSIT_KEY);
    sessionStorage.removeItem(PUSH_OPT_IN_DISMISSED_KEY);
    setUser(null);
    const safeRedirect = typeof redirectTo === 'string'
      && redirectTo.startsWith('/') && !redirectTo.startsWith('//')
      ? redirectTo : '/';
    window.location.href = safeRedirect;
  }, []);

  const refresh = loadMe;

  useEffect(() => {
    if (!user) return undefined;
    let lastActivity = Date.now();
    const markActivity = () => { lastActivity = Date.now(); };
    const events = ['mousedown', 'keydown', 'touchstart', 'scroll'];
    events.forEach((name) => window.addEventListener(name, markActivity, { passive: true }));
    const timer = window.setInterval(() => {
      if (Date.now() - lastActivity < 10 * 60 * 1000) {
        refreshBrowserSession().catch(() => {});
      }
    }, 5 * 60 * 1000);
    return () => {
      window.clearInterval(timer);
      events.forEach((name) => window.removeEventListener(name, markActivity));
    };
  }, [user]);

  const confirmTwoFactor = useCallback(async (code, setupToken) => {
    const { data } = await api.post('/auth/2fa/confirm', {
      code, setup_token: setupToken || undefined,
    });
    return data;
  }, []);

  const unlockAdminPanel = useCallback(async (code) => {
    const { data } = await api.post('/auth/admin-panel/verify', { code });
    if (data.user) setUser(data.user);
    return data;
  }, []);

  const value = useMemo(
    () => ({
      user, loading, login, register, logout, refresh, setUser,
      confirmTwoFactor, unlockAdminPanel,
    }),
    [user, loading, login, register, logout, refresh, confirmTwoFactor, unlockAdminPanel],
  );

  return (
    <AuthCtx.Provider value={value}>
      {children}
    </AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);
