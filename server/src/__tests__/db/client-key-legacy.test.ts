import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { encrypt } from '../../lib/crypto.js';
import {
  initDb,
  getUnifiedApiKey,
  authenticateApiKey,
  revealClientKey,
  ensureUnifiedKeyClientKey,
  getClientKey,
} from '../../db/index.js';

const independentKey = 'synthetic-independent-client-key-A';
const unifiedKey = 'synthetic-current-unified-client-key-B';
const hash = (key: string) => createHash('sha256').update(key).digest('hex');
const states = ['active', 'disabled', 'deleted'] as const;
type State = typeof states[number];
const defaultCiphers = ['missing', 'valid', 'wrong'] as const;

describe('Legacy client-key ciphertext repair', () => {
  let db: Database.Database;
  let directory: string;
  let dbPath: string;

  beforeEach(() => {
    vi.stubEnv('ENCRYPTION_KEY', '0'.repeat(64));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    directory = mkdtempSync(join(tmpdir(), 'freeapi-legacy-client-key-'));
    dbPath = join(directory, 'fixture.db');
    db = initDb(':memory:');
    db.prepare("UPDATE settings SET value = ? WHERE key = 'unified_api_key'").run(unifiedKey);
    db.prepare('DELETE FROM client_keys').run();
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

  function insertKey(id: number, key: string, state: State = 'active', cipherKey?: string) {
    const enc = cipherKey === undefined ? null : encrypt(cipherKey);
    db.prepare(`
      INSERT INTO client_keys (id, name, key_hash, key_prefix, enabled, deleted_at,
        created_at, last_used_at, encrypted_key, iv, auth_tag)
      VALUES (?, ?, ?, ?, ?, ?, '2020-01-01 00:00:00', '2020-01-02 00:00:00', ?, ?, ?)
    `).run(id, id === 1 ? 'Independent default' : 'Legacy unified', hash(key), key.slice(0, 16),
      state === 'active' ? 1 : 0, state === 'deleted' ? '2020-01-03 00:00:00' : null,
      enc?.encrypted ?? null, enc?.iv ?? null, enc?.authTag ?? null);
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, client_key_id, created_at)
      VALUES ('synthetic', 'fixture', 'success', ?, '2020-01-04 00:00:00')
    `).run(id);
  }

  const metadata = () => db.prepare(`
    SELECT id, name, key_hash, key_prefix, enabled, deleted_at, created_at, last_used_at
    FROM client_keys ORDER BY id
  `).all();
  const attribution = () => db.prepare('SELECT id, client_key_id FROM requests ORDER BY id').all();
  const keys = () => db.prepare('SELECT * FROM client_keys ORDER BY id').all();

  function expectRevealsMatchTheirRows() {
    const rows = db.prepare('SELECT id, key_hash FROM client_keys ORDER BY id').all() as
      Array<{ id: number; key_hash: string }>;
    for (const row of rows) {
      const revealed = revealClientKey(row.id);
      if (revealed !== null) expect(hash(revealed)).toBe(row.key_hash);
    }
  }

  it.each(states.flatMap(state => defaultCiphers.map(cipher => ({ state, cipher }))))(
    'reopens with a $state unified row at id=5 and $cipher independent id=1 ciphertext',
    async ({ state, cipher }) => {
      insertKey(1, independentKey, 'active', cipher === 'valid' ? independentKey
        : cipher === 'wrong' ? unifiedKey : undefined);
      insertKey(5, unifiedKey, state);
      const originalDefault = db.prepare('SELECT * FROM client_keys WHERE id = 1').get();
      const originalMetadata = metadata();
      const originalAttribution = attribution();

      await reopen();
      expect(db.prepare('SELECT * FROM client_keys WHERE id = 1').get()).toEqual(originalDefault);
      expect(metadata()).toEqual(originalMetadata);
      expect(attribution()).toEqual(originalAttribution);
      expect(getUnifiedApiKey() === unifiedKey).toBe(true);
      expect(revealClientKey(5) === unifiedKey).toBe(true);
      expect(revealClientKey(1) === (cipher === 'valid' ? independentKey : null)).toBe(true);
      expectRevealsMatchTheirRows();

      const firstReopen = keys();
      ensureUnifiedKeyClientKey(db);
      ensureUnifiedKeyClientKey(db);
      expect(keys()).toEqual(firstReopen);
      await reopen();
      expect(keys()).toEqual(firstReopen);
      expect(attribution()).toEqual(originalAttribution);
      expect(getUnifiedApiKey() === unifiedKey).toBe(true);
      expectRevealsMatchTheirRows();
      expect(authenticateApiKey(independentKey)).toEqual({ id: 1, name: 'Independent default' });
      expect(authenticateApiKey(unifiedKey)).toEqual(state === 'active' ? { id: 5, name: 'Legacy unified' } : null);
      expect(getClientKey(5) === null).toBe(state === 'deleted');
    },
  );

  it.each(states)(
    'backfills a matching %s id=1 without changing its identity or revocation state', async state => {
      insertKey(1, unifiedKey, state);
      const originalMetadata = metadata();
      const originalAttribution = attribution();
      await reopen();
      expect(metadata()).toEqual(originalMetadata);
      expect(attribution()).toEqual(originalAttribution);
      expect(revealClientKey(1) === unifiedKey).toBe(true);
      const firstReopen = keys();
      await reopen();
      expect(keys()).toEqual(firstReopen);
      expect(getUnifiedApiKey() === unifiedKey).toBe(true);
      expect(authenticateApiKey(unifiedKey)).toEqual(state === 'active'
        ? { id: 1, name: 'Independent default' } : null);
      expect(getClientKey(1) === null).toBe(state === 'deleted');
      expectRevealsMatchTheirRows();
    },
  );

  it('does not inject the unified key into an independent legacy row when its hash is absent', async () => {
    insertKey(1, independentKey);
    const original = db.prepare('SELECT * FROM client_keys WHERE id = 1').get();
    const originalAttribution = attribution();
    await reopen();
    const mapped = db.prepare('SELECT id FROM client_keys WHERE key_hash = ?').get(hash(unifiedKey)) as
      { id: number };
    expect(mapped.id).not.toBe(1);
    expect(db.prepare('SELECT * FROM client_keys WHERE id = 1').get()).toEqual(original);
    expect(revealClientKey(1)).toBeNull();
    expect(revealClientKey(mapped.id) === unifiedKey).toBe(true);
    expect(attribution()).toEqual(originalAttribution);
    const firstReopen = keys();
    await reopen();
    expect(keys()).toEqual(firstReopen);
    expect(getUnifiedApiKey() === unifiedKey).toBe(true);
    expect(authenticateApiKey(independentKey)).toEqual({ id: 1, name: 'Independent default' });
    expect(authenticateApiKey(unifiedKey)).toEqual({ id: mapped.id, name: 'Unified API key' });
    expectRevealsMatchTheirRows();
  });

  it('adds V49 columns and fills only the hash-matching nondefault row in a pre-V49 fixture', async () => {
    insertKey(1, independentKey);
    insertKey(5, unifiedKey);
    const originalMetadata = metadata();
    const originalAttribution = attribution();
    db.exec(`
      ALTER TABLE client_keys DROP COLUMN encrypted_key;
      ALTER TABLE client_keys DROP COLUMN iv;
      ALTER TABLE client_keys DROP COLUMN auth_tag;
    `);
    await reopen();
    expect(metadata()).toEqual(originalMetadata);
    expect(attribution()).toEqual(originalAttribution);
    expect(revealClientKey(1)).toBeNull();
    expect(revealClientKey(5) === unifiedKey).toBe(true);
    const firstReopen = keys();
    await reopen();
    expect(keys()).toEqual(firstReopen);
    expectRevealsMatchTheirRows();
    expect(authenticateApiKey(independentKey)).toEqual({ id: 1, name: 'Independent default' });
    expect(authenticateApiKey(unifiedKey)).toEqual({ id: 5, name: 'Legacy unified' });
  });

  it.each(['encrypted_key', 'iv', 'auth_tag'] as const)(
    'repairs only the matching row when its %s is missing', async column => {
      insertKey(1, independentKey, 'active', independentKey);
      insertKey(5, unifiedKey, 'disabled', unifiedKey);
      db.prepare(`UPDATE client_keys SET ${column} = NULL`).run();
      const originalDefault = db.prepare('SELECT * FROM client_keys WHERE id = 1').get();
      const originalMetadata = metadata();
      const originalAttribution = attribution();
      await reopen();
      expect(db.prepare('SELECT * FROM client_keys WHERE id = 1').get()).toEqual(originalDefault);
      expect(metadata()).toEqual(originalMetadata);
      expect(attribution()).toEqual(originalAttribution);
      expect(revealClientKey(1)).toBeNull();
      expect(revealClientKey(5) === unifiedKey).toBe(true);
      const firstReopen = keys();
      await reopen();
      expect(keys()).toEqual(firstReopen);
      expect(getUnifiedApiKey() === unifiedKey).toBe(true);
      expect(authenticateApiKey(independentKey)).toEqual({ id: 1, name: 'Independent default' });
      expect(authenticateApiKey(unifiedKey)).toBeNull();
      expectRevealsMatchTheirRows();
    },
  );

  it.each(['wrong plaintext', 'corrupt tag'])(
    'preserves complete matching ciphertext with %s and refuses reveal without rotating', async scenario => {
      insertKey(1, independentKey, 'active', independentKey);
      insertKey(5, unifiedKey, 'active', scenario === 'wrong plaintext' ? independentKey : unifiedKey);
      if (scenario === 'corrupt tag') {
        db.prepare("UPDATE client_keys SET auth_tag = 'not-a-valid-tag' WHERE id = 5").run();
      }
      const original = keys();
      const originalAttribution = attribution();
      expect(revealClientKey(5)).toBeNull();
      await reopen();
      ensureUnifiedKeyClientKey(db);
      expect(keys()).toEqual(original);
      expect(revealClientKey(5)).toBeNull();
      await reopen();
      expect(keys()).toEqual(original);
      expect(attribution()).toEqual(originalAttribution);
      expect(getUnifiedApiKey() === unifiedKey).toBe(true);
      expect(authenticateApiKey(independentKey)).toEqual({ id: 1, name: 'Independent default' });
      expect(authenticateApiKey(unifiedKey)).toEqual({ id: 5, name: 'Legacy unified' });
      expectRevealsMatchTheirRows();
    },
  );
});
