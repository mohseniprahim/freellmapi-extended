import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { PageHeader } from '@/components/page-header'

interface FallbackEntry {
  modelDbId: number
  priority: number
  effectivePriority: number
  penalty: number
  rateLimitHits: number
  enabled: boolean
  platform: string
  modelId: string
  displayName: string
  intelligenceRank: number
  speedRank: number
  sizeLabel: string
  rpmLimit: number | null
  rpdLimit: number | null
  monthlyTokenBudget: string
  keyCount: number
  modality: string
  visionCapable: boolean
  audioCapable: boolean
  imageRoutingEnabled: boolean
  audioRoutingEnabled: boolean
  supportsImg2Img: boolean
  supportsInpainting: boolean
  supportsJsonMode: boolean
  isReasoning: boolean
  isPaid: boolean
}

type PlanName = 'text' | 'audio' | 'vision'
type FallbackPlans = Record<PlanName, FallbackEntry[]>

const PLAN_LABELS: Record<PlanName, { title: string; description: string }> = {
  text: { title: 'Text', description: 'رسائل النص العادية' },
  audio: { title: 'Audio', description: 'التسجيلات الصوتية فقط' },
  vision: { title: 'Image / Vision', description: 'الصور والمرفقات المرئية' },
}

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

interface TokenUsageModelRow {
  displayName: string
  platform: string
  modelId?: string
  modality?: 'text' | 'image_gen' | 'embedding' | 'audio_tts' | 'audio_stt' | 'rerank'
  budget: number
  dailyBudget?: number
  monthlyUsed?: number
  dailyUsed?: number
  keyCount?: number
  neuronsPerCall?: number
  unlimited?: boolean
}

interface ModalityBlock {
  totalBudget: number
  totalDailyBudget: number
  totalMonthlyUsed: number
  totalDailyUsed: number
  models: TokenUsageModelRow[]
}

interface TokenUsageData {
  // Legacy top-level (text-only, backward compat)
  totalBudget: number
  totalUsed: number
  totalDailyBudget?: number
  totalDailyUsed?: number
  models: TokenUsageModelRow[]
  // New explicit modality blocks
  text?: ModalityBlock
  images?: ModalityBlock
  embeddings?: ModalityBlock
  audio_tts?: ModalityBlock
  audio_stt?: ModalityBlock
  rerank?: ModalityBlock
}

interface BudgetView {
  title: string
  unit: 'tokens' | 'images' | 'calls'  // controls labels in the bar UI
  totalBudget: number
  totalUsed: number
  // per-model rows; `used` and `budget` are scoped to whichever window this
  // view shows (monthly or daily). `unlimited` rows have no token quota
  // (e.g. NVIDIA NIM — RPM-capped only) and render as ∞.
  models: { displayName: string; platform: string; budget: number; used: number; unlimited?: boolean }[]
}

const platformColors: Record<string, string> = {
  google:      '#4285f4',
  groq:        '#f55036',
  cerebras:    '#8b5cf6',
  sambanova:   '#14b8a6',
  nvidia:      '#76b900',
  mistral:     '#f59e0b',
  openrouter:  '#ec4899',
  github:      '#6e7b8b',
  cohere:      '#d946ef',
  cloudflare:  '#f38020',
  zhipu:       '#06b6d4',
  ollama:      '#000000',
  pollinations:'#a855f7',
}

function formatUnit(n: number, unit: 'tokens' | 'images' | 'calls'): string {
  if (unit === 'images' || unit === 'calls') return Math.round(n).toLocaleString()
  return formatTokens(n)
}

function TokenUsageBar({ data }: { data: BudgetView }) {
  const { title, totalBudget, totalUsed, models, unit } = data
  const remaining = Math.max(0, totalBudget - totalUsed)
  const remainingPct = totalBudget > 0 ? Math.round((remaining / totalBudget) * 100) : 0

  // Scale each model's segment proportionally so the colored portion of the
  // bar sums to `remaining`; the grey tail represents what's been used.
  // Per-model remaining = max(budget - used, 0); fall back to old logic
  // (proportional share of overall remaining) when the row has no usage data.
  const modelsWithWidth = models.map(m => {
    const perModelRemaining = Math.max(0, m.budget - (m.used ?? 0))
    return {
      ...m,
      remainingTokens: perModelRemaining,
      // Unlimited rows have no finite quota — give them 0 bar width (they
      // cannot be sized) and the list renders ∞ instead of a number.
      widthPct: m.unlimited ? 0 : (totalBudget > 0 ? (perModelRemaining / totalBudget) * 100 : 0),
    }
  })
  const usedPct = totalBudget > 0 ? (totalUsed / totalBudget) * 100 : 0

  return (
    <section className="rounded-lg border bg-card p-5">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-medium">{title}</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          Used <span className="text-foreground font-medium">{formatUnit(totalUsed, unit)}</span>
          <span className="mx-1.5">·</span>
          Remaining <span className="text-foreground font-medium">{formatUnit(remaining, unit)}</span>
          <span className="mx-1.5">·</span>
          Total {formatUnit(totalBudget, unit)}
          <span className="mx-1.5">·</span>
          {remainingPct}% left
        </span>
      </div>

      <div className="flex h-2.5 rounded-full overflow-hidden bg-muted">
        {modelsWithWidth.map((m, i) => (
          <div
            key={i}
            title={`${m.displayName} (${m.platform}) — ${formatUnit(m.remainingTokens, unit)} remaining`}
            style={{
              width: `${m.widthPct}%`,
              backgroundColor: platformColors[m.platform] ?? '#94a3b8',
            }}
          />
        ))}
        {totalUsed > 0 && (
          <div
            title={`Used — ${formatUnit(totalUsed, unit)}`}
            className="bg-muted-foreground/30"
            style={{ width: `${usedPct}%` }}
          />
        )}
      </div>

      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-5 gap-y-1.5 text-xs tabular-nums">
        {modelsWithWidth.map((m, i) => (
          <div
            key={i}
            className="flex items-center gap-2 min-w-0"
            title={m.unlimited
              ? `${m.displayName} (${m.platform}) — no token quota (RPM-capped), used ${formatUnit(m.used ?? 0, unit)}`
              : `${m.displayName} (${m.platform}) — used ${formatUnit(m.used ?? 0, unit)} of ${formatUnit(m.budget, unit)}`}
          >
            <span
              className="size-2 rounded-sm flex-shrink-0"
              style={{ backgroundColor: platformColors[m.platform] ?? '#94a3b8' }}
            />
            <span className="truncate">{m.displayName}</span>
            <span className="flex-1" />
            <span className="font-mono text-muted-foreground/70 text-[10px] mr-1">
              (used {formatUnit(m.used ?? 0, unit)})
            </span>
            <span className="font-mono text-foreground">
              {m.unlimited ? '∞' : formatUnit(m.remainingTokens, unit)}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

function SortableModelRow({
  entry,
  index,
  onToggle,
  onMove,
}: {
  entry: FallbackEntry
  index: number
  onToggle: (modelDbId: number, enabled: boolean) => void
  onMove: (modelDbId: number, direction: 'up' | 'down') => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.modelDbId,
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group flex items-center gap-3 px-4 py-3 bg-card ${isDragging ? 'opacity-50' : ''} ${entry.enabled ? '' : 'opacity-50'}`}
    >
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-foreground transition-colors"
        aria-label="Drag to reorder"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" />
          <circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
          <circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" />
        </svg>
      </button>
      <span className="text-xs font-mono text-muted-foreground w-5 tabular-nums">{index + 1}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm">{entry.displayName}</span>
          <span className="text-xs text-muted-foreground">{entry.platform}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${entry.isPaid
            ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200'
            : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200'}`}>
            {entry.isPaid ? 'PAID' : 'FREE'}
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
            {entry.modality === 'audio_stt' ? 'STT' : entry.modality === 'audio_tts' ? 'TTS' : entry.modality}
          </span>
          {entry.visionCapable && <span title="Supports image input" className="text-[10px]">IMG</span>}
          {entry.supportsImg2Img && <span title="Supports image-to-image" className="text-[10px]">I2I</span>}
          {entry.supportsInpainting && <span title="Supports inpainting" className="text-[10px]">INPAINT</span>}
          {entry.modality === 'audio_stt' && <span title="Eligible for audio routing" className="text-[10px]">AUDIO</span>}
          {entry.penalty > 0 && (
            <span className="text-xs text-amber-600 dark:text-amber-400">
              −{entry.penalty} penalty
            </span>
          )}
        </div>
        <div className="flex gap-3 mt-0.5 text-xs text-muted-foreground tabular-nums">
          <span>Intel #{entry.intelligenceRank}</span>
          <span>Speed #{entry.speedRank}</span>
          {entry.rpmLimit && <span>{entry.rpmLimit} rpm</span>}
          {entry.rpdLimit && <span>{entry.rpdLimit} rpd</span>}
          {/* Providers with no token quota (NVIDIA NIM — RPM-capped) carry a
              non-numeric budget label; show ∞ instead of the raw string. */}
          <span>
            {/\d/.test(entry.monthlyTokenBudget)
              ? `${entry.monthlyTokenBudget} tok/mo`
              : '∞ tok/mo (RPM-capped)'}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1" aria-label="Change model priority">
        <button type="button" className="rounded border px-1.5 py-0.5 text-xs hover:bg-muted" title="Move up" onClick={() => onMove(entry.modelDbId, 'up')}>↑</button>
        <button type="button" className="rounded border px-1.5 py-0.5 text-xs hover:bg-muted" title="Move down" onClick={() => onMove(entry.modelDbId, 'down')}>↓</button>
      </div>
      <Switch
        checked={entry.enabled}
        onCheckedChange={(checked) => onToggle(entry.modelDbId, checked)}
      />
    </div>
  )
}

export default function FallbackPage() {
  const queryClient = useQueryClient()
  const [activePlan, setActivePlan] = useState<PlanName>('text')
  const [localPlans, setLocalPlans] = useState<Partial<FallbackPlans> | null>(null)

  const { data: plans, isLoading } = useQuery<FallbackPlans>({
    queryKey: ['fallback', 'plans'],
    queryFn: () => apiFetch('/api/fallback/plans'),
  })

  const { data: tokenUsage } = useQuery<TokenUsageData>({
    queryKey: ['fallback', 'token-usage'],
    queryFn: () => apiFetch('/api/fallback/token-usage'),
  })

  const saveMutation = useMutation({
    mutationFn: (data: { plan: PlanName; entries: { modelDbId: number; priority: number; enabled: boolean }[] }) =>
      apiFetch('/api/fallback/plans', { method: 'PUT', body: JSON.stringify(data) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fallback', 'plans'] })
      setLocalPlans(null)
    },
  })

  const syncOpenRouterMutation = useMutation({
    mutationFn: () => apiFetch('/api/models/sync-openrouter', { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fallback', 'plans'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
    },
  })

  const allEntries = localPlans?.[activePlan] ?? plans?.[activePlan] ?? []
  // Never hide catalog rows just because a provider key is missing. Paid
  // OpenRouter models must remain visible so the operator can configure them.
  const displayEntries = allEntries
  const unconfiguredPlatforms: string[] = []

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = displayEntries.findIndex(e => e.modelDbId === active.id)
    const newIndex = displayEntries.findIndex(e => e.modelDbId === over.id)
    const reorderedVisible = arrayMove(displayEntries, oldIndex, newIndex)
    // displayEntries currently contains the complete catalog, including rows
    // without configured keys. Appending those rows again creates duplicate
    // sortable IDs and makes both mouse and touch drag operations fail.
    setLocalPlans({ ...(localPlans ?? {}), [activePlan]: reorderedVisible.map((e, i) => ({ ...e, priority: i + 1 })) })
  }

  function handleToggle(modelDbId: number, enabled: boolean) {
    const updated = allEntries.map(e =>
      e.modelDbId === modelDbId ? { ...e, enabled } : e
    )
    setLocalPlans({ ...(localPlans ?? {}), [activePlan]: updated })
  }

  function handleMove(modelDbId: number, direction: 'up' | 'down') {
    const index = allEntries.findIndex(e => e.modelDbId === modelDbId)
    const nextIndex = direction === 'up' ? index - 1 : index + 1
    if (index < 0 || nextIndex < 0 || nextIndex >= allEntries.length) return
    const reordered = arrayMove(allEntries, index, nextIndex)
    setLocalPlans({ ...(localPlans ?? {}), [activePlan]: reordered.map((entry, i) => ({ ...entry, priority: i + 1 })) })
  }

  function handleSave() {
    if (!localPlans?.[activePlan]) return
    saveMutation.mutate(
      { plan: activePlan, entries: allEntries.map(e => ({
        modelDbId: e.modelDbId,
        priority: e.priority,
        enabled: e.enabled,
      })) }
    )
  }

  const hasChanges = Boolean(localPlans?.[activePlan])

  return (
    <div>
      <PageHeader
        title="Fallback chain"
        description="Drag to reorder. Requests try models top-to-bottom until one succeeds."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => syncOpenRouterMutation.mutate()} disabled={syncOpenRouterMutation.isPending}>
              {syncOpenRouterMutation.isPending ? 'Syncing OpenRouter…' : 'Sync OpenRouter models'}
            </Button>
          </>
        }
      />

      <div className="space-y-6">
        <div className="rounded-lg border bg-card p-2 flex flex-wrap gap-2">
          {(Object.keys(PLAN_LABELS) as PlanName[]).map((plan) => (
            <button
              key={plan}
              type="button"
              onClick={() => setActivePlan(plan)}
              className={`rounded-md px-4 py-2 text-left transition-colors ${activePlan === plan ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
            >
              <span className="block text-sm font-medium">{PLAN_LABELS[plan].title}</span>
              <span className={`block text-xs ${activePlan === plan ? 'text-primary-foreground/80' : 'text-muted-foreground'}`}>{PLAN_LABELS[plan].description}</span>
            </button>
          ))}
        </div>
        <div className="rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">
          ترتيب وتفعيل خطة <strong className="text-foreground">{PLAN_LABELS[activePlan].title}</strong> مستقل عن الخطط الأخرى. يمكن استخدام النموذج نفسه في أكثر من خطة.
        </div>
        {/* TEXT modality — monthly + daily token budgets */}
        {tokenUsage && tokenUsage.totalBudget > 0 && (
          <TokenUsageBar
            data={{
              title: 'Monthly token budget (text)',
              unit: 'tokens',
              totalBudget: tokenUsage.totalBudget,
              totalUsed: tokenUsage.totalUsed,
              models: tokenUsage.models.map((m) => ({
                displayName: m.displayName,
                platform: m.platform,
                budget: m.budget,
                used: m.monthlyUsed ?? 0,
                unlimited: m.unlimited,
              })),
            }}
          />
        )}

        {tokenUsage && (tokenUsage.totalDailyBudget ?? 0) > 0 && (
          <TokenUsageBar
            data={{
              title: 'Daily token budget (text)',
              unit: 'tokens',
              totalBudget: tokenUsage.totalDailyBudget ?? 0,
              totalUsed: tokenUsage.totalDailyUsed ?? 0,
              models: tokenUsage.models.map((m) => ({
                displayName: m.displayName,
                platform: m.platform,
                budget: m.dailyBudget ?? 0,
                used: m.dailyUsed ?? 0,
                unlimited: m.unlimited,
              })),
            }}
          />
        )}

        {/* IMAGE modality — budgets/usage measured in IMAGES (not tokens) */}
        {tokenUsage?.images && tokenUsage.images.totalDailyBudget > 0 && (
          <TokenUsageBar
            data={{
              title: 'Daily image capacity',
              unit: 'images',
              totalBudget: tokenUsage.images.totalDailyBudget,
              totalUsed: tokenUsage.images.totalDailyUsed,
              models: tokenUsage.images.models.map((m) => ({
                displayName: m.displayName,
                platform: m.platform,
                budget: m.dailyBudget ?? 0,
                used: m.dailyUsed ?? 0,
              })),
            }}
          />
        )}
        {tokenUsage?.images && tokenUsage.images.totalBudget > 0 && (
          <TokenUsageBar
            data={{
              title: 'Monthly image capacity',
              unit: 'images',
              totalBudget: tokenUsage.images.totalBudget,
              totalUsed: tokenUsage.images.totalMonthlyUsed,
              models: tokenUsage.images.models.map((m) => ({
                displayName: m.displayName,
                platform: m.platform,
                budget: m.budget,
                used: m.monthlyUsed ?? 0,
              })),
            }}
          />
        )}

        {/* EMBEDDING modality (V30) — budgets/usage measured in CALLS/day */}
        {tokenUsage?.embeddings && tokenUsage.embeddings.totalDailyBudget > 0 && (
          <TokenUsageBar
            data={{
              title: 'Daily embedding capacity',
              unit: 'calls',
              totalBudget: tokenUsage.embeddings.totalDailyBudget,
              totalUsed: tokenUsage.embeddings.totalDailyUsed,
              models: tokenUsage.embeddings.models.map((m) => ({
                displayName: m.displayName,
                platform: m.platform,
                budget: m.dailyBudget ?? 0,
                used: m.dailyUsed ?? 0,
              })),
            }}
          />
        )}
        {tokenUsage?.embeddings && tokenUsage.embeddings.totalBudget > 0 && (
          <TokenUsageBar
            data={{
              title: 'Monthly embedding capacity',
              unit: 'calls',
              totalBudget: tokenUsage.embeddings.totalBudget,
              totalUsed: tokenUsage.embeddings.totalMonthlyUsed,
              models: tokenUsage.embeddings.models.map((m) => ({
                displayName: m.displayName,
                platform: m.platform,
                budget: m.budget,
                used: m.monthlyUsed ?? 0,
              })),
            }}
          />
        )}

        {/* AUDIO_TTS modality (V32) — budgets/usage in CALLS/day */}
        {tokenUsage?.audio_tts && tokenUsage.audio_tts.totalDailyBudget > 0 && (
          <TokenUsageBar
            data={{
              title: 'Daily TTS capacity',
              unit: 'calls',
              totalBudget: tokenUsage.audio_tts.totalDailyBudget,
              totalUsed: tokenUsage.audio_tts.totalDailyUsed,
              models: tokenUsage.audio_tts.models.map((m) => ({
                displayName: m.displayName,
                platform: m.platform,
                budget: m.dailyBudget ?? 0,
                used: m.dailyUsed ?? 0,
              })),
            }}
          />
        )}

        {/* AUDIO_STT modality (V21) — budgets/usage in CALLS/day */}
        {tokenUsage?.audio_stt && tokenUsage.audio_stt.totalDailyBudget > 0 && (
          <TokenUsageBar
            data={{
              title: 'Daily STT capacity',
              unit: 'calls',
              totalBudget: tokenUsage.audio_stt.totalDailyBudget,
              totalUsed: tokenUsage.audio_stt.totalDailyUsed,
              models: tokenUsage.audio_stt.models.map((m) => ({
                displayName: m.displayName,
                platform: m.platform,
                budget: m.dailyBudget ?? 0,
                used: m.dailyUsed ?? 0,
              })),
            }}
          />
        )}

        {/* RERANK modality (V34) — Cohere trial 1000/MONTH/key, monthly first */}
        {tokenUsage?.rerank && tokenUsage.rerank.totalBudget > 0 && (
          <TokenUsageBar
            data={{
              title: 'Monthly rerank capacity',
              unit: 'calls',
              totalBudget: tokenUsage.rerank.totalBudget,
              totalUsed: tokenUsage.rerank.totalMonthlyUsed,
              models: tokenUsage.rerank.models.map((m) => ({
                displayName: m.displayName,
                platform: m.platform,
                budget: m.budget,
                used: m.monthlyUsed ?? 0,
              })),
            }}
          />
        )}
        {tokenUsage?.rerank && tokenUsage.rerank.totalDailyBudget > 0 && (
          <TokenUsageBar
            data={{
              title: 'Daily rerank capacity',
              unit: 'calls',
              totalBudget: tokenUsage.rerank.totalDailyBudget,
              totalUsed: tokenUsage.rerank.totalDailyUsed,
              models: tokenUsage.rerank.models.map((m) => ({
                displayName: m.displayName,
                platform: m.platform,
                budget: m.dailyBudget ?? 0,
                used: m.dailyUsed ?? 0,
              })),
            }}
          />
        )}

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : displayEntries.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center">
            <p className="text-sm text-muted-foreground">
              No models available. Add API keys on the <a href="/keys" className="underline text-foreground">Keys page</a> first.
            </p>
          </div>
        ) : (
          <>
            <div className="rounded-lg border divide-y overflow-hidden">
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={displayEntries.map(e => e.modelDbId)}
                  strategy={verticalListSortingStrategy}
                >
                  {displayEntries.map((entry, index) => (
                    <SortableModelRow
                      key={entry.modelDbId}
                      entry={entry}
                      index={index}
                      onToggle={handleToggle}
                      onMove={handleMove}
                    />
                  ))}
                </SortableContext>
              </DndContext>
            </div>

            {hasChanges && (
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setLocalPlans(null)}>
                  Discard
                </Button>
                <Button size="sm" onClick={handleSave} disabled={saveMutation.isPending}>
                  {saveMutation.isPending ? 'Saving…' : 'Save order'}
                </Button>
              </div>
            )}

            {unconfiguredPlatforms.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Hidden (no keys): {unconfiguredPlatforms.join(', ')}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
