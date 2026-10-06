import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, readUiPrefs, writeUiPrefs } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  CELLAR_CONTAINER_CAPACITY,
  CELLAR_NEAR_DAYS,
  CELLAR_STATE_FLOW,
  DAY_MS,
  createEmptyCellarFilter,
  parseCellarDate,
  type Cellar,
  type CellarContainer,
  type CellarFilterState,
  type CellarRow,
  type CellarState,
  type CellarUrgency
} from '@/types/cellar'
import type { Batch } from '@/types/batch'
import type { Formula } from '@/types/formula'
import { round } from '@/utils/ratio'
import {
  CellarCapacityError,
  buildUpdateDraft,
  planCellarCommit,
  validateCellarDraft,
  type CellarCommitOutcome,
  type CellarDraft
} from '@/utils/cellarMerge'

export const parseDate = parseCellarDate

/** 计算两个日期之间的整天数（to - from） */
export function daysBetween(from: string, to: string): number {
  const start = parseCellarDate(from)
  const end = parseCellarDate(to)
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

export interface ContainerUsage {
  container: CellarContainer
  used: number
  capacity: number
  remain: number
  full: boolean
}

/**
 * 窖藏 store：维护窖藏批次、环境读数与排序方式，
 * 派生临近出窖提醒（逾期 / 临近 / 正常 / 已出窖），
 * 提交统一走「修订号 + 三路合并」，成功后重算状态、告警与统计。
 */
export const useCellarStore = defineStore('cellar', () => {
  const cellarTable = useIdbTable<Cellar>((database) => database.cellars)
  const batchTable = useIdbTable<Batch>((database) => database.batches, { sortByUpdatedAt: false })
  const formulaTable = useIdbTable<Formula>((database) => database.formulas, { sortByUpdatedAt: false })

  const prefs = readUiPrefs()
  const sortMode = ref<'remain' | 'start'>(prefs.cellarSort)
  const filter = ref<CellarFilterState>(createEmptyCellarFilter())
  const currentCellarId = ref<string | null>(null)
  /** 最近一次重算窖藏状态/告警的时间：有效读数改动提交成功后刷新 */
  const lastRecalcAt = ref(Date.now())

  const cellars = computed<Cellar[]>(() => cellarTable.rows.value)
  const batches = computed<Batch[]>(() => batchTable.rows.value)
  const formulas = computed<Formula[]>(() => formulaTable.rows.value)
  const loading = computed(() => cellarTable.loading.value)
  const ready = computed(() => cellarTable.ready.value)
  const error = computed(() => cellarTable.error.value)

  /** 主记录：冲突留版的副本不参与容量、统计与告警 */
  const primaryCellars = computed(() => cellars.value.filter((cellar) => !cellar.conflictOf))

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

  /** 全部窖藏行：附带批次、香方与剩余天数 */
  const rows = computed<CellarRow[]>(() => {
    // 引用重算节拍：有效读数提交成功后触发派生状态重算
    void lastRecalcAt.value
    return cellars.value.map((cellar) => {
      const batch = batchMap.value[cellar.batchId]
      return {
        cellar,
        batchLabel: batchLabel(cellar.batchId),
        formulaName: batch ? formulaNameMap.value[batch.formulaId] ?? '香方已删除' : '香方已删除',
        quantity: batch?.quantity ?? 0,
        remainDays: daysBetween(todayIso(), cellar.endDate),
        agedDays: daysBetween(cellar.startDate, todayIso()),
        urgency: urgencyOf(cellar),
        isConflict: Boolean(cellar.conflictOf),
        conflictNote: cellar.conflictNote ?? ''
      }
    })
  })

  /** 按排序方式排列：临近出窖（剩余天数升序）/ 按入窖日期；冲突副本排在其主记录旁 */
  const sortedRows = computed<CellarRow[]>(() => {
    const list = [...rows.value]
    if (sortMode.value === 'start') {
      return list.sort((a, b) => {
        const dateDiff = b.cellar.startDate.localeCompare(a.cellar.startDate)
        if (dateDiff !== 0) return dateDiff
        return a.cellar.id.localeCompare(b.cellar.id)
      })
    }
    return list.sort((a, b) => {
      const rank = (row: CellarRow): number => (row.urgency === 'done' ? 1 : 0)
      const rankDiff = rank(a) - rank(b)
      if (rankDiff !== 0) return rankDiff
      const remainDiff = a.remainDays - b.remainDays
      if (remainDiff !== 0) return remainDiff
      return a.cellar.id.localeCompare(b.cellar.id)
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

  /** 临近出窖提醒：逾期 + 14 天内到期的在窖主记录（冲突副本不重复提醒） */
  const alerts = computed<CellarRow[]>(() =>
    sortedRows.value.filter(
      (row) => !row.isConflict && (row.urgency === 'overdue' || row.urgency === 'near')
    )
  )

  /** 冲突留版数：双方都改过、两版都保留待人工核对 */
  const conflictCount = computed(() => cellars.value.filter((cellar) => Boolean(cellar.conflictOf)).length)
  const conflictRows = computed<CellarRow[]>(() => sortedRows.value.filter((row) => row.isConflict))

  const agingCount = computed(() => primaryCellars.value.filter((cellar) => cellar.state === '窖藏中').length)
  const doneCount = computed(() => primaryCellars.value.filter((cellar) => cellar.state === '已出窖').length)

  const averageTemperature = computed(() => {
    void lastRecalcAt.value
    const list = primaryCellars.value.filter((cellar) => cellar.state === '窖藏中')
    if (list.length === 0) return 0
    return round(list.reduce((sum, cellar) => sum + cellar.temperatureC, 0) / list.length, 1)
  })

  const averageHumidity = computed(() => {
    void lastRecalcAt.value
    const list = primaryCellars.value.filter((cellar) => cellar.state === '窖藏中')
    if (list.length === 0) return 0
    return round(list.reduce((sum, cellar) => sum + cellar.humidityPct, 0) / list.length, 1)
  })

  /** 温湿度是否在建议区间内（18~26℃ / 50~70%），有效读数改动后随提交重算 */
  const environmentWarning = computed(() => {
    void lastRecalcAt.value
    return primaryCellars.value
      .filter((cellar) => cellar.state === '窖藏中')
      .filter((cellar) => cellar.temperatureC < 18 || cellar.temperatureC > 26 || cellar.humidityPct < 50 || cellar.humidityPct > 70)
      .map((cellar) => ({
        cellarId: cellar.id,
        label: batchLabel(cellar.batchId),
        temperatureC: cellar.temperatureC,
        humidityPct: cellar.humidityPct
      }))
  })

  const hasFilter = computed(
    () =>
      filter.value.keyword.trim().length > 0 ||
      filter.value.states.length > 0 ||
      filter.value.containers.length > 0
  )

  /** 各容器当前在窖占用（只数主记录） */
  const containerUsage = computed<Record<CellarContainer, ContainerUsage>>(() => {
    void lastRecalcAt.value
    const result = {} as Record<CellarContainer, ContainerUsage>
    ;(Object.keys(CELLAR_CONTAINER_CAPACITY) as CellarContainer[]).forEach((container) => {
      const capacity = CELLAR_CONTAINER_CAPACITY[container]
      const used = primaryCellars.value.filter(
        (cellar) => cellar.container === container && cellar.state === '窖藏中'
      ).length
      result[container] = {
        container,
        used,
        capacity,
        remain: Math.max(0, capacity - used),
        full: used >= capacity
      }
    })
    return result
  })

  /** 预览某次提交后容器占用：excludeId 为正在编辑的窖藏，inCellar 为提交后是否在窖 */
  function previewUsage(container: CellarContainer, excludeId: string | null, inCellar: boolean): ContainerUsage {
    const capacity = CELLAR_CONTAINER_CAPACITY[container]
    const others = primaryCellars.value.filter(
      (cellar) =>
        cellar.container === container &&
        cellar.state === '窖藏中' &&
        cellar.id !== excludeId
    ).length
    const used = others + (inCellar ? 1 : 0)
    return { container, used, capacity, remain: Math.max(0, capacity - used), full: used > capacity }
  }

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
    return cellars.value.find((cellar) => cellar.id === id)
  }

  function cellarsOfBatch(batchId: string): Cellar[] {
    return cellars.value.filter((cellar) => cellar.batchId === batchId)
  }

  /**
   * 按批次逐条离线合并提交：
   * 先做温湿度硬边界校验，再在事务内读取最新库值做三路合并与容量校验，
   * 容量不足直接抛 CellarCapacityError 拒绝入窖（调用方保留草稿以便重试）。
   */
  async function commitDraft(draft: CellarDraft): Promise<CellarCommitOutcome> {
    const { warnings } = validateCellarDraft(draft)
    const outcome = await db.transaction('rw', db.cellars, async () => {
      const all = await db.cellars.toArray()
      const remote = all.find((cellar) => cellar.id === draft.cellarId) ?? null
      const sameBatch = draft.kind === 'create' ? all.filter((cellar) => cellar.batchId === draft.batchId) : []
      const plan = planCellarCommit(draft, remote, sameBatch)

      // 提交前核对容器余量：主记录占一个在窖位，冲突副本不占位；不足则整笔拒绝
      const capacity = CELLAR_CONTAINER_CAPACITY[plan.primaryContainer]
      const others = all.filter(
        (cellar) =>
          cellar.container === plan.primaryContainer &&
          cellar.state === '窖藏中' &&
          !cellar.conflictOf &&
          cellar.id !== plan.capacityExcludeId
      ).length
      const occupied = others + (plan.primaryInCellar ? 1 : 0)
      if (occupied > capacity) {
        throw new CellarCapacityError(plan.primaryContainer, capacity, occupied)
      }

      await db.cellars.put(plan.outcome.cellar)
      if (plan.outcome.conflictCopy) await db.cellars.put(plan.outcome.conflictCopy)
      return { ...plan.outcome, warnings }
    })
    // 有效改动已落库：重算窖藏状态、告警与统计（导出直接读实时库，无需另算）
    lastRecalcAt.value = Date.now()
    return outcome
  }

  /** 就地温湿度录入：同样走修订号合并，避免多标签页整批覆盖 */
  async function commitReading(
    id: string,
    field: 'temperatureC' | 'humidityPct',
    value: number
  ): Promise<CellarCommitOutcome> {
    const current = cellarById(id)
    if (!current) throw new Error('窖藏记录不存在或已被删除')
    const draft = buildUpdateDraft(current, { [field]: round(value, 1) })
    return commitDraft(draft)
  }

  /** 状态流转：窖藏中 → 已出窖（可回退），修订号 +1 */
  async function advanceState(id: string): Promise<CellarState | null> {
    const cellar = cellarById(id)
    if (!cellar) return null
    const next = CELLAR_STATE_FLOW[cellar.state]
    const patch: Partial<Cellar> = { state: next }
    if (next === '已出窖' && cellar.endDate > todayIso()) {
      patch.endDate = todayIso()
    }
    const draft = buildUpdateDraft(cellar, patch)
    await commitDraft(draft)
    return next
  }

  async function setState(id: string, state: CellarState): Promise<void> {
    const cellar = cellarById(id)
    if (!cellar || cellar.state === state) return
    const draft = buildUpdateDraft(cellar, { state })
    await commitDraft(draft)
  }

  /** 一键出窖：把全部逾期的在窖主记录置为已出窖，逐条推进修订号 */
  async function releaseOverdue(): Promise<number> {
    const targets = primaryCellars.value.filter(
      (cellar) => cellar.state === '窖藏中' && daysBetween(todayIso(), cellar.endDate) < 0
    )
    if (targets.length === 0) return 0
    const now = Date.now()
    const today = todayIso()
    await db.transaction('rw', db.cellars, async () => {
      for (const cellar of targets) {
        await db.cellars.update(cellar.id, {
          state: '已出窖' as CellarState,
          endDate: cellar.endDate > today ? today : cellar.endDate,
          revision: cellar.revision + 1,
          updatedAt: now
        })
      }
    })
    lastRecalcAt.value = now
    return targets.length
  }

  /**
   * 处理冲突副本：
   * adopt=true 采用副本版本（业务值并入主记录、修订号 +1、删除副本）；
   * adopt=false 放弃副本、保留主记录。
   */
  async function resolveConflict(copyId: string, adopt: boolean): Promise<boolean> {
    const copy = cellarById(copyId)
    if (!copy || !copy.conflictOf) return false
    const primary = cellarById(copy.conflictOf)
    await db.transaction('rw', db.cellars, async () => {
      if (adopt && primary) {
        const adopted: Cellar = {
          ...primary,
          batchId: copy.batchId,
          startDate: copy.startDate,
          endDate: copy.endDate,
          temperatureC: copy.temperatureC,
          humidityPct: copy.humidityPct,
          container: copy.container,
          state: copy.state,
          revision: primary.revision + 1,
          conflictNote: undefined,
          updatedAt: Date.now()
        }
        await db.cellars.put(adopted)
      }
      await db.cellars.delete(copyId)
    })
    lastRecalcAt.value = Date.now()
    return true
  }

  async function removeCellar(id: string): Promise<void> {
    await cellarTable.remove(id)
    if (currentCellarId.value === id) currentCellarId.value = null
    lastRecalcAt.value = Date.now()
  }

  async function removeCellarsOfBatch(batchId: string): Promise<number> {
    const ids = cellarsOfBatch(batchId).map((cellar) => cellar.id)
    if (ids.length === 0) return 0
    await cellarTable.bulkRemove(ids)
    lastRecalcAt.value = Date.now()
    return ids.length
  }

  return {
    cellars,
    batches,
    formulas,
    loading,
    ready,
    error,
    sortMode,
    filter,
    currentCellarId,
    currentCellar,
    lastRecalcAt,
    rows,
    sortedRows,
    filteredRows,
    alerts,
    conflictCount,
    conflictRows,
    agingCount,
    doneCount,
    averageTemperature,
    averageHumidity,
    environmentWarning,
    containerUsage,
    previewUsage,
    hasFilter,
    batchMap,
    batchLabel,
    setSortMode,
    setCurrentCellar,
    patchFilter,
    resetFilter,
    cellarById,
    cellarsOfBatch,
    commitDraft,
    commitReading,
    advanceState,
    setState,
    releaseOverdue,
    resolveConflict,
    removeCellar,
    removeCellarsOfBatch
  }
})

