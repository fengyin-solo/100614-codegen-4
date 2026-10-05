<template>
  <div class="tab-panel">
    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">案卷总数</span>
        <strong class="stat-value">{{ views.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">组卷中</span>
        <strong class="stat-value">{{ statusCount('组卷中') }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待移交/待核对</span>
        <strong class="stat-value">{{ statusCount('待移交') }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已签收</span>
        <strong class="stat-value">{{ statusCount('已签收') }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">有缺件的卷</span>
        <strong class="stat-value" :class="{ warn: missingCount > 0 }">{{ missingCount }}</strong>
      </article>
    </div>

    <form class="filter-bar" @submit.prevent>
      <label class="filter-item">
        <span>单位工程</span>
        <select v-model="projectFilter">
          <option value="">全部</option>
          <option v-for="project in state.unitProjects" :key="project.id" :value="project.id">
            {{ project.name }}
          </option>
        </select>
      </label>
      <label class="filter-item">
        <span>卷状态</span>
        <select v-model="statusFilter">
          <option value="">全部</option>
          <option>组卷中</option>
          <option>待移交</option>
          <option>已签收</option>
        </select>
      </label>
      <label class="filter-check">
        <input v-model="onlyMissing" type="checkbox" /> 只看缺件卷
      </label>
    </form>

    <div v-if="role === '资料员'" class="bulk-bar">
      <label class="filter-check">
        <input :checked="allSelectableChecked" type="checkbox" @change="toggleSelectAll" />
        全选当前可提交卷（组卷中、未在批次内）
      </label>
      <span class="muted-text">已选 {{ selectedIds.length }} 卷</span>
      <button class="btn primary" type="button" :disabled="!selectedIds.length" @click="submitSelected">
        多选卷册一次提交移交
      </button>
      <button class="btn" type="button" @click="openRegister">登记散件（施工记录/测量成果）</button>
    </div>
    <p v-else class="muted-text hint-line">建设单位账号只读查看案卷构成；组卷、挂件与提交请切到资料员账号。</p>

    <table class="data-table">
      <thead>
        <tr>
          <th v-if="role === '资料员'" style="width: 36px"></th>
          <th>卷编号</th>
          <th>单位工程</th>
          <th>类别</th>
          <th>清单/已挂</th>
          <th>缺件点名（资料清单口径）</th>
          <th>状态</th>
          <th>批次</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="view in filteredViews" :key="view.volume.id" :class="{ 'row-missing': view.missingCount > 0 }">
          <td v-if="role === '资料员'">
            <input
              v-if="canSelect(view)"
              :checked="selectedIds.includes(view.volume.id)"
              type="checkbox"
              @change="toggleSelect(view.volume.id)"
            />
          </td>
          <td>{{ view.volume.code }}</td>
          <td>{{ view.unitProject.name }}</td>
          <td>{{ view.volume.category }}</td>
          <td>{{ view.volume.itemIds.length }} / {{ attachedOf(view) }}</td>
          <td>
            <div v-if="!view.missingEntries.length" class="ok-text">齐全</div>
            <div v-for="entry in view.missingEntries" :key="entry.itemId" class="missing-line">
              <span class="error-text">{{ entry.itemName }}</span>
              <span class="muted-text">（{{ entry.missingTypes.join('、') }}<template v-if="entry.missingTypes.includes('页数不足')">：{{ entry.actualPages ?? 0 }}/{{ entry.requiredPages }}页</template>）</span>
            </div>
          </td>
          <td>
            <span class="status-pill" :class="statusClass(view.volume.status)">{{ view.volume.status }}</span>
          </td>
          <td>
            <span v-if="view.activeBatch" class="pending-text">{{ view.activeBatch.code }}·待核对</span>
            <span v-else-if="view.lastBatch" :class="view.lastBatch.outcome === '已签收' ? 'ok-text' : 'error-text'">
              {{ view.lastBatch.code }}·{{ view.lastBatch.outcome }}
            </span>
            <span v-else class="muted-text">—</span>
          </td>
          <td>
            <button class="link" type="button" @click="openDetail(view.volume.id)">
              {{ view.volume.status === '已签收' ? '查看/补说明' : '查看卷内' }}
            </button>
          </td>
        </tr>
        <tr v-if="!filteredViews.length">
          <td :colspan="role === '资料员' ? 9 : 8" class="empty-state">
            还没有案卷，先到「存量迁移与口径」按单位工程迁移，或等待后续建卷。
          </td>
        </tr>
      </tbody>
    </table>

    <!-- 卷内明细抽屉 -->
    <div v-if="detail" class="drawer-mask" @click.self="closeDetail">
      <section class="drawer">
        <header class="drawer-head">
          <div>
            <h3>{{ detailView?.volume.code }} · {{ detailView?.unitProject.name }}</h3>
            <p class="muted-text">{{ detailView?.volume.category }} · 状态：{{ detailView?.volume.status }}</p>
          </div>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </header>

        <table class="data-table drawer-table">
          <thead>
            <tr>
              <th>清单条目（缺件基准）</th>
              <th>要求页数</th>
              <th>卷内资料 / 实测页数</th>
              <th v-if="detail.category === '试验报告'">委托清单状态</th>
              <th>判定</th>
              <th v-if="editable">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in itemsOf(detail)" :key="item.id">
              <td>{{ item.name }}</td>
              <td>{{ item.requiredPages }} 页</td>
              <td>
                <template v-if="attachOf(item.id)?.docId">
                  {{ docName(attachOf(item.id)!.docId!) }}
                  <span class="muted-text">（{{ actualPagesOf(item.id) }} 页）</span>
                </template>
                <span v-else-if="attachOf(item.id)" class="error-text">空挂占位（无报告原件）</span>
                <span v-else class="muted-text">未挂</span>
                <select
                  v-if="editable"
                  :value="attachOf(item.id)?.docId ?? ''"
                  class="attach-select"
                  @change="onPickDoc(item.id, ($event.target as HTMLSelectElement).value)"
                >
                  <option value="">— 选择资料池资料 —</option>
                  <option v-for="doc in attachableDocs(item)" :key="doc.id" :value="doc.id">
                    {{ doc.name }}（{{ doc.pages }}页 · {{ doc.submitter }}）
                  </option>
                </select>
              </td>
              <td v-if="detail.category === '试验报告'">
                <template v-if="item.testingRef">
                  <RouterLink class="link" to="/testing">{{ item.testingRef }}</RouterLink>
                  <span :class="evidenceReady(item.testingRef) ? 'ok-text' : 'error-text'">
                    · {{ evidenceText(item.testingRef) }}
                  </span>
                </template>
                <span v-else class="muted-text">无委托编号</span>
              </td>
              <td>
                <span v-if="!missingOf(item.id).length" class="ok-text">齐</span>
                <span v-else class="error-text">{{ missingOf(item.id).join('、') }}</span>
              </td>
              <td v-if="editable">
                <span class="row-actions">
                  <button v-if="attachOf(item.id)" class="link" type="button" @click="detach(item.id)">摘下</button>
                  <button class="link" type="button" @click="openFix(item.id)">
                    {{ actualPagesOf(item.id) < item.requiredPages ? '补页登记' : '修正页数' }}
                  </button>
                </span>
              </td>
            </tr>
          </tbody>
        </table>

        <div v-if="detail.status === '已签收'" class="readonly-tip">
          本卷已随批次签收，构成转只读：不能摘挂、不能改回待移交，只能在下方补充说明。
        </div>

        <section class="note-section">
          <h4>补充说明</h4>
          <ul class="note-list">
            <li v-for="(note, index) in detail.notes" :key="index">
              <span class="muted-text">{{ formatTime(note.at) }} · {{ note.role }}</span>
              <span>{{ note.text }}</span>
            </li>
            <li v-if="!detail.notes.length" class="muted-text">暂无说明</li>
          </ul>
          <div class="note-input">
            <input v-model="noteText" placeholder="已签收卷也可补充说明（不改构成、不改结论）" />
            <button class="btn" type="button" @click="addNote">追加说明</button>
          </div>
        </section>
      </section>
    </div>

    <!-- 登记散件 -->
    <div v-if="registering" class="drawer-mask" @click.self="registering = false">
      <section class="drawer small">
        <header class="drawer-head">
          <h3>登记散件（缺页追回/补录）</h3>
          <button class="btn ghost" type="button" @click="registering = false">关闭</button>
        </header>
        <p class="muted-text">试验报告不在此登记：必须到「试验检测」对委托出具报告，由系统同步入池。</p>
        <div class="form-grid">
          <label class="filter-item">
            <span>单位工程</span>
            <select v-model="regForm.unitProjectId">
              <option value="">请选择</option>
              <option v-for="project in state.unitProjects" :key="project.id" :value="project.id">{{ project.name }}</option>
            </select>
          </label>
          <label class="filter-item">
            <span>类别</span>
            <select v-model="regForm.category">
              <option>施工记录</option>
              <option>测量成果</option>
            </select>
          </label>
          <label class="filter-item">
            <span>资料名称（需与资料清单一致）</span>
            <input v-model="regForm.name" placeholder="如：联络通道开挖施工记录" />
          </label>
          <label class="filter-item">
            <span>实有页数</span>
            <input v-model.number="regForm.pages" type="number" min="1" />
          </label>
        </div>
        <button class="btn primary" type="button" @click="submitRegister">登记并归为散件</button>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

import {
  attachDoc,
  addVolumeNote,
  detachDoc,
  fixPages,
  looseDocs,
  registerDoc,
  submitVolumes,
  volumeViews,
  type VolumeView,
} from '@/api/archive-service'
import { listRows } from '@/data/local-store'
import type { ArchiveDoc, ArchiveState, ChecklistItem, Role, Volume } from '@/data/archive/types'

const props = defineProps<{ state: ArchiveState; role: Role; operator: string }>()
const emit = defineEmits<{
  changed: []
  notify: [text: string, kind?: 'ok' | 'err']
  'go-batches': []
}>()

const views = computed(() => volumeViews(props.state))
const projectFilter = ref('')
const statusFilter = ref('')
const onlyMissing = ref(false)
const selectedIds = ref<string[]>([])
const detailId = ref<string | null>(null)
const noteText = ref('')
const registering = ref(false)
const regForm = ref({ unitProjectId: '', category: '施工记录' as '施工记录' | '测量成果', name: '', pages: 1 })

const filteredViews = computed(() =>
  views.value.filter((view) => {
    if (projectFilter.value && view.volume.unitProjectId !== projectFilter.value) {
      return false
    }
    if (statusFilter.value && view.volume.status !== statusFilter.value) {
      return false
    }
    if (onlyMissing.value && view.missingCount === 0) {
      return false
    }
    return true
  }),
)

const missingCount = computed(() => views.value.filter((view) => view.missingCount > 0).length)
function statusCount(status: Volume['status']): number {
  return views.value.filter((view) => view.volume.status === status).length
}

function statusClass(status: Volume['status']): string {
  return status === '已签收' ? 'st-signed' : status === '待移交' ? 'st-pending' : 'st-composing'
}

const detail = computed<Volume | undefined>(() =>
  props.state.volumes.find((volume) => volume.id === detailId.value),
)
const detailView = computed<VolumeView | undefined>(() =>
  views.value.find((view) => view.volume.id === detailId.value),
)
const editable = computed(() => detail.value?.status === '组卷中' && props.role === '资料员')

function canSelect(view: VolumeView): boolean {
  return view.volume.status === '组卷中' && !view.activeBatch
}

const selectableInFilter = computed(() => filteredViews.value.filter(canSelect))
const allSelectableChecked = computed(
  () =>
    selectableInFilter.value.length > 0 &&
    selectableInFilter.value.every((view) => selectedIds.value.includes(view.volume.id)),
)

function toggleSelectAll(event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  const ids = selectableInFilter.value.map((view) => view.volume.id)
  selectedIds.value = checked
    ? [...new Set([...selectedIds.value, ...ids])]
    : selectedIds.value.filter((id) => !ids.includes(id))
}

function toggleSelect(id: string) {
  if (selectedIds.value.includes(id)) {
    selectedIds.value = selectedIds.value.filter((item) => item !== id)
  } else {
    selectedIds.value = [...selectedIds.value, id]
  }
}

function attachedOf(view: VolumeView): number {
  return view.volume.attachments.filter((attachment) => attachment.docId).length
}

function itemsOf(volume: Volume): ChecklistItem[] {
  return props.state.checklist.filter((item) => volume.itemIds.includes(item.id))
}

function attachOf(itemId: string) {
  return detail.value?.attachments.find((attachment) => attachment.itemId === itemId)
}

function docName(docId: string): string {
  return props.state.docs.find((doc) => doc.id === docId)?.name ?? docId
}

function actualPagesOf(itemId: string): number {
  const attachment = attachOf(itemId)
  if (!attachment?.docId) {
    return 0
  }
  if (typeof attachment.actualPages === 'number') {
    return attachment.actualPages
  }
  return props.state.docs.find((doc) => doc.id === attachment.docId)?.pages ?? 0
}

function missingOf(itemId: string): string[] {
  return detailView.value?.missingEntries.find((entry) => entry.itemId === itemId)?.missingTypes ?? []
}

function attachableDocs(item: ChecklistItem): ArchiveDoc[] {
  if (!detail.value) {
    return []
  }
  const current = attachOf(item.id)?.docId
  const usedByOthers = new Set(
    props.state.volumes
      .filter((volume) => volume.id !== detail.value!.id)
      .flatMap((volume) => volume.attachments.map((attachment) => attachment.docId).filter(Boolean)),
  )
  const pool = looseDocs(props.state).filter(
    (doc) =>
      doc.unitProjectId === detail.value!.unitProjectId &&
      doc.category === item.category &&
      !usedByOthers.has(doc.id),
  )
  const currentDoc = current ? props.state.docs.find((doc) => doc.id === current) : undefined
  return currentDoc ? [currentDoc, ...pool.filter((doc) => doc.id !== currentDoc.id)] : pool
}

function evidenceReady(testingRef: string): boolean {
  const row = listRows('testing').find((item) => String(item['委托编号']) === testingRef)
  return !!row && String(row.status) === '已出报告' && String(row['报告编号'] ?? '').trim() !== ''
}

function evidenceText(testingRef: string): string {
  const row = listRows('testing').find((item) => String(item['委托编号']) === testingRef)
  if (!row) {
    return '委托清单里查无此委托'
  }
  return String(row.status) + (row['报告编号'] ? ` · ${row['报告编号']}` : ' · 未出报告')
}

function openDetail(volumeId: string) {
  detailId.value = volumeId
  noteText.value = ''
}
function closeDetail() {
  detailId.value = null
}

function run(action: () => ArchiveState | void, okText: string) {
  try {
    action()
    emit('changed')
    emit('notify', okText)
  } catch (error) {
    emit('notify', error instanceof Error ? error.message : '操作失败', 'err')
  }
}

function onPickDoc(itemId: string, docId: string) {
  if (!detail.value || !docId) {
    return
  }
  run(
    () => attachDoc({ role: props.role, volumeId: detail.value!.id, itemId, docId }),
    '资料已挂入卷内，缺件口径已按资料清单重新判定',
  )
}

function detach(itemId: string) {
  if (!detail.value) {
    return
  }
  run(() => detachDoc({ role: props.role, volumeId: detail.value!.id, itemId }), '已从卷内摘下')
}

function openFix(itemId: string) {
  const item = props.state.checklist.find((candidate) => candidate.id === itemId)
  if (!item) {
    return
  }
  const input = window.prompt(`《${item.name}》追回后实测页数（清单要求 ${item.requiredPages} 页）：`, String(actualPagesOf(itemId) || item.requiredPages))
  if (input === null) {
    return
  }
  const pages = Number(input)
  run(() => fixPages({ role: props.role, volumeId: detail.value!.id, itemId, actualPages: pages }), '补页已登记，缺件判定已刷新')
}

function addNote() {
  if (!detail.value || !noteText.value.trim()) {
    return
  }
  const text = noteText.value
  run(() => addVolumeNote({ role: props.role, volumeId: detail.value!.id, text }), '说明已追加')
  noteText.value = ''
}

function submitSelected() {
  const ids = [...selectedIds.value]
  run(() => {
    const result = submitVolumes({ role: props.role, operator: props.operator, volumeIds: ids })
    selectedIds.value = []
    const tail = result.reused ? '（沿用最早批次号，第 2 次提交）' : '（新批次）'
    emit('notify', `已提交移交并读回校验通过 ${tail}，可到「移交批次」逐卷核对`, 'ok')
    emit('go-batches')
  }, '')
}

function openRegister() {
  registering.value = true
}

function submitRegister() {
  run(
    () =>
      registerDoc({
        role: props.role,
        operator: props.operator,
        unitProjectId: regForm.value.unitProjectId,
        category: regForm.value.category,
        name: regForm.value.name,
        pages: Number(regForm.value.pages),
      }),
    '散件已登记，可在卷内下拉选择挂接',
  )
  registering.value = false
  regForm.value = { unitProjectId: projectFilter.value, category: '施工记录', name: '', pages: 1 }
}

function formatTime(value?: string): string {
  if (!value) {
    return ''
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}
</script>
