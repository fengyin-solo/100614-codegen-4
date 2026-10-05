<template>
  <section class="page" data-module="testing">
    <header class="page-head">
      <div>
        <h2>试验检测管理</h2>
        <p class="page-desc">维护试验委托；委托与竣工卷内试验报告按委托编号一一对应，缺报告的卷在这里直接点名可查（缺件口径只认资料清单一份算法）。</p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn" to="/archive">前往竣工组卷移交</RouterLink>
        <button class="btn" type="button" @click="exportRows">导出试验检测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="{ warn: item.warn }">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item warn-legend">缺试验报告卷册：{{ deficientVolumeCount }}（与组卷页同一份计算）</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>组卷与移交结论</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in filteredRows" :key="String(item.row.id)">
          <td v-for="column in columns" :key="column">{{ item.row[column] || '—' }}</td>
          <td>{{ item.row.status }}</td>
          <td class="archive-cell">
            <div v-if="!item.links.length" class="muted-text">未挂入任何竣工卷的资料清单</div>
            <div v-for="link in item.links" :key="link.item.id" class="archive-link-line">
              <span class="chip">{{ link.unitProjectName }}</span>
              <span>{{ link.item.name }}</span>
              <span v-if="link.volumeCode" class="muted-text">（{{ link.volumeCode }}·{{ link.volumeStatus }}）</span>
              <span v-if="link.missingTypes.length" class="error-text">
                缺件：{{ link.missingTypes.join('、') }}
              </span>
              <span v-else-if="link.batchOutcome === '已签收'" class="ok-text">
                ✓ 已随 {{ link.batchCode }} 签收（{{ formatTime(link.signedAt) }}）
              </span>
              <span v-else-if="link.batchOutcome === '已退回'" class="error-text">
                批次 {{ link.batchCode }} 已整组退回（{{ formatTime(link.rejectAt) }}），点名到本卷
              </span>
              <span v-else-if="link.batchCode" class="pending-text">随 {{ link.batchCode }} 待核对</span>
            </div>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, item)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!filteredRows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无试验检测数据，可先登记试验委托</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ filteredRows.length }} 条试验检测记录；签收/退回结论实时取自移交批次，不另存副本</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { loadArchive, syncTestingReport, testingArchiveRows, testingReportDeficientVolumeIds } from '@/api/archive-service'
import type { TestingArchiveRow } from '@/api/archive-service'

const meta = moduleMeta('testing')
const columns = ["委托编号", "试样类型", "检测项目", "送样日期", "检测结果", "报告编号", "检测机构", "委托状态"]
const actions = ["送样委托", "出具报告", "登记不合格"]
const statuses = ["待送样", "检测中", "已出报告", "不合格"]

const rows = ref<TestingArchiveRow[]>([])
const deficientVolumeCount = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const stats = computed(() => [
  { label: '待送样委托', value: rows.value.filter((item) => item.row.status === '待送样').length, warn: false },
  { label: '检测中委托', value: rows.value.filter((item) => item.row.status === '检测中').length, warn: false },
  { label: '不合格项', value: rows.value.filter((item) => item.row.status === '不合格').length, warn: false },
  { label: '缺报告卷册数', value: deficientVolumeCount.value, warn: deficientVolumeCount.value > 0 },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.row.status) === status).length,
  })),
)

const filteredRows = computed(() => {
  const pairs = Object.entries(filters.value).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows.value
  }
  return rows.value.filter((item) =>
    pairs.every(([field, value]) => String(item.row[field] ?? '').includes(value.trim())),
  )
})

function formatTime(value?: string): string {
  if (!value) {
    return ''
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function resetFilters() {
  filters.value = {}
}

function exportRows() {
  downloadEntries(meta.key)
}

function runAction(action: string, item: TestingArchiveRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(item.row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  // 出具报告：委托状态落库后把同一份报告同步进资料池（失败则提示，列表照实重读）。
  if (action === '出具报告') {
    try {
      syncTestingReport(Number(item.row.id))
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : '报告同步资料池失败'
    }
  }
  reload()
}

function reload() {
  // 不做内存兜底：每次都从存储现读，保证两侧看到的是同一份最新数据。
  const archive = loadArchive()
  deficientVolumeCount.value = testingReportDeficientVolumeIds(archive).length
  rows.value = testingArchiveRows()
}

onMounted(reload)
</script>
