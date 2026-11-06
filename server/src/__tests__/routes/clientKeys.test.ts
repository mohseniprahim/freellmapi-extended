import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { encrypt } from '../../lib/crypto.js';
import {
  initDb,
  getDb,
  getUnifiedApiKey,
  regenerateUnifiedKey,
  authenticateApiKey,
  revealClientKey,
  ensureUnifiedKeyClientKey,
} from '../../db/index.js';

async function req(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  try {
    const addr = server.address() as any;
    const url = `http://127.0.0.1:${addr.port}${path}`;
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
}

function setIndependentDefault(key: string) {
  const enc = encrypt(key);
  getDb().prepare(`
    UPDATE client_keys SET key_hash = ?, key_prefix = ?, encrypted_key = ?, iv = ?, auth_tag = ?
    WHERE id = 1
  `).run(createHash('sha256').update(key).digest('hex'), key.slice(0, 16), enc.encrypted, enc.iv, enc.authTag);
}

describe('Client Keys CRUD', () => {
  let app: Express;

  beforeEach(() => {
    vi.stubEnv('ENCRYPTION_KEY', '0'.repeat(64));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    initDb(':memory:');
    app = createApp();
  });

  afterEach(() => {
    getDb().close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('V46 seeds the unified key as id=1 "Default"', async () => {
    const r = await req(app, 'GET', '/api/client-keys');
    expect(r.status).toBe(200);
    const general = r.body.find((k: any) => k.id === 1);
    expect(general).toBeDefined();
    expect(general.name).toBe('Default');
    expect(general.enabled).toBe(1);
  });

  it('never logs the plaintext unified key on fresh startup', () => {
    const unified = getUnifiedApiKey();
    const loggedSecret = vi.mocked(console.log).mock.calls.some(args =>
      args.some(value => String(value).includes(unified)));
    expect(loggedSecret).toBe(false);
  });

  it('legacy unified key still authenticates', () => {
    const unified = getUnifiedApiKey();
    const auth = authenticateApiKey(unified);
    expect(auth).toEqual({ id: 1, name: 'Default' });
  });

  it('POST creates a key and returns plain value ONCE', async () => {
    const r = await req(app, 'POST', '/api/client-keys', { name: 'Cline' });
    expect(r.status).toBe(201);
    expect(r.body.name).toBe('Cline');
    expect(r.body.key).toMatch(/^myllm-[0-9a-f]{48}$/);
    expect(r.body.key_prefix.length).toBeGreaterThan(0);

    // Subsequent list MUST NOT contain the plain key value.
    const list = await req(app, 'GET', '/api/client-keys');
    const row = list.body.find((k: any) => k.id === r.body.id);
    expect(row.key).toBeUndefined();
  });

  it('newly created key authenticates', async () => {
    const r = await req(app, 'POST', '/api/client-keys', { name: 'EmlakCopilot' });
    const auth = authenticateApiKey(r.body.key);
    expect(auth).toEqual({ id: r.body.id, name: 'EmlakCopilot' });
  });

  it('disabled key fails to authenticate', async () => {
    const created = await req(app, 'POST', '/api/client-keys', { name: 'X' });
    await req(app, 'PATCH', `/api/client-keys/${created.body.id}`, { enabled: false });
    const auth = authenticateApiKey(created.body.key);
    expect(auth).toBeNull();
  });

  it('PATCH renames a key', async () => {
    const created = await req(app, 'POST', '/api/client-keys', { name: 'Old' });
    const r = await req(app, 'PATCH', `/api/client-keys/${created.body.id}`, { name: 'New' });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('New');
  });

  it('DELETE removes a non-protected key', async () => {
    const created = await req(app, 'POST', '/api/client-keys', { name: 'Temp' });
    const r = await req(app, 'DELETE', `/api/client-keys/${created.body.id}`);
    expect(r.status).toBe(204);
    expect(authenticateApiKey(created.body.key)).toBeNull();
  });

  it('DELETE id=1 ("Default") is rejected', async () => {
    const r = await req(app, 'DELETE', '/api/client-keys/1');
    expect(r.status).toBe(400);
    expect(getDb().prepare('SELECT id FROM client_keys WHERE id = 1').get()).toBeDefined();
  });

  it('PATCH cannot disable id=1', async () => {
    const r = await req(app, 'PATCH', '/api/client-keys/1', { enabled: false });
    expect(r.status).toBe(400);
  });

  it('GET /:id/reveal returns the plain key for a freshly-created row (V49)', async () => {
    const created = await req(app, 'POST', '/api/client-keys', { name: 'Revealable' });
    const reveal = await req(app, 'GET', `/api/client-keys/${created.body.id}/reveal`);
    expect(reveal.status).toBe(200);
    expect(reveal.body.key === created.body.key).toBe(true);
  });

  it('GET /:id/reveal on the seeded Default key (V49 back-fill) works', async () => {
    const reveal = await req(app, 'GET', '/api/client-keys/1/reveal');
    expect(reveal.status).toBe(200);
    expect(reveal.body.key).toMatch(/^myllm-/);
    expect(authenticateApiKey(reveal.body.key)).toEqual({ id: 1, name: 'Default' });
  });

  it('GET /:id/reveal returns 404 for a missing row', async () => {
    const reveal = await req(app, 'GET', '/api/client-keys/99999/reveal');
    expect(reveal.status).toBe(404);
  });

  it.each(['missing ciphertext', 'missing IV', 'missing tag', 'corrupt tag', 'wrong plaintext'])(
    'GET /:id/reveal returns 410 without secrets for %s', async scenario => {
      const created = await req(app, 'POST', '/api/client-keys', { name: 'Unavailable' });
      const db = getDb();
      const id = created.body.id;
      const otherKey = 'synthetic-other-client-key';
      if (scenario === 'wrong plaintext') {
        const enc = encrypt(otherKey);
        db.prepare('UPDATE client_keys SET encrypted_key = ?, iv = ?, auth_tag = ? WHERE id = ?')
          .run(enc.encrypted, enc.iv, enc.authTag, id);
      } else {
        const column = scenario === 'missing ciphertext' ? 'encrypted_key'
          : scenario === 'missing IV' ? 'iv' : 'auth_tag';
        db.prepare(`UPDATE client_keys SET ${column} = ? WHERE id = ?`)
          .run(scenario === 'corrupt tag' ? 'not-a-valid-tag' : null, id);
      }
      const before = db.prepare('SELECT * FROM client_keys WHERE id = ?').get(id);
      expect(revealClientKey(id)).toBeNull();
      const response = await req(app, 'GET', `/api/client-keys/${id}/reveal`);
      expect(response.status).toBe(410);
      expect(response.body.key).toBeUndefined();
      const body = JSON.stringify(response.body);
      expect(body.includes(created.body.key) || body.includes(otherKey)).toBe(false);
      expect(db.prepare('SELECT * FROM client_keys WHERE id = ?').get(id)).toEqual(before);
      expect(authenticateApiKey(created.body.key)).toEqual({ id, name: 'Unavailable' });
    },
  );

  it('regenerating the unified key keeps Default auth and reveal in sync', () => {
    const previous = getUnifiedApiKey();
    const regenerated = regenerateUnifiedKey();

    expect(regenerated !== previous).toBe(true);
    expect(authenticateApiKey(previous)).toBeNull();
    expect(authenticateApiKey(regenerated)).toEqual({ id: 1, name: 'Default' });
    expect(revealClientKey(1) === regenerated).toBe(true);
  });

  it('registers a separate unified key without replacing a distinct Default client key', () => {
    const separateDefault = `myllm-${'a'.repeat(48)}`;
    setIndependentDefault(separateDefault);
    const original = getDb().prepare('SELECT * FROM client_keys WHERE id = 1').get();

    const regenerated = regenerateUnifiedKey();
    const unifiedHash = createHash('sha256').update(regenerated).digest('hex');
    const unifiedRow = getDb().prepare('SELECT id, name FROM client_keys WHERE key_hash = ?')
      .get(unifiedHash) as { id: number; name: string } | undefined;

    expect(unifiedRow).toBeDefined();
    expect(unifiedRow?.id).not.toBe(1);
    expect(unifiedRow?.name).toBe('Unified API key');
    expect(authenticateApiKey(regenerated)).toEqual({ id: unifiedRow!.id, name: 'Unified API key' });
    expect(getDb().prepare('SELECT * FROM client_keys WHERE id = 1').get()).toEqual(original);
    expect(revealClientKey(1) === separateDefault).toBe(true);
    expect(authenticateApiKey(separateDefault)).toEqual({ id: 1, name: 'Default' });
    expect(revealClientKey(unifiedRow!.id) === regenerated).toBe(true);
  });

  it('backfills the current unified key without rotating it or overwriting Default', () => {
    const db = getDb();
    const unified = getUnifiedApiKey();
    const unifiedHash = createHash('sha256').update(unified).digest('hex');
    const separateDefault = `myllm-${'b'.repeat(48)}`;
    setIndependentDefault(separateDefault);
    const original = db.prepare('SELECT * FROM client_keys WHERE id = 1').get();

    ensureUnifiedKeyClientKey(db);
    const mapped = db.prepare('SELECT id, name FROM client_keys WHERE key_hash = ?').get(unifiedHash) as
      { id: number; name: string } | undefined;
    expect(mapped).toBeDefined();
    expect(mapped?.id).not.toBe(1);
    expect(mapped?.name).toBe('Unified API key');
    expect(authenticateApiKey(unified)).toEqual({ id: mapped!.id, name: 'Unified API key' });
    expect(getUnifiedApiKey() === unified).toBe(true);
    expect(revealClientKey(mapped!.id) === unified).toBe(true);

    ensureUnifiedKeyClientKey(db);
    expect(db.prepare('SELECT COUNT(*) AS count FROM client_keys WHERE key_hash = ?').get(unifiedHash))
      .toEqual({ count: 1 });
    expect(db.prepare('SELECT * FROM client_keys WHERE id = 1').get()).toEqual(original);
    expect(revealClientKey(1) === separateDefault).toBe(true);
    expect(authenticateApiKey(separateDefault)).toEqual({ id: 1, name: 'Default' });
  });

  it.each(['active', 'disabled', 'deleted'])(
    'backfills missing cipher for a matching %s nondefault row without changing its state', state => {
      const db = getDb();
      const unified = getUnifiedApiKey();
      setIndependentDefault('synthetic-independent-default');
      db.prepare(`
        INSERT INTO client_keys (id, name, key_hash, key_prefix, enabled, deleted_at, created_at, last_used_at)
        VALUES (5, 'Legacy unified', ?, ?, ?, ?, '2020-01-01 00:00:00', '2020-01-02 00:00:00')
      `).run(createHash('sha256').update(unified).digest('hex'), unified.slice(0, 16),
        state === 'active' ? 1 : 0, state === 'deleted' ? '2020-01-03 00:00:00' : null);
      const metadata = () => db.prepare(`
        SELECT id, name, key_hash, key_prefix, enabled, deleted_at, created_at, last_used_at
        FROM client_keys ORDER BY id
      `).all();
      const before = metadata();
      ensureUnifiedKeyClientKey(db);
      expect(metadata()).toEqual(before);
      expect(revealClientKey(5) === unified).toBe(true);
      const complete = db.prepare('SELECT * FROM client_keys ORDER BY id').all();
      ensureUnifiedKeyClientKey(db);
      expect(db.prepare('SELECT * FROM client_keys ORDER BY id').all()).toEqual(complete);
      expect(getUnifiedApiKey() === unified).toBe(true);
      expect(authenticateApiKey(unified)).toEqual(state === 'active' ? { id: 5, name: 'Legacy unified' } : null);
    },
  );

  it('POST regenerate endpoint persists a /v1-authenticating key', async () => {
    const response = await req(app, 'POST', '/api/settings/api-key/regenerate');
    expect(response.status).toBe(200);
    expect(response.body.apiKey).toMatch(/^myllm-[0-9a-f]{48}$/);
    expect(authenticateApiKey(response.body.apiKey)).not.toBeNull();
  });
});
