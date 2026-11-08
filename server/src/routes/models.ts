import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { hasProvider } from '../providers/index.js';

export const modelsRouter = Router();

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
