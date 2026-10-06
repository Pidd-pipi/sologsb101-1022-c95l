import {
  CONTAINER_CAPACITY,
  HUMIDITY_HARD_MAX,
  HUMIDITY_HARD_MIN,
  HUMIDITY_IDEAL_MAX,
  HUMIDITY_IDEAL_MIN,
  TEMP_HARD_MAX,
  TEMP_HARD_MIN,
  TEMP_IDEAL_MAX,
  TEMP_IDEAL_MIN,
  type Cellar,
  type CellarContainer,
  type CellarDraft,
  type CellarHealthItem,
  type CellarHealthLevel,
  type CellarHealthSummary
} from '@/types/cellar'
import { createId } from '@/utils/db'

/** 一天的毫秒数 */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 旧数据修订号迁移：从入窖日期推导。
 * 取「1970-01-01 起经过的整天数 + 1」，保证同一记录迁移结果幂等、
 * 不同入窖日期的记录修订号互不相同且按时间单调。
 */
export function revisionFromStartDate(startDate: string): number {
  const parts = startDate.split('-').map((item) => Number(item))
  if (parts.length !== 3 || parts.some((item) => !Number.isFinite(item))) return 1
  const time = new Date(parts[0], parts[1] - 1, parts[2]).getTime()
  if (!Number.isFinite(time)) return 1
  return Math.floor(time / DAY_MS) + 1
}

let cachedOrigin: string | null = null

/**
 * 当前标签页标识：sessionStorage 在同一标签页内稳定、标签页间独立。
 * 冲突留版时用它区分改动来自哪一方。
 */
export function currentOrigin(): string {
  if (cachedOrigin) return cachedOrigin
  const key = 'gbincense:cellar-origin'
  let value = ''
  try {
    value = sessionStorage.getItem(key) ?? ''
    if (!value) {
      value = `tab-${createId('t').slice(-6)}`
      sessionStorage.setItem(key, value)
    }
  } catch {
    value = `tab-${createId('t').slice(-6)}`
  }
  cachedOrigin = value
  return value
}

/** 温湿度硬边界校验：越界的读数一律拒绝 */
export function validateReadingBounds(temperatureC: number, humidityPct: number): string[] {
  const errors: string[] = []
  if (!Number.isFinite(temperatureC) || temperatureC < TEMP_HARD_MIN || temperatureC > TEMP_HARD_MAX) {
    errors.push(`温度 ${temperatureC} ℃ 超出硬边界 ${TEMP_HARD_MIN} ~ ${TEMP_HARD_MAX} ℃，拒绝入窖`)
  }
  if (!Number.isFinite(humidityPct) || humidityPct < HUMIDITY_HARD_MIN || humidityPct > HUMIDITY_HARD_MAX) {
    errors.push(`湿度 ${humidityPct}% 超出硬边界 ${HUMIDITY_HARD_MIN} ~ ${HUMIDITY_HARD_MAX}%，拒绝入窖`)
  }
  return errors
}

/** 温湿度是否落在建议区间（18~26℃ / 50~70%） */
export function isIdealReading(temperatureC: number, humidityPct: number): boolean {
  return (
    temperatureC >= TEMP_IDEAL_MIN &&
    temperatureC <= TEMP_IDEAL_MAX &&
    humidityPct >= HUMIDITY_IDEAL_MIN &&
    humidityPct <= HUMIDITY_IDEAL_MAX
  )
}

/** 参与三路合并的窖藏可变字段（id / revision / forkOf / origin / updatedAt 之外的业务字段） */
export const CELLAR_MERGE_FIELDS = [
  'batchId',
  'startDate',
  'endDate',
  'temperatureC',
  'humidityPct',
  'container',
  'state'
] as const satisfies ReadonlyArray<keyof Cellar>

/** 以基线为准比较两条记录改动过的业务字段 */
export function changedFields(base: Cellar, candidate: Cellar): Array<(typeof CELLAR_MERGE_FIELDS)[number]> {
  return CELLAR_MERGE_FIELDS.filter((field) => base[field] !== candidate[field])
}

/** 逐条三路合并结论 */
export interface CellarMergeDecision {
  /** 写入主版本表的记录（新建 / 更新 / 留版的主版本），null 表示无需写入 */
  winner: Cellar | null
  /** 双方都改过同一字段时保留的另一版（fork） */
  fork: Cellar | null
  /** 被拒绝原因：硬边界或容器余量不足 */
  rejected: string | null
  /** 跳过原因：对端修订较旧、或内容完全一致 */
  skipped: string | null
  /** 主版本是否发生了有效改动（用于触发状态 / 告警 / 导出重算） */
  changed: boolean
}

interface ApplyContext {
  /** 批次数量（支 / 丸 / 饼），用于容器余量校验；未知批次返回 0 并由调用方拦截 */
  quantityOfBatch: (batchId: string) => number
  batchExists: (batchId: string) => boolean
  /** 该批次是否已有窖藏主版本（编辑自身除外）：防止多标签页重复入窖 */
  cellarExistsForBatch: (batchId: string, cellarId: string) => boolean
  /** 当前库内全部窖藏记录，容量余量按候选落库后的全量口径核算 */
  currentCellars: Cellar[]
}

function buildFork(existing: Cellar, incoming: Cellar): Cellar {
  return {
    ...incoming,
    id: createId('cellarf'),
    forkOf: existing.id,
    origin: incoming.origin || currentOrigin(),
    revision: Math.max(existing.revision, incoming.revision),
    updatedAt: Math.max(incoming.updatedAt, Date.now())
  }
}

/**
 * 把一条候选窖藏记录合并进当前库。
 *
 * - 同一条按修订号判新旧：修订号大者胜，相等再比 updatedAt；
 * - 基线与当前不一致时按字段三路合并：双方改的字段互不重叠则补在一起，
 *   重叠字段双方取值不同则主版本留较新修订号一方、另一方作为 fork 保留两版；
 * - 新建记录直接补入；
 * - 温湿度硬边界、容器余量不足直接拒绝（拒绝时草稿仍保留）。
 */
export function decideCellarMerge(
  existing: Cellar | undefined,
  candidate: Cellar,
  base: Cellar | null,
  context: ApplyContext
): CellarMergeDecision {
  const normalized: Cellar = {
    ...candidate,
    revision: Number.isFinite(candidate.revision) && candidate.revision > 0 ? Math.floor(candidate.revision) : 1
  }

  const boundErrors = validateReadingBounds(normalized.temperatureC, normalized.humidityPct)
  if (boundErrors.length > 0) {
    return { winner: null, fork: null, rejected: boundErrors.join('；'), skipped: null, changed: false }
  }
  if (!context.batchExists(normalized.batchId)) {
    return {
      winner: null,
      fork: null,
      rejected: `关联和香批次「${normalized.batchId}」不存在，拒绝入窖`,
      skipped: null,
      changed: false
    }
  }

  // 新建：库内尚无同 id 记录
  if (!existing) {
    if (context.cellarExistsForBatch(normalized.batchId, normalized.id)) {
      return {
        winner: null,
        fork: null,
        rejected: `该和香批次已有窖藏记录，拒绝重复入窖（可能是另一标签页先提交）`,
        skipped: null,
        changed: false
      }
    }
    const rejectReason = capacityRejection(normalized, context.currentCellars, context)
    if (rejectReason) return { winner: null, fork: null, rejected: rejectReason, skipped: null, changed: false }
    return { winner: normalized, fork: null, rejected: null, skipped: null, changed: true }
  }

  // 内容完全一致（修订号相同、业务字段无差异）：幂等跳过
  const noFieldDiff = changedFields(existing, normalized).length === 0
  if (existing.revision === normalized.revision && noFieldDiff) {
    return { winner: null, fork: null, rejected: null, skipped: '记录内容一致，跳过', changed: false }
  }

  // 无基线的集合合并（如导入）：修订号较新者胜，同修订号按更新时间
  if (!base || base.id !== existing.id) {
    if (normalized.revision < existing.revision) {
      return { winner: null, fork: null, rejected: null, skipped: '对端修订号较旧，跳过', changed: false }
    }
    if (normalized.revision === existing.revision && normalized.updatedAt <= existing.updatedAt && noFieldDiff) {
      return { winner: null, fork: null, rejected: null, skipped: '记录内容一致，跳过', changed: false }
    }
    if (normalized.revision === existing.revision && noFieldDiff) {
      return { winner: { ...normalized, id: existing.id }, fork: null, rejected: null, skipped: null, changed: false }
    }
    if (normalized.revision === existing.revision) {
      // 同修订号但内容不同且无基线：双方都可能改过，留两版
      const localWins = existing.updatedAt >= normalized.updatedAt
      const winner: Cellar = { ...(localWins ? existing : normalized), id: existing.id, forkOf: existing.forkOf }
      const rejectReason = capacityRejection(winner, context.currentCellars, context)
      if (rejectReason) return { winner: null, fork: null, rejected: rejectReason, skipped: null, changed: false }
      return {
        winner,
        fork: buildFork(existing, localWins ? normalized : existing),
        rejected: null,
        skipped: null,
        changed: true
      }
    }
    const winner = { ...normalized, id: existing.id }
    const rejectReason = capacityRejection(winner, context.currentCellars, context)
    if (rejectReason) return { winner: null, fork: null, rejected: rejectReason, skipped: null, changed: false }
    return { winner, fork: null, rejected: null, skipped: null, changed: true }
  }

  // 基于草稿的三路合并
  const baseRevision = base.revision || revisionFromStartDate(base.startDate)
  if (normalized.revision < baseRevision) {
    return { winner: null, fork: null, rejected: null, skipped: '草稿修订号落后于基线，跳过', changed: false }
  }

  // 本标签页编辑期间对端没有落新修订：快进覆盖
  if (existing.revision <= baseRevision) {
    if (noFieldDiff && existing.revision === normalized.revision) {
      return { winner: null, fork: null, rejected: null, skipped: '记录内容一致，跳过', changed: false }
    }
    const winner = { ...normalized, id: existing.id }
    const rejectReason = capacityRejection(winner, context.currentCellars, context)
    if (rejectReason) return { winner: null, fork: null, rejected: rejectReason, skipped: null, changed: false }
    return { winner, fork: null, rejected: null, skipped: null, changed: true }
  }

  // 对端已有更新修订：按字段三路合并
  const localChanged = changedFields(base, normalized)
  const remoteChanged = changedFields(base, existing)
  const conflicts = localChanged.filter(
    (field) => remoteChanged.includes(field) && normalized[field] !== existing[field]
  )

  if (conflicts.length === 0) {
    // 无冲突：以对端较新记录为底，补上本方改动字段
    const merged: Cellar = { ...existing, id: existing.id }
    localChanged.forEach((field) => {
      ;(merged as Cellar)[field] = normalized[field] as never
    })
    merged.revision = Math.max(existing.revision, normalized.revision) + 1
    merged.updatedAt = Date.now()
    merged.origin = currentOrigin()
    const rejectReason = capacityRejection(merged, context.currentCellars, context)
    if (rejectReason) return { winner: null, fork: null, rejected: rejectReason, skipped: null, changed: false }
    return { winner: merged, fork: null, rejected: null, skipped: null, changed: true }
  }

  // 双方都改了同一字段且取值不同：留两版
  const localNewer = normalized.revision > existing.revision
    || (normalized.revision === existing.revision && normalized.updatedAt >= existing.updatedAt)
  const winner: Cellar = {
    ...(localNewer ? normalized : existing),
    id: existing.id,
    revision: Math.max(existing.revision, normalized.revision) + 1,
    updatedAt: Date.now()
  }
  const rejectReason = capacityRejection(winner, context.currentCellars, context)
  if (rejectReason) return { winner: null, fork: null, rejected: rejectReason, skipped: null, changed: false }
  return { winner, fork: buildFork(existing, localNewer ? existing : normalized), rejected: null, skipped: null, changed: true }
}

/**
 * 容器余量校验：同容器在窖（窖藏中且非分叉）版本占用合计不得超过容器容量。
 * 以「候选记录落库后的全量列表」为口径：候选自身的旧版本不再重复计。
 */
export function capacityRejection(
  candidate: Cellar,
  currentCellars: Cellar[],
  context: Pick<ApplyContext, 'quantityOfBatch'>
): string | null {
  // 已出窖不再占用窖容；分叉版本与主版本同占一批，不重复计
  if (candidate.state !== '窖藏中' || candidate.forkOf) return null
  const limit = CONTAINER_CAPACITY[candidate.container as CellarContainer] ?? 0
  const used = currentCellars
    .filter(
      (cellar) =>
        cellar.id !== candidate.id &&
        !cellar.forkOf &&
        cellar.forkOf !== candidate.id &&
        cellar.state === '窖藏中' &&
        cellar.container === candidate.container
    )
    .reduce((sum, cellar) => sum + (context.quantityOfBatch(cellar.batchId) || 0), 0)
  const need = context.quantityOfBatch(candidate.batchId) || 0
  if (used + need > limit) {
    return `容器余量不足：${candidate.container} 已占 ${used} / ${limit}，本次需 ${need}，拒绝入窖`
  }
  return null
}

/** 某容器在窖主版本占用量（供页面展示余量） */
export function containerUsage(
  container: CellarContainer,
  cellars: Cellar[],
  quantityOfBatch: (batchId: string) => number
): { used: number; limit: number; remain: number } {
  const used = cellars
    .filter((cellar) => cellar.state === '窖藏中' && !cellar.forkOf && cellar.container === container)
    .reduce((sum, cellar) => sum + (quantityOfBatch(cellar.batchId) || 0), 0)
  const limit = CONTAINER_CAPACITY[container]
  return { used, limit, remain: limit - used }
}

/** 单条窖藏环境健康度（窖藏状态 / 温湿度派生） */
export function healthOfCellar(cellar: Cellar): CellarHealthLevel {
  if (cellar.state === '已出窖') return 'done'
  const bounds = validateReadingBounds(cellar.temperatureC, cellar.humidityPct)
  if (bounds.length > 0) return 'bad'
  return isIdealReading(cellar.temperatureC, cellar.humidityPct) ? 'ok' : 'warn'
}

/** 窖藏状态汇总：有效读数改动后随 liveQuery 自动重算，导出 JSON 一并携带 */
export function summarizeCellarHealth(cellars: Cellar[]): CellarHealthSummary {
  const aging = cellars.filter((cellar) => cellar.state === '窖藏中' && !cellar.forkOf)
  const average = (pick: (cellar: Cellar) => number): number => {
    if (aging.length === 0) return 0
    const total = aging.reduce((sum, cellar) => sum + pick(cellar), 0)
    return Math.round((total / aging.length) * 10) / 10
  }
  return {
    generatedAt: new Date().toISOString(),
    agingCount: aging.length,
    averageTemperatureC: average((cellar) => cellar.temperatureC),
    averageHumidityPct: average((cellar) => cellar.humidityPct),
    idealWarningCount: aging.filter((cellar) => !isIdealReading(cellar.temperatureC, cellar.humidityPct)).length,
    outOfBoundsCount: aging.filter(
      (cellar) => validateReadingBounds(cellar.temperatureC, cellar.humidityPct).length > 0
    ).length
  }
}

export interface CellarHealthDetail extends CellarHealthSummary {
  items: Array<CellarHealthItem & { level: CellarHealthLevel }>
}

/** 窖藏告警明细：超硬边界为 bad，超出建议区间为 warn */
export function cellarHealthDetails(
  cellars: Cellar[],
  labelOf: (cellar: Cellar) => string
): CellarHealthDetail {
  const summary = summarizeCellarHealth(cellars)
  const items = cellars
    .filter((cellar) => cellar.state === '窖藏中')
    .map((cellar) => ({
      cellarId: cellar.id,
      label: labelOf(cellar),
      level: healthOfCellar(cellar),
      temperatureC: cellar.temperatureC,
      humidityPct: cellar.humidityPct
    }))
  return { ...summary, items }
}

/**
 * 集合级逐条离线合并（导入快照 / 对端整批数据时使用）。
 * 同 id：修订号与时间留较新值；同修订号且内容互异则留两版；库内没有的补进来。
 * 纯函数：返回需要写入 / 新增的全部记录，fork 为追加的新 id 记录。
 */
export function mergeCellarCollections(local: Cellar[], incoming: Cellar[]): Cellar[] {
  const byId = new Map<string, Cellar>()
  const forks: Cellar[] = []
  local.forEach((cellar) => byId.set(cellar.id, cellar))

  incoming.forEach((candidateRaw) => {
    const candidate: Cellar = {
      ...candidateRaw,
      revision:
        Number.isFinite(candidateRaw.revision) && candidateRaw.revision > 0
          ? Math.floor(candidateRaw.revision)
          : revisionFromStartDate(candidateRaw.startDate)
    }
    const existing = byId.get(candidate.id)
    if (!existing) {
      byId.set(candidate.id, candidate)
      return
    }
    const noFieldDiff = changedFields(existing, candidate).length === 0
    if (candidate.revision < existing.revision) return
    if (candidate.revision > existing.revision) {
      byId.set(candidate.id, { ...candidate, id: existing.id })
      return
    }
    // 同修订号：比更新时间
    if (noFieldDiff) {
      if (candidate.updatedAt > existing.updatedAt) byId.set(candidate.id, { ...candidate, id: existing.id })
      return
    }
    const localWins = existing.updatedAt >= candidate.updatedAt
    const winner = localWins ? { ...existing } : { ...candidate, id: existing.id }
    const loser = localWins ? candidate : existing
    byId.set(existing.id, winner)
    forks.push({
      ...loser,
      id: createId('cellarf'),
      forkOf: existing.id,
      revision: existing.revision,
      updatedAt: Math.max(loser.updatedAt, Date.now())
    })
  })

  return [...byId.values(), ...forks]
}

/** 构造一条离线草稿 */
export function buildCellarDraft(input: {
  cellarId: string
  action: CellarDraft['action']
  base: Cellar | null
  next: Cellar
  batchLabel: string
}): CellarDraft {
  const now = Date.now()
  return {
    id: createId('draft'),
    cellarId: input.cellarId,
    action: input.action,
    base: input.base,
    next: input.next,
    batchLabel: input.batchLabel,
    status: 'pending',
    lastError: null,
    attempts: 0,
    origin: currentOrigin(),
    createdAt: now,
    updatedAt: now
  }
}
