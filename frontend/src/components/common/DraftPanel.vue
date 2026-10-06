<script setup lang="ts">
import { computed } from 'vue'
import { Delete, RefreshLeft, EditPen } from '@element-plus/icons-vue'
import { CELLAR_CONTAINER_CAPACITY } from '@/types/cellar'
import type { CellarDraft } from '@/utils/cellarMerge'

/**
 * 断网 / 拒绝提交后的离线草稿面板：
 * 草稿持久化在 localStorage，失败后仍然保留，可就地重试、继续编辑或丢弃。
 */
const props = defineProps<{
  drafts: CellarDraft[]
  batchLabel: (batchId: string) => string
}>()

const emit = defineEmits<{
  (e: 'retry', draft: CellarDraft): void
  (e: 'edit', draft: CellarDraft): void
  (e: 'discard', draftId: string): void
}>()

const ordered = computed(() => [...props.drafts].sort((a, b) => b.updatedAt - a.updatedAt))

function timeLabel(value: number): string {
  if (!Number.isFinite(value)) return ''
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}
</script>

<template>
  <el-alert
    v-if="drafts.length > 0"
    class="draft-panel"
    type="warning"
    show-icon
    :closable="false"
    :title="`有 ${drafts.length} 条窖藏草稿待提交（失败后已保留，可重试）`"
  >
    <div class="draft-list">
      <div v-for="draft in ordered" :key="draft.id" class="draft-item">
        <div class="draft-main">
          <div class="draft-title">
            <el-tag size="small" :type="draft.kind === 'create' ? 'success' : 'primary'" effect="plain">
              {{ draft.kind === 'create' ? '新入窖' : '编辑' }}
            </el-tag>
            <span>{{ batchLabel(draft.batchId) }}</span>
          </div>
          <div class="draft-meta muted">
            {{ draft.startDate }} → {{ draft.endDate }} · {{ draft.container }} ·
            {{ draft.temperatureC }}℃ / {{ draft.humidityPct }}% · {{ draft.state }} ·
            容量 {{ CELLAR_CONTAINER_CAPACITY[draft.container] }} 位
          </div>
          <div v-if="draft.lastError" class="draft-error">失败原因：{{ draft.lastError }}</div>
          <div v-else class="muted draft-time">保存于 {{ timeLabel(draft.updatedAt) }}</div>
        </div>
        <div class="draft-actions">
          <el-button size="small" type="primary" :icon="RefreshLeft" @click="emit('retry', draft)">
            重试提交
          </el-button>
          <el-button size="small" :icon="EditPen" @click="emit('edit', draft)">继续编辑</el-button>
          <el-button size="small" text type="danger" :icon="Delete" @click="emit('discard', draft.id)">
            丢弃
          </el-button>
        </div>
      </div>
    </div>
  </el-alert>
</template>

<style scoped>
.draft-panel {
  margin-bottom: 12px;
}

.draft-list {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.draft-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  background: var(--el-fill-color-blank, #fff);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  padding: 8px 10px;
}

.draft-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 13px;
}

.draft-meta {
  font-size: 12px;
  margin-top: 2px;
}

.draft-error {
  font-size: 12px;
  color: var(--el-color-danger);
  margin-top: 2px;
}

.draft-time {
  font-size: 12px;
  margin-top: 2px;
}

.draft-actions {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 4px;
}
</style>
