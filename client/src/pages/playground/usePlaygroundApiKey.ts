import { useQuery } from '@tanstack/react-query'
import { apiFetch, ApiSessionExpiredError } from '@/lib/api'

interface UnifiedApiKeyResponse {
  apiKey: string
}

export const API_KEY_MISSING_MESSAGE = 'مفتاح API غير متاح. يرجى التحقق من إعدادات المفتاح ثم إعادة المحاولة.'

export interface PlaygroundApiKeyState {
  apiKey: string | undefined
  isReady: boolean
  isFetching: boolean
  status: 'loading' | 'refetching' | 'error' | 'missing' | 'ready'
  error: Error | null
  message: string | undefined
}

/**
 * Share the API Keys page cache so regeneration invalidates the Playground key.
 * Never expose cached data during refetch or after an error. Request immediate
 * disposal when unused; other observers of this shared query may retain it.
 * The no-argument form remains compatible with existing scalar consumers.
 */
export function usePlaygroundApiKey(): string | undefined
export function usePlaygroundApiKey(options: { withState: true }): PlaygroundApiKeyState
export function usePlaygroundApiKey(options?: { withState: true }): string | undefined | PlaygroundApiKeyState {
  const { data, isFetching, isPending, isError, error } = useQuery<UnifiedApiKeyResponse>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  })
  const key = typeof data?.apiKey === 'string' ? data.apiKey.trim() : undefined
  const status: PlaygroundApiKeyState['status'] = isFetching || isPending
    ? (data ? 'refetching' : 'loading')
    : isError ? 'error' : key ? 'ready' : 'missing'
  const apiKey = status === 'ready' ? key : undefined
  const message = status === 'loading'
    ? 'جارٍ تحميل مفتاح API. يرجى الانتظار قبل الإرسال.'
    : status === 'refetching'
      ? 'جارٍ إعادة التحقق من مفتاح API. يرجى الانتظار قبل الإرسال.'
      : status === 'error'
        ? error instanceof ApiSessionExpiredError
          ? error.message
          : 'تعذر تحميل مفتاح API. يرجى إعادة تحميل الصفحة أو التحقق من جلسة الدخول.'
        : status === 'missing' ? API_KEY_MISSING_MESSAGE : undefined

  if (!options?.withState) return apiKey
  return { apiKey, isReady: status === 'ready', isFetching, status, error, message }
}
