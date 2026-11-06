import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

interface UnifiedApiKeyResponse {
  apiKey: string
}

/**
 * Share the same cache entry as the API Keys page. Regenerate invalidates this
 * query, so Playground picks up the new unified key instead of a stale default
 * client key. The server registers each regenerated unified key for /v1 auth.
 */
export function usePlaygroundApiKey() {
  const { data, isFetching } = useQuery<UnifiedApiKeyResponse>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  })
  return isFetching ? undefined : data?.apiKey
}
