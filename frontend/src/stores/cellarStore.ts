import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { db, createId, readUiPrefs, writeUiPrefs, bumpCellarRevision } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  buildCellarDraft,
  capacityRejection,
  containerUsage,
  currentOrigin,
  decideCellarMerge,
  healthOfCellar,
  validateReadingBounds,
  type CellarHealthDetail,
  cellarHealthDetails,
  revisionFromStartDate
} from '@/utils/cellarSync'
import {
  CELLAR_NEAR_DAYS,
  CELLAR_STATE_FLOW,
  CONTAINER_CAPACITY,
  createEmptyCellarFilter,
  type Cellar,
  type CellarContainer,
  type CellarDraft,
  type CellarFilterState,
  type CellarRow,
  type CellarState,
  type CellarUrgency
} from '@/types/cellar'
import type { Batch } from '@/types/batch'
import type { Formula } from '@/types/formula'
import { round } from '@/utils/ratio'

/** 一天的毫秒数 */
const DAY_MS = 24 * 60 * 60 * 1000

/** 把 yyyy-MM-dd 解析为当天 0 点的毫秒数，非法日期返回 NaN */
export function parseDate(value: string): number {
  if (!value) return Number.NaN
  const parts = value.split('-').map((item) => Number(item))
  if (parts.length !== 3 || parts.some((item) => !Number.isFinite(item))) return Number.NaN
  return new Date(parts[0], parts[1] - 1, parts[2]).getTime()
}

/** 计算两个日期之间的整天数（to - from） */
export function daysBetween(from: string, to: string): number {
  const start = parseDate(from)
  const end = parseDate(to)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0
  return Math.round((end - start) / DAY_MS)
}

/** 今天（本地时区）的 yyyy-MM-dd */
export function todayIso(): string {
  const now = new Date()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/** 其他标签页完成离线合并后的通知频道名 */
const SYNC_CHANNEL_NAME = 'gbincense:cellar-sync'

/**
 * 窖藏 store：维护窖藏批次、环境读数与离线草稿，
 * 提交前核对容器余量与温湿度硬边界；草稿逐条按修订号合并；
 * 派生临近出窖提醒（逾期 / 临近 / 正常 / 已出窖）与环境健康告警。
 */
export const useCellarStore = defineStore('cellar', () => {
  const cellarTable = useIdbTable<Cellar>((database) => database.cellars)
  const draftTable = useIdbTable<CellarDraft>((database) => database.cellarDrafts)
  const batchTable = useIdbTable<Batch>((database) => database.batches, { sortByUpdatedAt: false })
  const formulaTable = useIdbTable<Formula>((database) => database.formulas, { sortByUpdatedAt: false })

  const prefs = readUiPrefs()
  const sortMode = ref<'remain' | 'start'>(prefs.cellarSort)
  const filter = ref<CellarFilterState>(createEmptyCellarFilter())
  const currentCellarId = ref<string | null>(null)
  const flushing = ref(false)
  const lastSyncedAt = ref<number | null>(null)

  /** 主版本记录（非冲突分叉）：统计、容量与告警均以主版本为准 */
  const canonicalCellars = computed<Cellar[]>(() =>
    cellarTable.rows.value.filter((cellar) => !cellar.forkOf)
  )
  const cellars = computed<Cellar[]>(() => canonicalCellars.value)
  const batches = computed<Batch[]>(() => batchTable.rows.value)
  const formulas = computed<Formula[]>(() => formulaTable.rows.value)
  const drafts = computed<CellarDraft[]>(() =>
    [...draftTable.rows.value].sort((a, b) => a.createdAt - b.createdAt)
  )
  const loading = computed(() => cellarTable.loading.value)
  const ready = computed(() => cellarTable.ready.value)
  const error = computed(() => cellarTable.error.value)

  const currentCellar = computed<Cellar | null>(
    () => cellars.value.find((cellar) => cellar.id === currentCellarId.value) ?? null
  )

  const batchMap = computed<Record<string, Batch>>(() => {
    const map: Record<string, Batch> = {}
    batches.value.forEach((batch) => {
      map[batch.id] = batch
    })
    return map
  })

  const formulaNameMap = computed<Record<string, string>>(() => {
    const map: Record<string, string> = {}
    formulas.value.forEach((formula) => {
      map[formula.id] = formula.name
    })
    return map
  })

  /** 分叉版本按主版本 id 分组 */
  const forkMap = computed<Map<string, Cellar[]>>(() => {
    const map = new Map<string, Cellar[]>()
    cellarTable.rows.value
      .filter((cellar) => cellar.forkOf)
      .forEach((cellar) => {
        const list = map.get(cellar.forkOf as string) ?? []
        list.push(cellar)
        map.set(cellar.forkOf as string, list)
      })
    map.forEach((list) => list.sort((a, b) => b.updatedAt - a.updatedAt))
    return map
  })

  function quantityOfBatch(batchId: string): number {
    return batchMap.value[batchId]?.quantity ?? 0
  }

  /** 该批次是否已有窖藏主版本（编辑自身除外）：拦截多标签页重复入窖 */
  function cellarExistsForBatch(batchId: string, cellarId: string): boolean {
    return canonicalCellars.value.some((cellar) => cellar.batchId === batchId && cellar.id !== cellarId)
  }

  /** 批次标签：香方名 · 和香日期 · 成型方式 */
  function batchLabel(batchId: string): string {
    const batch = batchMap.value[batchId]
    if (!batch) return '批次已删除'
    const name = formulaNameMap.value[batch.formulaId] ?? '香方已删除'
    return `${name} · ${batch.mixedAt} · ${batch.formingMethod}`
  }

  function urgencyOf(cellar: Cellar): CellarUrgency {
    if (cellar.state === '已出窖') return 'done'
    const remain = daysBetween(todayIso(), cellar.endDate)
    if (remain < 0) return 'overdue'
    if (remain <= CELLAR_NEAR_DAYS) return 'near'
    return 'normal'
  }

  /** 全部窖藏行：主版本附带同条冲突版本，分叉版本单独成行 */
  const rows = computed<CellarRow[]>(() => {
    const mainRows: CellarRow[] = canonicalCellars.value.map((cellar) => {
      const batch = batchMap.value[cellar.batchId]
      return {
        cellar,
        batchLabel: batchLabel(cellar.batchId),
        formulaName: batch ? formulaNameMap.value[batch.formulaId] ?? '香方已删除' : '香方已删除',
        quantity: batch?.quantity ?? 0,
        remainDays: daysBetween(todayIso(), cellar.endDate),
        agedDays: daysBetween(cellar.startDate, todayIso()),
        urgency: urgencyOf(cellar),
        health: healthOfCellar(cellar),
        versions: forkMap.value.get(cellar.id) ?? [],
        isFork: false
      }
    })
    const forkRows: CellarRow[] = cellarTable.rows.value
      .filter((cellar) => cellar.forkOf)
      .map((cellar) => {
        const parent = cellarTable.rows.value.find((item) => item.id === cellar.forkOf)
        const batch = batchMap.value[cellar.batchId]
        return {
          cellar,
          batchLabel: batchLabel(cellar.batchId),
          formulaName: batch ? formulaNameMap.value[batch.formulaId] ?? '香方已删除' : '香方已删除',
          quantity: batch?.quantity ?? 0,
          remainDays: daysBetween(todayIso(), cellar.endDate),
          agedDays: daysBetween(cellar.startDate, todayIso()),
          urgency: urgencyOf(cellar),
          health: healthOfCellar(cellar),
          versions: [],
          isFork: true,
          parentLabel: parent ? batchLabel(parent.batchId) : '主版本已删除'
        }
      })
    return [...mainRows, ...forkRows]
  })

  /** 按排序方式排列：临近出窖（剩余天数升序）/ 按入窖日期 */
  const sortedRows = computed<CellarRow[]>(() => {
    const list = [...rows.value]
    if (sortMode.value === 'start') {
      return list.sort((a, b) => {
        const dateDiff = b.cellar.startDate.localeCompare(a.cellar.startDate)
        if (dateDiff !== 0) return dateDiff
        // 同批次的分叉版本排在其主版本之后
        if (a.isFork !== b.isFork) return a.isFork ? 1 : -1
        return 0
      })
    }
    return list.sort((a, b) => {
      const rank = (row: CellarRow): number => (row.urgency === 'done' ? 1 : 0)
      const rankDiff = rank(a) - rank(b)
      if (rankDiff !== 0) return rankDiff
      const remainDiff = a.remainDays - b.remainDays
      if (remainDiff !== 0) return remainDiff
      if (a.isFork !== b.isFork) return a.isFork ? 1 : -1
      return 0
    })
  })

  const filteredRows = computed<CellarRow[]>(() =>
    sortedRows.value.filter((row) => {
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${row.batchLabel}${row.formulaName}${row.cellar.container}${row.cellar.state}`
        if (!haystack.includes(keyword)) return false
      }
      if (filter.value.states.length > 0 && !filter.value.states.includes(row.cellar.state)) return false
      if (filter.value.containers.length > 0 && !filter.value.containers.includes(row.cellar.container)) return false
      return true
    })
  )

  /** 临近出窖提醒：逾期 + 14 天内到期的在窖主版本 */
  const alerts = computed<CellarRow[]>(() =>
    sortedRows.value.filter((row) => !row.isFork && (row.urgency === 'overdue' || row.urgency === 'near'))
  )

  const agingCount = computed(() => canonicalCellars.value.filter((cellar) => cellar.state === '窖藏中').length)
  const doneCount = computed(() => canonicalCellars.value.filter((cellar) => cellar.state === '已出窖').length)
  const forkCount = computed(() => cellarTable.rows.value.filter((cellar) => cellar.forkOf).length)

  const averageTemperature = computed(() => {
    const list = canonicalCellars.value.filter((cellar) => cellar.state === '窖藏中')
    if (list.length === 0) return 0
    return round(list.reduce((sum, cellar) => sum + cellar.temperatureC, 0) / list.length, 1)
  })

  const averageHumidity = computed(() => {
    const list = canonicalCellars.value.filter((cellar) => cellar.state === '窖藏中')
    if (list.length === 0) return 0
    return round(list.reduce((sum, cellar) => sum + cellar.humidityPct, 0) / list.length, 1)
  })

  /** 温湿度告警明细（读数改动即随 rows 重算）：超硬边界 bad / 超建议区间 warn */
  const environmentHealth = computed<CellarHealthDetail>(() =>
    cellarHealthDetails(canonicalCellars.value, (cellar) => batchLabel(cellar.batchId))
  )

  /** 需要告警的在窖批次：超出 18~26℃ / 50~70% 建议区间 */
  const environmentWarning = computed(() =>
    environmentHealth.value.items.filter((item) => item.level === 'warn' || item.level === 'bad')
  )

  /** 离线草稿队列：待提交 + 失败保留 */
  const pendingDrafts = computed(() => drafts.value.filter((draft) => draft.status === 'pending'))
  const failedDrafts = computed(() => drafts.value.filter((draft) => draft.status === 'failed'))
  const hasDrafts = computed(() => drafts.value.length > 0)

  const hasFilter = computed(
    () =>
      filter.value.keyword.trim().length > 0 ||
      filter.value.states.length > 0 ||
      filter.value.containers.length > 0
  )

  function setSortMode(mode: 'remain' | 'start'): void {
    sortMode.value = mode
    writeUiPrefs({ ...readUiPrefs(), cellarSort: mode })
  }

  function setCurrentCellar(id: string | null): void {
    currentCellarId.value = id
  }

  function patchFilter(patch: Partial<CellarFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptyCellarFilter()
  }

  function cellarById(id: string): Cellar | undefined {
    return cellarTable.rows.value.find((cellar) => cellar.id === id)
  }

  /** 某批次的窖藏主版本（分叉不计入「是否已入窖」） */
  function cellarsOfBatch(batchId: string): Cellar[] {
    return canonicalCellars.value.filter((cellar) => cellar.batchId === batchId)
  }

  /** 各容器当前占用与余量（容量不足时页面据此拒绝入窖） */
  function containerCapacityOf(container: CellarContainer) {
    return containerUsage(container, canonicalCellars.value, quantityOfBatch)
  }

  /** 提交前预检：温湿度硬边界 + 容器余量 + 批次唯一性，返回拒绝原因（null 为通过） */
  function preflightSubmission(input: {
    cellarId: string
    batchId: string
    container: CellarContainer
    state: CellarState
    temperatureC: number
    humidityPct: number
  }): string | null {
    const boundErrors = validateReadingBounds(input.temperatureC, input.humidityPct)
    if (boundErrors.length > 0) return boundErrors.join('；')
    if (!batchMap.value[input.batchId]) return `关联和香批次「${input.batchId}」不存在，拒绝入窖`
    if (cellarExistsForBatch(input.batchId, input.cellarId)) {
      return '该和香批次已有窖藏记录，拒绝重复入窖'
    }
    // 以「候选落库后」的全量列表核算容量：编辑中的旧版本由候选顶替
    const candidateCellar: Cellar = {
      id: input.cellarId,
      batchId: input.batchId,
      startDate: '',
      endDate: '',
      temperatureC: input.temperatureC,
      humidityPct: input.humidityPct,
      container: input.container,
      state: input.state,
      revision: 0,
      origin: currentOrigin(),
      updatedAt: 0
    }
    const projected = canonicalCellars.value
      .filter((cellar) => cellar.id !== input.cellarId && !cellar.forkOf)
      .concat(candidateCellar)
    return capacityRejection(candidateCellar, projected, { quantityOfBatch })
  }

  /** 新建入窖：生成草稿（含完整候选记录），随后逐条离线合并 */
  async function createCellar(payload: {
    batchId: string
    startDate: string
    endDate: string
    temperatureC: number
    humidityPct: number
    container: CellarContainer
    state?: CellarState
  }): Promise<{ cellarId: string; draftId: string; status: 'applied' | 'failed'; error: string | null; result: { applied: number; failed: number } }> {
    const temperatureC = round(payload.temperatureC, 1)
    const humidityPct = round(payload.humidityPct, 1)
    const cellarId = createId('cellar')
    const state = payload.state ?? '窖藏中'
    const reason = preflightSubmission({
      cellarId,
      batchId: payload.batchId,
      container: payload.container,
      state,
      temperatureC,
      humidityPct
    })
    if (reason) throw new Error(reason)

    const now = Date.now()
    const next: Cellar = {
      id: cellarId,
      batchId: payload.batchId,
      startDate: payload.startDate,
      endDate: payload.endDate,
      temperatureC,
      humidityPct,
      container: payload.container,
      state,
      revision: revisionFromStartDate(payload.startDate),
      origin: currentOrigin(),
      updatedAt: now
    }
    const draft = buildCellarDraft({ cellarId, action: 'create', base: null, next, batchLabel: batchLabel(payload.batchId) })
    await db.cellarDrafts.put(draft)
    const result = await flushCellarDrafts()
    // 直接读库回查，避免 liveQuery 尚未刷新；被拒的草稿仍在
    const remaining = await db.cellarDrafts.get(draft.id)
    if (remaining) return { cellarId, draftId: draft.id, status: 'failed' as const, error: remaining.lastError, result }
    return { cellarId, draftId: draft.id, status: 'applied' as const, error: null, result }
  }

  /**
   * 修改窖藏（含温湿度读数）：先落离线草稿再按修订号合并。
   * 预检失败时草稿仍会保留（status=failed），改对后可重试；
   * 仅温度 / 湿度等有效读数改动会在合并成功后推动修订号自增与状态重算。
   */
  async function updateCellar(
    id: string,
    patch: Partial<Cellar>
  ): Promise<{ draftId: string; status: 'applied' | 'failed'; error: string | null }> {
    const existing = cellarById(id)
    if (!existing) throw new Error('窖藏记录不存在或为待合并版本')
    const nextPatch: Partial<Cellar> = { ...patch }
    if (patch.temperatureC !== undefined) nextPatch.temperatureC = round(patch.temperatureC, 1)
    if (patch.humidityPct !== undefined) nextPatch.humidityPct = round(patch.humidityPct, 1)

    const candidate = bumpCellarRevision({ ...existing, ...nextPatch, updatedAt: Date.now() }, currentOrigin())
    const reason = preflightSubmission({
      cellarId: id,
      batchId: candidate.batchId,
      container: candidate.container,
      state: candidate.state,
      temperatureC: candidate.temperatureC,
      humidityPct: candidate.humidityPct
    })

    const draft = buildCellarDraft({
      cellarId: id,
      action: 'update',
      base: { ...existing },
      next: candidate,
      batchLabel: batchLabel(existing.batchId)
    })
    if (reason) {
      draft.status = 'failed'
      draft.lastError = reason
      await db.cellarDrafts.put(draft)
      return { draftId: draft.id, status: 'failed', error: reason }
    }
    await db.cellarDrafts.put(draft)
    await flushCellarDrafts()
    const remaining = await db.cellarDrafts.get(draft.id)
    if (remaining) return { draftId: draft.id, status: 'failed', error: remaining.lastError }
    return { draftId: draft.id, status: 'applied', error: null }
  }

  /**
   * 逐条提交离线草稿：每条草稿独立事务 + 三路合并，
   * 单条被拒（余量不足 / 越界 / 目标缺失）只标记该条失败，草稿保留可重试。
   */
  async function flushCellarDrafts(): Promise<{ applied: number; failed: number }> {
    if (flushing.value) return { applied: 0, failed: 0 }
    flushing.value = true
    let applied = 0
    let failed = 0
    try {
      // 直接读库，避免刚入队草稿尚未反映到 liveQuery 快照
      const queue = (await db.cellarDrafts.where('status').equals('pending').toArray()).sort(
        (a, b) => a.createdAt - b.createdAt
      )
      for (const draft of queue) {
        try {
          await db.transaction('rw', db.cellars, db.cellarDrafts, async () => {
            const existing = await db.cellars.get(draft.cellarId)
            const allCellars = await db.cellars.toArray()
            const decision = decideCellarMerge(existing, draft.next, draft.base, {
              quantityOfBatch: (batchId) => batchMap.value[batchId]?.quantity ?? 0,
              batchExists: (batchId) => Boolean(batchMap.value[batchId]),
              cellarExistsForBatch,
              currentCellars: allCellars
            })
            if (decision.rejected) {
              await db.cellarDrafts.update(draft.id, {
                status: 'failed',
                lastError: decision.rejected,
                attempts: draft.attempts + 1,
                updatedAt: Date.now()
              })
              throw new Error(decision.rejected)
            }
            if (decision.winner) await db.cellars.put(decision.winner)
            if (decision.fork) await db.cellars.put(decision.fork)
            await db.cellarDrafts.delete(draft.id)
          })
          applied += 1
        } catch (err) {
          const message = err instanceof Error ? err.message : '离线合并失败'
          try {
            // 事务回滚后失败标记也会回滚，这里非事务补登，保证失败草稿仍在队列
            const still = await db.cellarDrafts.get(draft.id)
            if (still) {
              await db.cellarDrafts.put({
                ...still,
                status: 'failed',
                lastError: message,
                attempts: still.attempts + 1,
                updatedAt: Date.now()
              })
            }
          } catch {
            /* 草稿补登失败时保留原值，等待下次重试 */
          }
          failed += 1
        }
      }
      if (applied > 0) {
        lastSyncedAt.value = Date.now()
        notifyOtherTabs()
      }
    } finally {
      flushing.value = false
    }
    return { applied, failed }
  }

  /** 失败草稿重试：清掉上次错误后重新逐条合并 */
  async function retryDrafts(ids?: string[]): Promise<{ applied: number; failed: number }> {
    const targets = ids
      ? drafts.value.filter((draft) => ids.includes(draft.id))
      : drafts.value.filter((draft) => draft.status === 'failed')
    if (targets.length === 0) return { applied: 0, failed: 0 }
    await db.cellarDrafts.bulkPut(
      targets.map((draft) => ({ ...draft, status: 'pending' as const, lastError: null, updatedAt: Date.now() }))
    )
    return flushCellarDrafts()
  }

  /** 放弃草稿（手动丢弃），窖藏主数据不受影响 */
  async function discardDraft(id: string): Promise<void> {
    await db.cellarDrafts.delete(id)
  }

  /** 状态流转：窖藏中 → 已出窖（可回退）。状态操作直接落库并递增修订号 */
  async function advanceState(id: string): Promise<CellarState | null> {
    const cellar = cellarById(id)
    if (!cellar) return null
    const next = CELLAR_STATE_FLOW[cellar.state]
    const patch: Partial<Cellar> = { state: next }
    if (next === '已出窖' && cellar.endDate > todayIso()) {
      patch.endDate = todayIso()
    }
    await commitDirect(id, patch)
    return next
  }

  async function setState(id: string, state: CellarState): Promise<void> {
    await commitDirect(id, { state })
  }

  /** 不经草稿队列的直接落库（状态流转）：仍递增修订号、标记来源 */
  async function commitDirect(id: string, patch: Partial<Cellar>): Promise<void> {
    const existing = cellarById(id)
    if (!existing) return
    const next = bumpCellarRevision({ ...existing, ...patch, updatedAt: Date.now() }, currentOrigin())
    await db.cellars.put(next)
    notifyOtherTabs()
  }

  /** 一键出窖：把全部逾期的在窖批次置为已出窖 */
  async function releaseOverdue(): Promise<number> {
    const targets = rows.value.filter(
      (row) => !row.isFork && row.cellar.state === '窖藏中' && row.remainDays < 0
    )
    if (targets.length === 0) return 0
    const now = Date.now()
    const origin = currentOrigin()
    await db.transaction('rw', db.cellars, async () => {
      for (const row of targets) {
        const current = await db.cellars.get(row.cellar.id)
        if (!current || current.state !== '窖藏中') continue
        await db.cellars.put(
          bumpCellarRevision({ ...current, state: '已出窖', updatedAt: now }, origin)
        )
      }
    })
    notifyOtherTabs()
    return targets.length
  }

  async function removeCellar(id: string): Promise<void> {
    const forkIds = (forkMap.value.get(id) ?? []).map((cellar) => cellar.id)
    await db.transaction('rw', db.cellars, db.cellarDrafts, async () => {
      await db.cellars.bulkDelete([id, ...forkIds])
      const draftIds = await db.cellarDrafts.where('cellarId').anyOf([id, ...forkIds]).primaryKeys()
      if (draftIds.length > 0) await db.cellarDrafts.bulkDelete(draftIds)
    })
    if (currentCellarId.value === id) currentCellarId.value = null
  }

  async function removeCellarsOfBatch(batchId: string): Promise<number> {
    const list = cellarTable.rows.value.filter((cellar) => cellar.batchId === batchId)
    if (list.length === 0) return 0
    const ids = list.map((cellar) => cellar.id)
    await db.transaction('rw', db.cellars, db.cellarDrafts, async () => {
      await db.cellars.bulkDelete(ids)
      const draftIds = await db.cellarDrafts.where('cellarId').anyOf(ids).primaryKeys()
      if (draftIds.length > 0) await db.cellarDrafts.bulkDelete(draftIds)
    })
    return canonicalCellars.value.filter((cellar) => cellar.batchId === batchId).length
  }

  /** 跨标签页通道：任一标签页合并完成或断网恢复后触发本页重试 */
  let syncChannel: BroadcastChannel | null = null
  try {
    syncChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(SYNC_CHANNEL_NAME) : null
  } catch {
    syncChannel = null
  }
  function notifyOtherTabs(): void {
    try {
      syncChannel?.postMessage({ type: 'cellar-synced', at: Date.now(), origin: currentOrigin() })
    } catch {
      /* 通道不可用时静默：IndexedDB liveQuery 仍会反映改动 */
    }
  }
  syncChannel?.addEventListener('message', (event) => {
    const data = event.data as { type?: string } | null
    if (data?.type === 'cellar-synced' && pendingDrafts.value.length > 0) {
      void flushCellarDrafts()
    }
  })
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      void flushCellarDrafts()
    })
  }

  // 首屏数据就绪后自动重放上次断网 / 崩溃遗留的待提交草稿
  watch(
    () => cellarTable.ready.value,
    (ready) => {
      if (ready && pendingDrafts.value.length > 0) void flushCellarDrafts()
    },
    { immediate: true }
  )

  return {
    cellars,
    allCellars: computed(() => cellarTable.rows.value),
    batches,
    formulas,
    drafts,
    pendingDrafts,
    failedDrafts,
    hasDrafts,
    flushing,
    lastSyncedAt,
    loading,
    ready,
    error,
    sortMode,
    filter,
    currentCellarId,
    currentCellar,
    rows,
    sortedRows,
    filteredRows,
    alerts,
    agingCount,
    doneCount,
    forkCount,
    averageTemperature,
    averageHumidity,
    environmentHealth,
    environmentWarning,
    hasFilter,
    batchMap,
    batchLabel,
    setSortMode,
    setCurrentCellar,
    patchFilter,
    resetFilter,
    cellarById,
    cellarsOfBatch,
    containerCapacityOf,
    preflightSubmission,
    createCellar,
    updateCellar,
    flushCellarDrafts,
    retryDrafts,
    discardDraft,
    advanceState,
    setState,
    releaseOverdue,
    removeCellar,
    removeCellarsOfBatch,
    containerLimit: CONTAINER_CAPACITY
  }
})
