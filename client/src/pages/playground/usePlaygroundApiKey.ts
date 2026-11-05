import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

interface ClientKeyReveal {
  id: number
  name: string
  key: string
}

/**
 * The Playground calls public /v1 routes, which authenticate against
 * client_keys. The dashboard's unified key belongs to a different auth path.
 */
export function usePlaygroundApiKey() {
  const { data } = useQuery<ClientKeyReveal>({
    queryKey: ['playground-client-key', 1],
    queryFn: () => apiFetch('/api/client-keys/1/reveal'),
  })
  return data?.key
}
