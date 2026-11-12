import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { routeRequest } from '../../services/router.js';
import { getImageRouteAttemptLimit, resolveImageGenModel, runImageGeneration } from '../../lib/runImageGeneration.js';
import { encrypt } from '../../lib/crypto.js';
import { getProvider } from '../../providers/index.js';

function insertKey(platform: string) {
  const enc = encrypt('fake-key-for-test');
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test', ?, ?, ?, 'healthy', 1)
  `).run(platform, enc.encrypted, enc.iv, enc.authTag);
}

function insertImageModel(platform: string, modelId: string, priceClass: 'free' | 'paid', price: number, unit: string, priority: number) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, modality)
    VALUES (?, ?, ?, 1, 1, 'Image', 'image_gen')
  `).run(platform, modelId, modelId);
  const modelDbId = Number(result.lastInsertRowid);
  db.prepare(`
    UPDATE models SET image_gen_capable = 1, image_cost_class = ?, image_cost_usd = ?,
      image_cost_unit = ?, image_endpoint_available = 1, image_provider_tag = 'test-provider'
    WHERE id = ?
  `).run(priceClass, price, unit, modelDbId);
  db.prepare(`
    INSERT INTO fallback_modality_config (modality, model_db_id, priority, enabled)
    VALUES ('image_gen', ?, ?, 1)
  `).run(modelDbId, priority);
  return modelDbId;
}

describe('routeRequest modality gate', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM cooldowns').run();
    db.prepare('DELETE FROM usage_counters').run();
  });

  it('modality=image_gen picks an image-gen model', () => {
    insertKey('cloudflare');
    const route = routeRequest(100, undefined, undefined, false, false, false, 'image_gen');
    const row = getDb().prepare('SELECT modality, image_gen_capable FROM models WHERE id = ?').get(route.modelDbId) as { modality: string; image_gen_capable: number };
    expect(row.modality === 'image_gen' || row.image_gen_capable === 1).toBe(true);
    expect(['cloudflare', 'pollinations']).toContain(route.platform);
  });

  it('tries every free image route, then the cheapest paid OpenRouter route and its next fallback', async () => {
    const db = getDb();
    insertKey('openrouter');
    const originalPlan = db.prepare("SELECT model_db_id, priority, enabled FROM fallback_modality_config WHERE modality = 'image_gen'")
      .all() as Array<{ model_db_id: number; priority: number; enabled: number }>;
    const inserted: number[] = [];
    const calls: string[] = [];
    const pollinations = getProvider('pollinations')!;
    const openrouter = getProvider('openrouter')!;
    const pollinationsSpy = vi.spyOn(pollinations, 'generateImage').mockImplementation(async (_key, modelId) => {
      calls.push(modelId);
      throw new Error('429 too many requests');
    });
    const openrouterSpy = vi.spyOn(openrouter, 'generateImage').mockImplementation(async (_key, modelId) => {
      calls.push(modelId);
      if (modelId === 'openrouter/test-paid-cheapest') throw new Error('429 too many requests');
      return { b64Images: ['aGVsbG8='], mimeType: 'image/png' };
    });

    try {
      db.prepare("UPDATE fallback_modality_config SET enabled = 0 WHERE modality = 'image_gen'").run();
      for (let i = 1; i <= 10; i++) {
        inserted.push(insertImageModel('pollinations', `test-free-${String(i).padStart(2, '0')}`, 'free', 0, 'image', i));
      }
      const cheapestId = insertImageModel('openrouter', 'openrouter/test-paid-cheapest', 'paid', 0.007, 'image', 100);
      const nextId = insertImageModel('openrouter', 'openrouter/test-paid-next', 'paid', 0.0184, 'image', 1);
      inserted.push(cheapestId, nextId);

      expect(getImageRouteAttemptLimit()).toBe(12);
      const result = await runImageGeneration({ prompt: 'test prompt' });

      expect(result.routedModel).toBe('openrouter/test-paid-next');
      expect(result.attempts).toBe(11);
      expect(calls).toHaveLength(12);
      expect(calls.slice(0, 10)).toEqual(Array.from({ length: 10 }, (_, i) => `test-free-${String(i + 1).padStart(2, '0')}`));
      expect(calls[10]).toBe('openrouter/test-paid-cheapest');
      expect(calls[11]).toBe('openrouter/test-paid-next');
    } finally {
      pollinationsSpy.mockRestore();
      openrouterSpy.mockRestore();
      db.prepare("DELETE FROM fallback_modality_config WHERE modality = 'image_gen' AND model_db_id IN (" + inserted.map(() => '?').join(',') + ")")
        .run(...inserted);
      db.prepare(`DELETE FROM models WHERE id IN (${inserted.map(() => '?').join(',')})`).run(...inserted);
      db.prepare("DELETE FROM fallback_modality_config WHERE modality = 'image_gen'").run();
      const restore = db.prepare("INSERT INTO fallback_modality_config (modality, model_db_id, priority, enabled) VALUES ('image_gen', ?, ?, ?)");
      originalPlan.forEach(row => restore.run(row.model_db_id, row.priority, row.enabled));
    }
  });

  it('default text routing never picks image-gen models', () => {
    insertKey('groq');
    const route = routeRequest(1000, undefined, undefined, false, false, true);
    const row = getDb().prepare('SELECT modality FROM models WHERE id = ?').get(route.modelDbId) as { modality: string | null };
    // text or null (legacy rows) are fine; image_gen is not
    expect(row.modality === null || row.modality === 'text').toBe(true);
  });

  it('no image-gen models enabled → throws 400', () => {
    const db = getDb();
    const oldPlan = db.prepare("SELECT model_db_id, enabled FROM fallback_modality_config WHERE modality = 'image_gen'").all() as Array<{ model_db_id: number; enabled: number }>;
    db.prepare("UPDATE fallback_modality_config SET enabled = 0 WHERE modality = 'image_gen'").run();
    insertKey('cloudflare');

    expect(() => routeRequest(100, undefined, undefined, false, false, false, 'image_gen'))
      .toThrowError(/No image-generation models/);

    const restore = db.prepare("UPDATE fallback_modality_config SET enabled = ? WHERE modality = 'image_gen' AND model_db_id = ?");
    oldPlan.forEach(row => restore.run(row.enabled, row.model_db_id));
  });
});

describe('resolveImageGenModel', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('drops pin when caller named a text model', () => {
    expect(resolveImageGenModel('llama-3.3-70b-versatile')).toBeUndefined();
  });

  it('keeps pin when caller named an image-gen model (full id)', () => {
    const r = resolveImageGenModel('@cf/black-forest-labs/flux-1-schnell');
    expect(typeof r).toBe('number');
  });

  it('keeps pin via bare suffix id ("flux-1-schnell")', () => {
    const r = resolveImageGenModel('flux-1-schnell');
    expect(typeof r).toBe('number');
  });

  it('throws on unknown model', () => {
    expect(() => resolveImageGenModel('nonexistent-model-xyz')).toThrowError(/not in the catalog/);
  });
});
