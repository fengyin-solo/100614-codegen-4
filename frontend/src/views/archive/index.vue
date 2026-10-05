<template>
  <section class="page archive-page">
    <header class="page-head">
      <div>
        <h2>竣工资料组卷与移交</h2>
        <p class="page-desc">
          按单位工程建案卷，资料清单缺项的案卷不允许提交；多卷一次移交、逐卷核对后整组签收，任何一卷缺件整组退回并点名到卷。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn ghost" type="button" @click="reload">重新进入核对（现读库）</button>
        <button class="btn ghost" type="button" @click="confirmReset">重置演示数据</button>
      </div>
    </header>

    <div class="role-banner" :class="store.role === '资料员' ? 'role-clerk' : 'role-owner'">
      <strong>{{ store.role }}账号 · {{ store.operator }}</strong>
      <span>{{ store.accountDesc }}</span>
      <span class="role-switch-hint">切换账号：右上角下拉选择。</span>
    </div>

    <nav class="tab-bar">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab-btn"
        :class="{ active: activeTab === tab.key }"
        type="button"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}
        <em v-if="tab.key === 'volumes' && missingTotal > 0" class="tab-badge">{{ missingTotal }}</em>
        <em v-if="tab.key === 'batches' && pendingBatchCount > 0" class="tab-badge">{{ pendingBatchCount }}</em>
      </button>
    </nav>

    <p v-if="message" class="result-line" :class="messageKind">{{ message }}</p>

    <VolumesTab
      v-if="activeTab === 'volumes'"
      :state="state"
      :role="store.role"
      :operator="store.operator"
      @changed="reload"
      @notify="notify"
      @go-batches="activeTab = 'batches'"
    />
    <BatchesTab
      v-if="activeTab === 'batches'"
      :state="state"
      :role="store.role"
      :operator="store.operator"
      @changed="reload"
      @notify="notify"
    />
    <MigrationTab
      v-if="activeTab === 'migration'"
      :state="state"
      :role="store.role"
      @changed="reload"
      @notify="notify"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { batchViews, loadArchive, volumeViews } from '@/api/archive-service'
import { resetArchive } from '@/data/archive/store'
import type { ArchiveState } from '@/data/archive/types'
import { useSessionStore } from '@/stores/session'

import BatchesTab from './components/BatchesTab.vue'
import MigrationTab from './components/MigrationTab.vue'
import VolumesTab from './components/VolumesTab.vue'

const store = useSessionStore()
const activeTab = ref<'volumes' | 'batches' | 'migration'>('volumes')
const state = ref<ArchiveState>(loadArchive())
const message = ref('')
const messageKind = ref<'ok' | 'err'>('ok')

const tabs = [
  { key: 'volumes', label: '组卷' },
  { key: 'batches', label: '移交批次' },
  { key: 'migration', label: '存量迁移与口径' },
] as const

const missingTotal = computed(() => volumeViews(state.value).filter((item) => item.missingCount > 0).length)
const pendingBatchCount = computed(
  () => batchViews(state.value).filter((item) => item.batch.outcome === '待核对').length,
)

function notify(text: string, kind: 'ok' | 'err' = 'ok') {
  message.value = text
  messageKind.value = kind
}

function reload() {
  // 业务动作后重新「进页面」：现读库核对，不使用任何旧内存兜底。
  state.value = loadArchive()
}

function confirmReset() {
  if (window.confirm('确定把档案域数据重置为示例数据？本机浏览器内的组卷/移交记录都会清空。')) {
    resetArchive()
    reload()
    notify('已重置为示例数据', 'ok')
  }
}

onMounted(reload)
</script>
