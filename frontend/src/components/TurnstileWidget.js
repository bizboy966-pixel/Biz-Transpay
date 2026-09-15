import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';

const SCRIPT_ID = 'cloudflare-turnstile-script';
const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

let scriptPromise;

function safelyRunTurnstile(action) {
  try {
    action();
  } catch {
    // Cloudflare can throw a non-Error value when a solved widget has already
    // been detached during route navigation. Cleanup must never break routing.
  }
}

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
  const [errorCode, setErrorCode] = useState('');

  useEffect(() => {
    onTokenRef.current = onToken;
  }, [onToken]);

  useImperativeHandle(ref, () => ({
    reset() {
      if (widgetIdRef.current !== null && window.turnstile) {
        safelyRunTurnstile(() => window.turnstile.reset(widgetIdRef.current));
      }
      onTokenRef.current?.('');
    },
  }), []);

  useEffect(() => {
    let cancelled = false;
    let islandNode = null;
    if (disabled || !siteKey || !containerRef.current) {
      onTokenRef.current?.('');
      return undefined;
    }

    const hostNode = containerRef.current;
    // React owns only containerRef. Every Turnstile instance gets a separate
    // imperative island so a delayed cleanup can never touch a newer widget.
    islandNode = document.createElement('div');
    islandNode.className = 'turnstile-widget__island';
    hostNode.appendChild(islandNode);
    setLoadError(false);
    setErrorCode('');
    loadTurnstileScript()
      .then((turnstile) => {
        if (cancelled || !turnstile || islandNode?.parentNode !== hostNode) return;
        // Cloudflare may replace or detach mountNode. Both mountNode and its
        // parent island are outside React's managed child tree.
        const mountNode = document.createElement('div');
        islandNode.appendChild(mountNode);
        widgetIdRef.current = turnstile.render(mountNode, {
          sitekey: siteKey,
          action,
          callback: (token) => {
            if (!cancelled) onTokenRef.current?.(token);
          },
          'expired-callback': () => {
            if (!cancelled) onTokenRef.current?.('');
          },
          'timeout-callback': () => {
            if (!cancelled) onTokenRef.current?.('');
          },
          'error-callback': (code) => {
            if (cancelled) return;
            onTokenRef.current?.('');
            setErrorCode(String(code || ''));
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
      // Detach only this instance's island. React never tracks its children,
      // and a later Cloudflare cleanup cannot reach a replacement widget.
      if (islandNode?.parentNode === hostNode) {
        islandNode.parentNode.removeChild(islandNode);
      }
      if (widgetIdRef.current !== null && window.turnstile) {
        const widgetId = widgetIdRef.current;
        widgetIdRef.current = null;
        // Clear only Cloudflare's registry after the isolated DOM is detached.
        window.setTimeout(() => {
          if (window.turnstile) {
            safelyRunTurnstile(() => window.turnstile.remove(widgetId));
          }
        }, 0);
      }
    };
  }, [action, disabled, siteKey]);

  if (!siteKey || disabled) {
    return (
      <p className="turnstile-widget__notice mt-3 rounded-lg bg-amber-50 px-3 py-2 text-center text-xs text-amber-800">
        Vérification anti-bot indisponible. Réessayez plus tard.
      </p>
    );
  }

  return (
    <div className="turnstile-widget mt-3" data-testid="turnstile-widget">
      <div className="turnstile-widget__canvas">
        <div ref={containerRef} aria-label="Vérification anti-bot" />
      </div>
      {loadError && (
        <p className="turnstile-widget__error mt-1 text-xs leading-4 text-center text-red-600">
          {errorCode === '110200'
            ? 'Ce domaine n’est pas autorisé dans Cloudflare Turnstile. Ajoutez le domaine Preview/production dans Hostname Management.'
            : 'Impossible de charger la vérification anti-bot. Réessayez.'}
        </p>
      )}
    </div>
  );
});

export default TurnstileWidget;