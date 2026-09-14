import axios from 'axios';

const API = `${process.env.REACT_APP_BACKEND_URL || ''}/api`;

export const api = axios.create({ baseURL: API, withCredentials: true });

api.interceptors.request.use((config) => config);

api.interceptors.response.use(
  (res) => res,
  (err) => {
    const securityDetail = err.response?.data?.detail;
    if (
      err.response?.status === 428
      && securityDetail?.code === 'REAUTH_REQUIRED'
      && !err.config?._reauthRetry
    ) {
      return new Promise((resolve, reject) => {
        window.dispatchEvent(new CustomEvent('btp-reauth-required', {
          detail: { config: err.config, resolve, reject },
        }));
      });
    }
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
      if (!window.location.pathname.startsWith('/login') && !window.location.pathname.startsWith('/register') && window.location.pathname !== '/') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(err);
  }
);

export default api;
