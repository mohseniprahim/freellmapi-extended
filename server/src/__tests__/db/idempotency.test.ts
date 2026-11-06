import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initDb, getUnifiedApiKey, authenticateApiKey, revealClientKey } from '../../db/index.js';

/**
 * Running initDb twice on the same physical database should preserve catalog
 * counts and client-key identity. Every test starts with its own memory DB;
 * reopen tests persist that fixture to a private, cleaned-up temporary file.
 */
describe('Migration idempotency', () => {
  let db: Database.Database;
  let directory: string;
  let dbPath: string;

  beforeEach(() => {
    vi.stubEnv('ENCRYPTION_KEY', '0'.repeat(64));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    directory = mkdtempSync(join(tmpdir(), 'freeapi-idempotency-'));
    dbPath = join(directory, 'fixture.db');
    db = initDb(':memory:');
  });

  afterEach(() => {
    try {
      if (db?.open) db.close();
      rmSync(directory, { recursive: true, force: true });
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });

  async function reopen() {
    if (db.name === ':memory:') await db.backup(dbPath);
    db.close();
    db = initDb(dbPath);
  }

  it('backfills a formerly rotated unified setting without colliding with existing id=1', async () => {
    const originalKey = getUnifiedApiKey();
    const original = db.prepare('SELECT * FROM client_keys WHERE id = 1').get();
    const legacyUnified = 'synthetic-legacy-unified-setting';
    const legacyHash = createHash('sha256').update(legacyUnified).digest('hex');
    db.prepare("UPDATE settings SET value = ? WHERE key = 'unified_api_key'").run(legacyUnified);

    await reopen();
    expect(db.prepare('SELECT id, key_hash FROM client_keys ORDER BY id').all()).toEqual([
      { id: 1, key_hash: createHash('sha256').update(originalKey).digest('hex') },
      { id: 2, key_hash: legacyHash },
    ]);
    expect(db.prepare('SELECT * FROM client_keys WHERE id = 1').get()).toEqual(original);
    expect(revealClientKey(1) === originalKey).toBe(true);
    expect(revealClientKey(2) === legacyUnified).toBe(true);
    const afterFirst = db.prepare('SELECT * FROM client_keys ORDER BY id').all();
    await reopen();
    expect(db.prepare('SELECT * FROM client_keys ORDER BY id').all()).toEqual(afterFirst);
    expect(getUnifiedApiKey() === legacyUnified).toBe(true);
    expect(authenticateApiKey(originalKey)).toEqual({ id: 1, name: 'Default' });
    expect(authenticateApiKey(legacyUnified)).toEqual({ id: 2, name: 'Unified API key' });
  });

  it('re-running initDb on the same database produces identical catalog row counts', async () => {
    const counts = () => ({
      models: (db.prepare('SELECT COUNT(*) AS c FROM models').get() as { c: number }).c,
      fallback: (db.prepare('SELECT COUNT(*) AS c FROM fallback_config').get() as { c: number }).c,
      enabledModels: (db.prepare('SELECT COUNT(*) AS c FROM models WHERE enabled = 1').get() as { c: number }).c,
      disabledModels: (db.prepare('SELECT COUNT(*) AS c FROM models WHERE enabled = 0').get() as { c: number }).c,
      orphanFallbacks: (db.prepare(`
        SELECT COUNT(*) AS c FROM fallback_config f
        LEFT JOIN models m ON f.model_db_id = m.id
        WHERE m.id IS NULL
      `).get() as { c: number }).c,
    });
    const before = counts();
    await reopen();
    expect(counts()).toEqual(before);
    await reopen();
    expect(counts()).toEqual(before);
    expect(counts().orphanFallbacks).toBe(0);
  });

  it('every catalog row has exactly one fallback_config entry', () => {
    const rows = db.prepare(`
      SELECT m.id, COUNT(f.id) AS fb_count
        FROM models m
        LEFT JOIN fallback_config f ON m.id = f.model_db_id
       GROUP BY m.id
      HAVING COUNT(f.id) <> 1
    `).all() as { id: number; fb_count: number }[];

    expect(rows).toEqual([]);
  });

  it('UNIQUE(platform, model_id) constraint holds — no duplicate catalog rows', () => {
    const dups = db.prepare(`
      SELECT platform, model_id, COUNT(*) AS c FROM models
       GROUP BY platform, model_id
      HAVING COUNT(*) > 1
    `).all();

    expect(dups).toEqual([]);
  });

  it('all enabled catalog platforms have a registered provider', async () => {
    const { hasProvider } = await import('../../providers/index.js');
    const platforms = (db.prepare(
      `SELECT DISTINCT platform FROM models WHERE enabled = 1`
    ).all() as { platform: any }[]).map(r => r.platform);

    const missing = platforms.filter(p => !hasProvider(p));
    expect(missing).toEqual([]);
  });
});
