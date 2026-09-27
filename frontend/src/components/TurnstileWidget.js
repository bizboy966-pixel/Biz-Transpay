import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';

const SCRIPT_ID = 'cloudflare-turnstile-script';
const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const SCRIPT_LOAD_TIMEOUT_MS = 15000;

let scriptPromise = null;

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
  // A failed/stalled script element may have already emitted its error event.
  // Reusing it would leave every later attempt waiting on an event that cannot
  // fire again.
  document.getElementById(SCRIPT_ID)?.remove();

  const script = document.createElement('script');
  script.id = SCRIPT_ID;
  script.src = SCRIPT_SRC;
  script.async = true;
  script.defer = true;
  let resolveLoad;
  let rejectLoad;
  let timeoutId;
  const pending = new Promise((resolve, reject) => {
    resolveLoad = resolve;
    rejectLoad = reject;
  });
  scriptPromise = pending;

  const clearHandlers = () => {
    window.clearTimeout(timeoutId);
    script.onload = null;
    script.onerror = null;
  };
  const fail = (error) => {
    clearHandlers();
    script.remove();
    if (scriptPromise === pending) scriptPromise = null;
    rejectLoad(error);
  };

  script.onload = () => {
    clearHandlers();
    if (!window.turnstile) {
      fail(new Error('Turnstile loaded without exposing its API'));
      return;
    }
    if (scriptPromise === pending) scriptPromise = null;
    resolveLoad(window.turnstile);
  };
  script.onerror = () => fail(new Error('Turnstile script failed to load'));
  timeoutId = window.setTimeout(
    () => fail(new Error('Turnstile script load timed out')),
    SCRIPT_LOAD_TIMEOUT_MS,
  );
  try {
    document.head.appendChild(script);
  } catch (error) {
    fail(error);
  }
  return pending;
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
  const [retryCount, setRetryCount] = useState(0);

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
  }, [action, disabled, siteKey, retryCount]);

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
        <div
          className="turnstile-widget__error mt-1 text-center text-xs leading-4 text-red-600"
          role="alert"
        >
          <p>
            {errorCode === '110200'
              ? 'Ce domaine n’est pas autorisé dans Cloudflare Turnstile. Ajoutez le domaine Preview/production dans Hostname Management.'
              : 'La vérification anti-bot ne répond pas. Réessayez.'}
          </p>
          <button
            type="button"
            data-testid="btn-turnstile-retry"
            className="mt-1 font-semibold text-blue-700 underline hover:text-blue-800"
            onClick={() => {
              onTokenRef.current?.('');
              setLoadError(false);
              setErrorCode('');
              setRetryCount((count) => count + 1);
            }}
          >
            Réessayer
          </button>
        </div>
      )}
    </div>
  );
});

export default TurnstileWidget;