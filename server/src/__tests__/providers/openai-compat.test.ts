import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';

describe('OpenAICompatProvider', () => {
  let provider: OpenAICompatProvider;

  beforeEach(() => {
    provider = new OpenAICompatProvider({
      platform: 'groq',
      name: 'TestProvider',
      baseUrl: 'https://api.test.com/v1',
      extraHeaders: { 'X-Custom': 'test' },
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('should set platform and name from config', () => {
    expect(provider.platform).toBe('groq');
    expect(provider.name).toBe('TestProvider');
  });

  it('should call API with correct URL and headers', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      capturedUrl = url as string;
      capturedHeaders = (init as any).headers;
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'test-id',
          object: 'chat.completion',
          created: 123,
          model: 'test-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      } as any;
    });

    await provider.chatCompletion('my-key', [{ role: 'user', content: 'test' }], 'test-model');

    expect(capturedUrl).toBe('https://api.test.com/v1/chat/completions');
    expect(capturedHeaders['Authorization']).toBe('Bearer my-key');
    expect(capturedHeaders['X-Custom']).toBe('test');
    expect(capturedBody.messages[0].role).toBe('user');
  });

  it('uses OpenRouter dedicated image API with the configured model and returns image bytes', async () => {
    const openrouter = new OpenAICompatProvider({
      platform: 'openrouter',
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      extraHeaders: { 'HTTP-Referer': 'https://whatsexpert.com', 'X-Title': 'WhatsExpert' },
    });
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      capturedUrl = url as string;
      capturedHeaders = (init as any).headers;
      capturedBody = JSON.parse((init as any).body);
      return new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=', media_type: 'image/png' }] }));
    });

    const result = await openrouter.generateImage(
      'openrouter-test-key', 'qwen/qwen-image-2.1-turbo', 'A teal abstract chat icon',
      { n: 1, size: '1024x1024' },
    );

    expect(capturedUrl).toBe('https://openrouter.ai/api/v1/images');
    expect(capturedHeaders.Authorization).toBe('Bearer openrouter-test-key');
    expect(capturedHeaders['HTTP-Referer']).toBe('https://whatsexpert.com');
    expect(capturedBody).toMatchObject({
      model: 'qwen/qwen-image-2.1-turbo',
      prompt: 'A teal abstract chat icon',
      resolution: '1K',
      aspect_ratio: '1:1',
      n: 1,
    });
    expect(result).toEqual({ b64Images: ['aGVsbG8='], mimeType: 'image/png' });
  });

  it('does not enable image generation for other OpenAI-compatible providers', async () => {
    await expect(provider.generateImage('key', 'model', 'prompt')).rejects.toThrow(/does not support image generation/);
  });

  it('should pass tool-calling params through untouched', async () => {
    let capturedBody: any = null;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'test-id',
          object: 'chat.completion',
          created: 123,
          model: 'test-model',
          choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [] }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      } as any;
    });

    await provider.chatCompletion(
      'my-key',
      [{ role: 'user', content: 'what is weather?' }],
      'test-model',
      {
        tools: [{
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        }],
        tool_choice: 'required',
        parallel_tool_calls: true,
      },
    );

    expect(capturedBody.tools).toHaveLength(1);
    expect(capturedBody.tool_choice).toBe('required');
    expect(capturedBody.parallel_tool_calls).toBe(true);
  });

  it('should throw on error response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: 'Rate Limited',
      json: () => Promise.resolve({ error: { message: 'Too many requests' } }),
    } as any);

    await expect(
      provider.chatCompletion('key', [{ role: 'user', content: 'hi' }], 'model')
    ).rejects.toThrow(/Too many requests/);
  });

  it('should validate key using models endpoint', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true, status: 200 } as any);
    expect(await provider.validateKey('valid')).toBe(true);
  });

  it('validateKey returns false on confirmed 401', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: false, status: 401 } as any);
    expect(await provider.validateKey('bad')).toBe(false);
  });

  it('validateKey propagates transport errors instead of swallowing', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(provider.validateKey('any')).rejects.toThrow(/ECONNREFUSED/);
  });

  async function completeMessage(message: Record<string, unknown>, finishReason = 'stop') {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finishReason }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as any);

    return provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
  }

  async function streamDeltas(deltas: Record<string, unknown>[], finishReason = 'stop') {
    const events = deltas.map((delta, index) => `data: ${JSON.stringify({
      id: 'id', object: 'chat.completion.chunk', created: 1, model: 'm',
      choices: [{ index: 0, delta, finish_reason: index === deltas.length - 1 ? finishReason : null }],
    })}\n\n`).join('') + 'data: [DONE]\n\n';
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(events, {
      headers: { 'Content-Type': 'text/event-stream' },
    }));

    const chunks = [];
    for await (const chunk of provider.streamChatCompletion('k', [{ role: 'user', content: 'hi' }], 'm')) {
      chunks.push(chunk);
    }
    return chunks;
  }

  it.each(['reasoning_content', 'reasoning', 'reasoning_details', 'thinking',
    'thinking_content', 'thinking_blocks', 'analysis', 'analysis_content'])(
    'strips %s without promoting it into empty final content', async (field) => {
      const result = await completeMessage({ content: '', [field]: 'synthetic private block' });
      expect(result.choices[0].message.content).toBe('');
      expect(result.choices[0].message).not.toHaveProperty(field);
    },
  );

  it('preserves null final content when reasoning exhausts the response budget', async () => {
    const result = await completeMessage({
      content: null,
      reasoning_content: 'We need to follow internal policies...',
    }, 'length');
    expect(result.choices[0].message.content).toBeNull();
    expect(result.choices[0].message).not.toHaveProperty('reasoning_content');
    expect(result.choices[0].finish_reason).toBe('length');
    expect(result.usage).toEqual({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
    expect(result._routed_via).toEqual({ platform: 'groq', model: 'm' });
  });

  it('flattens array content into a string (Mistral magistral style)', async () => {
    const result = await completeMessage({
      content: [{ type: 'text', text: 'part one ' }, { type: 'text', text: 'part two' }],
    });
    expect(result.choices[0].message.content).toBe('part one part two');
  });

  it('flattens only strings and explicitly typed text blocks from mixed content', async () => {
    const result = await completeMessage({
      content: [
        { type: 'thinking', text: 'synthetic private block' },
        { type: 'reasoning', text: 'synthetic private block' },
        { type: 'analysis', text: 'synthetic private block' },
        { type: 'text', text: 'مرحبا ' },
        'بك',
        { text: 'untyped block' },
        { type: 'image_url', text: 'not final text' },
        { type: 'text', text: 123 },
        null,
        123,
      ],
    });
    expect(result.choices[0].message.content).toBe('مرحبا بك');
  });

  it('does not substitute any side channel when all content blocks are private', async () => {
    const result = await completeMessage({
      content: [{ type: 'thinking', text: 'synthetic private block' }],
      reasoning_content: 'synthetic private block',
      reasoning: 'synthetic private block',
    });
    expect(result.choices[0].message.content).toBe('');
    expect(result.choices[0].message).not.toHaveProperty('reasoning_content');
    expect(result.choices[0].message).not.toHaveProperty('reasoning');
  });

  it('preserves null content and tool calls while stripping reasoning', async () => {
    const toolCalls = [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }];
    const result = await completeMessage({
      content: null,
      reasoning_content: 'synthetic private block',
      tool_calls: toolCalls,
    }, 'tool_calls');
    expect(result.choices[0].message.content).toBeNull();
    expect(result.choices[0].message.tool_calls).toEqual(toolCalls);
    expect(result.choices[0].message).not.toHaveProperty('reasoning_content');
    expect(result.choices[0].finish_reason).toBe('tool_calls');
  });

  it('leaves real string content untouched', async () => {
    const result = await completeMessage({
      content: 'مرحبا بك', reasoning_content: 'synthetic private block', reasoning: 'synthetic private block',
    });
    expect(result.choices[0].message.content).toBe('مرحبا بك');
    expect(result.choices[0].message).not.toHaveProperty('reasoning_content');
    expect(result.choices[0].message).not.toHaveProperty('reasoning');
  });

  it('streams only final text while removing all private side channels', async () => {
    const chunks = await streamDeltas([
      { role: 'assistant', reasoning_content: 'synthetic private block', reasoning: 'synthetic private block' },
      { thinking: 'synthetic private block', thinking_content: 'synthetic private block',
        thinking_blocks: [], reasoning_details: [], analysis: 'synthetic private block',
        analysis_content: 'synthetic private block' },
      { content: 'مرحبا', reasoning_content: 'synthetic private block' },
      { content: [{ type: 'thinking', text: 'synthetic private block' },
        { type: 'reasoning', text: 'synthetic private block' },
        { type: 'analysis', text: 'synthetic private block' },
        { type: 'text', text: ' ' }, 'بك', { text: 'untyped block' }, null] },
    ]);
    expect(chunks).toHaveLength(4);
    expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant' });
    expect(chunks[1].choices[0].delta).toEqual({});
    expect(chunks[2].choices[0].delta).toEqual({ content: 'مرحبا' });
    expect(chunks[3].choices[0].delta).toEqual({ content: ' بك' });
    expect(chunks[3].choices[0].finish_reason).toBe('stop');
  });

  it('preserves null streaming content and length without substituting reasoning', async () => {
    const chunks = await streamDeltas([{ content: null, reasoning_content: 'synthetic private block' }], 'length');
    expect(chunks[0].choices[0].delta).toEqual({ content: null });
    expect(chunks[0].choices[0].finish_reason).toBe('length');
  });

  it('preserves streamed tool calls and null content while stripping reasoning', async () => {
    const toolCalls = [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }];
    const chunks = await streamDeltas([{
      content: null, tool_calls: toolCalls, reasoning: 'synthetic private block',
    }], 'tool_calls');
    expect(chunks[0].choices[0].delta).toEqual({ content: null, tool_calls: toolCalls });
    expect(chunks[0].choices[0].finish_reason).toBe('tool_calls');
  });

  for (const streaming of [false, true]) {
    it.each([
      { platform: 'openrouter', model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
        reasoning: { exclude: true, enabled: false } },
      { platform: 'openrouter', model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
        reasoning: { exclude: true, enabled: false } },
      { platform: 'openrouter', model: 'ordinary-model', reasoning: { exclude: true } },
      { platform: 'openrouter', model: 'nvidia/another-reasoning-model:free', reasoning: { exclude: true } },
      { platform: 'groq', model: 'ordinary-model', reasoning: undefined },
      { platform: 'nvidia', model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', reasoning: undefined },
    ])(`uses scoped reasoning defaults for $platform / $model (stream=${streaming})`, async (testCase) => {
      const instance = new OpenAICompatProvider({
        platform: testCase.platform as 'openrouter' | 'groq' | 'nvidia',
        name: 'TestProvider', baseUrl: 'https://api.test.com/v1',
      });
      let body: any;
      vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
        body = JSON.parse(init!.body as string);
        return new Response(streaming ? 'data: [DONE]\n\n' : JSON.stringify({
          id: 'id', object: 'chat.completion', created: 1, model: testCase.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      });

      const messages = [{ role: 'user' as const, content: 'hi' }];
      if (streaming) {
        for await (const _chunk of instance.streamChatCompletion('k', messages, testCase.model, { max_tokens: 450 })) {
          // Consume the mocked SSE response to send the request.
        }
      } else {
        await instance.chatCompletion('k', messages, testCase.model, { max_tokens: 450 });
      }
      expect(body.reasoning).toEqual(testCase.reasoning);
      if (testCase.reasoning === undefined) expect(body).not.toHaveProperty('reasoning');
      expect(body.max_tokens).toBe(450);
      expect(body.stream).toBe(streaming ? true : undefined);
    });
  }
});

describe('OpenAICompatProvider - platform instances', () => {
  // Mirrors the actual registrations in server/src/providers/index.ts.
  // Update both when adding/removing a platform.
  const platforms = [
    { platform: 'groq',       name: 'Groq',          baseUrl: 'https://api.groq.com/openai/v1' },
    { platform: 'cerebras',   name: 'Cerebras',      baseUrl: 'https://api.cerebras.ai/v1' },
    { platform: 'sambanova',  name: 'SambaNova',     baseUrl: 'https://api.sambanova.ai/v1' },
    { platform: 'nvidia',     name: 'NVIDIA NIM',    baseUrl: 'https://integrate.api.nvidia.com/v1' },
    { platform: 'mistral',    name: 'Mistral',       baseUrl: 'https://api.mistral.ai/v1' },
    { platform: 'openrouter', name: 'OpenRouter',    baseUrl: 'https://openrouter.ai/api/v1' },
    { platform: 'github',     name: 'GitHub Models', baseUrl: 'https://models.github.ai/inference' },
    { platform: 'zhipu',      name: 'Zhipu AI',      baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  ] as const;

  for (const p of platforms) {
    it(`${p.name} provider should make requests to ${p.baseUrl}`, async () => {
      const provider = new OpenAICompatProvider(p as any);

      let capturedUrl = '';
      vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
        capturedUrl = url as string;
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'id', object: 'chat.completion', created: 1, model: 'm',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }),
        } as any;
      });

      const result = await provider.chatCompletion('key', [{ role: 'user', content: 'hi' }], 'model');
      expect(capturedUrl).toContain(p.baseUrl);
      expect(result._routed_via?.platform).toBe(p.platform);
    });
  }
});
