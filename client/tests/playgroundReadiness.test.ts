import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isValidElement } from 'react'
import type { ReactElement } from 'react'
import { Button } from '../src/components/ui/button'
import PlaygroundPage from '../src/pages/PlaygroundPage'
import ImageEditPanel from '../src/pages/playground/ImageEditPanel'
import { EmbeddingPanel, ImageGenPanel, RerankPanel, SttPanel, TtsPanel } from '../src/pages/playground/ModalityPanels'
import { API_KEY_MISSING_MESSAGE } from '../src/pages/playground/usePlaygroundApiKey'
import type { PlaygroundApiKeyState } from '../src/pages/playground/usePlaygroundApiKey'

// Exercise the actual element props and request handlers without adding a DOM
// dependency. Controlled state fixtures ensure inputs are valid, so readiness
// (rather than empty inputs) is what disables each request button.
const mocks = vi.hoisted(() => ({
  values: [] as unknown[],
  setters: [] as ReturnType<typeof vi.fn>[],
  refs: [] as unknown[],
  keyState: {} as PlaygroundApiKeyState,
}))
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState: () => {
    const setter = vi.fn()
    mocks.setters.push(setter)
    return [mocks.values.shift(), setter]
  },
  useRef: () => ({ current: mocks.refs.shift() ?? null }),
  useEffect: () => {},
}))
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: [] }) }))
vi.mock('../src/pages/playground/usePlaygroundApiKey', async importOriginal => ({
  ...await importOriginal<typeof import('../src/pages/playground/usePlaygroundApiKey')>(),
  usePlaygroundApiKey: () => mocks.keyState,
}))
vi.mock('../src/components/ui/button', () => ({ Button: 'test-button' }))
vi.mock('../src/components/ui/label', () => ({ Label: 'test-label' }))
vi.mock('../src/components/page-header', () => ({ PageHeader: 'test-page-header' }))
vi.mock('../src/components/ui/select', () => ({
  Select: 'test-select', SelectContent: 'test-select-content', SelectItem: 'test-select-item',
  SelectTrigger: 'test-select-trigger', SelectValue: 'test-select-value',
}))

function elements(node: unknown): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement(node)) return []
  const element = node as ReactElement<Record<string, any>>
  return [element, ...elements(element.props.children)]
}

const imageStates = (mode: string) => [mode, 'data:image/png;base64,U1lOVEhFVElD', { w: 1, h: 1 }, 'synthetic prompt', 32, 'right', 128, 0.8, false, null, null]
const panels = [
  { name: 'image generation', component: ImageGenPanel, button: 'Generate', values: () => ['synthetic prompt', false, '', [], undefined] },
  { name: 'text-to-speech', component: TtsPanel, button: 'Synthesise', values: () => ['synthetic text', 'alloy', false, '', undefined, undefined] },
  { name: 'speech-to-text', component: SttPanel, button: 'Transcribe', values: () => ['synthetic.wav', 'data:audio/wav;base64,U1lOVEhFVElD', false, '', undefined, undefined] },
  { name: 'embeddings', component: EmbeddingPanel, button: 'Embed', values: () => ['synthetic text', false, '', null] },
  { name: 'rerank', component: RerankPanel, button: 'Rerank', values: () => ['synthetic query', 'one\ntwo', false, '', null] },
  { name: 'inpaint', component: ImageEditPanel, button: 'Run inpaint', values: () => imageStates('inpaint') },
  { name: 'outpaint', component: ImageEditPanel, button: 'Run outpaint', values: () => imageStates('outpaint') },
  { name: 'chat', component: PlaygroundPage, button: 'Send', values: () => ['chat', [], 'synthetic message', false, 'auto'] },
]

function panelTree(panel: typeof panels[number]) {
  mocks.values = panel.values()
  const tree = elements(panel.component())
  const button = tree.find(el => el.type === Button && el.props.children === panel.button)
  expect(button, `${panel.name} request button exists`).toBeDefined()
  return { tree, button: button! }
}

beforeEach(() => {
  mocks.values = []
  mocks.setters = []
  mocks.refs = []
  mocks.keyState = { apiKey: undefined, isReady: false, isFetching: false, status: 'missing', error: null, message: API_KEY_MISSING_MESSAGE }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { headers: { 'Content-Type': 'application/json' } })))
})
afterEach(() => vi.unstubAllGlobals())

describe.each(panels)('$name readiness', panel => {
  it.each(['loading', 'refetching', 'error', 'missing'] as const)('disables sending and guards the handler during %s', async status => {
    const message = status === 'error' ? 'تعذر تحميل مفتاح API.' : status === 'missing' ? API_KEY_MISSING_MESSAGE : 'جارٍ إعادة التحقق من مفتاح API.'
    // A refetch/error can leave stale cached data in the query. Even if present
    // in a state fixture, readiness must still prohibit sending it.
    mocks.keyState = { apiKey: status === 'refetching' || status === 'error' ? 'myllm-stale-synthetic-test-only' : undefined, isReady: false, isFetching: status === 'loading' || status === 'refetching', status, error: null, message }
    const { tree, button } = panelTree(panel)
    expect(button.props.disabled).toBe(true)
    expect(tree.some(el => el.props.msg === message || el.props.children === message)).toBe(true)
    await button.props.onClick()
    expect(fetch).not.toHaveBeenCalled()
    const updates = mocks.setters.flatMap(setter => setter.mock.calls.map(call => call[0]))
    expect(updates.some(value => value === message || (Array.isArray(value) && value.at(-1)?.content === message))).toBe(true)
  })

  it('enables the send button only with a verified key and valid inputs', () => {
    mocks.keyState = { apiKey: 'myllm-current-synthetic-test-only', isReady: true, isFetching: false, status: 'ready', error: null, message: undefined }
    const { button } = panelTree(panel)
    expect(button.props.disabled).toBe(false)
  })
})

it.each(panels.filter(panel => panel.name !== 'inpaint'))('$name sends a synthetic Bearer key once readiness is restored', async panel => {
  mocks.keyState = { apiKey: 'myllm-current-synthetic-test-only', isReady: true, isFetching: false, status: 'ready', error: null, message: undefined }
  // Outpaint only reads the image canvas; no real image processing is needed.
  if (panel.name === 'outpaint') mocks.refs = [{ toDataURL: () => 'data:image/png;base64,U1lOVEhFVElD' }]
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:synthetic-test-only')
  const { button } = panelTree(panel)
  await button.props.onClick()
  expect(fetch).toHaveBeenCalledOnce()
  const [url, options] = vi.mocked(fetch).mock.calls[0]
  expect(url).toMatch(/^\/llm-admin\/v1\//)
  expect(options?.method).toBe('POST')
  expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer myllm-current-synthetic-test-only')
})

it('text-to-speech displays the Arabic session expiry without consuming login HTML as audio', async () => {
  mocks.keyState = { apiKey: 'myllm-current-synthetic-test-only', isReady: true, isFetching: false, status: 'ready', error: null, message: undefined }
  const response = new Response('<html>Login</html>', { headers: { 'Content-Type': 'text/html' } })
  Object.defineProperties(response, { redirected: { value: true }, url: { value: 'https://example.invalid/llm-admin/login' } })
  const blob = vi.spyOn(response, 'blob')
  const json = vi.spyOn(response, 'json')
  vi.mocked(fetch).mockResolvedValueOnce(response)
  const { button } = panelTree(panels.find(panel => panel.name === 'text-to-speech')!)
  await button.props.onClick()
  expect(mocks.setters[3]).toHaveBeenLastCalledWith('انتهت جلسة الإدارة. يرجى تسجيل الدخول مجددًا ثم إعادة المحاولة.')
  expect(blob).not.toHaveBeenCalled()
  expect(json).not.toHaveBeenCalled()
})
