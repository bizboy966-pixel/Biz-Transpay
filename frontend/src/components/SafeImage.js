import { useEffect, useState } from 'react';

/**
 * Image wrapper for user/provider supplied assets.
 *
 * Broken remote URLs must never leave an empty logo area in the UI. The
 * fallback is intentionally supplied by the caller so each surface can keep
 * its own size and visual language.
 */
export function SafeImage({ src, alt = '', fallback = null, onError, ...props }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (!src || failed) return fallback;

  return (
    <img
      {...props}
      src={src}
      alt={alt}
      onError={(event) => {
        setFailed(true);
        onError?.(event);
      }}
    />
  );
}