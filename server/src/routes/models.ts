import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { hasProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';

export const modelsRouter = Router();

async function fetchOpenRouterCatalog() {
  const db = getDb();
  const key = db.prepare(`
    SELECT encrypted_key, iv, auth_tag FROM api_keys
    WHERE platform = 'openrouter' AND enabled = 1 ORDER BY id ASC LIMIT 1
  `).get() as any;
  if (!key) throw new Error('Add an enabled OpenRouter API key first.');
  const apiKey = decrypt(key.encrypted_key, key.iv, key.auth_tag);
  const response = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}`, 'HTTP-Referer': 'https://whatsexpert.com', 'X-Title': 'FreeLLM' },
  });
  if (!response.ok) throw new Error(`OpenRouter catalog request failed (${response.status})`);
  const body = await response.json() as { data?: any[] };
  return body.data ?? [];
}

/** Discover every OpenRouter route, including paid models (not only :free). */
modelsRouter.post('/sync-openrouter', async (_req: Request, res: Response) => {
  try {
    const catalog = await fetchOpenRouterCatalog();
    const db = getDb();
    const insert = db.prepare(`
      INSERT OR IGNORE INTO models (
        platform, model_id, display_name, intelligence_rank, speed_rank,
        size_label, monthly_token_budget, context_window, enabled, modality,
        vision_capable, audio_capable, price_input_per_1m, price_output_per_1m
      ) VALUES ('openrouter', ?, ?, 100, 100, '', ?, ?, 1, 'text', ?, ?, ?, ?)
    `);
    const addFallback = db.prepare(`
      INSERT OR IGNORE INTO fallback_config (model_db_id, priority, enabled)
      SELECT id, COALESCE((SELECT MAX(priority) + 1 FROM fallback_config), 1), 1
      FROM models WHERE platform = 'openrouter' AND model_id = ?
    `);
    const update = db.prepare(`
      UPDATE models SET display_name = ?, context_window = ?, vision_capable = ?,
        audio_capable = ?, price_input_per_1m = ?, price_output_per_1m = ?, enabled = 1
      WHERE platform = 'openrouter' AND model_id = ?
    `);
    let added = 0;
    const sync = db.transaction(() => {
      for (const m of catalog) {
        if (!m?.id) continue;
        const inputs = Array.isArray(m.architecture?.input_modalities) ? m.architecture.input_modalities : [];
        const vision = inputs.includes('image');
        const audio = inputs.includes('audio');
        const inputPrice = Number(m.pricing?.prompt ?? 0) * 1_000_000;
        const outputPrice = Number(m.pricing?.completion ?? 0) * 1_000_000;
        const budget = inputPrice > 0 || outputPrice > 0 ? '~paid' : '~free';
        const result = insert.run(m.id, m.name ?? m.id, budget, m.context_length ?? null,
          vision ? 1 : 0, audio ? 1 : 0, inputPrice, outputPrice);
        if (result.changes > 0) added++;
        update.run(m.name ?? m.id, m.context_length ?? null, vision ? 1 : 0, audio ? 1 : 0,
          inputPrice, outputPrice, m.id);
        addFallback.run(m.id);
      }
    });
    sync();
    res.json({ success: true, upstreamCount: catalog.length, added });
  } catch (error: any) {
    res.status(502).json({ error: { message: error?.message ?? 'OpenRouter sync failed' } });
  }
});

// List all models with availability info
modelsRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const models = db.prepare(`
    SELECT m.*, fc.priority, fc.enabled as fallback_enabled
    FROM models m
    LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
    ORDER BY COALESCE(fc.priority, m.intelligence_rank) ASC
  `).all() as any[];

  // Count keys per platform
  const keyCounts = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM api_keys
    WHERE enabled = 1
    GROUP BY platform
  `).all() as { platform: string; count: number }[];

  const keyCountMap = new Map(keyCounts.map(k => [k.platform, k.count]));

  const result = models.map(m => ({
    id: m.id,
    platform: m.platform,
    modelId: m.model_id,
    displayName: m.display_name,
    intelligenceRank: m.intelligence_rank,
    speedRank: m.speed_rank,
    sizeLabel: m.size_label,
    rpmLimit: m.rpm_limit,
    rpdLimit: m.rpd_limit,
    tpmLimit: m.tpm_limit,
    tpdLimit: m.tpd_limit,
    monthlyTokenBudget: m.monthly_token_budget,
    contextWindow: m.context_window,
    modality: m.modality ?? 'text',
    visionCapable: m.vision_capable === 1,
    audioCapable: m.audio_capable === 1,
    imageRoutingEnabled: m.image_routing_enabled !== 0,
    audioRoutingEnabled: m.audio_routing_enabled !== 0,
    supportsImg2Img: m.supports_img2img === 1,
    supportsInpainting: m.supports_inpainting === 1,
    supportsJsonMode: m.supports_json_mode === 1,
    isReasoning: m.is_reasoning === 1,
    // The catalog has explicit pricing for paid routes; OpenRouter's :free
    // suffix is also treated as authoritative when a provider has no price
    // metadata yet.
    isPaid: !String(m.model_id).endsWith(':free') && (
      Number(m.price_input_per_1m ?? 0) > 0 ||
      Number(m.price_output_per_1m ?? 0) > 0 ||
      Number(m.price_per_call ?? 0) > 0 ||
      m.platform === 'openrouter'
    ),
    enabled: m.enabled === 1,
    priority: m.priority,
    fallbackEnabled: m.fallback_enabled === 1,
    hasProvider: hasProvider(m.platform),
    keyCount: keyCountMap.get(m.platform) ?? 0,
  }));

  res.json(result);
});
