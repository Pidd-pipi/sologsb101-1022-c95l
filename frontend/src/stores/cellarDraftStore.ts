import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { CellarContainer, CellarState } from '@/types/cellar'
import { buildCreateDraft, buildUpdateDraft, type CellarDraft } from '@/utils/cellarMerge'
import type { Cellar } from '@/types/cellar'

/** 离线草稿持久化键：提交失败（断网 / 容量不足 / 边界拒绝）后草稿仍在，刷新后可重试 */
const LS_DRAFTS_KEY = 'gbincense:cellar-drafts'

function loadDrafts(): CellarDraft[] {
  try {
    const raw = localStorage.getItem(LS_DRAFTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as CellarDraft[]) : []
  } catch {
    return []
  }
}

/**
 * 窖藏离线草稿 store。
 * 多标签页断网回来合并提交：任一失败原因（容量不足、温湿度越界、写库异常）
 * 都不会丢草稿，可在重试面板继续编辑或直接重试。
 */
export const useCellarDraftStore = defineStore('cellarDrafts', () => {
  const drafts = ref<CellarDraft[]>(loadDrafts())

  const pendingCount = computed(() => drafts.value.length)
  const hasPending = computed(() => drafts.value.length > 0)

  function persist(): void {
    try {
      localStorage.setItem(LS_DRAFTS_KEY, JSON.stringify(drafts.value))
    } catch {
      // 存储空间不足等异常不影响内存中的草稿，仍可重试
    }
  }

  function draftOfCellar(cellarId: string): CellarDraft | undefined {
    return drafts.value.find((draft) => draft.cellarId === cellarId)
  }

  function saveCreateDraft(input: {
    batchId: string
    startDate: string
    endDate: string
    temperatureC: number
    humidityPct: number
    container: CellarContainer
    state: CellarState
  }): CellarDraft {
    const draft = buildCreateDraft(input)
    drafts.value = [draft, ...drafts.value.filter((item) => item.id !== draft.id)]
    persist()
    return draft
  }

  function saveUpdateDraft(
    cellar: Cellar,
    input: Partial<Omit<Cellar, 'id' | 'revision'>>
  ): CellarDraft {
    const draft = buildUpdateDraft(cellar, input)
    drafts.value = [draft, ...drafts.value.filter((item) => item.id !== draft.id)]
    persist()
    return draft
  }

  /** 记录最近一次失败原因，草稿保留 */
  function markFailed(draftId: string, error: string): void {
    drafts.value = drafts.value.map((draft) =>
      draft.id === draftId ? { ...draft, lastError: error, updatedAt: Date.now() } : draft
    )
    persist()
  }

  function patchDraft(draftId: string, patch: Partial<Omit<CellarDraft, 'id' | 'kind' | 'cellarId'>>): void {
    drafts.value = drafts.value.map((draft) =>
      draft.id === draftId ? { ...draft, ...patch, lastError: undefined, updatedAt: Date.now() } : draft
    )
    persist()
  }

  function removeDraft(draftId: string): void {
    drafts.value = drafts.value.filter((draft) => draft.id !== draftId)
    persist()
  }

  function clearDrafts(): void {
    drafts.value = []
    persist()
  }

  return {
    drafts,
    pendingCount,
    hasPending,
    draftOfCellar,
    saveCreateDraft,
    saveUpdateDraft,
    markFailed,
    patchDraft,
    removeDraft,
    clearDrafts
  }
})
