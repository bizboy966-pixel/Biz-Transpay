import { useEffect, useState } from 'react';
import api from '@/api';

/** Public /settings/features cached in-memory for the current session.
 *  Refreshed each time useFeatures() mounts so admin toggles reflect quickly. */
export function useFeatures() {
  const [features, setFeatures] = useState(null);
  useEffect(() => {
    let alive = true;
    api.get('/settings/features')
      .then(({ data }) => { if (alive) setFeatures(data); })
      .catch(() => { if (alive) setFeatures({ mobile_money_enabled: true, crypto_enabled: true }); });
    return () => { alive = false; };
  }, []);
  return features;
}
