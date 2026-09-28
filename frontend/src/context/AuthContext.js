import { createContext, useContext, useEffect, useState } from 'react';
import api from '../api';
import { ACTIVE_MOMO_DEPOSIT_KEY } from '../constants/payment';
import {
  currentPushToken,
  disableBrowserPush,
  PUSH_OPT_IN_DISMISSED_KEY,
  startBrowserPush,
} from '@/lib/pushNotifications';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const userId = user?.id;

  const loadMe = async () => {
    try {
      const { data } = await api.get('/auth/me');
      setUser(data);
    } catch { setUser(null); }
    setLoading(false);
  };

  useEffect(() => { loadMe(); }, []);
  useEffect(() => {
    // A saved token means this browser explicitly opted in before. Browser
    // permission alone is not enough: disabling push leaves it granted.
    if (userId && currentPushToken()) startBrowserPush().catch(() => {});
  }, [userId]);

  const login = async (email, password, security = {}) => {
    const { data } = await api.post('/auth/login', {
      email, password, ...security,
    });
    if (data.user && data.token !== undefined) {
      sessionStorage.removeItem(PUSH_OPT_IN_DISMISSED_KEY);
      setUser(data.user);
    }
    return data;
  };

  const register = async (payload) => {
    const { data } = await api.post('/auth/register', payload);
    if (data.user && data.token !== undefined) {
      sessionStorage.removeItem(PUSH_OPT_IN_DISMISSED_KEY);
      setUser(data.user);
    }
    return data;
  };

  const logout = async () => {
    // Best effort: remove only this browser's token, never other devices.
    await disableBrowserPush().catch(() => {});
    await api.post('/auth/logout').catch(() => {});
    sessionStorage.removeItem(ACTIVE_MOMO_DEPOSIT_KEY);
    sessionStorage.removeItem(PUSH_OPT_IN_DISMISSED_KEY);
    setUser(null);
    window.location.href = '/';
  };

  const refresh = loadMe;

  useEffect(() => {
    if (!user) return undefined;
    let lastActivity = Date.now();
    const markActivity = () => { lastActivity = Date.now(); };
    const events = ['mousedown', 'keydown', 'touchstart', 'scroll'];
    events.forEach((name) => window.addEventListener(name, markActivity, { passive: true }));
    const timer = window.setInterval(() => {
      if (Date.now() - lastActivity < 10 * 60 * 1000) {
        api.post('/auth/session/refresh').catch(() => {});
      }
    }, 5 * 60 * 1000);
    return () => {
      window.clearInterval(timer);
      events.forEach((name) => window.removeEventListener(name, markActivity));
    };
  }, [user]);

  const confirmTwoFactor = async (code, setupToken) => {
    const { data } = await api.post('/auth/2fa/confirm', {
      code, setup_token: setupToken || undefined,
    });
    return data;
  };

  return (
    <AuthCtx.Provider value={{ user, loading, login, register, logout, refresh, setUser, confirmTwoFactor }}>
      {children}
    </AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);
