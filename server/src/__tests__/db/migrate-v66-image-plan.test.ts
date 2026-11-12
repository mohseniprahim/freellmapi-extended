import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, initDb } from '../../db/index.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freellm-v66-'));
const dbPath = path.join(tempDir, 'upgrade.db');
const priceDbPath = path.join(tempDir, 'price-upgrade.db');

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

  it('V67 enables only the six cheapest directly-priced OpenRouter image routes by default', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const initialDb = initDb(priceDbPath);
    const addModel = initialDb.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, modality)
      VALUES ('openrouter', ?, ?, 1, 1, 'Image', 'image_gen')
    `);
    for (let i = 1; i <= 7; i++) {
      const modelId = `openrouter/test-cheap-${i}`;
      const id = Number(addModel.run(modelId, modelId).lastInsertRowid);
      initialDb.prepare(`
        UPDATE models SET image_gen_capable = 1, image_cost_class = 'paid',
          image_cost_usd = ?, image_cost_unit = 'image', image_endpoint_available = 1
        WHERE id = ?
      `).run(i * 0.001, id);
      initialDb.prepare(`
        INSERT INTO fallback_modality_config (modality, model_db_id, priority, enabled)
        VALUES ('image_gen', ?, ?, 0)
      `).run(id, i);
    }

    initialDb.prepare("DELETE FROM settings WHERE key = 'migration_v67_image_price_defaults'").run();
    const upgradedDb = initDb(priceDbPath);
    const enabled = upgradedDb.prepare(`
      SELECT m.model_id, fc.enabled FROM models m
      JOIN fallback_modality_config fc ON fc.model_db_id = m.id AND fc.modality = 'image_gen'
      WHERE m.platform = 'openrouter' AND m.model_id LIKE 'openrouter/test-cheap-%'
      ORDER BY m.image_cost_usd ASC
    `).all() as Array<{ model_id: string; enabled: number }>;

    expect(enabled).toHaveLength(7);
    expect(enabled.slice(0, 6).every(row => row.enabled === 1)).toBe(true);
    expect(enabled[6].enabled).toBe(0);
  });
});
