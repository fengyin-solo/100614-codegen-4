<template>
  <section class="page" data-module="testing">
    <header class="page-head">
      <div>
        <h2>试验检测管理</h2>
        <p class="page-desc">维护试验委托，围绕委托编号、试样类型、检测项目、送样日期做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记试验委托</button>
        <button class="btn" type="button" @click="exportRows">导出试验检测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
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
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无试验检测数据，可先登记试验委托</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条试验检测记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <section class="handover-panel">
      <h3>竣工资料移交签收结论（与组卷、移交页同一份数据，{{ archiveBoard?.rulesVersion }}）</h3>
      <p class="page-desc">
        结论不在这里另存一份，直接从移交记录取；缺报告案卷的缺件数与组卷页读到的是同一份算法的结果。
      </p>
      <table class="data-table">
        <thead>
          <tr>
            <th>移交编号</th><th>案卷列表</th><th>状态</th><th>结论</th><th>缺件卷（点名）</th><th>签收人 / 时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in handoverRows" :key="String(row['移交编号'])">
            <td>{{ row['移交编号'] }}</td>
            <td>{{ row['案卷列表'] }}</td>
            <td>{{ row.status }}</td>
            <td>{{ row['结论'] || '—' }}</td>
            <td>
              <span v-if="row['缺件卷']" class="missing-text">{{ row['缺件卷'] }}</span>
              <span v-else>—</span>
            </td>
            <td>{{ row['签收人'] || '—' }} {{ row['签收时间'] || '' }}</td>
          </tr>
          <tr v-if="!handoverRows.length">
            <td colspan="6" class="empty-state">还没有移交签收记录</td>
          </tr>
        </tbody>
      </table>

      <h4>缺报告案卷（试验报告类，按资料清单口径）</h4>
      <form class="filter-bar" @submit.prevent>
        <label class="filter-item">
          <span>按案卷编号查</span>
          <input v-model="reportQuery" placeholder="如 VOL-0002" />
        </label>
      </form>
      <table class="data-table">
        <thead>
          <tr><th>案卷编号</th><th>案卷题名</th><th>单位工程</th><th>缺件数</th><th>缺项明细</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in filteredMissingReports" :key="item.code">
            <td>{{ item.code }}</td>
            <td>{{ item.title }}</td>
            <td>{{ item.unit }}</td>
            <td class="missing-text">缺 {{ item.missing.count }} 项</td>
            <td>{{ item.missing.missing.join('、') }}</td>
          </tr>
          <tr v-if="!filteredMissingReports.length">
            <td colspan="5" class="empty-state">没有缺报告的案卷</td>
          </tr>
        </tbody>
      </table>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { loadArchiveState, type ArchiveBoard } from '@/api/archive-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('testing')
const columns = ["委托编号", "试样类型", "检测项目", "送样日期", "检测结果", "报告编号", "检测机构", "委托状态"]
const actions = ["送样委托", "出具报告", "登记不合格"]
const statuses = ["待送样", "检测中", "已出报告", "不合格"]
const stats = [{"label": "待送样委托", "value": 0}, {"label": "检测中委托", "value": 0}, {"label": "不合格项", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
// 竣工资料移交结论：与组卷页、移交页读同一份数据，两边只认一份
const archiveBoard = ref<ArchiveBoard | null>(null)
const reportQuery = ref('')
const handoverRows = computed(() => archiveBoard.value?.handovers ?? [])
const filteredMissingReports = computed(() => {
  const list = archiveBoard.value?.missingReports ?? []
  const query = reportQuery.value.trim()
  return query ? list.filter((item) => item.code.includes(query)) : list
})
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '试验委托登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    archiveBoard.value = loadArchiveState()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '试验检测列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.handover-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 16px;
  margin-top: 16px;
}
.handover-panel h3 { margin: 4px 0 8px; font-size: 15px; }
.handover-panel h4 { margin: 14px 0 6px; font-size: 13px; }
.missing-text { color: #b42318; font-weight: 600; }
</style>
