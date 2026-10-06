import { createId } from '@/utils/db'
import { round } from '@/utils/ratio'
import {
  CELLAR_HUMIDITY_BOUNDS,
  CELLAR_TEMPERATURE_BOUNDS,
  type Cellar,
  type CellarContainer,
  type CellarState
} from '@/types/cellar'

/**
 * 窖藏多标签页离线合并。
 *
 * 同一条窖藏记录按 revision（修订号）+ updatedAt（时间）判新旧：
 * - 远端没被别人动过：草稿直接快进提交；
 * - 别人的修订号更老：草稿直接覆盖；
 * - 别人修订号更新或同修订号分叉：逐字段三路合并（base / draft / remote），
 *   只被一方改过的字段自动补进来，双方都改且改成不同值的字段记为冲突，
 *   主记录按「修订号 + 时间」保留较新一版，另一版原样留成 conflictOf 副本，两版都在。
 */

/** 参与三方合并的业务字段（不含 id / 修订号 / 时间戳 / 冲突标记） */
export const CELLAR_MERGE_FIELDS = [
  'batchId',
  'startDate',
  'endDate',
  'temperatureC',
  'humidityPct',
  'container',
  'state'
] as const

export type CellarMergeField = (typeof CELLAR_MERGE_FIELDS)[number]

export const CELLAR_FIELD_LABELS: Record<CellarMergeField, string> = {
  batchId: '关联批次',
  startDate: '入窖日期',
  endDate: '出窖日期',
  temperatureC: '温度',
  humidityPct: '湿度',
  container: '容器',
  state: '状态'
}

/** 离线草稿：新建（create）或基于 base 快照编辑（update） */
export interface CellarDraft {
  /** 草稿自身主键：update 时固定为 `draft_${cellarId}`，保证同一条只有一份草稿 */
  id: string
  kind: 'create' | 'update'
  /** update 时为被编辑窖藏 id；create 时为预先分配、提交后继续沿用的 id */
  cellarId: string
  batchId: string
  startDate: string
  endDate: string
  temperatureC: number
  humidityPct: number
  container: CellarContainer
  state: CellarState
  /** 开始编辑时的基线快照（含 revision），用于三路合并 */
  base?: Cellar
  createdAt: number
  updatedAt: number
  /** 最近一次提交失败原因，供重试面板展示 */
  lastError?: string
}

export type CellarCommitOutcomeType =
  | 'created'
  | 'updated'
  | 'fast-forward'
  | 'overwritten'
  | 'merged'
  | 'conflict'
  | 'restored'
  | 'duplicate'

export interface CellarCommitOutcome {
  type: CellarCommitOutcomeType
  /** 主记录 id */
  cellarId: string
  /** 实际写入的记录（created/restored 时为新建，否则为更新后的主记录） */
  cellar: Cellar
  /** 冲突留版时新建的另一版本（两版都保留） */
  conflictCopy?: Cellar
  /** 容量拒绝之外的说明：合并补入字段、冲突字段等 */
  notes: string[]
  /** 温湿度超出建议区间但未越过硬边界的告警 */
  warnings: string[]
}

/** 容量不足：拒绝入窖 */
export class CellarCapacityError extends Error {
  readonly container: CellarContainer
  readonly capacity: number
  readonly occupied: number
  constructor(container: CellarContainer, capacity: number, occupied: number) {
    super(`「${container}」在窖容量不足：容量 ${capacity} 位，已占 ${occupied} 位`)
    this.name = 'CellarCapacityError'
    this.container = container
    this.capacity = capacity
    this.occupied = occupied
  }
}

/** 温湿度硬边界越界：拒绝提交 */
export class CellarBoundaryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CellarBoundaryError'
  }
}

/** 提交内容硬校验：只拦截越过硬边界与日期非法的情况，建议区间只告警 */
export function validateCellarDraft(draft: CellarDraft): { warnings: string[] } {
  const errors: string[] = []
  const [tMin, tMax] = CELLAR_TEMPERATURE_BOUNDS
  const [hMin, hMax] = CELLAR_HUMIDITY_BOUNDS
  if (!Number.isFinite(draft.temperatureC) || draft.temperatureC < tMin || draft.temperatureC > tMax) {
    errors.push(`温度需在 ${tMin} ~ ${tMax} ℃ 之间`)
  }
  if (!Number.isFinite(draft.humidityPct) || draft.humidityPct < hMin || draft.humidityPct > hMax) {
    errors.push(`湿度需在 ${hMin} ~ ${hMax} % 之间`)
  }
  if (!draft.startDate || !draft.endDate) errors.push('入窖与出窖日期不能为空')
  if (errors.length > 0) throw new CellarBoundaryError(errors.join('；'))

  const warnings: string[] = []
  if (draft.temperatureC < 18 || draft.temperatureC > 26) {
    warnings.push(`温度 ${draft.temperatureC}℃ 超出 18~26℃ 建议区间`)
  }
  if (draft.humidityPct < 50 || draft.humidityPct > 70) {
    warnings.push(`湿度 ${draft.humidityPct}% 超出 50~70% 建议区间`)
  }
  return { warnings }
}

/** 构造新建草稿（预先分配 cellarId，提交前后 id 一致，便于重试） */
export function createCellarDraftId(): string {
  return createId('cellar')
}

export function buildCreateDraft(input: {
  batchId: string
  startDate: string
  endDate: string
  temperatureC: number
  humidityPct: number
  container: CellarContainer
  state: CellarState
}): CellarDraft {
  const now = Date.now()
  const cellarId = createCellarDraftId()
  return {
    id: `draft_${cellarId}`,
    kind: 'create',
    cellarId,
    batchId: input.batchId,
    startDate: input.startDate,
    endDate: input.endDate,
    temperatureC: round(input.temperatureC, 1),
    humidityPct: round(input.humidityPct, 1),
    container: input.container,
    state: input.state,
    createdAt: now,
    updatedAt: now
  }
}

/** 基于当前窖藏记录构造编辑草稿（保存基线快照） */
export function buildUpdateDraft(cellar: Cellar, input: Partial<Omit<Cellar, 'id' | 'revision'>>): CellarDraft {
  const now = Date.now()
  return {
    id: `draft_${cellar.id}`,
    kind: 'update',
    cellarId: cellar.id,
    batchId: input.batchId ?? cellar.batchId,
    startDate: input.startDate ?? cellar.startDate,
    endDate: input.endDate ?? cellar.endDate,
    temperatureC:
      input.temperatureC !== undefined ? round(input.temperatureC, 1) : cellar.temperatureC,
    humidityPct:
      input.humidityPct !== undefined ? round(input.humidityPct, 1) : cellar.humidityPct,
    container: input.container ?? cellar.container,
    state: input.state ?? cellar.state,
    base: { ...cellar },
    createdAt: now,
    updatedAt: now
  }
}

function sameField(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return round(a, 1) === round(b, 1)
  return a === b
}

function draftValue(draft: CellarDraft, field: CellarMergeField): unknown {
  return draft[field]
}

function assignField(target: Cellar, field: CellarMergeField, value: unknown): void {
  switch (field) {
    case 'batchId':
      target.batchId = value as string
      break
    case 'startDate':
      target.startDate = value as string
      break
    case 'endDate':
      target.endDate = value as string
      break
    case 'temperatureC':
      target.temperatureC = value as number
      break
    case 'humidityPct':
      target.humidityPct = value as number
      break
    case 'container':
      target.container = value as CellarContainer
      break
    case 'state':
      target.state = value as CellarState
      break
  }
}

/** 判断「较新」：先比修订号，修订号相同再比提交时间，时间相同草稿（当前提交）优先 */
function draftIsNewer(draft: CellarDraft, base: Cellar, remote: Cellar): boolean {
  if (remote.revision !== base.revision) return false
  return draft.updatedAt >= remote.updatedAt
}

function conflictNoteOf(fields: CellarMergeField[]): string {
  return `两端改动冲突：${fields.map((field) => CELLAR_FIELD_LABELS[field]).join('、')}`
}

export interface CellarPlan {
  outcome: Omit<CellarCommitOutcome, 'warnings'>
  /** 容量校验时需要忽略的窖藏 id（主记录自身） */
  capacityExcludeId: string | null
  /** 提交后容器是否处于「在窖占用」状态（决定是否要占容量） */
  primaryInCellar: boolean
  primaryContainer: CellarContainer
}

/**
 * 纯函数合并规划：不触碰数据库。
 * @param draft 离线草稿
 * @param remote 库里当前的同 id 记录（不存在传 null）
 * @param sameBatchCellars 同批次已有的全部窖藏（create 时防重复入窖）
 */
export function planCellarCommit(
  draft: CellarDraft,
  remote: Cellar | null,
  sameBatchCellars: Cellar[]
): CellarPlan {
  const now = Date.now()

  // ---- 新建分支 ----
  if (draft.kind === 'create') {
    const draftCellar: Cellar = {
      id: draft.cellarId,
      batchId: draft.batchId,
      startDate: draft.startDate,
      endDate: draft.endDate,
      temperatureC: round(draft.temperatureC, 1),
      humidityPct: round(draft.humidityPct, 1),
      container: draft.container,
      state: draft.state,
      revision: 1,
      updatedAt: now
    }
    if (remote) {
      // 极少出现：预分配 id 已存在，退化为一次编辑合并
      const base: Cellar = { ...remote }
      return planUpdate(draft, base, remote, 'restored')
    }
    const other = sameBatchCellars.find((cellar) => !cellar.conflictOf)
    if (other) {
      // 多标签页同时给同一批次入窖：两版都留，新草稿留作并行版本
      const copy: Cellar = {
        ...draftCellar,
        id: createId('cellar'),
        conflictOf: other.id,
        conflictNote: '多个标签页同时登记同一批次入窖',
        revision: other.revision
      }
      return {
        outcome: {
          type: 'duplicate',
          cellarId: other.id,
          cellar: other,
          conflictCopy: copy,
          notes: [`该批次已在 ${other.startDate} 入窖，本次登记已保留为并行版本，请人工核对`]
        },
        capacityExcludeId: other.id,
        primaryInCellar: other.state === '窖藏中',
        primaryContainer: other.container
      }
    }
    return {
      outcome: { type: 'created', cellarId: draftCellar.id, cellar: draftCellar, notes: [] },
      capacityExcludeId: null,
      primaryInCellar: draftCellar.state === '窖藏中',
      primaryContainer: draftCellar.container
    }
  }

  // ---- 编辑分支 ----
  const base = draft.base
  if (!base) throw new Error('编辑草稿缺少基线快照，无法合并')
  if (!remote) {
    // 库里的记录被删掉了：按草稿恢复，修订号在基线基础上 +1
    const restored: Cellar = {
      ...base,
      batchId: draft.batchId,
      startDate: draft.startDate,
      endDate: draft.endDate,
      temperatureC: round(draft.temperatureC, 1),
      humidityPct: round(draft.humidityPct, 1),
      container: draft.container,
      state: draft.state,
      revision: base.revision + 1,
      conflictOf: undefined,
      conflictNote: undefined,
      updatedAt: now
    }
    return {
      outcome: {
        type: 'restored',
        cellarId: restored.id,
        cellar: restored,
        notes: ['原记录已被删除，已按离线草稿恢复']
      },
      capacityExcludeId: null,
      primaryInCellar: restored.state === '窖藏中',
      primaryContainer: restored.container
    }
  }

  return planUpdate(draft, base, remote)
}

function planUpdate(
  draft: CellarDraft,
  base: Cellar,
  remote: Cellar,
  forcedType?: CellarCommitOutcomeType
): CellarPlan {
  const now = Date.now()

  const applyDraft = (revision: number): Cellar => ({
    ...remote,
    batchId: draft.batchId,
    startDate: draft.startDate,
    endDate: draft.endDate,
    temperatureC: round(draft.temperatureC, 1),
    humidityPct: round(draft.humidityPct, 1),
    container: draft.container,
    state: draft.state,
    revision,
    updatedAt: now
  })

  // 远端未分叉（别人没动过）：快进提交
  if (remote.revision === base.revision && remote.updatedAt === base.updatedAt) {
    const cellar = applyDraft(base.revision + 1)
    return {
      outcome: {
        type: forcedType ?? 'fast-forward',
        cellarId: cellar.id,
        cellar,
        notes: forcedType === 'restored' ? ['原记录已被删除，已按离线草稿恢复'] : []
      },
      capacityExcludeId: cellar.id,
      primaryInCellar: cellar.state === '窖藏中',
      primaryContainer: cellar.container
    }
  }

  // 远端比基线还老（理论上不会，防御性处理）：草稿直接覆盖
  if (remote.revision < base.revision) {
    const cellar = applyDraft(Math.max(base.revision, remote.revision) + 1)
    return {
      outcome: {
        type: 'overwritten',
        cellarId: cellar.id,
        cellar,
        notes: ['本地修订号较新，已覆盖旧版本']
      },
      capacityExcludeId: cellar.id,
      primaryInCellar: cellar.state === '窖藏中',
      primaryContainer: cellar.container
    }
  }

  // 远端更新（修订号更大）或同修订号分叉：逐字段三路合并
  const draftChanged = new Set<CellarMergeField>()
  const remoteChanged = new Set<CellarMergeField>()
  CELLAR_MERGE_FIELDS.forEach((field) => {
    if (!sameField(draftValue(draft, field), base[field])) draftChanged.add(field)
    if (!sameField(remote[field], base[field])) remoteChanged.add(field)
  })

  const merged: Cellar = { ...remote }
  const conflictFields: CellarMergeField[] = []
  const autoMerged: CellarMergeField[] = []
  draftChanged.forEach((field) => {
    const value = draftValue(draft, field)
    if (!remoteChanged.has(field) || sameField(value, remote[field])) {
      // 只被我方改过，或双方改成了相同值：直接补入
      if (!remoteChanged.has(field)) autoMerged.push(field)
      assignField(merged, field, value)
    } else {
      // 双方都改过且值不同：冲突字段
      conflictFields.push(field)
    }
  })

  const notes: string[] = []
  if (autoMerged.length > 0) {
    notes.push(`已自动合入离线修改：${autoMerged.map((field) => CELLAR_FIELD_LABELS[field]).join('、')}`)
  }

  if (conflictFields.length === 0) {
    merged.revision = remote.revision + 1
    merged.updatedAt = now
    return {
      outcome: {
        type: 'merged',
        cellarId: merged.id,
        cellar: merged,
        notes
      },
      capacityExcludeId: merged.id,
      primaryInCellar: merged.state === '窖藏中',
      primaryContainer: merged.container
    }
  }

  // 有冲突：较新一版作为主记录，另一版原样留为副本，两版都保留
  const draftNewer = draftIsNewer(draft, base, remote)
  let primary: Cellar
  let copySource: Cellar
  if (draftNewer) {
    CELLAR_MERGE_FIELDS.forEach((field) => {
      assignField(merged, field, draftValue(draft, field))
    })
    primary = { ...merged, revision: remote.revision + 1, updatedAt: now }
    copySource = remote
  } else {
    // 主记录维持远端（较新），仅补入无冲突字段；草稿的冲突值随副本保留
    primary = { ...merged, revision: remote.revision + 1, updatedAt: now }
    copySource = {
      ...base,
      batchId: draft.batchId,
      startDate: draft.startDate,
      endDate: draft.endDate,
      temperatureC: round(draft.temperatureC, 1),
      humidityPct: round(draft.humidityPct, 1),
      container: draft.container,
      state: draft.state
    }
  }

  const copy: Cellar = {
    ...copySource,
    id: createId('cellar'),
    conflictOf: primary.id,
    conflictNote: conflictNoteOf(conflictFields),
    revision: remote.revision,
    updatedAt: draft.updatedAt
  }
  notes.push(
    draftNewer
      ? `${conflictNoteOf(conflictFields)}；已保留当前较新版本，另一版留为并行副本`
      : `${conflictNoteOf(conflictFields)}；已保留对方较新版本，本端版本留为并行副本`
  )

  return {
    outcome: {
      type: 'conflict',
      cellarId: primary.id,
      cellar: primary,
      conflictCopy: copy,
      notes
    },
    capacityExcludeId: primary.id,
    primaryInCellar: primary.state === '窖藏中',
    primaryContainer: primary.container
  }
}
