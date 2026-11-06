import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, getUnifiedApiKey, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import {
  chatCompletionSchema, isRetryableError, MAX_CHAT_ATTEMPTS,
  runChatCompletion, type ChatCompletionRequest,
} from '../../lib/runChatCompletion.js';
import { getProvider } from '../../providers/index.js';
import { routeRequest } from '../../services/router.js';
import { classifyError, isKeyWideError, setCooldown, setKeyCooldown } from '../../services/ratelimit.js';

const MANUAL_MODEL = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';
let sequence = 0;
const unique = (label: string) => `offline-${label}-${++sequence}`;

function addModel(platform: string, priority: number, opts: {
  id?: string; reasoning?: boolean; fallbackEnabled?: boolean; modelEnabled?: boolean;
  vision?: boolean; json?: boolean; context?: number;
} = {}) {
  const db = getDb();
  const modelId = opts.id ?? unique(platform);
  db.prepare(`INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank)
    VALUES (?, ?, ?, 50, 50)`).run(platform, modelId, modelId);
  db.prepare(`UPDATE models SET enabled=?, is_reasoning=?, vision_capable=?, supports_json_mode=?,
    modality='text', context_window=?, rpm_limit=NULL, rpd_limit=NULL, tpm_limit=NULL, tpd_limit=NULL
    WHERE platform=? AND model_id=?`).run(opts.modelEnabled === false ? 0 : 1, opts.reasoning ? 1 : 0,
    opts.vision ? 1 : 0, opts.json ? 1 : 0, opts.context ?? 262144, platform, modelId);
  const row = db.prepare('SELECT id FROM models WHERE platform=? AND model_id=?').get(platform, modelId) as { id: number };
  db.prepare(`INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, ?)
    ON CONFLICT(model_db_id) DO UPDATE SET priority=excluded.priority, enabled=excluded.enabled`)
    .run(row.id, priority, opts.fallbackEnabled === false ? 0 : 1);
  return { id: row.id, modelId };
}

function addKey(platform: string, enabled = true, status = 'healthy') {
  const key = encrypt(unique('synthetic-key'));
  const row = getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'offline-test', ?, ?, ?, ?, ?)`).run(platform, key.encrypted, key.iv, key.authTag, status, enabled ? 1 : 0);
  return Number(row.lastInsertRowid);
}

function stubProvider(platform: string, handler: (model: string) => string) {
  const provider = getProvider(platform as any)!;
  const completion = vi.spyOn(provider, 'chatCompletion').mockImplementation(async (_key, _messages, model) => ({
    id: 'offline-completion', object: 'chat.completion', created: 1, model,
    choices: [{ index: 0, message: { role: 'assistant', content: handler(model) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));
  const stream = vi.spyOn(provider, 'streamChatCompletion').mockImplementation(async function* (_key, _messages, model) {
    const content = handler(model);
    yield {
      id: 'offline-stream', object: 'chat.completion.chunk', created: 1, model,
      choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: 'stop' }],
    };
  });
  return { completion, stream };
}

function request(extra: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return chatCompletionSchema.parse({ messages: [{ role: 'user', content: unique('prompt') }], max_tokens: 100, ...extra });
}

let app: Express;
async function invoke(streaming: boolean, extra: Partial<ChatCompletionRequest> = {}) {
  const body = request({ ...extra, stream: streaming });
  if (!streaming) {
    const result = await runChatCompletion(body);
    return { routed: result.routedModel, raw: JSON.stringify(result.response), attempts: result.attempts };
  }
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getUnifiedApiKey()}` },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    if (!res.ok || raw.includes('"error":')) throw new Error(raw);
    return { routed: res.headers.get('X-Routed-Via')!.slice(res.headers.get('X-Routed-Via')!.indexOf('/') + 1),
      raw, attempts: Number(res.headers.get('X-Fallback-Attempts') ?? 0) };
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe('Auto routing regressions (no provider network)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    // initDb logs a generated test-only default credential; never capture it.
    const quiet = vi.spyOn(console, 'log').mockImplementation(() => {});
    initDb(':memory:');
    app = createApp();
    quiet.mockRestore();
  });
  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM cooldowns').run();
    db.prepare('DELETE FROM usage_counters').run();
    db.prepare('DELETE FROM requests').run();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('UPDATE models SET enabled=0').run();
    db.prepare('UPDATE fallback_config SET enabled=0').run();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const localFetch = globalThis.fetch.bind(globalThis);
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, opts) => {
      if (!String(url).startsWith('http://127.0.0.1:')) throw new Error('Provider network forbidden in routing tests');
      return localFetch(url, opts);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('preserves omitted versus explicit false nested reasoning policy; top-level is not the contract', () => {
    expect(request().extra).toBeUndefined();
    expect(request({ extra: {} }).extra?.allow_reasoning).toBeUndefined();
    expect(request({ extra: { allow_reasoning: false } }).extra?.allow_reasoning).toBe(false);
    expect(request({ extra: { allow_reasoning: true } }).extra?.allow_reasoning).toBe(true);
    expect(chatCompletionSchema.parse({ messages: [{ role: 'user', content: 'x' }], allow_reasoning: true }).extra).toBeUndefined();
  });

  for (const streaming of [false, true]) {
    const mode = streaming ? 'stream' : 'sync';
    it(`${mode}: invalid Google 400 key on eight models cascades to a healthy manual provider in two attempts`, async () => {
      for (let i = 0; i < 8; i++) addModel('google', i * 20 + 1);
      const good = addModel('groq', 1000);
      const badKey = addKey('google');
      addKey('groq');
      const bad = stubProvider('google', () => { throw new Error('Google API error 400: API key not valid. Please pass a valid API key.'); });
      const healthy = stubProvider('groq', () => 'working manual provider');
      const result = await invoke(streaming);
      expect(result.routed).toBe(good.modelId);
      expect(result.attempts).toBe(1);
      expect(streaming ? bad.stream : bad.completion).toHaveBeenCalledTimes(1);
      expect(streaming ? healthy.stream : healthy.completion).toHaveBeenCalledTimes(1);
      expect(getDb().prepare("SELECT model_id, reason FROM cooldowns WHERE platform='google' AND key_id=?").all(badKey))
        .toEqual([{ model_id: '*', reason: 'invalid_key' }]);
    });

    it(`${mode}: eight dead models on one provider cannot monopolize the eight-attempt budget`, async () => {
      for (let i = 0; i < 8; i++) addModel('google', i * 20 + 1);
      const good = addModel('groq', 1000);
      addKey('google'); addKey('groq');
      const dead = stubProvider('google', () => { throw new Error('Google API error 404: model not found'); });
      stubProvider('groq', () => 'healthy');
      const result = await invoke(streaming);
      expect(result.routed).toBe(good.modelId);
      expect(result.attempts).toBe(1);
      expect(streaming ? dead.stream : dead.completion).toHaveBeenCalledTimes(1);
    });

    it(`${mode}: model daily quota does not blanket-block a healthy model on the same key`, async () => {
      const a = addModel('google', 1);
      const b = addModel('google', 50);
      const key = addKey('google');
      stubProvider('google', model => {
        if (model === a.modelId) throw new Error('Google API error 429: Quota exceeded for generate_content_free_tier_requests per day for this model');
        return 'same key still works';
      });
      expect((await invoke(streaming)).routed).toBe(b.modelId);
      expect(getDb().prepare('SELECT model_id, reason FROM cooldowns WHERE key_id=?').all(key))
        .toEqual([{ model_id: a.modelId, reason: 'rate_limit_day' }]);
    });

    it(`${mode}: explicit minute quota wins over RESOURCE_EXHAUSTED and stays model-local`, async () => {
      const a = addModel('google', 1);
      const b = addModel('google', 50);
      const key = addKey('google');
      stubProvider('google', model => {
        if (model === a.modelId) throw new Error('Google API error 429: RESOURCE_EXHAUSTED: quota exceeded for free_tier_requests per minute');
        return 'minute fallback';
      });
      expect((await invoke(streaming)).routed).toBe(b.modelId);
      expect(getDb().prepare('SELECT model_id, reason FROM cooldowns WHERE key_id=?').all(key))
        .toEqual([{ model_id: a.modelId, reason: 'rate_limit_minute' }]);
    });

    it(`${mode}: explicit account balance cooldown skips all models on just the failed key`, async () => {
      addModel('google', 1); addModel('google', 30);
      const good = addModel('groq', 100);
      const key = addKey('google'); addKey('groq');
      const exhausted = stubProvider('google', () => { throw new Error('API error 402: Insufficient Balance'); });
      stubProvider('groq', () => 'funded fallback');
      expect((await invoke(streaming)).routed).toBe(good.modelId);
      expect(streaming ? exhausted.stream : exhausted.completion).toHaveBeenCalledTimes(1);
      expect(getDb().prepare('SELECT model_id, reason FROM cooldowns WHERE key_id=?').all(key))
        .toEqual([{ model_id: '*', reason: 'rate_limit_day' }]);
    });

    it(`${mode}: model subscription 403 does not invalidate every model on the key`, async () => {
      const paid = addModel('google', 1);
      const free = addModel('google', 50);
      const key = addKey('google');
      stubProvider('google', model => {
        if (model === paid.modelId) throw new Error('API error 403 Forbidden: this model requires a subscription');
        return 'free model';
      });
      expect((await invoke(streaming)).routed).toBe(free.modelId);
      expect(getDb().prepare("SELECT COUNT(*) AS n FROM cooldowns WHERE key_id=? AND model_id='*'").get(key)).toEqual({ n: 0 });
    });

    it(`${mode}: omitted policy reaches the exact live-success reasoning model after Gemma RPM failures`, async () => {
      const gemmaA = addModel('openrouter', 1, { id: 'google/gemma-4-26b-a4b-it:free' });
      const gemmaB = addModel('openrouter', 50, { id: 'google/gemma-4-31b-it:free' });
      addModel('openrouter', 100, { id: MANUAL_MODEL, reasoning: true });
      const blocked = addKey('openrouter'); addKey('openrouter');
      setKeyCooldown('openrouter', blocked, 'invalid_key');
      const seen: string[] = [];
      stubProvider('openrouter', model => {
        seen.push(model);
        if (model === gemmaA.modelId || model === gemmaB.modelId) throw new Error('OpenRouter API error 429: Too many requests per minute');
        if (model !== MANUAL_MODEL) throw new Error('Unexpected model');
        return 'nonempty live-shaped fallback';
      });
      const result = await invoke(streaming);
      expect(result.routed).toBe(MANUAL_MODEL);
      expect(result.raw).toContain('nonempty live-shaped fallback');
      expect(seen).toEqual([gemmaA.modelId, gemmaB.modelId, MANUAL_MODEL]);
      // Production wildcard and model cooldowns are not deleted by fallback.
      expect(getDb().prepare("SELECT reason FROM cooldowns WHERE key_id=? AND model_id='*'").get(blocked)).toEqual({ reason: 'invalid_key' });
    });

    it(`${mode}: Auto prefers non-reasoning even if reasoning has higher catalog priority`, async () => {
      addModel('openrouter', 1, { id: MANUAL_MODEL, reasoning: true });
      const regular = addModel('groq', 100);
      addKey('openrouter'); addKey('groq');
      const reason = stubProvider('openrouter', () => 'reasoning');
      stubProvider('groq', () => 'ordinary answer');
      expect((await invoke(streaming)).routed).toBe(regular.modelId);
      expect(streaming ? reason.stream : reason.completion).not.toHaveBeenCalled();
    });

    it(`${mode}: reasoning last resort still gets a slot when regular failures exhaust the bounded budget`, async () => {
      for (let i = 0; i < 10; i++) addModel('openrouter', i * 20 + 1);
      addModel('openrouter', 1000, { id: MANUAL_MODEL, reasoning: true });
      addKey('openrouter');
      const provider = stubProvider('openrouter', model => {
        if (model !== MANUAL_MODEL) throw new Error('API error 400: endpoint does not support feature');
        return 'last bounded slot';
      });
      const result = await invoke(streaming);
      expect(result.routed).toBe(MANUAL_MODEL);
      expect(result.attempts).toBe(MAX_CHAT_ATTEMPTS - 1);
      expect(streaming ? provider.stream : provider.completion).toHaveBeenCalledTimes(MAX_CHAT_ATTEMPTS);
    });

    it(`${mode}: explicit false never falls back to reasoning (also applies to relationship alias)`, async () => {
      addModel('openrouter', 1, { id: MANUAL_MODEL, reasoning: true }); addKey('openrouter');
      const provider = stubProvider('openrouter', () => 'must not be used');
      await expect(invoke(streaming, { extra: { allow_reasoning: false } })).rejects.toThrow();
      await expect(invoke(streaming, { model: 'relationship', extra: { allow_reasoning: false } })).rejects.toThrow();
      expect(streaming ? provider.stream : provider.completion).not.toHaveBeenCalled();
    });

    it(`${mode}: nested true and a real manual pin can use the exact reasoning model`, async () => {
      addModel('openrouter', 1, { id: MANUAL_MODEL, reasoning: true }); addKey('openrouter');
      stubProvider('openrouter', () => 'pinned answer');
      expect((await invoke(streaming, { extra: { allow_reasoning: true } })).routed).toBe(MANUAL_MODEL);
      expect((await invoke(streaming, { model: MANUAL_MODEL, no_cascade: true })).routed).toBe(MANUAL_MODEL);
    });

    it(`${mode}: JSON never uses reasoning, even with explicit true`, async () => {
      addModel('openrouter', 1, { id: MANUAL_MODEL, reasoning: true, json: true }); addKey('openrouter');
      const provider = stubProvider('openrouter', () => 'must not be used');
      await expect(invoke(streaming, { extra: { allow_reasoning: true }, response_format: { type: 'json_object' } })).rejects.toThrow();
      expect(streaming ? provider.stream : provider.completion).not.toHaveBeenCalled();
    });

    it(`${mode}: no_cascade never switches away from an unavailable real pin`, async () => {
      const pinned = addModel('google', 1);
      addModel('groq', 50);
      const key = addKey('google'); addKey('groq');
      setCooldown('google', pinned.modelId, key, 'rate_limit_minute');
      const other = stubProvider('groq', () => 'wrong model');
      await expect(invoke(streaming, { model: pinned.modelId, no_cascade: true })).rejects.toThrow();
      expect(streaming ? other.stream : other.completion).not.toHaveBeenCalled();
    });

    it(`${mode}: no_cascade surfaces a pin failure after only one upstream attempt`, async () => {
      const pinned = addModel('google', 1);
      addModel('groq', 50);
      addKey('google'); addKey('groq');
      const bad = stubProvider('google', () => { throw new Error('API error 400: endpoint rejects feature'); });
      const other = stubProvider('groq', () => 'wrong model');
      await expect(invoke(streaming, { model: pinned.modelId, no_cascade: true })).rejects.toThrow();
      expect(streaming ? bad.stream : bad.completion).toHaveBeenCalledTimes(1);
      expect(streaming ? other.stream : other.completion).not.toHaveBeenCalled();
    });

    it(`${mode}: a client-format failure does not turn into a quota cascade`, async () => {
      addModel('google', 1); addModel('groq', 50);
      addKey('google'); addKey('groq');
      stubProvider('google', () => { throw new Error('API error 400: unsupported image format'); });
      const other = stubProvider('groq', () => 'must not cascade');
      await expect(invoke(streaming)).rejects.toThrow();
      expect(streaming ? other.stream : other.completion).not.toHaveBeenCalled();
      expect(getDb().prepare('SELECT COUNT(*) AS n FROM cooldowns').get()).toEqual({ n: 0 });
    });
  }

  it('alias priority prefix cannot resurrect fallback-disabled or missing entries', () => {
    const disabled = addModel('google', 1, { fallbackEnabled: false });
    const missing = addModel('google', 2);
    const good = addModel('groq', 100);
    getDb().prepare('DELETE FROM fallback_config WHERE model_db_id=?').run(missing.id);
    addKey('google'); addKey('groq');
    const result = routeRequest(100, undefined, undefined, false, false, false, 'text', undefined, [disabled.id, missing.id]);
    expect(result.modelDbId).toBe(good.id);
  });

  it('provider fairness and reasoning fallback do not override disabled models/keys or coding provider restriction', async () => {
    addModel('google', 1, { modelEnabled: false }); addKey('google');
    addModel('groq', 10); addKey('groq', false);
    addModel('openrouter', 20, { id: MANUAL_MODEL, reasoning: true }); addKey('openrouter');
    const enabled = addModel('cerebras', 50);
    addKey('cerebras'); stubProvider('cerebras', () => 'eligible coding');
    expect((await invoke(false, { model: 'coding' })).routed).toBe(enabled.modelId);
    getDb().prepare("UPDATE api_keys SET enabled=0 WHERE platform='cerebras'").run();
    await expect(invoke(false, { model: 'coding' })).rejects.toThrow();
  });

  it('reasoning fallback never overrides vision or context-window eligibility', async () => {
    addModel('openrouter', 1, { id: MANUAL_MODEL, reasoning: true, context: 16 }); addKey('openrouter');
    const provider = stubProvider('openrouter', () => 'must not be used');
    await expect(invoke(false)).rejects.toThrow();
    await expect(invoke(false, { messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: 'https://invalid.test/offline.png' } },
    ] }] })).rejects.toThrow();
    expect(provider.completion).not.toHaveBeenCalled();
  });
});

describe('retry classification agrees with cooldown scope', () => {
  it.each([
    'Google API error 400: API key not valid',
    'Google API error 400: API_KEY_INVALID',
    'Invalid API key',
    '401 Unauthorized',
    'API error 402: Insufficient Balance',
    'Out of credits',
    'Account-wide quota exhausted per day',
  ])('retries and blocks confirmed account-wide failure: %s', message => {
    expect(isRetryableError(new Error(message))).toBe(true);
    expect(isKeyWideError(message)).toBe(true);
  });
  it.each([
    'Google API error 429: quota exceeded for free_tier_requests per minute',
    'RESOURCE_EXHAUSTED: per_minute limit exceeded',
    'Quota exceeded for GenerateContentRequestsPerMinutePerProjectPerModel-FreeTier',
  ])('minute marker wins over generic daily vocabulary: %s', message => {
    expect(classifyError(message)).toBe('rate_limit_minute');
    expect(isKeyWideError(message)).toBe(false);
  });
  it.each([
    'Quota exceeded for requests per day for model x per project',
    'API error 403 Forbidden: this model requires a subscription',
    'Account is healthy but model quota exceeded',
    'API error 400: max_tokens invalid for this model',
    'API error 400: token count invalid',
  ])('does not infer wildcard scope from model quota / mere account text: %s', message => {
    expect(isKeyWideError(message)).toBe(false);
  });
  it('retries bare transport failures but not ordinary bad input', () => {
    expect(isRetryableError(new Error('fetch failed'))).toBe(true);
    expect(isRetryableError(new Error('API error 400: Bad Request'))).toBe(false);
    expect(isRetryableError(new Error('API error 400: unsupported image format'))).toBe(false);
  });
});
