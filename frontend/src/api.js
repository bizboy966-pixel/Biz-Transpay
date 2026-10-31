import axios from 'axios';

const API = `${process.env.REACT_APP_BACKEND_URL || ''}/api`;

export const api = axios.create({ baseURL: API, withCredentials: true });

function publicPaymentMessage(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/\bPayDunya\b/gi, 'Biz-transPay')
    .replace(/\bAfriBaPay\b/gi, 'Biz-transPay')
    .replace(/\bMbiyo(?:Pay)?\b/gi, 'Biz-transPay')
    .replace(/\bPay\s*Junior\b/gi, 'Biz-transPay')
    .replace(/\bBiya\s*Pay\b/gi, 'Biz-transPay')
    .replace(/\bAfrika\s*Pay\b/gi, 'Biz-transPay')
    .replace(/\b(?:PAYDUNYA|AFRIBAPAY|MBIYO)_([A-Z0-9_]+)\b/gi, 'BIZTRANSPAY_$1');
}

const CSRF_COOKIE_NAME = 'btp_csrf';
const MUTATING_METHODS = new Set(['post', 'put', 'patch', 'delete']);
const CSRF_PUBLIC_PATHS = new Set([
  '/auth/login',
  '/auth/register',
  '/auth/recover',
]);
let csrfRequest = null;
let sessionRefreshRequest = null;
let sessionGeneration = 0;

export function refreshBrowserSession() {
  if (!sessionRefreshRequest) {
    sessionRefreshRequest = api.post('/auth/session/refresh', {}, { _sessionRefresh: true })
      .then((result) => {
        sessionGeneration += 1;
        return result;
      })
      .finally(() => { sessionRefreshRequest = null; });
  }
  return sessionRefreshRequest;
}

function readCookie(name) {
  const prefix = `${encodeURIComponent(name)}=`;
  const item = document.cookie.split('; ').find((value) => value.startsWith(prefix));
  return item ? decodeURIComponent(item.slice(prefix.length)) : null;
}

async function ensureCsrfToken() {
  const existing = readCookie(CSRF_COOKIE_NAME);
  if (existing) return existing;
  if (!csrfRequest) {
    csrfRequest = axios
      .get(`${API}/auth/csrf`, { withCredentials: true })
      .then(({ data }) => data?.csrf_token || readCookie(CSRF_COOKIE_NAME))
      .catch(() => null)
      .finally(() => { csrfRequest = null; });
  }
  return csrfRequest;
}

api.interceptors.request.use(async (config) => {
  if (sessionRefreshRequest && !config._sessionRefresh) {
    await sessionRefreshRequest.catch(() => {});
  }
  config._sessionGeneration = sessionGeneration;
  const method = String(config.method || 'get').toLowerCase();
  const path = String(config.url || '').split('?')[0];
  if (MUTATING_METHODS.has(method) && !CSRF_PUBLIC_PATHS.has(path)) {
    const token = await ensureCsrfToken();
    if (token) {
      if (typeof config.headers?.set === 'function') {
        config.headers.set('X-CSRF-Token', token);
      } else {
        config.headers = { ...(config.headers || {}), 'X-CSRF-Token': token };
      }
    }
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  async (err) => {
    if (err.response?.status === 401
      && String(err.config?.method || 'get').toLowerCase() === 'get'
      && !err.config?._sessionRetry) {
      if (sessionRefreshRequest) await sessionRefreshRequest.catch(() => {});
      if (Number.isInteger(err.config?._sessionGeneration)
        && err.config._sessionGeneration < sessionGeneration) {
        // Retry only reads rejected for the old cookie during a successful
        // rotation. Never replay a financial mutation or ignore real expiry.
        return api({ ...err.config, _sessionRetry: true });
      }
    }
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
    const preserveStructuredDetail = raw?.code === 'AUTH_CHALLENGE_REQUIRED';
    if (raw && typeof raw !== 'string' && !preserveStructuredDetail) {
      let msg = 'Erreur de validation';
      try {
        if (typeof raw.code === 'string'
            && /^(?:PAYDUNYA|AFRIBAPAY|MBIYO)_[A-Z0-9_]+$/i.test(raw.code)
            && typeof raw.message === 'string' && raw.message.trim()) {
          msg = publicPaymentMessage(raw.message.trim());
        } else if (Array.isArray(raw) && raw.length > 0 && typeof raw[0]?.msg === 'string') {
          msg = raw.map((e) => e.msg).join(' · ');
        } else {
          msg = JSON.stringify(raw);
        }
      } catch { /* fallback stays 'Erreur de validation' */ }
      if (err.response?.data) err.response.data.detail = publicPaymentMessage(msg);
    }
    if (typeof err.response?.data?.detail === 'string') {
      err.response.data.detail = publicPaymentMessage(err.response.data.detail);
    }
    if (typeof err.response?.data?.message === 'string') {
      err.response.data.message = publicPaymentMessage(err.response.data.message);
    }
    if (err.response?.status === 401) {
      const pathName = window.location.pathname;
      const isPublicPaymentLink = pathName === '/pay' || pathName.startsWith('/pay/');
      const isPublicDocs = pathName === '/integration/docs' || pathName.startsWith('/integration/docs/');
      if (
        !isPublicPaymentLink
        && !isPublicDocs
        && !pathName.startsWith('/login')
        && !pathName.startsWith('/register')
        && pathName !== '/'
      ) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(err);
  }
);

export default api;
