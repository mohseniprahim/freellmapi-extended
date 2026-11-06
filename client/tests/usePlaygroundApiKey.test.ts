import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useQuery } from '@tanstack/react-query'
import { ApiSessionExpiredError, SESSION_EXPIRED_MESSAGE } from '../src/lib/api'
import { API_KEY_MISSING_MESSAGE, usePlaygroundApiKey } from '../src/pages/playground/usePlaygroundApiKey'

vi.mock('@tanstack/react-query', () => ({ useQuery: vi.fn() }))

const syntheticKey = 'myllm-synthetic-test-only'
function queryState(overrides: Record<string, unknown> = {}) {
  vi.mocked(useQuery).mockReturnValue({
    data: undefined, isFetching: false, isPending: false, isError: false, error: null,
    ...overrides,
  } as ReturnType<typeof useQuery>)
}

beforeEach(() => queryState())

describe('usePlaygroundApiKey', () => {
  it('keeps the default scalar return for existing consumers', () => {
    queryState({ data: { apiKey: syntheticKey } })
    expect(usePlaygroundApiKey()).toBe(syntheticKey)
    expect(usePlaygroundApiKey({ withState: true })).toMatchObject({ apiKey: syntheticKey, isReady: true, status: 'ready', message: undefined })
  })

  it('blocks the initial load and a paused pending query with an Arabic status', () => {
    for (const isFetching of [true, false]) {
      queryState({ isFetching, isPending: true })
      expect(usePlaygroundApiKey()).toBeUndefined()
      expect(usePlaygroundApiKey({ withState: true })).toMatchObject({ apiKey: undefined, isReady: false, status: 'loading', message: expect.stringContaining('جارٍ تحميل') })
    }
  })

  it('withholds a cached key throughout refetch and exposes only the fresh result', () => {
    queryState({ data: { apiKey: syntheticKey }, isFetching: true })
    expect(usePlaygroundApiKey()).toBeUndefined()
    expect(usePlaygroundApiKey({ withState: true })).toMatchObject({ isReady: false, status: 'refetching', message: expect.stringContaining('إعادة التحقق') })
    queryState({ data: { apiKey: 'myllm-new-synthetic-test-only' } })
    expect(usePlaygroundApiKey()).toBe('myllm-new-synthetic-test-only')
  })

  it('never exposes cached data after refetch fails', () => {
    const error = new Error('synthetic fetch failure')
    queryState({ data: { apiKey: syntheticKey }, isError: true, error })
    expect(usePlaygroundApiKey()).toBeUndefined()
    expect(usePlaygroundApiKey({ withState: true })).toMatchObject({ apiKey: undefined, isReady: false, status: 'error', error, message: expect.stringContaining('تعذر تحميل') })
  })

  it('preserves the Arabic session-expired message instead of describing a failed query as loading', () => {
    queryState({ isError: true, error: new ApiSessionExpiredError(), data: { apiKey: syntheticKey } })
    expect(usePlaygroundApiKey({ withState: true })).toMatchObject({ isReady: false, status: 'error', message: SESSION_EXPIRED_MESSAGE })
  })

  it.each([undefined, '', '   ', null, 123])('rejects missing or malformed response key %s', apiKey => {
    queryState({ data: { apiKey } })
    expect(usePlaygroundApiKey()).toBeUndefined()
    expect(usePlaygroundApiKey({ withState: true })).toMatchObject({ isReady: false, status: 'missing', message: API_KEY_MISSING_MESSAGE })
  })

  it('reuses invalidation identity without retaining an unobserved long-lived cache', () => {
    usePlaygroundApiKey()
    expect(vi.mocked(useQuery).mock.calls[0][0]).toMatchObject({
      queryKey: ['unified-key'], staleTime: 0, gcTime: 0, retry: false,
      refetchOnMount: 'always', refetchOnWindowFocus: 'always',
    })
  })
})
