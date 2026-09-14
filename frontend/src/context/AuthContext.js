import { createContext, useContext, useEffect, useState } from 'react';
import api from '../api';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadMe = async () => {
    const token = localStorage.getItem('btp_token');
    if (!token) { setLoading(false); return; }
    try {
      const { data } = await api.get('/auth/me');
      setUser(data);
    } catch { localStorage.removeItem('btp_token'); }
    setLoading(false);
  };

  useEffect(() => { loadMe(); }, []);

  const login = async (email, password, security = {}) => {
    const { data } = await api.post('/auth/login', {
      email, password, ...security,
    });
    if (data.token) {
      localStorage.setItem('btp_token', data.token);
      setUser(data.user);
    }
    return data;
  };

  const register = async (payload) => {
    const { data } = await api.post('/auth/register', payload);
    localStorage.setItem('btp_token', data.token);
    setUser(data.user);
    return data.user;
  };

  const logout = () => {
    localStorage.removeItem('btp_token');
    setUser(null);
    window.location.href = '/';
  };

  const refresh = loadMe;

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
