<template>
  <section class="page" data-module="archive-handover">
    <header class="page-head">
      <div>
        <h2>竣工资料移交签收</h2>
        <p class="page-desc">
          多卷一组一次提交，建设单位逐卷核对后整组签收；任何一卷缺件整组退回重报并点名到卷。
          签收结论与组卷页、试验检测页共用同一份数据（{{ board?.rulesVersion }}）。当前角色：{{ store.role }}。
        </p>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th>移交编号</th>
          <th>卷数</th>
          <th>案卷列表</th>
          <th>缺件卷（点名）</th>
          <th>状态</th>
          <th>首次提交</th>
          <th>最近提交</th>
          <th>签收人 / 时间</th>
          <th>结论 / 退回原因</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="row in handovers" :key="String(row['移交编号'])">
          <tr>
            <td>{{ row['移交编号'] }}</td>
            <td>{{ row['卷数'] }}</td>
            <td>{{ row['案卷列表'] }}</td>
            <td>
              <span v-if="row['缺件卷']" class="missing-text">{{ row['缺件卷'] }}</span>
              <span v-else>—</span>
            </td>
            <td>{{ row.status }}</td>
            <td>{{ row['首次提交时间'] }}</td>
            <td>{{ row['最近提交时间'] }}</td>
            <td>{{ row['签收人'] || '—' }} {{ row['签收时间'] || '' }}</td>
            <td class="note-cell">
              <span v-if="row['结论']">{{ row['结论'] }}</span>
              <span v-if="row['退回原因']" class="missing-text">（{{ row['退回原因'] }}）</span>
              <span v-if="!row['结论'] && !row['退回原因']">—</span>
            </td>
            <td class="row-actions">
              <button class="link" type="button" @click="toggleCheck(String(row['移交编号']))">
                {{ checkCode === String(row['移交编号']) ? '收起核对' : '逐卷核对' }}
              </button>
              <template v-if="row.status === '待签收' && store.isOwner">
                <button class="link" type="button" @click="sign(String(row['移交编号']))">核对并签收</button>
                <button class="link" type="button" @click="sendBack(String(row['移交编号']))">整组退回</button>
              </template>
            </td>
          </tr>
          <tr v-if="checkCode === String(row['移交编号'])">
            <td colspan="10">
              <table class="data-table check-table">
                <thead>
                  <tr>
                    <th>案卷编号</th><th>案卷题名</th><th>单位工程</th>
                    <th>当前状态</th><th>缺件数</th><th>缺项明细</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="code in volumeCodes(row)" :key="code">
                    <td>{{ code }}</td>
                    <td>{{ volumeOf(code)?.['案卷题名'] ?? '（卷已不存在）' }}</td>
                    <td>{{ volumeOf(code)?.['单位工程'] ?? '—' }}</td>
                    <td>{{ volumeOf(code)?.status ?? '—' }}</td>
                    <td>
                      <span v-if="missingOf(code).count > 0" class="missing-text">
                        缺 {{ missingOf(code).count }} 项
                      </span>
                      <span v-else>齐</span>
                    </td>
                    <td>{{ missingOf(code).missing.join('、') || '—' }}</td>
                  </tr>
                </tbody>
              </table>
              <p class="page-desc">
                缺件数按资料清单现算，与组卷页、试验检测页读到的是同一份；退回次数：{{ row['退回次数'] }}。
              </p>
            </td>
          </tr>
        </template>
        <tr v-if="!handovers.length">
          <td colspan="10" class="empty-state">还没有移交记录，请先在组卷页勾选卷册提交移交</td>
        </tr>
      </tbody>
    </table>

    <p class="page-desc role-hint">
      权限口径：资料员负责建卷、挂资料、提交移交；建设单位账号逐卷核对后签收，
      签收后该账号对本组卷册即转只读，已签收卷册只能由资料员追加补充说明，不能改回待移交。
    </p>

    <footer class="page-foot">
      <span>共 {{ handovers.length }} 组移交记录</span>
      <span v-if="message" :class="{ 'error-text': isError }">{{ message }}</span>
      <button v-if="verifyFailed" class="btn" type="button" @click="verify">核对失败，点击重试</button>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  loadArchiveState,
  loadVerifiedState,
  returnHandover,
  signHandover,
  type ArchiveBoard,
} from '@/api/archive-service'
import { splitVolumeCodes } from '@/data/archive-rules'
import type { ActionResult, EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const store = useSessionStore()

const board = ref<ArchiveBoard | null>(null)
const message = ref('')
const isError = ref(false)
const verifyFailed = ref(false)
const checkCode = ref('')

const handovers = computed(() =>
  [...(board.value?.handovers ?? [])].sort((a, b) => Number(b.id) - Number(a.id)),
)

const stats = computed(() => {
  const list = board.value?.handovers ?? []
  return [
    { label: '待签收', value: list.filter((h) => h.status === '待签收').length },
    { label: '已签收', value: list.filter((h) => h.status === '已签收').length },
    { label: '已退回', value: list.filter((h) => h.status === '已退回').length },
    { label: '缺报告案卷', value: board.value?.missingReports.length ?? 0 },
  ]
})

function volumeCodes(row: EntryRow): string[] {
  return splitVolumeCodes(row['案卷列表'])
}

function volumeOf(code: string): EntryRow | undefined {
  return (board.value?.volumes ?? []).find((v) => String(v['案卷编号']) === code)
}

function missingOf(code: string) {
  return board.value?.missing[code] ?? { missing: [], count: 0 }
}

function toggleCheck(code: string) {
  checkCode.value = checkCode.value === code ? '' : code
}

function apply(result: ActionResult) {
  message.value = result.message
  isError.value = !result.ok
  if (result.ok) {
    verify()
  }
}

/** 签收/退回之后强制重读核对，中途断掉就重试，不拿老数据兜底。 */
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

function sign(code: string) {
  apply(signHandover(code, store.role, store.roleOperator))
}

function sendBack(code: string) {
  const reason = window.prompt('请写明整组退回的原因')
  if (reason === null) return
  apply(returnHandover(code, reason, store.role, store.roleOperator))
}

onMounted(() => {
  board.value = loadArchiveState()
  verify()
})
</script>

<style scoped>
.missing-text { color: #b42318; font-weight: 600; }
.note-cell { max-width: 320px; white-space: pre-wrap; }
.check-table { margin: 4px 0; }
.role-hint { margin-top: 10px; }
</style>
