<template>
  <section class="page" data-module="archive">
    <header class="page-head">
      <div>
        <h2>竣工资料组卷</h2>
        <p class="page-desc">
          按单位工程建案卷、挂资料；缺件以资料清单（{{ board?.rulesVersion }}）为准，
          缺项的案卷不能提交移交。当前角色：{{ store.role }}。
        </p>
      </div>
      <div class="page-actions">
        <button v-if="store.isArchivist" class="btn primary" type="button" @click="showCreate = !showCreate">
          新建案卷
        </button>
        <button v-if="store.isArchivist" class="btn" type="button" @click="runMigrate">存量迁移组卷</button>
        <button class="btn" type="button" @click="runRecompute">按清单口径重算</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <form v-if="showCreate && store.isArchivist" class="filter-bar" @submit.prevent="submitCreate">
      <label class="filter-item">
        <span>单位工程</span>
        <select v-model="createForm.unit">
          <option v-for="unit in units" :key="String(unit['单位工程'])" :value="String(unit['单位工程'])">
            {{ unit['单位工程'] }}
          </option>
        </select>
      </label>
      <label class="filter-item">
        <span>案卷类别</span>
        <select v-model="createForm.category">
          <option v-for="category in categories" :key="category" :value="category">{{ category }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>案卷题名</span>
        <input v-model="createForm.title" placeholder="默认按单位工程+类别命名" />
      </label>
      <button class="btn primary" type="submit">建卷</button>
    </form>

    <form class="filter-bar" @submit.prevent>
      <label class="filter-item">
        <span>单位工程</span>
        <select v-model="filterUnit">
          <option value="">全部</option>
          <option v-for="unit in units" :key="String(unit['单位工程'])" :value="String(unit['单位工程'])">
            {{ unit['单位工程'] }}
          </option>
        </select>
      </label>
      <label class="filter-item">
        <span>案卷状态</span>
        <select v-model="filterStatus">
          <option value="">全部</option>
          <option v-for="status in volumeStatuses" :key="status" :value="status">{{ status }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>关键字</span>
        <input v-model="filterKeyword" placeholder="按编号 / 题名检索" />
      </label>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <p class="selection-bar">
      <span>已选 {{ selected.length }} 卷（仅组卷中且无缺件的卷可勾选）</span>
      <button
        class="btn primary"
        type="button"
        :disabled="!selected.length || !store.isArchivist"
        @click="submitSelected"
      >
        提交移交（一次一组）
      </button>
    </p>

    <table class="data-table">
      <thead>
        <tr>
          <th></th>
          <th>案卷编号</th>
          <th>案卷题名</th>
          <th>单位工程</th>
          <th>类别</th>
          <th>资料份数</th>
          <th>缺件数</th>
          <th>状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="volume in filteredVolumes" :key="String(volume['案卷编号'])">
          <td>
            <input
              type="checkbox"
              :checked="selected.includes(String(volume['案卷编号']))"
              :disabled="!selectable(volume)"
              :title="selectable(volume) ? '可提交移交' : '仅组卷中且无缺件的卷可提交'"
              @change="toggleSelect(String(volume['案卷编号']))"
            />
          </td>
          <td>{{ volume['案卷编号'] }}</td>
          <td>{{ volume['案卷题名'] }}</td>
          <td>{{ volume['单位工程'] }}</td>
          <td>{{ volume['案卷类别'] }}</td>
          <td>{{ docCount(String(volume['案卷编号'])) }}</td>
          <td>
            <span
              v-if="missingOf(String(volume['案卷编号'])).count > 0"
              class="missing-text"
              :title="'缺：' + missingOf(String(volume['案卷编号'])).missing.join('、')"
            >
              缺 {{ missingOf(String(volume['案卷编号'])).count }} 项
            </span>
            <span v-else>齐</span>
          </td>
          <td>{{ volume.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(String(volume['案卷编号']))">
              {{ detailCode === String(volume['案卷编号']) ? '收起' : '详情' }}
            </button>
          </td>
        </tr>
        <tr v-if="!filteredVolumes.length">
          <td colspan="9" class="empty-state">没有符合条件的案卷</td>
        </tr>
      </tbody>
    </table>

    <section v-if="detailVolume" class="detail-panel">
      <h3>
        {{ detailVolume['案卷编号'] }} · {{ detailVolume['案卷题名'] }}
        <span class="legend-item">{{ detailVolume.status }}</span>
      </h3>
      <p class="page-desc">
        编制人：{{ detailVolume['编制人'] || '—' }}；首次提交：{{ detailVolume['首次提交时间'] || '—' }}；
        签收：{{ detailVolume['签收人'] || '—' }} {{ detailVolume['签收时间'] || '' }}
      </p>

      <h4>资料清单核对（缺件以清单为准）</h4>
      <table class="data-table">
        <thead>
          <tr><th>清单项</th><th>要求份数</th><th>实装份数</th><th>核对</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in detailChecklist" :key="row.item">
            <td>{{ row.item }}</td>
            <td>{{ row.copies }}</td>
            <td>{{ row.got }}</td>
            <td :class="{ 'missing-text': !row.ok }">{{ row.ok ? '齐' : '缺' }}</td>
          </tr>
        </tbody>
      </table>

      <h4>卷内资料</h4>
      <table class="data-table">
        <thead>
          <tr>
            <th>资料编号</th><th>资料名称</th><th>清单项</th><th>提交人</th>
            <th>页数</th><th>状态</th><th>缺页说明</th><th v-if="canEditDetail">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="doc in detailDocs" :key="String(doc['资料编号'])">
            <td>{{ doc['资料编号'] }}</td>
            <td>{{ doc['资料名称'] }}</td>
            <td>{{ doc['清单项'] }}</td>
            <td>{{ doc['提交人'] }}</td>
            <td>{{ doc['页数'] }}</td>
            <td :class="{ 'missing-text': doc.status === '待补页' }">{{ doc.status }}</td>
            <td class="note-cell">{{ doc['缺页说明'] || '—' }}</td>
            <td v-if="canEditDetail" class="row-actions">
              <button v-if="doc.status === '已装卷'" class="link" type="button" @click="markPages(doc, '登记缺页')">登记缺页</button>
              <button v-if="doc.status === '待补页'" class="link" type="button" @click="markPages(doc, '补齐归档')">补齐归档</button>
              <button class="link" type="button" @click="detach(doc)">撤出</button>
            </td>
          </tr>
          <tr v-if="!detailDocs.length">
            <td :colspan="canEditDetail ? 8 : 7" class="empty-state">卷内还没有资料</td>
          </tr>
        </tbody>
      </table>

      <form v-if="canEditDetail" class="filter-bar" @submit.prevent="submitAttach">
        <label class="filter-item">
          <span>资料名称</span>
          <input v-model="attachForm.name" placeholder="如：左线钢筋原材复试报告" />
        </label>
        <label class="filter-item">
          <span>清单项</span>
          <select v-model="attachForm.item">
            <option v-for="item in detailItems" :key="item" :value="item">{{ item }}</option>
          </select>
        </label>
        <label class="filter-item">
          <span>提交人</span>
          <input v-model="attachForm.submitter" placeholder="谁交的" />
        </label>
        <label class="filter-item">
          <span>页数</span>
          <input v-model.number="attachForm.pages" type="number" min="0" />
        </label>
        <button class="btn primary" type="submit">挂到案卷</button>
      </form>

      <template v-if="detailVolume.status === '已签收'">
        <h4>补充说明（已签收卷册只能追加说明，不能改回待移交）</h4>
        <pre v-if="detailVolume['补充说明']" class="note-block">{{ detailVolume['补充说明'] }}</pre>
        <form v-if="store.isArchivist" class="filter-bar" @submit.prevent="submitNote">
          <label class="filter-item note-input">
            <span>追加说明</span>
            <input v-model="noteText" placeholder="如：电子版光盘已补交" />
          </label>
          <button class="btn" type="submit">追加</button>
        </form>
      </template>
    </section>

    <section v-if="poolDocs.length" class="detail-panel">
      <h3>待认领池（存量迁移进来的资料，按单位工程逐份归类挂卷）</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>资料编号</th><th>资料名称</th><th>来源</th>
            <th v-if="store.isArchivist">归入案卷</th><th v-if="store.isArchivist">清单项</th><th v-if="store.isArchivist">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="doc in poolDocs" :key="String(doc['资料编号'])">
            <td>{{ doc['资料编号'] }}</td>
            <td>{{ doc['资料名称'] }}</td>
            <td>{{ doc['提交人'] }}</td>
            <td v-if="store.isArchivist">
              <select v-model="classifyTargets[String(doc['资料编号'])]">
                <option value="">选择案卷</option>
                <option
                  v-for="volume in openVolumes"
                  :key="String(volume['案卷编号'])"
                  :value="String(volume['案卷编号'])"
                >
                  {{ volume['案卷编号'] }} {{ volume['案卷题名'] }}
                </option>
              </select>
            </td>
            <td v-if="store.isArchivist">
              <select v-model="classifyItems[String(doc['资料编号'])]">
                <option value="">选择清单项</option>
                <option v-for="item in itemsForTarget(String(doc['资料编号']))" :key="item" :value="item">
                  {{ item }}
                </option>
              </select>
            </td>
            <td v-if="store.isArchivist" class="row-actions">
              <button class="link" type="button" @click="classify(doc)">归类挂卷</button>
              <button class="link" type="button" @click="detach(doc)">移除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ filteredVolumes.length }} 卷 · 待认领资料 {{ poolDocs.length }} 份</span>
      <span v-if="message" :class="{ 'error-text': isError }">{{ message }}</span>
      <button v-if="verifyFailed" class="btn" type="button" @click="verify">核对失败，点击重试</button>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  POOL_CODE,
  appendVolumeNote,
  attachDoc,
  classifyDoc,
  createVolume,
  loadArchiveState,
  loadVerifiedState,
  markDocPages,
  migrateLegacy,
  recomputeHandovers,
  removeDoc,
  submitHandover,
  checklistItems,
  type ArchiveBoard,
} from '@/api/archive-service'
import { ARCHIVE_CATEGORIES, CHECKLIST, VOLUME_STATUSES } from '@/data/archive-rules'
import type { ActionResult, EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const store = useSessionStore()
const categories = ARCHIVE_CATEGORIES
const volumeStatuses = VOLUME_STATUSES

const board = ref<ArchiveBoard | null>(null)
const message = ref('')
const isError = ref(false)
const verifyFailed = ref(false)
const showCreate = ref(false)
const filterUnit = ref('')
const filterStatus = ref('')
const filterKeyword = ref('')
const selected = ref<string[]>([])
const detailCode = ref('')
const noteText = ref('')

const createForm = reactive({ unit: '', category: categories[0] as string, title: '' })
const attachForm = reactive({ name: '', item: '', submitter: '', pages: 0 })
const classifyTargets = reactive<Record<string, string>>({})
const classifyItems = reactive<Record<string, string>>({})

const units = computed(() => board.value?.units ?? [])
const volumes = computed(() => board.value?.volumes ?? [])
const docs = computed(() => board.value?.docs ?? [])

const stats = computed(() => {
  const list = volumes.value
  const missing = board.value?.missing ?? {}
  return [
    { label: '案卷总数', value: list.length },
    { label: '组卷中', value: list.filter((v) => v.status === '组卷中').length },
    { label: '待移交', value: list.filter((v) => v.status === '待移交').length },
    { label: '已签收', value: list.filter((v) => v.status === '已签收').length },
    {
      label: '缺件案卷',
      value: list.filter((v) => (missing[String(v['案卷编号'])]?.count ?? 0) > 0).length,
    },
  ]
})

const filteredVolumes = computed(() =>
  volumes.value.filter((volume) => {
    if (filterUnit.value && String(volume['单位工程']) !== filterUnit.value) return false
    if (filterStatus.value && String(volume.status) !== filterStatus.value) return false
    if (filterKeyword.value) {
      const text = `${volume['案卷编号']}${volume['案卷题名']}`
      if (!text.includes(filterKeyword.value.trim())) return false
    }
    return true
  }),
)

const detailVolume = computed(
  () => volumes.value.find((v) => String(v['案卷编号']) === detailCode.value) ?? null,
)

const canEditDetail = computed(
  () => store.isArchivist && detailVolume.value?.status === '组卷中',
)

const detailDocs = computed(() =>
  docs.value.filter((doc) => String(doc['案卷编号']) === detailCode.value),
)

const detailItems = computed(() => checklistItems(String(detailVolume.value?.['案卷类别'] ?? '')))

const detailChecklist = computed(() => {
  const volume = detailVolume.value
  if (!volume) return []
  const required = CHECKLIST[String(volume['案卷类别'])] ?? []
  const code = String(volume['案卷编号'])
  return required.map(({ item, copies }) => {
    const got = docs.value.filter(
      (doc) =>
        String(doc['案卷编号']) === code &&
        String(doc.status) === '已装卷' &&
        String(doc['清单项']) === item,
    ).length
    return { item, copies, got, ok: got >= copies }
  })
})

const poolDocs = computed(() => docs.value.filter((doc) => String(doc['案卷编号']) === POOL_CODE))

const openVolumes = computed(() => volumes.value.filter((v) => v.status === '组卷中'))

function missingOf(code: string) {
  return board.value?.missing[code] ?? { missing: [], count: 0 }
}

function docCount(code: string) {
  return docs.value.filter((doc) => String(doc['案卷编号']) === code).length
}

function selectable(volume: EntryRow) {
  return volume.status === '组卷中' && missingOf(String(volume['案卷编号'])).count === 0
}

function toggleSelect(code: string) {
  selected.value = selected.value.includes(code)
    ? selected.value.filter((item) => item !== code)
    : [...selected.value, code]
}

function itemsForTarget(docCode: string): string[] {
  const target = classifyTargets[docCode]
  const volume = volumes.value.find((v) => String(v['案卷编号']) === target)
  return volume ? checklistItems(String(volume['案卷类别'])) : []
}

function apply(result: ActionResult) {
  message.value = result.message
  isError.value = !result.ok
  if (result.ok) {
    verify()
  }
}

/** 交完之后重新核对：强制重读，中途断掉就重试，不拿老数据兜底。 */
function verify() {
  try {
    board.value = loadVerifiedState()
    verifyFailed.value = false
  } catch (error) {
    verifyFailed.value = true
    isError.value = true
    message.value = error instanceof Error ? error.message : '重新核对失败，请重试'
  }
}

function resetFilters() {
  filterUnit.value = ''
  filterStatus.value = ''
  filterKeyword.value = ''
}

function openDetail(code: string) {
  detailCode.value = detailCode.value === code ? '' : code
  attachForm.item = detailItems.value[0] ?? ''
}

function submitCreate() {
  const title = createForm.title.trim() || `${createForm.unit}${createForm.category}卷`
  apply(createVolume(
    { 单位工程: createForm.unit, 案卷类别: createForm.category, 案卷题名: title },
    store.role,
    store.roleOperator,
  ))
  createForm.title = ''
}

function submitAttach() {
  if (!detailVolume.value) return
  apply(attachDoc(
    String(detailVolume.value['案卷编号']),
    { 资料名称: attachForm.name, 清单项: attachForm.item, 提交人: attachForm.submitter, 页数: attachForm.pages },
    store.role,
  ))
  attachForm.name = ''
  attachForm.submitter = ''
  attachForm.pages = 0
}

function submitSelected() {
  apply(submitHandover(selected.value, store.role, store.roleOperator))
  selected.value = []
}

function submitNote() {
  if (!detailVolume.value) return
  apply(appendVolumeNote(String(detailVolume.value['案卷编号']), noteText.value, store.role))
  noteText.value = ''
}

function markPages(doc: EntryRow, action: '登记缺页' | '补齐归档') {
  const hint = action === '登记缺页' ? '请写明缺页情况（页码范围）' : '请写明补齐情况'
  const note = window.prompt(hint)
  if (note === null) return
  apply(markDocPages(String(doc['资料编号']), action, note, store.role))
}

function detach(doc: EntryRow) {
  if (!window.confirm(`确定把 ${doc['资料编号']} 撤出吗？`)) return
  apply(removeDoc(String(doc['资料编号']), store.role))
}

function classify(doc: EntryRow) {
  const code = String(doc['资料编号'])
  const target = classifyTargets[code]
  const item = classifyItems[code]
  if (!target || !item) {
    message.value = '请先选择归入的案卷和清单项'
    isError.value = true
    return
  }
  apply(classifyDoc(code, target, item, store.role))
}

function runMigrate() {
  apply(migrateLegacy(store.role))
}

function runRecompute() {
  apply(recomputeHandovers())
}

onMounted(() => {
  board.value = loadArchiveState()
  createForm.unit = String(units.value[0]?.['单位工程'] ?? '')
  verify()
})
</script>

<style scoped>
.detail-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 16px;
  margin-top: 12px;
}
.detail-panel h3 { margin: 4px 0 8px; font-size: 15px; }
.detail-panel h4 { margin: 14px 0 6px; font-size: 13px; }
.missing-text { color: #b42318; font-weight: 600; }
.selection-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--muted);
}
.note-cell { max-width: 260px; white-space: pre-wrap; }
.note-block {
  background: #f8fafc;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12px;
  white-space: pre-wrap;
}
.note-input { flex: 1; }
select {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 5px 8px;
  background: #fff;
}
</style>
