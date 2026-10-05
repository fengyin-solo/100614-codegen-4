<template>
  <div class="tab-panel">
    <section class="policy-box">
      <h3>缺件口径（只有一份算法）</h3>
      <ul>
        <li>缺件一律以《资料清单》为准：未挂件、试验报告未出具（委托清单不是「已出报告」）、实有页数少于清单要求，都算缺。</li>
        <li>资料清单与委托清单口径打架时，<strong>以资料清单为准</strong>；委托清单只回答「报告出了没有」。</li>
        <li>组卷页与试验检测页实时调用同一份算法，落库前先校验两边缺件数一致。</li>
        <li>当前算法版本：<strong>{{ state.algorithmVersion }}</strong>；换版后已生成的移交记录照新口径整体重算，签收结论不回退。</li>
      </ul>
      <button class="btn" type="button" :disabled="role !== '资料员'" @click="recompute">
        已生成移交记录照现口径重算
      </button>
      <span v-if="role !== '资料员'" class="muted-text">重算仅限资料员账号。</span>
    </section>

    <h3 class="block-title">存量工程迁移</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>单位工程</th>
          <th>编号</th>
          <th>迁移状态</th>
          <th>迁移报告</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="project in state.unitProjects" :key="project.id">
          <td>{{ project.name }}</td>
          <td>{{ project.code }}</td>
          <td>
            <span v-if="migrationOf(project.id)" class="ok-text">已迁移 {{ migrationOf(project.id)!.createdVolumeIds.length }} 卷</span>
            <span v-else class="pending-text">待迁移（散件 {{ looseCount(project.id) }} 份）</span>
          </td>
          <td>
            <template v-if="migrationOf(project.id)">
              <span :class="migrationOf(project.id)!.deficiencies.length ? 'error-text' : 'ok-text'">
                缺件/缺页 {{ migrationOf(project.id)!.deficiencies.length }} 条
              </span>
              <span v-if="migrationOf(project.id)!.looseDocIds.length" class="muted-text">
                ，未归卷散件 {{ migrationOf(project.id)!.looseDocIds.length }} 份
              </span>
            </template>
            <span v-else class="muted-text">迁移后生成</span>
          </td>
          <td>
            <button
              v-if="!migrationOf(project.id) && role === '资料员'"
              class="btn primary"
              type="button"
              @click="migrate(project.id)"
            >
              按单位工程迁移组卷
            </button>
            <span v-else-if="!migrationOf(project.id)" class="muted-text">迁移限资料员</span>
            <button v-else class="link" type="button" @click="toggleReport(project.id)">
              {{ expanded === project.id ? '收起报告' : '查看缺页补齐方式' }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-for="project in state.unitProjects" :key="`report-${project.id}`">
      <section v-if="expanded === project.id && migrationOf(project.id)" class="report-box">
        <h4>{{ project.name }} 迁移报告（{{ formatTime(migrationOf(project.id)!.migratedAt) }}）</h4>
        <p class="muted-text">
          按资料清单类别自动建卷 {{ migrationOf(project.id)!.createdVolumeIds.length }} 卷，自动归卷
          {{ migrationOf(project.id)!.attachedCount }} 份散件；缺页/缺件补齐方式逐条如下。
        </p>
        <table class="data-table">
          <thead>
            <tr><th>卷编号</th><th>清单条目</th><th>问题</th><th>怎么补齐</th></tr>
          </thead>
          <tbody>
            <tr v-for="(item, index) in migrationOf(project.id)!.deficiencies" :key="index">
              <td>{{ item.volumeCode }}</td>
              <td>{{ item.itemName }}</td>
              <td class="error-text">{{ item.missingTypes.join('、') }}</td>
              <td>{{ item.remedy }}</td>
            </tr>
            <tr v-if="!migrationOf(project.id)!.deficiencies.length">
              <td colspan="4" class="empty-state">无缺件，可直接在组卷页提交移交。</td>
            </tr>
          </tbody>
        </table>
        <div v-if="migrationOf(project.id)!.looseDocIds.length" class="loose-box">
          <strong>未归卷散件（对不上清单名称，需人工核实）：</strong>
          <ul>
            <li v-for="docId in migrationOf(project.id)!.looseDocIds" :key="docId">
              {{ docOf(docId)?.name }}（{{ docOf(docId)?.pages }}页，{{ docOf(docId)?.submitter }}）
              —— 先确认应归哪条清单，必要时在组卷页登记/挂接。
            </li>
          </ul>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

import { migrateUnitProject, recomputeExistingBatches } from '@/api/archive-service'
import { looseDocs } from '@/api/archive-service'
import type { ArchiveState, Role } from '@/data/archive/types'

const props = defineProps<{ state: ArchiveState; role: Role }>()
const emit = defineEmits<{
  changed: []
  notify: [text: string, kind?: 'ok' | 'err']
}>()

const expanded = ref<string | null>('U-001')

function migrationOf(unitProjectId: string) {
  return props.state.migrations.find((item) => item.unitProjectId === unitProjectId)
}

function looseCount(unitProjectId: string): number {
  return looseDocs(props.state).filter((doc) => doc.unitProjectId === unitProjectId).length
}

function docOf(docId: string) {
  return props.state.docs.find((doc) => doc.id === docId)
}

function migrate(unitProjectId: string) {
  try {
    migrateUnitProject({ role: props.role, unitProjectId })
    expanded.value = unitProjectId
    emit('changed')
    emit('notify', '存量迁移完成：已按单位工程建卷并自动归卷散件，缺件见迁移报告', 'ok')
  } catch (error) {
    emit('notify', error instanceof Error ? error.message : '迁移失败', 'err')
  }
}

function toggleReport(unitProjectId: string) {
  expanded.value = expanded.value === unitProjectId ? null : unitProjectId
}

function recompute() {
  try {
    const result = recomputeExistingBatches(props.role)
    emit('changed')
    emit('notify', `已按 ${props.state.algorithmVersion} 重算 ${result.recalculated} 个移交批次，签收结论保持不变`, 'ok')
  } catch (error) {
    emit('notify', error instanceof Error ? error.message : '重算失败', 'err')
  }
}

function formatTime(value?: string): string {
  if (!value) {
    return ''
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}
</script>
