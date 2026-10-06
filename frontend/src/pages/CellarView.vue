<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Bell, Delete, Edit, Plus, Sort } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar, { type FilterModel } from '@/components/common/FilterBar.vue'
import GradeTag from '@/components/common/GradeTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useCellarStore, parseDate } from '@/stores/cellarStore'
import { useFormulaStore } from '@/stores/formulaStore'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useProportion } from '@/hooks/useProportion'
import { db } from '@/utils/db'
import { round } from '@/utils/ratio'
import {
  CELLAR_CONTAINERS,
  CELLAR_NEAR_DAYS,
  CELLAR_STATES,
  HUMIDITY_HARD_MAX,
  HUMIDITY_HARD_MIN,
  TEMP_HARD_MAX,
  TEMP_HARD_MIN,
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
const formulaStore = useFormulaStore()
const batchTable = useIdbTable<Batch>((database) => database.batches, { sortByUpdatedAt: false })
const proportionTable = useIdbTable<Proportion>((database) => database.proportions, { sortByUpdatedAt: false })

const dialogVisible = ref(false)
const submitting = ref(false)
const editingId = ref<string | null>(null)
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
        if (!Number.isFinite(value) || value < -10 || value > 50) callback(new Error('温度建议在 -10 ~ 50 ℃'))
        else callback()
      },
      trigger: 'blur'
    }
  ],
  humidityPct: [
    { required: true, message: '请填写窖藏湿度', trigger: 'blur' },
    {
      validator: (_rule, value: number, callback: (error?: Error) => void) => {
        if (!Number.isFinite(value) || value < 0 || value > 100) callback(new Error('湿度应在 0 ~ 100 %'))
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

/** 所选容器的窖容余量：提交前核对，容量不足直接拒绝入窖（编辑时排除自身占用） */
const selectedBatchQuantity = computed(
  () => batchTable.rows.value.find((batch) => batch.id === form.batchId)?.quantity ?? 0
)
const capacityPreview = computed(() => {
  const stat = cellarStore.containerCapacityOf(form.container)
  const self = editingId.value ? cellarStore.cellarById(editingId.value) : null
  if (self && self.state === '窖藏中' && self.container === form.container) {
    const selfQty = batchTable.rows.value.find((batch) => batch.id === self.batchId)?.quantity ?? 0
    return { ...stat, used: Math.max(0, stat.used - selfQty), remain: stat.remain + selfQty }
  }
  return stat
})
const capacityShort = computed(
  () => form.state === '窖藏中' && capacityPreview.value.remain < selectedBatchQuantity.value
)

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

/** 未入窖的批次，供新建窖藏时选择（冲突分叉不计入占用） */
const availableBatches = computed(() =>
  batchTable.rows.value.filter((batch) => {
    if (editingId.value && batch.id === cellarStore.cellarById(editingId.value)?.batchId) return true
    return cellarStore.cellarsOfBatch(batch.id).length === 0
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

function openCreate(): void {
  editingId.value = null
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
  editingId.value = cellar.id
  form.batchId = cellar.batchId
  form.startDate = cellar.startDate
  form.endDate = cellar.endDate
  form.temperatureC = cellar.temperatureC
  form.humidityPct = cellar.humidityPct
  form.container = cellar.container
  form.state = cellar.state
  dialogVisible.value = true
}

/** 冲突留版只允许查看，不能再就地覆盖主版本 */
const viewingFork = computed(() => {
  const cellar = editingId.value ? cellarStore.cellarById(editingId.value) : null
  return Boolean(cellar?.forkOf)
})

async function submitForm(): Promise<void> {
  if (!formRef.value) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  // 提交前核对容器余量与温湿度边界：容量不足 / 越界直接拒绝入窖
  const editing = editingId.value ? cellarStore.cellarById(editingId.value) : null
  const preflight = cellarStore.preflightSubmission({
    cellarId: editingId.value ?? 'cellar_pending',
    batchId: form.batchId,
    container: form.container,
    state: form.state,
    temperatureC: form.temperatureC,
    humidityPct: form.humidityPct
  })
  if (preflight) {
    ElMessage.error(preflight)
    return
  }
  submitting.value = true
  try {
    if (editing) {
      const result = await cellarStore.updateCellar(editing.id, {
        batchId: form.batchId,
        startDate: form.startDate,
        endDate: form.endDate,
        temperatureC: form.temperatureC,
        humidityPct: form.humidityPct,
        container: form.container,
        state: form.state
      })
      // 离线合并被拒绝：草稿保留，到「离线草稿」面板重试
      if (result.status === 'failed') {
        ElMessage.warning(result.error ?? '改动已存为离线草稿，可在草稿面板重试')
      } else {
        ElMessage.success('窖藏环境记录已更新')
        dialogVisible.value = false
      }
    } else {
      const result = await cellarStore.createCellar({
        batchId: form.batchId,
        startDate: form.startDate,
        endDate: form.endDate,
        temperatureC: form.temperatureC,
        humidityPct: form.humidityPct,
        container: form.container,
        state: form.state
      })
      if (result.status === 'failed') {
        ElMessage.warning(result.error ?? '入窖已存为离线草稿，可在草稿面板重试')
      } else {
        ElMessage.success('已登记窖藏批次，临近出窖会自动提醒')
        dialogVisible.value = false
      }
    }
  } catch (err) {
    // 预检拦截：不产生草稿；其它失败时草稿仍在队列里，可重试
    ElMessage.error(err instanceof Error ? err.message : '提交失败，草稿已保留，可稍后重试')
  } finally {
    submitting.value = false
  }
}

async function advanceState(row: CellarRow): Promise<void> {
  const next = await cellarStore.advanceState(row.cellar.id)
  if (next) ElMessage.success(`「${row.formulaName}」已流转为「${next}」`)
}

async function setState(row: CellarRow, state: CellarState): Promise<void> {
  if (row.cellar.state === state) return
  await cellarStore.setState(row.cellar.id, state)
  ElMessage.success(`已置为「${state}」`)
}

async function updateReading(row: CellarRow, field: 'temperatureC' | 'humidityPct', value: number): Promise<void> {
  const next = round(value, 1)
  if (next === row.cellar[field]) return
  // 有效读数改动走离线草稿队列；越界 / 容量不足时草稿保留并提示重试
  let result: { status: 'applied' | 'failed'; error: string | null }
  try {
    result = await cellarStore.updateCellar(row.cellar.id, { [field]: next } as Partial<Cellar>)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '读数提交失败，草稿已保留')
    return
  }
  if (result.status === 'failed') {
    ElMessage.warning(`${result.error ?? '读数已存为离线草稿'}（可在草稿面板重试）`)
    return
  }
  const outOfRange = field === 'temperatureC' ? next < 18 || next > 26 : next < 50 || next > 70
  ElMessage({
    type: outOfRange ? 'warning' : 'success',
    message:
      field === 'temperatureC'
        ? `温度已记录 ${next} ℃（修订号已自增）${outOfRange ? '（超出 18~26 ℃ 建议区间）' : ''}`
        : `湿度已记录 ${next}%（修订号已自增）${outOfRange ? '（超出 50~70% 建议区间）' : ''}`
  })
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

async function releaseOverdue(): Promise<void> {
  const count = await cellarStore.releaseOverdue()
  if (count === 0) {
    ElMessage.info('当前没有逾期的在窖批次')
    return
  }
  ElMessage.success(`已将 ${count} 个逾期批次置为「已出窖」`)
}

/** 离线草稿面板：断网回来逐条重试；失败草稿也保留在此 */
async function retryAllDrafts(): Promise<void> {
  const result = await cellarStore.retryDrafts()
  if (result.applied > 0) ElMessage.success(`已合并 ${result.applied} 条离线草稿`)
  if (result.failed > 0) ElMessage.warning(`${result.failed} 条草稿仍被拒绝（容量不足 / 越界），草稿已保留`)
  if (result.applied === 0 && result.failed === 0) ElMessage.info('没有待提交的草稿')
}

async function retryDraft(id: string): Promise<void> {
  const result = await cellarStore.retryDrafts([id])
  if (result.applied > 0) ElMessage.success('草稿已合并')
  else ElMessage.warning('草稿仍被拒绝，已保留可再次重试')
}

async function discardDraft(id: string): Promise<void> {
  const confirmed = await ElMessageBox.confirm('放弃这条离线草稿？对应的入窖 / 读数改动会丢弃。', '放弃草稿', {
    type: 'warning',
    confirmButtonText: '放弃',
    cancelButtonText: '取消'
  }).catch(() => false)
  if (!confirmed) return
  await cellarStore.discardDraft(id)
  ElMessage.success('草稿已放弃')
}

function draftActionLabel(action: string): string {
  return action === 'create' ? '入窖登记' : '窖藏修改'
}

function healthTone(health: CellarRow['health']): 'success' | 'warning' | 'danger' | 'info' {
  if (health === 'done') return 'success'
  if (health === 'bad') return 'danger'
  if (health === 'warn') return 'warning'
  return 'info'
}

function healthLabel(health: CellarRow['health']): string {
  if (health === 'done') return '已出窖'
  if (health === 'bad') return '读数越界'
  if (health === 'warn') return '区间外'
  return '环境适宜'
}

async function goTasting(row: CellarRow): Promise<void> {
  await db.batches.update(row.cellar.batchId, { updatedAt: Date.now() })
  void router.push({ path: '/tastings', query: { batch: row.cellar.batchId } })
}

const formingText = (batchId: string): FormingMethod | '—' =>
  batchTable.rows.value.find((batch) => batch.id === batchId)?.formingMethod ?? '—'
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
          <template v-if="cellarStore.forkCount > 0"> · 冲突留版 {{ cellarStore.forkCount }} 条</template>
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
      v-if="cellarStore.environmentWarning.length > 0"
      class="cellar-alert"
      type="error"
      show-icon
      :closable="false"
      :title="`环境超限 ${cellarStore.environmentWarning.length} 条（建议 18~26 ℃ / 50~70%）`"
    />

    <el-alert
      v-if="cellarStore.hasDrafts"
      class="cellar-alert"
      :type="cellarStore.failedDrafts.length > 0 ? 'error' : 'warning'"
      show-icon
      :closable="false"
      :title="`离线草稿 ${cellarStore.drafts.length} 条（待提交 ${cellarStore.pendingDrafts.length} · 失败 ${cellarStore.failedDrafts.length}）`"
    >
      <template #default>
        <div class="draft-box">
          <div v-for="draft in cellarStore.drafts" :key="draft.id" class="draft-item">
            <el-tag :type="draft.status === 'failed' ? 'danger' : 'warning'" size="small" effect="plain">
              {{ draftActionLabel(draft.action) }}
            </el-tag>
            <span class="draft-label">{{ draft.batchLabel }}</span>
            <span class="muted">修订 r{{ draft.base?.revision ?? '新' }} → r{{ draft.next.revision }}</span>
            <span v-if="draft.lastError" class="draft-error">{{ draft.lastError }}</span>
            <el-button
              size="small"
              type="primary"
              text
              :loading="cellarStore.flushing"
              @click="retryDraft(draft.id)"
            >
              重试
            </el-button>
            <el-button size="small" type="danger" text @click="discardDraft(draft.id)">放弃</el-button>
          </div>
          <div class="draft-actions">
            <el-button size="small" type="primary" plain :loading="cellarStore.flushing" @click="retryAllDrafts">
              断网恢复后一键合并全部草稿
            </el-button>
          </div>
        </div>
      </template>
    </el-alert>

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

      <el-table v-else :data="rows" row-key="cellar.id" stripe>
        <el-table-column label="批次 / 香方" min-width="230">
          <template #default="{ row }: { row: CellarRow }">
            <div class="cell-main">
              {{ row.formulaName }}
              <el-tag v-if="row.isFork" size="small" type="danger" effect="plain" round>冲突留版</el-tag>
              <el-tag v-else-if="row.versions.length > 0" size="small" type="warning" effect="plain" round>
                {{ row.versions.length }} 版并存
              </el-tag>
            </div>
            <div class="cell-sub muted">
              {{ formingText(row.cellar.batchId) }} · {{ row.quantity }} 支 · 配比
              {{ batchFormulaMaterialCount(row.cellar.batchId) }} 味
            </div>
            <div v-if="row.isFork" class="cell-sub muted">保留自主版本：{{ row.parentLabel }}</div>
          </template>
        </el-table-column>
        <el-table-column label="窖藏天数" width="150">
          <template #default="{ row }: { row: CellarRow }">
            <div class="cell-sub">已窖 {{ row.agedDays }} 天</div>
            <div class="cell-sub" :class="row.urgency === 'overdue' ? 'ratio-error' : row.urgency === 'near' ? 'ratio-warn' : 'muted'">
              {{ urgencyLabel(row) }}
            </div>
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
              :min="TEMP_HARD_MIN"
              :max="TEMP_HARD_MAX"
              :step="0.5"
              :precision="1"
              size="small"
              controls-position="right"
              :disabled="row.isFork"
              style="width: 108px"
              @change="(value: number | undefined) => updateReading(row, 'temperatureC', value ?? 0)"
            />
          </template>
        </el-table-column>
        <el-table-column label="湿度 %" width="130">
          <template #default="{ row }: { row: CellarRow }">
            <el-input-number
              :model-value="row.cellar.humidityPct"
              :min="HUMIDITY_HARD_MIN"
              :max="HUMIDITY_HARD_MAX"
              :step="1"
              :precision="1"
              size="small"
              controls-position="right"
              :disabled="row.isFork"
              style="width: 108px"
              @change="(value: number | undefined) => updateReading(row, 'humidityPct', value ?? 0)"
            />
          </template>
        </el-table-column>
        <el-table-column label="容器 / 状态" width="200">
          <template #default="{ row }: { row: CellarRow }">
            <GradeTag plain size="small" :label="row.cellar.container" />
            <el-tag class="state-tag" :type="urgencyTone(row.urgency)" effect="plain" round>
              {{ row.cellar.state }}
            </el-tag>
            <el-tooltip
              :content="`修订号 r${row.cellar.revision} · 来源 ${row.cellar.origin}`"
              placement="top"
            >
              <el-tag class="state-tag" size="small" :type="healthTone(row.health)" effect="plain">
                {{ healthLabel(row.health) }}
              </el-tag>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="270" fixed="right">
          <template #default="{ row }: { row: CellarRow }">
            <el-button
              v-if="!row.isFork"
              size="small"
              type="warning"
              plain
              @click="advanceState(row)"
            >
              {{ row.cellar.state === '窖藏中' ? '出窖' : '回退为在窖' }}
            </el-button>
            <el-dropdown
              v-if="!row.isFork"
              trigger="click"
              @command="(command: string) => setState(row, command as CellarState)"
            >
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
            <el-button size="small" text type="primary" :icon="Edit" @click="openEdit(row.cellar)">
              {{ row.isFork ? '查看' : '编辑' }}
            </el-button>
            <el-button size="small" text type="danger" :icon="Delete" @click="removeCellar(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog
      v-model="dialogVisible"
      :title="viewingFork ? '查看冲突留版' : editingId ? '编辑窖藏记录' : '登记窖藏批次'"
      width="580px"
      append-to-body
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="112px" :disabled="viewingFork">
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
          <el-input-number
            v-model="form.temperatureC"
            :min="TEMP_HARD_MIN"
            :max="TEMP_HARD_MAX"
            :step="0.5"
            :precision="1"
            style="width: 180px"
          />
          <span class="muted form-hint">建议 18 ~ 26 ℃（硬边界 -10 ~ 50 ℃）</span>
        </el-form-item>
        <el-form-item label="湿度 %" prop="humidityPct">
          <el-input-number
            v-model="form.humidityPct"
            :min="HUMIDITY_HARD_MIN"
            :max="HUMIDITY_HARD_MAX"
            :step="1"
            :precision="1"
            style="width: 180px"
          />
          <span class="muted form-hint">建议 50 ~ 70 %（硬边界 0 ~ 100 %）</span>
        </el-form-item>
        <el-form-item label="容器" prop="container">
          <el-radio-group v-model="form.container">
            <el-radio v-for="item in CELLAR_CONTAINERS" :key="item" :value="item">{{ item }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="状态" prop="state">
          <el-select v-model="form.state" style="width: 100%">
            <el-option v-for="item in CELLAR_STATES" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
        <el-alert
          v-if="form.batchId"
          class="ratio-alert"
          :type="capacityShort ? 'error' : 'success'"
          :closable="false"
          show-icon
          :title="
            `${form.container}窖容：已占 ${capacityPreview.used} / ${capacityPreview.limit}，余 ${capacityPreview.remain}；本批 ${selectedBatchQuantity} 支`
          "
          :description="capacityShort ? '容器余量不足，本次提交会被拒绝入窖：请更换容器或先出窖腾出空间。' : '余量充足，可以入窖。'"
        />
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
        <el-button @click="dialogVisible = false">{{ viewingFork ? '关闭' : '取消' }}</el-button>
        <el-button
          v-if="!viewingFork"
          type="primary"
          :loading="submitting"
          :disabled="capacityShort"
          @click="submitForm"
        >
          {{ editingId ? '保存修改（离线合并）' : '登记入窖' }}
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

.form-hint {
  margin-left: 10px;
  font-size: 12px;
}

.ratio-alert {
  margin-bottom: 12px;
}

.draft-box {
  margin-top: 4px;
}

.draft-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  line-height: 1.8;
  flex-wrap: wrap;
}

.draft-label {
  font-weight: 600;
}

.draft-error {
  color: var(--el-color-danger);
}

.draft-actions {
  margin-top: 4px;
}
</style>
