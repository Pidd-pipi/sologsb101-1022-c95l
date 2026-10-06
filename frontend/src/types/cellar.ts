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
  /** 修订号：每次有效改动自增，离线合并据此判定新旧 */
  revision: number
  /** 最后改动来源（标签页标识），冲突留版时区分双方 */
  origin: string
  /** 冲突分叉：非空表示本条是双方同改后保留下来的另一版，值为主版本 id */
  forkOf?: string
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

/** 温湿度硬边界：超出即拒绝入窖 / 拒绝读数改动 */
export const TEMP_HARD_MIN = -10
export const TEMP_HARD_MAX = 50
export const HUMIDITY_HARD_MIN = 0
export const HUMIDITY_HARD_MAX = 100

/** 温湿度建议区间：在硬边界之内、超出该区间只告警不拒绝 */
export const TEMP_IDEAL_MIN = 18
export const TEMP_IDEAL_MAX = 26
export const HUMIDITY_IDEAL_MIN = 50
export const HUMIDITY_IDEAL_MAX = 70

/**
 * 容器窖容上限（支 / 丸 / 饼，按批次 quantity 计）。
 * 同一容器在窖主版本占用量合计不得超过该容量。
 */
export const CONTAINER_CAPACITY: Record<CellarContainer, number> = {
  陶罐: 500,
  锡罐: 200,
  竹筒: 120
}

/** 窖藏环境健康度（由温湿度读数与状态派生，读数改动即重算） */
export type CellarHealthLevel = 'ok' | 'warn' | 'bad' | 'done'

export interface CellarHealthItem {
  cellarId: string
  label: string
  level: CellarHealthLevel
  temperatureC: number
  humidityPct: number
}

/** 导出 JSON 附带的窖藏状态汇总：有效读数改动后重新计算 */
export interface CellarHealthSummary {
  generatedAt: string
  /** 在窖主版本数 */
  agingCount: number
  averageTemperatureC: number
  averageHumidityPct: number
  /** 超出建议区间（18~26℃ / 50~70%）的条数 */
  idealWarningCount: number
  /** 超出硬边界（-10~50℃ / 0~100%）的条数 */
  outOfBoundsCount: number
}

/** 离线草稿动作：新建入窖 / 修改窖藏（含温湿度读数） */
export type CellarDraftAction = 'create' | 'update'

/** 草稿处理状态：待提交 / 最近一次失败（草稿保留，可重试） */
export type CellarDraftStatus = 'pending' | 'failed'

/**
 * 窖藏离线草稿：多个标签页同时改动时先各自落本表，
 * 网络恢复或重试时逐条按修订号与基线快照合并入 cellars。
 */
export interface CellarDraft {
  id: string
  /** 目标窖藏记录 id（create 时即预生成） */
  cellarId: string
  action: CellarDraftAction
  /** 改动前基线快照（create 为 null），三路合并据此识别同改 */
  base: Cellar | null
  /** 改动后的完整候选记录 */
  next: Cellar
  /** 提交时快照的批次标签，草稿列表离线可显示 */
  batchLabel: string
  status: CellarDraftStatus
  lastError: string | null
  attempts: number
  /** 草稿产生的标签页标识 */
  origin: string
  createdAt: number
  updatedAt: number
}

export const CELLAR_DRAFT_STATUSES: CellarDraftStatus[] = ['pending', 'failed']

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
  /** 环境健康度（读数派生） */
  health: CellarHealthLevel
  /** 同一条双方都改过时保留的其他版本（主版本行才有） */
  versions: Cellar[]
  /** 是否为冲突保留下来的分叉版本 */
  isFork: boolean
  /** 分叉行对应的主版本批次标签 */
  parentLabel?: string
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
