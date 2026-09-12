import axios from 'axios';

const API = `${process.env.REACT_APP_BACKEND_URL || ''}/api`;

export const api = axios.create({ baseURL: API });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('btp_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    // Normalise error `detail` so callers can safely display it without React
    // crashing on non-string values (FastAPI 422s produce arrays/objects).
    const raw = err.response?.data?.detail;
    if (raw && typeof raw !== 'string') {
      let msg = 'Erreur de validation';
      try {
        if (Array.isArray(raw) && raw.length > 0 && typeof raw[0]?.msg === 'string') {
          msg = raw.map((e) => e.msg).join(' · ');
        } else {
          msg = JSON.stringify(raw);
        }
      } catch { /* fallback stays 'Erreur de validation' */ }
      if (err.response?.data) err.response.data.detail = msg;
    }
    if (err.response?.status === 401) {
      localStorage.removeItem('btp_token');
      if (!window.location.pathname.startsWith('/login') && !window.location.pathname.startsWith('/register') && window.location.pathname !== '/') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(err);
  }
);

export default api;
