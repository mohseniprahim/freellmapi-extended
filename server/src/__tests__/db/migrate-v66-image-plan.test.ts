import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, initDb } from '../../db/index.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freellm-v66-'));
const dbPath = path.join(tempDir, 'upgrade.db');

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('V66 independent image fallback plan migration', () => {
  it('upgrades a legacy modality constraint without losing existing plan rows', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const initialDb = initDb(dbPath);
    const existingModel = initialDb.prepare('SELECT id FROM models ORDER BY id LIMIT 1').get() as { id: number };

    initialDb.exec(`
      DROP TABLE fallback_modality_config;
      CREATE TABLE fallback_modality_config (
        modality TEXT NOT NULL CHECK (modality IN ('text', 'audio', 'vision')),
        model_db_id INTEGER NOT NULL REFERENCES models(id),
        priority INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (modality, model_db_id)
      );
    `);
    initialDb.prepare(`
      INSERT INTO fallback_modality_config (modality, model_db_id, priority, enabled)
      VALUES ('text', ?, 7, 1)
    `).run(existingModel.id);

    const upgradedDb = initDb(dbPath);
    const schema = upgradedDb.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'fallback_modality_config'",
    ).get() as { sql: string };
    expect(schema.sql).toContain("'image_gen'");
    expect(upgradedDb.prepare(
      "SELECT priority, enabled FROM fallback_modality_config WHERE modality = 'text' AND model_db_id = ?",
    ).get(existingModel.id)).toEqual({ priority: 7, enabled: 1 });

    const imageModel = upgradedDb.prepare(
      "SELECT id FROM models WHERE platform = 'openrouter' AND model_id = 'qwen/qwen-image-2.1-turbo'",
    ).get() as { id: number };
    expect(() => upgradedDb.prepare(`
      INSERT INTO fallback_modality_config (modality, model_db_id, priority, enabled)
      VALUES ('image_gen', ?, 1, 1)
    `).run(imageModel.id)).not.toThrow();

    upgradedDb.prepare("UPDATE models SET image_cost_class = 'free' WHERE id = ?").run(imageModel.id);
    const restartedDb = initDb(dbPath);
    const retained = restartedDb.prepare('SELECT image_cost_class FROM models WHERE id = ?').get(imageModel.id) as { image_cost_class: string };
    expect(retained.image_cost_class).toBe('free');
  });
});
