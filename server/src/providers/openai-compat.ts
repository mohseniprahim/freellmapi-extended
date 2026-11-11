import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  Platform,
} from '@myllm/shared/types.js';
import { BaseProvider, type CompletionOptions, type EmbedOptions, type EmbedResult, type ImageGenerationOptions, type ImageGenerationResult } from './base.js';

/**
 * Generic provider for platforms that use an OpenAI-compatible API.
 * Covers: Groq, Cerebras, SambaNova, NVIDIA NIM, Mistral, OpenRouter,
 * GitHub Models, Fireworks AI.
 */
export class OpenAICompatProvider extends BaseProvider {
  readonly platform: Platform;
  readonly name: string;
  /** Keyless providers (Kilo's anonymous gateway, etc.) set this false so the
   *  router synthesizes a placeholder key row and we send NO Authorization
   *  header (an empty `Bearer ` is rejected by some gateways). */
  readonly requiresApiKey: boolean;
  private readonly baseUrl: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly validateUrl?: string;
  /** Per-provider HTTP timeout override. Cloud APIs finish in ~15s; locally-hosted
   * inference (llama.cpp / vLLM on CPU) can take 30-120s for long prompts. Default 15000. */
  private readonly timeoutMs: number;

  constructor(opts: {
    platform: Platform;
    name: string;
    baseUrl: string;
    extraHeaders?: Record<string, string>;
    validateUrl?: string;
    timeoutMs?: number;
    requiresApiKey?: boolean;
  }) {
    super();
    this.platform = opts.platform;
    this.name = opts.name;
    this.baseUrl = opts.baseUrl;
    this.extraHeaders = opts.extraHeaders ?? {};
    this.validateUrl = opts.validateUrl;
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.requiresApiKey = opts.requiresApiKey ?? true;
  }

  /** Authorization header — omitted for keyless providers when apiKey is empty,
   *  so anonymous gateways don't see a malformed `Bearer ` token. */
  private authHeaders(apiKey: string): Record<string, string> {
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  }

  /** Hide OpenRouter reasoning; disable it only for the verified optional-
   * thinking Nemotron Omni model, never for models with mandatory reasoning. */
  private reasoningOptions(modelId: string): { exclude: true; enabled?: false } | undefined {
    if (this.platform !== 'openrouter') return undefined;
    if (modelId === 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free'
      || modelId === 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning') {
      return { exclude: true, enabled: false };
    }
    return { exclude: true };
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        ...this.authHeaders(apiKey),
        'Content-Type': 'application/json',
        ...this.extraHeaders,
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        temperature: options?.temperature,
        max_tokens: options?.max_tokens,
        top_p: options?.top_p,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: options?.parallel_tool_calls,
        response_format: options?.response_format,
        reasoning: this.reasoningOptions(modelId),
      }),
    }, options?.timeoutMs ?? this.timeoutMs);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`${this.name} API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    const data = await res.json() as ChatCompletionResponse;
    normalizeChoices(data);
    data._routed_via = { platform: this.platform, model: modelId };
    return data;
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        ...this.authHeaders(apiKey),
        'Content-Type': 'application/json',
        ...this.extraHeaders,
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        temperature: options?.temperature,
        max_tokens: options?.max_tokens,
        top_p: options?.top_p,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: options?.parallel_tool_calls,
        response_format: options?.response_format,
        reasoning: this.reasoningOptions(modelId),
        stream: true,
      }),
    }, options?.timeoutMs ?? this.timeoutMs);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`${this.name} API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') return;
        try {
          const chunk = JSON.parse(data) as ChatCompletionChunk;
          normalizeChoices(chunk);
          yield chunk;
        } catch {
          // Skip malformed chunks
        }
      }
    }
  }

  async validateKey(apiKey: string): Promise<boolean> {
    // Note: transport errors (DNS / timeout / TLS) propagate to the caller.
    // health.ts catches them and marks status='error' WITHOUT incrementing
    // the consecutive-failure counter — only confirmed 401/403 disables a key.
    const url = this.validateUrl ?? `${this.baseUrl}/models`;
    // 20s timeout: some providers (Ollama Cloud, OpenRouter under load) take
    // 10-15s for /models even when the key is healthy. 10s previously caused
    // benign abort warnings in the log every few sweeps.
    const res = await this.fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        ...this.authHeaders(apiKey),
        ...this.extraHeaders,
      },
    }, 20000);
    return res.status !== 401 && res.status !== 403;
  }

  /**
   * OpenAI-compatible /v1/embeddings. Used by Mistral, Zhipu, GitHub Models,
   * NVIDIA NIM, OpenRouter, and any other provider whose embedding endpoint
   * matches the OpenAI shape:
   *   POST {baseUrl}/embeddings  body {model, input, dimensions?}
   *   reply {object:'list', data:[{embedding:[...],index}], usage:{prompt_tokens}}
   *
   * Cohere is NOT routed through here — it uses its own /v1/embed endpoint
   * with different field names. See cohere.ts.
   */
  async embed(
    apiKey: string,
    modelId: string,
    input: string[],
    options?: EmbedOptions,
  ): Promise<EmbedResult> {
    const url = `${this.baseUrl}/embeddings`;
    const body: Record<string, unknown> = {
      model: modelId,
      input,
    };
    if (options?.dimensions != null) body.dimensions = options.dimensions;
    // NVIDIA NIM embed-qa models REQUIRE `input_type` ('query'|'passage');
    // others ignore the field. Default to 'query' so RAG search flows work
    // out of the box; client can override via EmbedOptions.inputType.
    if (this.platform === 'nvidia') {
      body.input_type = options?.inputType === 'search_document' ? 'passage' : 'query';
      body.truncate = 'NONE';
    }

    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        ...this.authHeaders(apiKey),
        'Content-Type': 'application/json',
        ...this.extraHeaders,
      },
      body: JSON.stringify(body),
    }, this.timeoutMs);

    if (!res.ok) {
      let msg = res.statusText;
      try {
        const e = await res.json() as any;
        msg = e.error?.message ?? e.message ?? msg;
      } catch {}
      throw new Error(`${this.name} embed API error ${res.status}: ${msg}`);
    }

    const data = await res.json() as {
      data?: Array<{ embedding: number[]; index?: number }>;
      usage?: { prompt_tokens?: number; total_tokens?: number };
      model?: string;
    };

    if (!data.data || data.data.length === 0) {
      throw new Error(`${this.name} embed API: empty response from ${modelId}`);
    }

    // Preserve input-array order even if the upstream re-shuffled (some
    // providers return data sorted by index, others by submission order).
    const sorted = [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors = sorted.map(d => d.embedding);
    const dimensions = vectors[0]?.length ?? 0;
    const promptTokens = data.usage?.prompt_tokens
      ?? Math.ceil(input.reduce((s, t) => s + t.length, 0) / 4);

    return { vectors, promptTokens, dimensions };
  }

  /** OpenRouter's dedicated image API is not the OpenAI /images/generations shape.
   * Keep this override scoped to OpenRouter so other compatible chat providers
   * continue to reject image generation unless explicitly implemented. */
  async generateImage(
    apiKey: string,
    modelId: string,
    prompt: string,
    options?: ImageGenerationOptions,
  ): Promise<ImageGenerationResult> {
    if (this.platform !== 'openrouter') return super.generateImage(apiKey, modelId, prompt, options);

    const [width, height] = (options?.size ?? '1024x1024').split('x').map(Number);
    const aspectRatio = width > 0 && height > 0 ? `${width / gcd(width, height)}:${height / gcd(width, height)}` : '1:1';
    const payload = {
      model: modelId,
      prompt: options?.negative_prompt ? `${prompt}\n\nAvoid: ${options.negative_prompt}` : prompt,
      resolution: Math.max(width, height) > 1024 ? '2K' : '1K',
      aspect_ratio: aspectRatio,
      n: options?.n ?? 1,
    };
    const response = await this.fetchWithTimeout(`${this.baseUrl}/images`, {
      method: 'POST',
      headers: {
        ...this.authHeaders(apiKey),
        'Content-Type': 'application/json',
        ...this.extraHeaders,
      },
      body: JSON.stringify(payload),
    }, 120_000);

    if (!response.ok) {
      let message = response.statusText;
      try {
        const error = await response.json() as any;
        message = error.error?.message ?? error.message ?? message;
      } catch {}
      throw new Error(`${this.name} image API error ${response.status}: ${message}`);
    }

    const data = await response.json() as {
      data?: Array<{ b64_json?: string; media_type?: string }>;
    };
    const images = (data.data ?? []).filter((item): item is { b64_json: string; media_type?: string } => Boolean(item.b64_json));
    if (images.length === 0) throw new Error(`${this.name} image API returned no base64 image data for ${modelId}`);
    const mimeType = images[0].media_type === 'image/jpeg' ? 'image/jpeg'
      : images[0].media_type === 'image/webp' ? 'image/webp' : 'image/png';
    return { b64Images: images.map(image => image.b64_json), mimeType };
  }
}

function gcd(a: number, b: number): number {
  a = Math.abs(Math.trunc(a));
  b = Math.abs(Math.trunc(b));
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

/**
 * Normalize only final-answer text, for both complete messages and stream
 * deltas. Reasoning is never a substitute for an empty/truncated answer.
 */
function normalizeChoices(data: ChatCompletionResponse | ChatCompletionChunk): void {
  for (const choice of data.choices ?? []) {
    normalizeAssistantContent('message' in choice ? choice.message : choice.delta);
  }
}

function normalizeAssistantContent(message: unknown): void {
  if (!message || typeof message !== 'object') return;
  const msg = message as Record<string, unknown>;

  // Some providers return mixed text/thinking blocks. Only explicitly typed
  // text blocks or plain strings belong in customer-facing final content.
  if (Array.isArray(msg.content)) {
    msg.content = msg.content.map(seg => {
      if (typeof seg === 'string') return seg;
      if (seg && typeof seg === 'object' && seg.type === 'text' && typeof seg.text === 'string') {
        return seg.text;
      }
      return '';
    }).join('');
  }

  // Remove provider-private side channels so compatible clients cannot
  // accidentally display them. Preserve content=null (including tool calls),
  // absent stream content, tool_calls, finish_reason and other metadata.
  for (const field of [
    'reasoning_content', 'reasoning', 'reasoning_details',
    'thinking', 'thinking_content', 'thinking_blocks',
    'analysis', 'analysis_content',
  ]) {
    delete msg[field];
  }
}
