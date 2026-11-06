import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch, assertApiSession, ApiSessionExpiredError, readApiJson, SESSION_EXPIRED_MESSAGE } from '../src/lib/api'

function loginResponse(contentType = 'text/html; charset=utf-8', url = 'https://example.invalid/llm-admin/login') {
  const response = new Response('<!doctype html><html>Login</html>', { headers: { 'Content-Type': contentType } })
  Object.defineProperties(response, { redirected: { value: true }, url: { value: url } })
  return response
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } })))
})
afterEach(() => vi.unstubAllGlobals())

describe('apiFetch headers', () => {
  it('preserves the default Content-Type and deployment prefix', async () => {
    await expect(apiFetch('/api/settings/api-key')).resolves.toEqual({ ok: true })
    const [url, options] = vi.mocked(fetch).mock.calls[0]
    expect(url).toBe('/llm-admin/api/settings/api-key')
    expect(options?.headers).toBeInstanceOf(Headers)
    expect(new Headers(options?.headers).get('Content-Type')).toBe('application/json')
  })

  it.each([
    ['record', { 'X-Audit': 'synthetic' }],
    ['tuples', [['X-Audit', 'synthetic']]],
    ['Headers', new Headers({ 'X-Audit': 'synthetic' })],
  ] as [string, HeadersInit][])('merges %s without dropping default headers or request options', async (_name, headers) => {
    const signal = new AbortController().signal
    await apiFetch('/api/test', { method: 'POST', body: '{}', headers, signal, credentials: 'same-origin' })
    const options = vi.mocked(fetch).mock.calls[0][1]!
    expect(options).toMatchObject({ method: 'POST', body: '{}', signal, credentials: 'same-origin' })
    expect(new Headers(options.headers).get('Content-Type')).toBe('application/json')
    expect(new Headers(options.headers).get('X-Audit')).toBe('synthetic')
  })

  it.each([
    ['record', { 'content-type': 'application/custom+json' }],
    ['tuples', [['CONTENT-TYPE', 'application/custom+json']]],
    ['Headers', new Headers({ 'Content-Type': 'application/custom+json' })],
  ] as [string, HeadersInit][])('honors caller Content-Type in %s case-insensitively', async (_name, headers) => {
    await apiFetch('/api/test', { headers })
    expect(new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).get('Content-Type')).toBe('application/custom+json')
  })

  it('does not mutate caller-owned Headers', async () => {
    const headers = new Headers({ Authorization: 'Bearer myllm-synthetic-test-only' })
    await apiFetch('/api/test', { headers })
    expect(headers.has('Content-Type')).toBe(false)
    expect(new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer myllm-synthetic-test-only')
  })
})

describe('session and response errors', () => {
  it('reports redirected HTTP 200 login HTML in Arabic before parsing JSON', async () => {
    const response = loginResponse()
    const json = vi.spyOn(response, 'json')
    vi.mocked(fetch).mockResolvedValueOnce(response)
    await expect(apiFetch('/api/settings/api-key')).rejects.toThrow(SESSION_EXPIRED_MESSAGE)
    expect(json).not.toHaveBeenCalled()
  })

  it('recognizes a login redirect even when Content-Type is absent or incorrect', async () => {
    await expect(readApiJson(loginResponse('text/plain', 'https://example.invalid/llm-admin/login/?next=test'))).rejects.toBeInstanceOf(ApiSessionExpiredError)
  })

  it('recognizes redirected HTML when the final URL is not exposed', () => {
    expect(() => assertApiSession(loginResponse('application/xhtml+xml', ''))).toThrow(SESSION_EXPIRED_MESSAGE)
  })

  it('protects binary consumers from treating login HTML as audio', () => {
    expect(() => assertApiSession(loginResponse())).toThrow(ApiSessionExpiredError)
  })

  it('does not reject a successful redirected JSON API response', async () => {
    const response = new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } })
    Object.defineProperties(response, { redirected: { value: true }, url: { value: 'https://example.invalid/api/new' } })
    await expect(readApiJson(response)).resolves.toEqual({ ok: true })
  })

  it('preserves JSON API errors and provides a non-JSON HTTP fallback', async () => {
    await expect(readApiJson(new Response('{"error":{"message":"Invalid API key"}}', { status: 401 }))).rejects.toThrow('Invalid API key')
    await expect(readApiJson(new Response('bad gateway', { status: 502 }))).rejects.toThrow('HTTP 502')
  })
})
