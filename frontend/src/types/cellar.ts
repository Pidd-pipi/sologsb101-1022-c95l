/** 窖藏：和香成型后的陈化环境记录 */
export type CellarState = '窖藏中' | '已出窖'
export type CellarContainer = '陶罐' | '锡罐' | '竹筒'

export interface Cellar {
  id: string
  /** 关联和香批次 */
  batchId: string
  /** 入窖日期（ISO 日期串 yyyy-MM-dd） */
  startDate: string
  /** 计划出窖日期（ISO 日期串 yyyy-MM-dd） */
  endDate: string
  /** 窖藏温度 ℃ */
  temperatureC: number
  /** 窖藏湿度 % */
  humidityPct: number
  /** 容器：陶罐/锡罐/竹筒 */
  container: CellarContainer
  /** 状态：窖藏中/已出窖 */
  state: CellarState
  /**
   * 修订号：每次成功的合并提交 +1，多标签页据此判断新旧。
   * v3 之前的旧数据没有修订号，迁移时从入窖日期折算补齐。
   */
  revision: number
  /** 非空表示该条是冲突时保留下来的另一版本，值指向主记录 id */
  conflictOf?: string
  /** 冲突留版说明（哪些字段两端不一致） */
  conflictNote?: string
  updatedAt: number
}

export const CELLAR_STATES: CellarState[] = ['窖藏中', '已出窖']
export const CELLAR_CONTAINERS: CellarContainer[] = ['陶罐', '锡罐', '竹筒']

/** 窖藏状态流转：窖藏中 → 已出窖 */
export const CELLAR_STATE_FLOW: Record<CellarState, CellarState> = {
  窖藏中: '已出窖',
  已出窖: '窖藏中'
}

/** 临近出窖提醒阈值：剩余天数小于等于该值即提醒 */
export const CELLAR_NEAR_DAYS = 14

/** 各类容器同时在窖的批次容量（含主记录，冲突副本不占位） */
export const CELLAR_CONTAINER_CAPACITY: Record<CellarContainer, number> = {
  陶罐: 20,
  锡罐: 12,
  竹筒: 8
}

/** 温湿度硬边界：超出即拒绝提交 */
export const CELLAR_TEMPERATURE_BOUNDS: readonly [number, number] = [-10, 50]
export const CELLAR_HUMIDITY_BOUNDS: readonly [number, number] = [0, 100]

/** 温湿度建议区间：超出不阻断提交，但给出告警并在环境超限中列出 */
export const CELLAR_TEMPERATURE_ADVISE: readonly [number, number] = [18, 26]
export const CELLAR_HUMIDITY_ADVISE: readonly [number, number] = [50, 70]

/** 一天的毫秒数 */
export const DAY_MS = 24 * 60 * 60 * 1000

/** 把 yyyy-MM-dd 解析为当天 0 点的毫秒数，非法日期返回 NaN */
export function parseCellarDate(value: string): number {
  if (!value) return Number.NaN
  const parts = value.split('-').map((item) => Number(item))
  if (parts.length !== 3 || parts.some((item) => !Number.isFinite(item))) return Number.NaN
  return new Date(parts[0], parts[1] - 1, parts[2]).getTime()
}

/**
 * 旧数据缺修订号时的迁移兜底：由入窖日期折算。
 * 取入窖日距 1970-01-01 的天数（必然为正整数且随日期单调递增），
 * 使老记录之间也能按「入窖越早修订号越小」比较新旧。
 */
export function revisionFromStartDate(startDate: string): number {
  const ms = parseCellarDate(startDate)
  if (!Number.isFinite(ms)) return 1
  return Math.max(1, Math.floor(ms / DAY_MS) + 1)
}

export type CellarUrgency = 'overdue' | 'near' | 'normal' | 'done'

/** 窖藏列表行：窖藏 + 批次 + 香方 + 剩余天数 */
export interface CellarRow {
  cellar: Cellar
  batchLabel: string
  formulaName: string
  quantity: number
  /** 距计划出窖的天数（正数=剩余，负数=已逾期） */
  remainDays: number
  /** 已窖藏天数 */
  agedDays: number
  urgency: CellarUrgency
  /** 是否为冲突时保留的并行版本（指向某条主记录） */
  isConflict: boolean
  /** 冲突留版说明 */
  conflictNote: string
}

/** 窖藏环境读数筛选条件 */
export interface CellarFilterState {
  keyword: string
  states: CellarState[]
  containers: CellarContainer[]
}

export function createEmptyCellarFilter(): CellarFilterState {
  return { keyword: '', states: [], containers: [] }
}
