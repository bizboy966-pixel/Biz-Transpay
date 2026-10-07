import { useQuery } from '@tanstack/react-query';
import api from '@/api';

export const FEATURES_QUERY_KEY = ['public-features'];

const DEFAULT_FEATURES = { mobile_money_enabled: true, crypto_enabled: true };

/** Share the small public feature response between pages; admin saves invalidate it. */
export function useFeatures() {
  const { data } = useQuery({
    queryKey: FEATURES_QUERY_KEY,
    queryFn: async () => {
      try {
        const { data: features } = await api.get('/settings/features');
        return features;
      } catch {
        return DEFAULT_FEATURES;
      }
    },
    staleTime: 15_000,
  });
  return data ?? null;
}
