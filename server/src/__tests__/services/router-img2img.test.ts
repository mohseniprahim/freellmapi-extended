import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { routeRequest } from '../../services/router.js';
import { encrypt } from '../../lib/crypto.js';

function insertKey(platform: string) {
  const enc = encrypt('fake');
  getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test', ?, ?, ?, 'healthy', 1)`).run(platform, enc.encrypted, enc.iv, enc.authTag);
}

describe('router img2img + inpainting gate', () => {
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

  it('requireInpainting selects inpainting-capable row', () => {
    insertKey('cloudflare');
    const route = routeRequest(100, undefined, undefined, false, false, false, 'image_gen',
      { requireInpainting: true });
    const row = getDb().prepare(
      'SELECT supports_inpainting, model_id FROM models WHERE id = ?'
    ).get(route.modelDbId) as { supports_inpainting: number; model_id: string };
    expect(row.supports_inpainting).toBe(1);
  });

  // V25 (May 2026): CF deprecated img2img. The gate still exists in the
  // router; if any provider re-enables img2img in the future this test would
  // be re-activated. Currently no CF model has supports_img2img=1 so the
  // router throws "No img2img" — covered by the test below.
  it.skip('requireImg2Img selects img2img-capable row (gate stays; no CF provider as of V25)', () => {});

  it('throws 400 when no inpainting model enabled', () => {
    const db = getDb();
    const oldPlan = db.prepare("SELECT f.model_db_id, f.enabled FROM fallback_modality_config f JOIN models m ON m.id=f.model_db_id WHERE f.modality='image_gen' AND m.supports_inpainting=1").all() as Array<{ model_db_id: number; enabled: number }>;
    db.prepare("UPDATE fallback_modality_config SET enabled=0 WHERE modality='image_gen' AND model_db_id IN (SELECT id FROM models WHERE supports_inpainting=1)").run();
    insertKey('cloudflare');

    expect(() => routeRequest(100, undefined, undefined, false, false, false, 'image_gen',
      { requireInpainting: true })).toThrowError(/No inpainting/);

    const restore = db.prepare("UPDATE fallback_modality_config SET enabled=? WHERE modality='image_gen' AND model_db_id=?");
    oldPlan.forEach(row => restore.run(row.enabled, row.model_db_id));
  });

  it('throws 400 when no img2img model enabled', () => {
    const db = getDb();
    const oldPlan = db.prepare("SELECT f.model_db_id, f.enabled FROM fallback_modality_config f JOIN models m ON m.id=f.model_db_id WHERE f.modality='image_gen' AND m.supports_img2img=1").all() as Array<{ model_db_id: number; enabled: number }>;
    db.prepare("UPDATE fallback_modality_config SET enabled=0 WHERE modality='image_gen' AND model_db_id IN (SELECT id FROM models WHERE supports_img2img=1)").run();
    insertKey('cloudflare');

    expect(() => routeRequest(100, undefined, undefined, false, false, false, 'image_gen',
      { requireImg2Img: true })).toThrowError(/No img2img/);

    const restore = db.prepare("UPDATE fallback_modality_config SET enabled=? WHERE modality='image_gen' AND model_db_id=?");
    oldPlan.forEach(row => restore.run(row.enabled, row.model_db_id));
  });

  it('regular image_gen request unaffected by img2img filter', () => {
    insertKey('cloudflare');
    const route = routeRequest(100, undefined, undefined, false, false, false, 'image_gen');
    expect(route.platform).toMatch(/cloudflare|pollinations/);
  });
});
