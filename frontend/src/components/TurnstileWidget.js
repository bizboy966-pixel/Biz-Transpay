import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';

const SCRIPT_ID = 'cloudflare-turnstile-script';
const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

let scriptPromise;

function loadTurnstileScript() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID);
    if (existing) {
      existing.addEventListener('load', () => resolve(window.turnstile));
      existing.addEventListener('error', reject);
      return;
    }
    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(window.turnstile);
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export function useTurnstileConfig() {
  const [config, setConfig] = useState({ loading: true, enabled: false, siteKey: null });

  useEffect(() => {
    let active = true;
    fetch(`${process.env.REACT_APP_BACKEND_URL || ''}/api/security/turnstile-config`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!active) return;
        setConfig({
          loading: false,
          enabled: Boolean(data?.enabled && data?.site_key),
          siteKey: data?.site_key || null,
        });
      })
      .catch(() => {
        if (active) setConfig({ loading: false, enabled: false, siteKey: null });
      });
    return () => { active = false; };
  }, []);

  return config;
}

const TurnstileWidget = forwardRef(function TurnstileWidget(
  { siteKey, action, onToken, disabled = false },
  ref,
) {
  const containerRef = useRef(null);
  const widgetIdRef = useRef(null);
  const onTokenRef = useRef(onToken);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    onTokenRef.current = onToken;
  }, [onToken]);

  useImperativeHandle(ref, () => ({
    reset() {
      if (widgetIdRef.current !== null && window.turnstile) {
        window.turnstile.reset(widgetIdRef.current);
      }
      onTokenRef.current?.('');
    },
  }), []);

  useEffect(() => {
    let cancelled = false;
    if (disabled || !siteKey || !containerRef.current) {
      onTokenRef.current?.('');
      return undefined;
    }

    containerRef.current.replaceChildren();
    setLoadError(false);
    loadTurnstileScript()
      .then((turnstile) => {
        if (cancelled || !turnstile || !containerRef.current) return;
        widgetIdRef.current = turnstile.render(containerRef.current, {
          sitekey: siteKey,
          action,
          callback: (token) => onTokenRef.current?.(token),
          'expired-callback': () => onTokenRef.current?.(''),
          'timeout-callback': () => onTokenRef.current?.(''),
          'error-callback': () => {
            onTokenRef.current?.('');
            setLoadError(true);
          },
        });
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError(true);
          onTokenRef.current?.('');
        }
      });

    return () => {
      cancelled = true;
      if (widgetIdRef.current !== null && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [action, disabled, siteKey]);

  if (!siteKey || disabled) {
    return (
      <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
        Vérification anti-bot indisponible. Réessayez plus tard.
      </p>
    );
  }

  return (
    <div className="mt-3">
      <div ref={containerRef} aria-label="Vérification anti-bot" />
      {loadError && (
        <p className="mt-1 text-xs text-red-600">
          Impossible de charger la vérification anti-bot.
        </p>
      )}
    </div>
  );
});

export default TurnstileWidget;