import { useQuery } from '@tanstack/react-query';
import api from '@/api';

export const SUPPORT_CONFIG_QUERY_KEY = ['support-config'];

export function useSupportConfig() {
  const { data } = useQuery({
    queryKey: SUPPORT_CONFIG_QUERY_KEY,
    queryFn: async () => {
      try {
        const { data: config } = await api.get('/support/config');
        return config || {};
      } catch {
        return {};
      }
    },
    staleTime: 30_000,
  });
  return data;
}
