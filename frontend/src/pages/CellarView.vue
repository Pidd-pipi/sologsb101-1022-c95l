<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Bell, Delete, Edit, Plus, Sort } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar, { type FilterModel } from '@/components/common/FilterBar.vue'
import GradeTag from '@/components/common/GradeTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import DraftPanel from '@/components/common/DraftPanel.vue'
import { useCellarStore, parseDate } from '@/stores/cellarStore'
import { useCellarDraftStore } from '@/stores/cellarDraftStore'
import { useFormulaStore } from '@/stores/formulaStore'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useProportion } from '@/hooks/useProportion'
import { db } from '@/utils/db'
import { round } from '@/utils/ratio'
import {
  CellarBoundaryError,
  CellarCapacityError,
  type CellarCommitOutcome,
  type CellarDraft
} from '@/utils/cellarMerge'
import {
  CELLAR_CONTAINERS,
  CELLAR_NEAR_DAYS,
  CELLAR_STATES,
  type Cellar,
  type CellarContainer,
  type CellarFilterState,
  type CellarRow,
  type CellarState,
  type CellarUrgency
} from '@/types/cellar'
import type { Batch, FormingMethod } from '@/types/batch'
import type { Proportion } from '@/types/proportion'

const route = useRoute()
const router = useRouter()
const cellarStore = useCellarStore()
const draftStore = useCellarDraftStore()
const formulaStore = useFormulaStore()
const batchTable = useIdbTable<Batch>((database) => database.batches, { sortByUpdatedAt: false })
const proportionTable = useIdbTable<Proportion>((database) => database.proportions, { sortByUpdatedAt: false })

const dialogVisible = ref(false)
const submitting = ref(false)
/** 对话框承载的草稿：有值表示正在编辑/新建一条草稿（提交后才落库） */
const dialogDraftId = ref<string | null>(null)
const formRef = ref<FormInstance>()

const form = reactive<{
  batchId: string
  startDate: string
  endDate: string
  temperatureC: number
  humidityPct: number
  container: CellarContainer
  state: CellarState
}>({
  batchId: '',
  startDate: new Date().toISOString().slice(0, 10),
  endDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  temperatureC: 22,
  humidityPct: 60,
  container: '陶罐',
  state: '窖藏中'
})

const rules: FormRules = {
  batchId: [{ required: true, message: '请选择关联和香批次', trigger: 'change' }],
  startDate: [{ required: true, message: '请选择入窖日期', trigger: 'change' }],
  endDate: [
    { required: true, message: '请选择计划出窖日期', trigger: 'change' },
    {
      validator: (_rule, value: string, callback: (error?: Error) => void) => {
        const start = parseDate(form.startDate)
        const end = parseDate(value)
        if (Number.isFinite(start) && Number.isFinite(end) && end <= start) {
          callback(new Error('计划出窖日期需晚于入窖日期'))
        } else {
          callback()
        }
      },
      trigger: 'change'
    }
  ],
  temperatureC: [
    { required: true, message: '请填写窖藏温度', trigger: 'blur' },
    {
      validator: (_rule, value: number, callback: (error?: Error) => void) => {
        if (!Number.isFinite(value) || value < -10 || value > 50) callback(new Error('温度需在 -10 ~ 50 ℃，超出将拒绝入窖'))
        else callback()
      },
      trigger: 'blur'
    }
  ],
  humidityPct: [
    { required: true, message: '请填写窖藏湿度', trigger: 'blur' },
    {
      validator: (_rule, value: number, callback: (error?: Error) => void) => {
        if (!Number.isFinite(value) || value < 0 || value > 100) callback(new Error('湿度需在 0 ~ 100 %，超出将拒绝入窖'))
        else callback()
      },
      trigger: 'blur'
    }
  ]
}

/** 入窖表单所选批次对应的香方，用于校验该方配比是否已平衡 */
const watchedFormulaId = computed(() => {
  const batch = batchTable.rows.value.find((item) => item.id === form.batchId)
  return batch?.formulaId ?? null
})
const {
  checkLevel: ratioLevel,
  checkMessage: ratioMessage,
  total: ratioTotal,
  rows: ratioRows
} = useProportion({ formulaId: watchedFormulaId })

const filterModel = computed<FilterModel>(() => ({
  keyword: cellarStore.filter.keyword,
  state: cellarStore.filter.states,
  container: cellarStore.filter.containers
}))

const filterSelects = computed(() => [
  { key: 'state', label: '状态', options: CELLAR_STATES.map((item) => ({ label: item, value: item })) },
  { key: 'container', label: '容器', options: CELLAR_CONTAINERS.map((item) => ({ label: item, value: item })) }
])

function pushQuery(): void {
  const query: Record<string, string> = {}
  const { keyword, states, containers } = cellarStore.filter
  if (keyword.trim()) query.kw = keyword.trim()
  if (states.length) query.state = states.join(',')
  if (containers.length) query.container = containers.join(',')
  if (cellarStore.sortMode === 'start') query.sort = 'start'
  void router.replace({ query })
}

function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item))
  if (typeof value === 'string' && value.length > 0) return value.split(',').filter((item) => item.length > 0)
  return []
}

function readQuery(): void {
  const query = route.query
  cellarStore.patchFilter({
    keyword: typeof query.kw === 'string' ? query.kw : '',
    states: toArray(query.state).filter((item): item is CellarState => (CELLAR_STATES as string[]).includes(item)),
    containers: toArray(query.container).filter((item): item is CellarContainer =>
      (CELLAR_CONTAINERS as string[]).includes(item)
    )
  })
  if (query.sort === 'start' || query.sort === 'remain') cellarStore.setSortMode(query.sort)
}

if (Object.keys(route.query).length > 0) readQuery()

watch(
  () => route.query,
  (query) => {
    if (Object.keys(query).length === 0 && cellarStore.hasFilter) {
      cellarStore.resetFilter()
      return
    }
    readQuery()
  }
)

/** 未入窖的批次；正在编辑的草稿对应批次始终放行（含其已有草稿的批次） */
const availableBatches = computed(() =>
  batchTable.rows.value.filter((batch) => {
    const draft = dialogDraftId.value ? draftStore.drafts.find((item) => item.id === dialogDraftId.value) : null
    if (draft && draft.batchId === batch.id) return true
    if (cellarStore.cellarsOfBatch(batch.id).some((cellar) => !cellar.conflictOf)) return false
    // 该批次已有待提交的新建草稿时，不允许重复登记
    const hasPendingCreate = draftStore.drafts.some(
      (item) => item.kind === 'create' && item.batchId === batch.id && item.id !== dialogDraftId.value
    )
    return !hasPendingCreate
  })
)

const batchOptions = computed(() =>
  availableBatches.value.map((batch) => {
    const formula = formulaStore.formulaById(batch.formulaId)
    return {
      label: `${formula?.name ?? '香方已删除'} · ${batch.mixedAt} · ${batch.formingMethod} · ${batch.quantity} 支`,
      value: batch.id
    }
  })
)

/** 香方 id → 配比味数，用于批次卡片回显 */
const proportionCountMap = computed<Record<string, number>>(() => {
  const map: Record<string, number> = {}
  proportionTable.rows.value.forEach((proportion) => {
    map[proportion.formulaId] = (map[proportion.formulaId] ?? 0) + 1
  })
  return map
})

function batchFormulaMaterialCount(batchId: string): number {
  const batch = batchTable.rows.value.find((item) => item.id === batchId)
  if (!batch) return 0
  return proportionCountMap.value[batch.formulaId] ?? batch.snapshot.length
}

const rows = computed<CellarRow[]>(() => cellarStore.filteredRows)

/** 对话框当前内容提交后的容器余量（编辑时排除自身占位） */
const dialogUsage = computed(() => {
  const draft = dialogDraftId.value
    ? draftStore.drafts.find((item) => item.id === dialogDraftId.value)
    : null
  const excludeId = draft?.kind === 'update' ? draft.cellarId : null
  return cellarStore.previewUsage(form.container, excludeId, form.state === '窖藏中')
})

const tempAdviseWarn = computed(() => form.temperatureC < 18 || form.temperatureC > 26)
const humAdviseWarn = computed(() => form.humidityPct < 50 || form.humidityPct > 70)

function urgencyTone(urgency: CellarUrgency): 'success' | 'warning' | 'danger' | 'info' {
  if (urgency === 'overdue') return 'danger'
  if (urgency === 'near') return 'warning'
  if (urgency === 'done') return 'success'
  return 'info'
}

function urgencyLabel(row: CellarRow): string {
  if (row.cellar.state === '已出窖') return '已出窖'
  if (row.remainDays < 0) return `已逾期 ${Math.abs(row.remainDays)} 天`
  if (row.remainDays <= CELLAR_NEAR_DAYS) return `剩 ${row.remainDays} 天出窖`
  return `剩 ${row.remainDays} 天`
}

function handleFilterChange(value: FilterModel): void {
  const next: Partial<CellarFilterState> = {
    keyword: value.keyword,
    states: Array.isArray(value.state) ? (value.state as CellarState[]) : [],
    containers: Array.isArray(value.container) ? (value.container as CellarContainer[]) : []
  }
  cellarStore.patchFilter(next)
  pushQuery()
}

function handleReset(): void {
  cellarStore.resetFilter()
  pushQuery()
}

function changeSort(mode: 'remain' | 'start'): void {
  cellarStore.setSortMode(mode)
  pushQuery()
  ElMessage.success(mode === 'remain' ? '已按临近出窖排序' : '已按入窖日期排序')
}

function fillForm(draft: CellarDraft): void {
  form.batchId = draft.batchId
  form.startDate = draft.startDate
  form.endDate = draft.endDate
  form.temperatureC = draft.temperatureC
  form.humidityPct = draft.humidityPct
  form.container = draft.container
  form.state = draft.state
}

function openCreate(): void {
  dialogDraftId.value = null
  const first = availableBatches.value[0]
  form.batchId = first?.id ?? ''
  form.startDate = new Date().toISOString().slice(0, 10)
  form.endDate = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  form.temperatureC = 22
  form.humidityPct = 60
  form.container = '陶罐'
  form.state = '窖藏中'
  dialogVisible.value = true
}

function openEdit(cellar: Cellar): void {
  if (cellar.conflictOf) {
    ElMessage.info('这是冲突保留的另一版本，请用「采用此版 / 放弃此版」处理')
    return
  }
  const draft = draftStore.saveUpdateDraft(cellar, {
    batchId: cellar.batchId,
    startDate: cellar.startDate,
    endDate: cellar.endDate,
    temperatureC: cellar.temperatureC,
    humidityPct: cellar.humidityPct,
    container: cellar.container,
    state: cellar.state
  })
  dialogDraftId.value = draft.id
  fillForm(draft)
  dialogVisible.value = true
}

/** 从草稿面板继续编辑：直接回填已有草稿 */
function openDraft(draft: CellarDraft): void {
  dialogDraftId.value = draft.id
  fillForm(draft)
  dialogVisible.value = true
}

/** 把对话框当前内容写回草稿（新建或编辑） */
function syncFormToDraft(): CellarDraft {
  const existing = dialogDraftId.value ? draftStore.drafts.find((item) => item.id === dialogDraftId.value) : null
  if (existing) {
    draftStore.patchDraft(existing.id, {
      batchId: form.batchId,
      startDate: form.startDate,
      endDate: form.endDate,
      temperatureC: round(form.temperatureC, 1),
      humidityPct: round(form.humidityPct, 1),
      container: form.container,
      state: form.state
    })
    return draftStore.drafts.find((item) => item.id === existing.id) as CellarDraft
  }
  const draft = draftStore.saveCreateDraft({
    batchId: form.batchId,
    startDate: form.startDate,
    endDate: form.endDate,
    temperatureC: form.temperatureC,
    humidityPct: form.humidityPct,
    container: form.container,
    state: form.state
  })
  dialogDraftId.value = draft.id
  return draft
}

function outcomeMessage(outcome: CellarCommitOutcome): void {
  outcome.notes.forEach((note) => ElMessage.warning(note))
  outcome.warnings.forEach((warning) => ElMessage.warning(warning))
  switch (outcome.type) {
    case 'created':
      ElMessage.success('已登记窖藏批次，临近出窖会自动提醒')
      break
    case 'fast-forward':
      ElMessage.success('窖藏记录已保存')
      break
    case 'merged':
      ElMessage.success('离线修改已按批次逐条合并，无冲突')
      break
    case 'conflict':
      ElMessage.warning('与另一标签页的修改存在冲突，两版均已保留，请在列表中核对')
      break
    case 'overwritten':
      ElMessage.success('本地版本较新，已覆盖旧版本')
      break
    case 'restored':
      ElMessage.warning('原记录此前被删除，已按草稿恢复')
      break
    case 'duplicate':
      ElMessage.warning('该批次已被其他标签页登记入窖，本次内容保留为并行版本')
      break
  }
}

/** 提交草稿；任何失败（容量不足、边界越界、写库异常）都保留草稿并可重试 */
async function commitWithDraft(draft: CellarDraft): Promise<boolean> {
  submitting.value = true
  try {
    const outcome = await cellarStore.commitDraft(draft)
    outcomeMessage(outcome)
    draftStore.removeDraft(draft.id)
    return true
  } catch (err) {
    const reason =
      err instanceof CellarCapacityError
        ? err.message
        : err instanceof CellarBoundaryError
          ? err.message
          : err instanceof Error
            ? err.message
            : '提交失败'
    draftStore.markFailed(draft.id, reason)
    ElMessage.error(
      err instanceof CellarCapacityError
        ? `容器余量不足，已拒绝入窖：${err.message}（草稿已保留，可调整后重试）`
        : err instanceof CellarBoundaryError
          ? `读数越界，已拒绝提交：${err.message}（草稿已保留，可调整后重试）`
          : `提交失败，草稿已保留可重试：${reason}`
    )
    return false
  } finally {
    submitting.value = false
  }
}

async function submitForm(): Promise<void> {
  if (!formRef.value) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  if (dialogUsage.value.used > dialogUsage.value.capacity) {
    const draft = syncFormToDraft()
    draftStore.markFailed(
      draft.id,
      `「${form.container}」容量 ${dialogUsage.value.capacity} 位，已占 ${dialogUsage.value.used} 位`
    )
    ElMessage.error(
      `「${form.container}」在窖容量不足（${dialogUsage.value.used}/${dialogUsage.value.capacity}），已拒绝入窖，草稿已保留`
    )
    return
  }
  const draft = syncFormToDraft()
  const ok = await commitWithDraft(draft)
  if (ok) {
    dialogVisible.value = false
    dialogDraftId.value = null
  }
}

async function retryDraft(draft: CellarDraft): Promise<void> {
  await commitWithDraft(draft)
}

async function discardDraft(draftId: string): Promise<void> {
  const confirmed = await ElMessageBox.confirm('丢弃这条离线草稿？丢弃后无法恢复。', '丢弃草稿', {
    type: 'warning',
    confirmButtonText: '丢弃',
    cancelButtonText: '取消'
  }).catch(() => false)
  if (!confirmed) return
  draftStore.removeDraft(draftId)
  if (dialogDraftId.value === draftId) {
    dialogDraftId.value = null
    dialogVisible.value = false
  }
  ElMessage.success('草稿已丢弃')
}

async function advanceState(row: CellarRow): Promise<void> {
  try {
    const next = await cellarStore.advanceState(row.cellar.id)
    if (next) ElMessage.success(`「${row.formulaName}」已流转为「${next}」`)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '状态流转失败')
  }
}

async function setState(row: CellarRow, state: CellarState): Promise<void> {
  if (row.cellar.state === state) return
  try {
    await cellarStore.setState(row.cellar.id, state)
    ElMessage.success(`已置为「${state}」`)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '状态更新失败')
  }
}

async function updateReading(row: CellarRow, field: 'temperatureC' | 'humidityPct', value: number): Promise<void> {
  const next = round(value, 1)
  if (next === row.cellar[field]) return
  try {
    const outcome = await cellarStore.commitReading(row.cellar.id, field, next)
    outcome.warnings.forEach((warning) => ElMessage.warning(warning))
    const outOfRange = field === 'temperatureC' ? next < 18 || next > 26 : next < 50 || next > 70
    ElMessage({
      type: outOfRange ? 'warning' : 'success',
      message:
        field === 'temperatureC'
          ? `温度已记录 ${next} ℃（rev.${outcome.cellar.revision}）${outOfRange ? '（超出 18~26 ℃ 建议区间）' : ''}`
          : `湿度已记录 ${next}%（rev.${outcome.cellar.revision}）${outOfRange ? '（超出 50~70% 建议区间）' : ''}`
    })
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '读数提交失败')
  }
}

async function removeCellar(row: CellarRow): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    `删除「${row.formulaName}」的这条窖藏记录？批次本身与品香记录会保留。`,
    '删除确认',
    { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
  ).catch(() => false)
  if (!confirmed) return
  await cellarStore.removeCellar(row.cellar.id)
  ElMessage.success('窖藏记录已删除')
}

async function resolveConflict(row: CellarRow, adopt: boolean): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    adopt
      ? `采用这一版本（${row.cellar.startDate} → ${row.cellar.endDate} · ${row.cellar.container} · ${row.cellar.temperatureC}℃/${row.cellar.humidityPct}%）覆盖主记录？另一版将被删除。`
      : '放弃这一版本，保留主记录？',
    '冲突留版处理',
    { type: 'warning', confirmButtonText: adopt ? '采用此版' : '放弃此版', cancelButtonText: '取消' }
  ).catch(() => false)
  if (!confirmed) return
  await cellarStore.resolveConflict(row.cellar.id, adopt)
  ElMessage.success(adopt ? '已采用该版本并删除另一版' : '已放弃该版本')
}

async function releaseOverdue(): Promise<void> {
  try {
    const count = await cellarStore.releaseOverdue()
    if (count === 0) {
      ElMessage.info('当前没有逾期的在窖批次')
      return
    }
    ElMessage.success(`已将 ${count} 个逾期批次置为「已出窖」`)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '批量处理失败')
  }
}

async function goTasting(row: CellarRow): Promise<void> {
  await db.batches.update(row.cellar.batchId, { updatedAt: Date.now() })
  void router.push({ path: '/tastings', query: { batch: row.cellar.batchId } })
}

const formingText = (batchId: string): FormingMethod | '—' =>
  batchTable.rows.value.find((batch) => batch.id === batchId)?.formingMethod ?? '—'

function rowClassName({ row }: { row: CellarRow }): string {
  return row.isConflict ? 'conflict-row' : ''
}
</script>

<template>
  <div>
    <div class="page-title">
      <div>
        <h2>窖藏批次与环境</h2>
        <p>
          共 {{ cellarStore.cellars.length }} 条窖藏记录 · 在窖 {{ cellarStore.agingCount }} 个 · 待提醒
          {{ cellarStore.alerts.length }} 个 · 均温 {{ cellarStore.averageTemperature }} ℃ / 均湿
          {{ cellarStore.averageHumidity }}%
        </p>
      </div>
      <div class="page-title__actions">
        <el-button :icon="Sort" @click="changeSort(cellarStore.sortMode === 'remain' ? 'start' : 'remain')">
          切换为{{ cellarStore.sortMode === 'remain' ? '按入窖日期' : '按临近出窖' }}排序
        </el-button>
        <el-button :icon="Bell" @click="releaseOverdue">批量处理逾期</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">登记窖藏</el-button>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="窖藏记录" :value="cellarStore.cellars.length" suffix="条" icon="Coin" tone="primary" />
      <StatBadge label="在窖" :value="cellarStore.agingCount" suffix="个" icon="Histogram" tone="warning" />
      <StatBadge label="已出窖" :value="cellarStore.doneCount" suffix="个" icon="Files" tone="success" />
      <StatBadge
        label="临近出窖"
        :value="cellarStore.alerts.length"
        suffix="个"
        icon="WarningFilled"
        tone="danger"
        :hint="`剩余天数 ≤ ${CELLAR_NEAR_DAYS} 天或已逾期`"
      />
      <StatBadge label="在窖均温" :value="cellarStore.averageTemperature" suffix="℃" icon="TrendCharts" tone="info" />
      <StatBadge label="在窖均湿" :value="cellarStore.averageHumidity" suffix="%" icon="PieChart" tone="info" />
    </div>

    <DraftPanel
      :drafts="draftStore.drafts"
      :batch-label="cellarStore.batchLabel"
      @retry="retryDraft"
      @edit="openDraft"
      @discard="discardDraft"
    />

    <el-alert
      v-if="cellarStore.alerts.length > 0"
      class="cellar-alert"
      type="warning"
      show-icon
      :closable="false"
      :title="`临近出窖提醒：${cellarStore.alerts.length} 个批次需要关注`"
    >
      <template #default>
        <ul class="alert-list">
          <li v-for="row in cellarStore.alerts.slice(0, 5)" :key="row.cellar.id">
            {{ row.formulaName }} · 计划 {{ row.cellar.endDate }} · {{ urgencyLabel(row) }}
          </li>
        </ul>
      </template>
    </el-alert>

    <el-alert
      v-if="cellarStore.conflictCount > 0"
      class="cellar-alert"
      type="error"
      show-icon
      :closable="false"
      :title="`多标签页合并冲突 ${cellarStore.conflictCount} 条：两版均已保留，请逐个人工核对`"
    />

    <el-alert
      v-if="cellarStore.environmentWarning.length > 0"
      class="cellar-alert"
      type="error"
      show-icon
      :closable="false"
      :title="`环境超限 ${cellarStore.environmentWarning.length} 条（建议 18~26 ℃ / 50~70%）`"
    />

    <FilterBar
      :model-value="filterModel"
      :selects="filterSelects"
      keyword-placeholder="按香方名 / 容器 / 状态搜索"
      @change="handleFilterChange"
      @reset="handleReset"
    />

    <div class="section-card cellar-table">
      <div v-if="rows.length === 0" class="cellar-empty">
        <EmptyPanel
          title="暂无窖藏记录"
          :description="
            cellarStore.cellars.length === 0
              ? '和香成型后即可入窖：登记起止日期、温湿度与容器，系统会按天数提醒临近出窖。'
              : '当前筛选条件下没有匹配的窖藏记录，可重置条件或登记新记录。'
          "
          action-text="登记窖藏"
          @action="openCreate"
        />
      </div>

      <el-table v-else :data="rows" row-key="cellar.id" stripe :row-class-name="rowClassName">
        <el-table-column label="批次 / 香方" min-width="210">
          <template #default="{ row }: { row: CellarRow }">
            <div class="cell-main">
              {{ row.formulaName }}
              <el-tag v-if="row.isConflict" size="small" type="danger" effect="dark" round class="conflict-tag">
                冲突留版
              </el-tag>
            </div>
            <div class="cell-sub muted">
              {{ formingText(row.cellar.batchId) }} · {{ row.quantity }} 支 · 配比
              {{ batchFormulaMaterialCount(row.cellar.batchId) }} 味
            </div>
            <div v-if="row.isConflict" class="cell-sub conflict-note">
              {{ row.conflictNote || '与另一标签页的修改不一致' }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="窖藏天数" width="150">
          <template #default="{ row }: { row: CellarRow }">
            <div class="cell-sub">已窖 {{ row.agedDays }} 天</div>
            <div class="cell-sub" :class="row.urgency === 'overdue' ? 'ratio-error' : row.urgency === 'near' ? 'ratio-warn' : 'muted'">
              {{ urgencyLabel(row) }}
            </div>
            <div class="cell-sub muted">rev.{{ row.cellar.revision }}</div>
          </template>
        </el-table-column>
        <el-table-column label="起止日期" width="200">
          <template #default="{ row }: { row: CellarRow }">
            <div class="cell-sub mono">{{ row.cellar.startDate }} → {{ row.cellar.endDate }}</div>
          </template>
        </el-table-column>
        <el-table-column label="温度 ℃" width="130">
          <template #default="{ row }: { row: CellarRow }">
            <el-input-number
              :model-value="row.cellar.temperatureC"
              :min="-10"
              :max="50"
              :step="0.5"
              :precision="1"
              size="small"
              controls-position="right"
              :disabled="row.isConflict"
              style="width: 108px"
              @change="(value: number | undefined) => updateReading(row, 'temperatureC', value ?? 0)"
            />
          </template>
        </el-table-column>
        <el-table-column label="湿度 %" width="130">
          <template #default="{ row }: { row: CellarRow }">
            <el-input-number
              :model-value="row.cellar.humidityPct"
              :min="0"
              :max="100"
              :step="1"
              :precision="1"
              size="small"
              controls-position="right"
              :disabled="row.isConflict"
              style="width: 108px"
              @change="(value: number | undefined) => updateReading(row, 'humidityPct', value ?? 0)"
            />
          </template>
        </el-table-column>
        <el-table-column label="容器 / 状态" width="190">
          <template #default="{ row }: { row: CellarRow }">
            <GradeTag plain size="small" :label="row.cellar.container" />
            <el-tag class="state-tag" :type="urgencyTone(row.urgency)" effect="plain" round>
              {{ row.cellar.state }}
            </el-tag>
            <div v-if="!row.isConflict" class="cell-sub muted">
              {{ cellarStore.containerUsage[row.cellar.container].used }}/{{
                cellarStore.containerUsage[row.cellar.container].capacity
              }}
              位
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="300" fixed="right">
          <template #default="{ row }: { row: CellarRow }">
            <template v-if="row.isConflict">
              <el-button size="small" type="primary" plain @click="resolveConflict(row, true)">采用此版</el-button>
              <el-button size="small" type="danger" plain @click="resolveConflict(row, false)">放弃此版</el-button>
            </template>
            <template v-else>
              <el-button size="small" type="warning" plain @click="advanceState(row)">
                {{ row.cellar.state === '窖藏中' ? '出窖' : '回退为在窖' }}
              </el-button>
              <el-dropdown trigger="click" @command="(command: string) => setState(row, command as CellarState)">
                <el-button size="small">状态</el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item v-for="state in CELLAR_STATES" :key="state" :command="state">
                      {{ state }}
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
              <el-button size="small" text @click="goTasting(row)">去品香</el-button>
              <el-button size="small" text type="primary" :icon="Edit" @click="openEdit(row.cellar)">编辑</el-button>
              <el-button size="small" text type="danger" :icon="Delete" @click="removeCellar(row)">删除</el-button>
            </template>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog v-model="dialogVisible" :title="dialogDraftId ? '编辑窖藏记录' : '登记窖藏批次'" width="580px" append-to-body>
      <el-form ref="formRef" :model="form" :rules="rules" label-width="112px">
        <el-form-item label="和香批次" prop="batchId">
          <el-select v-model="form.batchId" filterable placeholder="选择未入窖的批次" style="width: 100%">
            <el-option v-for="item in batchOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="入窖日期" prop="startDate">
          <el-date-picker
            v-model="form.startDate"
            type="date"
            value-format="YYYY-MM-DD"
            style="width: 100%"
            placeholder="选择入窖日期"
          />
        </el-form-item>
        <el-form-item label="计划出窖" prop="endDate">
          <el-date-picker
            v-model="form.endDate"
            type="date"
            value-format="YYYY-MM-DD"
            style="width: 100%"
            placeholder="选择计划出窖日期"
          />
        </el-form-item>
        <el-form-item label="温度 ℃" prop="temperatureC">
          <el-input-number v-model="form.temperatureC" :min="-10" :max="50" :step="0.5" :precision="1" style="width: 180px" />
          <span class="form-hint" :class="tempAdviseWarn ? 'ratio-warn' : 'muted'">
            建议 18 ~ 26 ℃{{ tempAdviseWarn ? '（超出仅告警，不阻断）' : '' }}
          </span>
        </el-form-item>
        <el-form-item label="湿度 %" prop="humidityPct">
          <el-input-number v-model="form.humidityPct" :min="0" :max="100" :step="1" :precision="1" style="width: 180px" />
          <span class="form-hint" :class="humAdviseWarn ? 'ratio-warn' : 'muted'">
            建议 50 ~ 70 %{{ humAdviseWarn ? '（超出仅告警，不阻断）' : '' }}
          </span>
        </el-form-item>
        <el-form-item label="容器" prop="container">
          <el-radio-group v-model="form.container">
            <el-radio v-for="item in CELLAR_CONTAINERS" :key="item" :value="item">{{ item }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="容器余量">
          <el-tag :type="dialogUsage.full ? 'danger' : dialogUsage.remain <= 3 ? 'warning' : 'success'" effect="plain">
            {{ form.container }}：{{ dialogUsage.used }} / {{ dialogUsage.capacity }} 位
            （剩 {{ dialogUsage.remain }} 位）
          </el-tag>
          <span v-if="dialogUsage.full" class="form-hint ratio-error">
            容量不足，若提交将拒绝入窖并保留草稿
          </span>
        </el-form-item>
        <el-form-item label="状态" prop="state">
          <el-select v-model="form.state" style="width: 100%">
            <el-option v-for="item in CELLAR_STATES" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
        <el-alert
          v-if="watchedFormulaId"
          class="ratio-alert"
          :type="ratioLevel === 'ok' ? 'success' : ratioLevel === 'warn' ? 'warning' : 'error'"
          :closable="false"
          show-icon
          :title="`该批次所属香方配比合计：${ratioTotal}%（${ratioRows.length} 味）`"
          :description="ratioMessage"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ dialogDraftId ? '保存修改' : '登记入窖' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.cellar-alert {
  margin-bottom: 12px;
}

.alert-list {
  margin: 4px 0 0;
  padding-left: 18px;
  font-size: 12px;
}

.cellar-table {
  margin-top: 16px;
}

.cellar-empty {
  padding: 8px 0;
}

.cell-main {
  font-weight: 600;
}

.cell-sub {
  font-size: 12px;
  line-height: 1.6;
}

.state-tag {
  margin-left: 6px;
}

.conflict-tag {
  margin-left: 8px;
}

.conflict-note {
  color: var(--el-color-danger);
}

.form-hint {
  margin-left: 10px;
  font-size: 12px;
}

.ratio-alert {
  margin-bottom: 12px;
}

:deep(.conflict-row) {
  background-color: var(--el-color-danger-light-9);
}
</style>
