import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { routeRequest } from '../../services/router.js';
import { resolveImageGenModel } from '../../lib/runImageGeneration.js';
import { encrypt } from '../../lib/crypto.js';

function insertKey(platform: string) {
  const enc = encrypt('fake-key-for-test');
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test', ?, ?, ?, 'healthy', 1)
  `).run(platform, enc.encrypted, enc.iv, enc.authTag);
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

  it('free image models always precede paid OpenRouter even when paid has higher manual priority', () => {
    const db = getDb();
    insertKey('openrouter');
    const free = db.prepare("SELECT id FROM models WHERE platform = 'pollinations' AND image_gen_capable = 1").get() as { id: number } | undefined;
    const paid = db.prepare("SELECT id FROM models WHERE platform = 'openrouter' AND model_id = 'qwen/qwen-image-2.1-turbo'").get() as { id: number } | undefined;
    expect(free).toBeTruthy();
    expect(paid).toBeTruthy();
    db.prepare("UPDATE fallback_modality_config SET priority = 999, enabled = 1 WHERE modality = 'image_gen' AND model_db_id = ?").run(free!.id);
    db.prepare("UPDATE fallback_modality_config SET priority = 1, enabled = 1 WHERE modality = 'image_gen' AND model_db_id = ?").run(paid!.id);
    db.prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(free!.id);

    const route = routeRequest(100, undefined, undefined, false, false, false, 'image_gen');
    expect(route.platform).toBe('pollinations');
    db.prepare('UPDATE models SET enabled = 1 WHERE id = ?').run(free!.id);
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
