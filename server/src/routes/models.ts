import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { getAllProviders, hasProvider } from '../providers/index.js';
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

/** Discover image-output models across every registered image provider and
 *  update only image catalog metadata; text fallback rows/settings are untouched. */
modelsRouter.post('/sync-images', async (_req: Request, res: Response) => {
  const db = getDb();
  const providerResults: Array<{ platform: string; discovered: number; added: number; enabled: number; error?: string; skipped?: string }> = [];
  let totalDiscovered = 0;
  let totalAdded = 0;
  const providers = getAllProviders().filter(provider => provider.supportsImageGeneration);

  for (const provider of providers) {
    try {
      const keyRow = db.prepare(`
        SELECT encrypted_key, iv, auth_tag FROM api_keys
        WHERE platform = ? AND enabled = 1 AND status != 'invalid' ORDER BY id ASC LIMIT 1
      `).get(provider.platform) as { encrypted_key: string; iv: string; auth_tag: string } | undefined;
      const apiKey = keyRow ? decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag) : '';
      const catalog = await provider.discoverImageModels(apiKey);
      const insertModel = db.prepare(`
        INSERT OR IGNORE INTO models (
          platform, model_id, display_name, intelligence_rank, speed_rank,
          size_label, monthly_token_budget, enabled, modality
        ) VALUES (?, ?, ?, 100, 100, 'Image', 'image-generation', 1, 'image_gen')
      `);
      const findModel = db.prepare('SELECT id, image_endpoint_available FROM models WHERE platform = ? AND model_id = ?');
      const updateModel = db.prepare(`
        UPDATE models SET display_name = ?, image_gen_capable = 1,
          image_cost_class = ?, image_cost_usd = ?, image_cost_unit = ?, image_provider_tag = ?,
          image_endpoint_available = ? WHERE id = ?
      `);
      const nextPriority = db.prepare("SELECT COALESCE(MAX(priority), 0) + 1 AS priority FROM fallback_modality_config WHERE modality = 'image_gen'");
      const addPlan = db.prepare(`
        INSERT OR IGNORE INTO fallback_modality_config (modality, model_db_id, priority, enabled)
        VALUES ('image_gen', ?, ?, ?)
      `);
      let added = 0;
      let enabled = 0;
      const sync = db.transaction(() => {
        for (const item of catalog) {
          if (!item.modelId) continue;
          const result = insertModel.run(provider.platform, item.modelId, item.displayName);
          if (result.changes > 0) added++;
          const model = findModel.get(provider.platform, item.modelId) as { id: number; image_endpoint_available: number } | undefined;
          if (!model) continue;
          const available = item.available === undefined
            ? (result.changes > 0 ? 0 : model.image_endpoint_available)
            : item.available ? 1 : 0;
          updateModel.run(item.displayName, item.priceClass, item.priceUsd ?? null,
            item.priceUnit ?? null, item.providerTag ?? null, available, model.id);
          const shouldEnable = available === 1 && item.enabledByDefault === true;
          const priority = (nextPriority.get() as { priority: number }).priority;
          const planRow = addPlan.run(model.id, priority, shouldEnable ? 1 : 0);
          if (planRow.changes > 0 && shouldEnable) enabled++;
        }
      });
      sync();
      totalDiscovered += catalog.length;
      totalAdded += added;
      providerResults.push({ platform: provider.platform, discovered: catalog.length, added, enabled });
    } catch (error: any) {
      providerResults.push({ platform: provider.platform, discovered: 0, added: 0, enabled: 0, error: error?.message ?? 'فشل اكتشاف النماذج' });
    }
  }
  res.json({ success: providerResults.some(result => !result.error && !result.skipped), totalDiscovered, totalAdded, providers: providerResults });
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
