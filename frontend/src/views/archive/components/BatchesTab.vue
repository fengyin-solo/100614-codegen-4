<template>
  <div class="tab-panel">
    <p class="hint-line">
      多选卷册在「组卷」页一次提交；这里逐卷核对后整组签收——任何一卷缺件，整组退回重报并点名到卷。
      重报按原卷册再递时沿用最早批次号。
    </p>

    <div v-for="view in views" :key="view.batch.id" class="batch-card" :class="outcomeClass(view.batch.outcome)">
      <header class="batch-head">
        <div>
          <strong>{{ view.batch.code }}</strong>
          <span class="status-pill" :class="outcomeClass(view.batch.outcome)">{{ view.batch.outcome }}</span>
          <span class="muted-text">第 {{ view.batch.submitNo }} 次提交 · 首次 {{ formatTime(view.batch.firstSubmittedAt) }}</span>
        </div>
        <div class="row-actions">
          <button class="btn" type="button" @click="exportReceipt(view.batch.id)">打印/导出签收单</button>
          <button
            v-if="role === '建设单位' && view.batch.outcome === '待核对'"
            class="btn primary"
            type="button"
            @click="review(view.batch.id)"
          >
            逐卷核对并整组签收
          </button>
        </div>
      </header>

      <dl class="batch-meta">
        <div><dt>单位工程</dt><dd>{{ view.unitProjects.map((item) => item.name).join('、') }}</dd></div>
        <div><dt>移交人</dt><dd>{{ view.batch.submitter }}</dd></div>
        <div v-if="view.batch.signer"><dt>签收人</dt><dd>{{ view.batch.signer }}（{{ formatTime(view.batch.signedAt) }}）</dd></div>
        <div>
          <dt>现口径缺件</dt>
          <dd :class="view.liveMissingCount ? 'error-text' : 'ok-text'">
            {{ view.liveMissingCount }} 项
            <span class="muted-text">（按 {{ ALGORITHM_VERSION }} 实时重算，与试验检测页同一份）</span>
          </dd>
        </div>
      </dl>

      <table class="data-table">
        <thead>
          <tr>
            <th>卷编号</th>
            <th>类别</th>
            <th>清单/已挂</th>
            <th>卷状态</th>
            <th>核对结果</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="volumeView in view.volumes" :key="volumeView.volume.id" :class="{ 'row-missing': volumeView.missingCount > 0 }">
            <td>{{ volumeView.volume.code }}</td>
            <td>{{ volumeView.volume.category }}</td>
            <td>{{ volumeView.volume.itemIds.length }} / {{ volumeView.volume.attachments.filter((a) => a.docId).length }}</td>
            <td><span class="status-pill" :class="statusClass(volumeView.volume.status)">{{ volumeView.volume.status }}</span></td>
            <td>
              <span v-if="!volumeView.missingEntries.length" class="ok-text">✓ 齐全</span>
              <div v-for="entry in volumeView.missingEntries" :key="entry.itemId" class="missing-line">
                <span class="error-text">✗ {{ entry.itemName }}</span>
                <span class="muted-text">
                  （{{ entry.missingTypes.join('、')
                  }}<template v-if="entry.missingTypes.includes('页数不足')">：{{ entry.actualPages ?? 0 }}/{{ entry.requiredPages }}页</template>）
                </span>
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-if="view.batch.rejectReason" class="reject-box">
        <strong>整组退回（{{ formatTime(view.batch.rejectReason.at) }}），点名到卷：</strong>
        <ul>
          <li v-for="deficient in view.batch.rejectReason.deficientVolumes" :key="deficient.volumeId">
            <span class="error-text">{{ deficient.volumeCode }}</span>：
            {{ deficient.entries.map((entry) => `${entry.itemName}（${entry.missingTypes.join('、')}）`).join('；') }}
          </li>
        </ul>
      </div>

      <details class="event-log">
        <summary>流转记录（{{ view.batch.events.length }}）</summary>
        <ul>
          <li v-for="(log, index) in view.batch.events" :key="index">
            <span class="muted-text">{{ formatTime(log.at) }} · {{ log.role }}</span>
            <strong>{{ log.action }}</strong>
            <span>{{ log.detail }}</span>
          </li>
        </ul>
      </details>
    </div>

    <p v-if="!views.length" class="empty-state">还没有移交批次，先到「组卷」页勾选齐套卷册提交。</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

import { batchViews, exportBatchReceipt, reviewBatch, type BatchView } from '@/api/archive-service'
import type { ArchiveState, BatchOutcome, Role, VolumeStatus } from '@/data/archive/types'
import { ALGORITHM_VERSION } from '@/data/archive/types'

const props = defineProps<{ state: ArchiveState; role: Role; operator: string }>()
const emit = defineEmits<{
  changed: []
  notify: [text: string, kind?: 'ok' | 'err']
}>()

const views = computed<BatchView[]>(() => batchViews(props.state))

function review(batchId: string) {
  try {
    const result = reviewBatch({ role: props.role, operator: props.operator, batchId })
    emit('changed')
    if (result.signed) {
      emit('notify', '逐卷核对齐全，整组签收完成，卷册已转只读', 'ok')
    } else {
      const names = result.deficient.map((item) => item.volumeCode).join('、')
      emit('notify', `整组退回重报，缺件点名到卷：${names}；卷册已全部回到组卷中`, 'err')
    }
  } catch (error) {
    emit('notify', error instanceof Error ? error.message : '核对失败', 'err')
  }
}

function exportReceipt(batchId: string) {
  try {
    const { filename, content } = exportBatchReceipt(batchId)
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
  } catch (error) {
    emit('notify', error instanceof Error ? error.message : '导出失败', 'err')
  }
}

function outcomeClass(outcome: BatchOutcome): string {
  return outcome === '已签收' ? 'st-signed' : outcome === '已退回' ? 'st-rejected' : 'st-pending'
}
function statusClass(status: VolumeStatus): string {
  return status === '已签收' ? 'st-signed' : status === '待移交' ? 'st-pending' : 'st-composing'
}
function formatTime(value?: string): string {
  if (!value) {
    return ''
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}
</script>
