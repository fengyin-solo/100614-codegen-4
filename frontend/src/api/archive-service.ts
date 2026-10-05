import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

import {
  assertCrossEntryConsistency,
  computeBatchMissing,
  computeVolumeMissing,
  isReportReady,
  recalcBatchSnapshot,
  snapshotOf,
  type TestingEvidence,
} from '../data/archive/algorithm'
import { commitArchive, readArchive } from '../data/archive/store'
import { ALGORITHM_VERSION } from '../data/archive/types'
import type {
  ArchiveDoc,
  ArchiveState,
  BatchEvent,
  ChecklistItem,
  DocCategory,
  HandoverBatch,
  MissingEntry,
  MissingType,
  Role,
  UnitProject,
  Volume,
} from '../data/archive/types'

// ─────────────────────────────────────────────────────────────────────────────
// 读取与口径装配
// ─────────────────────────────────────────────────────────────────────────────

function testingRows(): EntryRow[] {
  return listRows('testing')
}

/** 委托清单证据：报告出了没有，只认试验检测模块这一处。 */
function evidenceOf(testingRef: string): TestingEvidence | undefined {
  const row = testingRows().find((item) => String(item['委托编号'] ?? '') === testingRef)
  if (!row) {
    return { exists: false, status: '', reportNo: '' }
  }
  return {
    exists: true,
    status: String(row.status ?? ''),
    reportNo: String(row['报告编号'] ?? ''),
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function event(role: Role, action: string, detail: string): BatchEvent {
  return { at: nowIso(), role, action, detail }
}

/**
 * 载入档案库：若还是旧口径（v1），先把已生成的移交记录按新口径整体重算一遍再返回。
 * 重算只刷快照与缺件点名，签收结论不回退。
 */
export function loadArchive(): ArchiveState {
  const state = readArchive()
  if (state.algorithmVersion === ALGORITHM_VERSION) {
    return state
  }
  return commitArchive((draft) => {
    draft.algorithmVersion = ALGORITHM_VERSION
    draft.batches = draft.batches.map((batch) => {
      const recalculated = recalcBatchSnapshot(draft, batch, evidenceOf)
      const count = recalculated.snapshots.重算?.missingCount ?? 0
      return {
        ...recalculated,
        events: [
          ...recalculated.events,
          event(
            '资料员',
            '口径换版重算',
            `缺件口径升级为 ${ALGORITHM_VERSION}，本批次历史移交记录照新口径重算：现缺 ${count} 项；签收/退回结论不回退。`,
          ),
        ],
      }
    })
  })
}

export function listUnitProjects(): UnitProject[] {
  return loadArchive().unitProjects
}

export function projectNameOf(state: ArchiveState, unitProjectId: string): string {
  return state.unitProjects.find((item) => item.id === unitProjectId)?.name ?? unitProjectId
}

// ─────────────────────────────────────────────────────────────────────────────
// 读模型：组卷侧与试验检测侧都从这里取，保证只认一份
// ─────────────────────────────────────────────────────────────────────────────

export type VolumeView = {
  volume: Volume
  unitProject: UnitProject
  missingCount: number
  missingEntries: MissingEntry[]
  /** 该卷当前所在批次（待核对/最近一次）。 */
  activeBatch?: HandoverBatch
  lastBatch?: HandoverBatch
}

function batchOfVolume(state: ArchiveState, volumeId: string): { active?: HandoverBatch; last?: HandoverBatch } {
  const linked = state.batches
    .filter((batch) => batch.volumeIds.includes(volumeId))
    .sort((a, b) => (a.firstSubmittedAt < b.firstSubmittedAt ? 1 : -1))
  return {
    active: linked.find((batch) => batch.outcome === '待核对'),
    last: linked[0],
  }
}

export function volumeViews(state: ArchiveState): VolumeView[] {
  return state.volumes.map((volume) => {
    const missing = computeVolumeMissing(state, volume, evidenceOf)
    const links = batchOfVolume(state, volume.id)
    return {
      volume,
      unitProject: state.unitProjects.find((item) => item.id === volume.unitProjectId)!,
      missingCount: missing.count,
      missingEntries: missing.entries,
      activeBatch: links.active,
      lastBatch: links.last,
    }
  })
}

export type BatchView = {
  batch: HandoverBatch
  unitProjects: UnitProject[]
  volumes: { volume: Volume; missingCount: number; missingEntries: MissingEntry[] }[]
  liveMissingCount: number
}

export function batchViews(state: ArchiveState): BatchView[] {
  return [...state.batches]
    .sort((a, b) => (a.firstSubmittedAt < b.firstSubmittedAt ? 1 : -1))
    .map((batch) => {
      const live = computeBatchMissing(state, batch.volumeIds, evidenceOf)
      return {
        batch,
        unitProjects: state.unitProjects.filter((item) => batch.unitProjectIds.includes(item.id)),
        volumes: batch.volumeIds.map((id) => {
          const volume = state.volumes.find((item) => item.id === id)!
          const missing = live.volumes.find((item) => item.volumeId === id)
          return { volume, missingCount: missing?.count ?? 0, missingEntries: missing?.entries ?? [] }
        }),
        liveMissingCount: live.count,
      }
    })
}

/** 没有挂进任何卷的散件：迁移与组卷时人工认领的候选。 */
export function looseDocs(state: ArchiveState): ArchiveDoc[] {
  const used = new Set(
    state.volumes.flatMap((volume) =>
      volume.attachments.map((attachment) => attachment.docId).filter((id): id is string => !!id),
    ),
  )
  return state.docs.filter((doc) => !used.has(doc.id))
}

/**
 * 试验报告类缺件涉及的卷（编号集合）——组卷页与试验检测页显示同一个数。
 */
export function testingReportDeficientVolumeIds(state: ArchiveState): string[] {
  const ids = new Set<string>()
  for (const volume of state.volumes) {
    const missing = computeVolumeMissing(state, volume, evidenceOf)
    if (missing.entries.some((entry) => entry.category === '试验报告')) {
      ids.add(volume.id)
    }
  }
  return [...ids]
}

/** 试验检测页的逐行结论：委托清单在这里能查到卷、缺件点名和最终签收结论。 */
export type TestingArchiveRow = {
  row: EntryRow
  reportReady: boolean
  links: {
    unitProjectId: string
    unitProjectName: string
    item: ChecklistItem
    volume?: Volume
    volumeCode?: string
    volumeStatus?: string
    missingTypes: MissingType[]
    batchCode?: string
    batchOutcome?: HandoverBatch['outcome']
    signedAt?: string
    rejectAt?: string
  }[]
}

export function testingArchiveRows(): TestingArchiveRow[] {
  const state = loadArchive()
  return testingRows().map((row) => {
    const ref = String(row['委托编号'] ?? '')
    const evidence: TestingEvidence = {
      exists: true,
      status: String(row.status ?? ''),
      reportNo: String(row['报告编号'] ?? ''),
    }
    const items = state.checklist.filter((item) => item.testingRef === ref)
    const links = items.map((item) => {
      const volume = state.volumes.find((candidate) => candidate.itemIds.includes(item.id))
      const missing = volume
        ? computeVolumeMissing(state, volume, evidenceOf).entries.find((entry) => entry.itemId === item.id)
        : undefined
      const batchLinks = volume ? batchOfVolume(state, volume.id) : undefined
      const active = batchLinks?.active ?? batchLinks?.last
      return {
        unitProjectId: item.unitProjectId,
        unitProjectName: projectNameOf(state, item.unitProjectId),
        item,
        volume,
        volumeCode: volume?.code,
        volumeStatus: volume?.status,
        missingTypes: missing?.missingTypes ?? [],
        batchCode: active?.code,
        batchOutcome: active?.outcome,
        signedAt: active?.signedAt,
        rejectAt: active?.rejectReason?.at,
      }
    })
    return { row, reportReady: isReportReady(evidence), links }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 组卷：只有资料员能改案卷构成；状态机单向
// ─────────────────────────────────────────────────────────────────────────────

function requireRole(role: Role, expected: Role, action: string): void {
  if (role !== expected) {
    throw new Error(`${action}仅限${expected}账号，当前是${role}账号`)
  }
}

function requireComposing(volume: Volume): void {
  if (volume.status !== '组卷中') {
    throw new Error(
      volume.status === '已签收'
        ? `案卷 ${volume.code} 已签收，构成只读，只能补充说明`
        : `案卷 ${volume.code} 已在待移交批次中，不能再改构成；若被退回会自动回到组卷中`,
    )
  }
}

function nextDocId(state: ArchiveState): string {
  // 时间戳同毫秒会撞号（连续同步多份报告时实测撞过）：加随机后缀并去重。
  const base = `D-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
  let id = base
  let n = 1
  while (state.docs.some((doc) => doc.id === id)) {
    id = `${base}-${n++}`
  }
  return id
}

/** 登记散件：试验报告不允许手工补，只能从试验检测委托清单出具后同步入池。 */
export function registerDoc(input: {
  role: Role
  operator: string
  unitProjectId: string
  category: Exclude<DocCategory, '试验报告'>
  name: string
  pages: number
}): ArchiveState {
  requireRole(input.role, '资料员', '登记资料')
  const name = input.name.trim()
  if (!name) {
    throw new Error('资料名称不能为空')
  }
  if (!Number.isInteger(input.pages) || input.pages <= 0) {
    throw new Error('实有页数必须是正整数')
  }
  return commitArchive((draft) => {
    if (!draft.unitProjects.some((item) => item.id === input.unitProjectId)) {
      throw new Error('请选择有效的单位工程')
    }
    draft.docs.push({
      id: nextDocId(draft),
      unitProjectId: input.unitProjectId,
      category: input.category,
      name,
      pages: input.pages,
      submitter: input.operator,
      submittedAt: nowIso(),
    })
  })
}

export function attachDoc(input: {
  role: Role
  volumeId: string
  itemId: string
  docId: string
}): ArchiveState {
  requireRole(input.role, '资料员', '调整案卷构成')
  return commitArchive((draft) => {
    const volume = draft.volumes.find((item) => item.id === input.volumeId)
    if (!volume) {
      throw new Error('没有找到这一卷')
    }
    requireComposing(volume)
    if (!volume.itemIds.includes(input.itemId)) {
      throw new Error('该清单条目不属于这一卷')
    }
    const item = draft.checklist.find((candidate) => candidate.id === input.itemId)
    if (!item) {
      throw new Error('清单条目不存在')
    }
    const doc = draft.docs.find((candidate) => candidate.id === input.docId)
    if (!doc) {
      throw new Error('资料不存在或已被移除')
    }
    if (doc.unitProjectId !== volume.unitProjectId || doc.category !== item.category) {
      throw new Error('资料的单位工程或类别与清单条目对不上，不能挂接')
    }
    if (item.category === '试验报告') {
      const evidence = item.testingRef ? evidenceOf(item.testingRef) : undefined
      if (!isReportReady(evidence)) {
        throw new Error(
          `《${item.name}》对应的委托 ${item.testingRef ?? ''} 尚未在试验检测清单出具报告，不能作为已到卷资料`,
        )
      }
      if (doc.syncedFromTesting === undefined || doc.testingRef !== item.testingRef) {
        throw new Error('试验报告只能挂委托清单出具后同步入池、且委托编号一致的那一份')
      }
    }
    // 同一份资料只能在一卷内：两边入口只认一份，禁止一稿两挂。
    const occupied = draft.volumes.find(
      (candidate) =>
        candidate.id !== volume.id &&
        candidate.attachments.some((attachment) => attachment.docId === doc.id),
    )
    if (occupied) {
      throw new Error(`该资料已挂在案卷 ${occupied.code} 中，不能重复装卷`)
    }
    const others = volume.attachments.filter((attachment) => attachment.itemId !== input.itemId)
    volume.attachments = [
      ...others,
      { itemId: input.itemId, docId: doc.id, attachedAt: nowIso() },
    ]
    volume.updatedAt = nowIso()
    assertCrossEntryConsistency(draft, [volume.id], evidenceOf)
  })
}

export function detachDoc(input: { role: Role; volumeId: string; itemId: string }): ArchiveState {
  requireRole(input.role, '资料员', '调整案卷构成')
  return commitArchive((draft) => {
    const volume = draft.volumes.find((item) => item.id === input.volumeId)
    if (!volume) {
      throw new Error('没有找到这一卷')
    }
    requireComposing(volume)
    if (!volume.attachments.some((attachment) => attachment.itemId === input.itemId)) {
      throw new Error('这一卷没有挂这条资料')
    }
    volume.attachments = volume.attachments.filter((attachment) => attachment.itemId !== input.itemId)
    volume.updatedAt = nowIso()
    assertCrossEntryConsistency(draft, [volume.id], evidenceOf)
  })
}

/** 缺页补齐登记：追回原件后按实测页数修正卷内页数（资料原件页数留痕，不动资料池）。 */
export function fixPages(input: {
  role: Role
  volumeId: string
  itemId: string
  actualPages: number
}): ArchiveState {
  requireRole(input.role, '资料员', '补页登记')
  if (!Number.isInteger(input.actualPages) || input.actualPages <= 0) {
    throw new Error('实有页数必须是正整数')
  }
  return commitArchive((draft) => {
    const volume = draft.volumes.find((item) => item.id === input.volumeId)
    if (!volume) {
      throw new Error('没有找到这一卷')
    }
    requireComposing(volume)
    const index = volume.attachments.findIndex((attachment) => attachment.itemId === input.itemId)
    if (index < 0) {
      throw new Error('请先把资料挂进卷内再登记补页')
    }
    volume.attachments[index] = {
      ...volume.attachments[index],
      actualPages: input.actualPages,
      remark: `缺页追回后修正为 ${input.actualPages} 页`,
    }
    volume.updatedAt = nowIso()
    assertCrossEntryConsistency(draft, [volume.id], evidenceOf)
  })
}

/** 已签收卷只能补说明；其余状态也允许留痕，但说明不改构成、不改结论。 */
export function addVolumeNote(input: { role: Role; volumeId: string; text: string }): ArchiveState {
  const text = input.text.trim()
  if (!text) {
    throw new Error('说明内容不能为空')
  }
  return commitArchive((draft) => {
    const volume = draft.volumes.find((item) => item.id === input.volumeId)
    if (!volume) {
      throw new Error('没有找到这一卷')
    }
    volume.notes.push({ at: nowIso(), role: input.role, text })
    volume.updatedAt = nowIso()
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 存量迁移：按单位工程一次建卷，散件自动对名归卷，缺页/缺报告点名并给补齐路径
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORY_CODE: Record<DocCategory, string> = {
  施工记录: 'SG',
  测量成果: 'CL',
  试验报告: 'SY',
}

function remedyFor(itemName: string, types: MissingType[], testingRef?: string): string {
  if (types.includes('试验报告未出具')) {
    return `《${itemName}》对应的委托 ${testingRef ?? ''} 尚未出具报告：到「试验检测」页对该委托送样并出具报告，系统自动入资料池后回卷内补挂（试验报告不许手工补）。`
  }
  if (types.includes('未挂件')) {
    return `按资料清单《${itemName}》补齐资料：施工记录/测量成果先在组卷页「登记散件」，再挂进本卷。`
  }
  if (types.includes('页数不足')) {
    return `追回缺页原件后，在卷内对《${itemName}》做「补页/修正页数」，直到达到清单要求页数。`
  }
  return ''
}

export function migrateUnitProject(input: {
  role: Role
  unitProjectId: string
}): ArchiveState {
  requireRole(input.role, '资料员', '存量迁移')
  return commitArchive((draft) => {
    const project = draft.unitProjects.find((item) => item.id === input.unitProjectId)
    if (!project) {
      throw new Error('没有找到这个单位工程')
    }
    if (draft.migrations.some((item) => item.unitProjectId === project.id)) {
      throw new Error(`${project.name}已经迁移组卷过，不能重复迁移；缺件直接在组卷页补齐`)
    }
    if (draft.volumes.some((item) => item.unitProjectId === project.id)) {
      throw new Error(`${project.name}下已有案卷，迁移中止（幂等保护）`)
    }
    const items = draft.checklist.filter((item) => item.unitProjectId === project.id)
    if (items.length === 0) {
      throw new Error(`${project.name}还没有资料清单，无法按单位工程组卷`)
    }
    const categories = [...new Set(items.map((item) => item.category))]
    const createdVolumeIds: string[] = []
    const matchedDocIds = new Set<string>()
    const unitSuffix = project.id.replace('-', '')

    for (const category of categories) {
      const categoryItems = items.filter((item) => item.category === category)
      const volumeId = `V-${unitSuffix}-${CATEGORY_CODE[category]}`
      const attachments = categoryItems
        .map((item) => {
          // 散件按「单位工程 + 类别 + 清单名称」对名归卷；对不上的留作 loose。
          const doc = draft.docs.find(
            (candidate) =>
              candidate.unitProjectId === project.id &&
              candidate.category === category &&
              candidate.name === item.name,
          )
          if (doc) {
            matchedDocIds.add(doc.id)
            return { itemId: item.id, docId: doc.id, attachedAt: nowIso() }
          }
          return undefined
        })
        .filter((attachment): attachment is { itemId: string; docId: string; attachedAt: string } => !!attachment)
      draft.volumes.push({
        id: volumeId,
        code: `${CATEGORY_CODE[category]}-2026-${unitSuffix}`,
        unitProjectId: project.id,
        category,
        itemIds: categoryItems.map((item) => item.id),
        attachments,
        status: '组卷中',
        notes: [
          {
            at: nowIso(),
            role: '资料员',
            text: '按单位工程存量迁移自动建卷，散件按资料清单名称归卷，缺件见迁移报告。',
          },
        ],
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      createdVolumeIds.push(volumeId)
    }

    const deficiencies = []
    for (const volumeId of createdVolumeIds) {
      const volume = draft.volumes.find((item) => item.id === volumeId)!
      const missing = computeVolumeMissing(draft, volume, evidenceOf)
      for (const entry of missing.entries) {
        deficiencies.push({
          volumeId: volume.id,
          volumeCode: volume.code,
          itemId: entry.itemId,
          itemName: entry.itemName,
          missingTypes: entry.missingTypes,
          remedy: remedyFor(entry.itemName, entry.missingTypes, entry.testingRef),
        })
      }
    }

    draft.migrations.push({
      unitProjectId: project.id,
      migratedAt: nowIso(),
      createdVolumeIds,
      attachedCount: matchedDocIds.size,
      deficiencies,
      looseDocIds: draft.docs
        .filter((doc) => doc.unitProjectId === project.id && !matchedDocIds.has(doc.id))
        .map((doc) => doc.id),
    })
    assertCrossEntryConsistency(draft, createdVolumeIds, evidenceOf)
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 移交提交：多选卷册一次提交；缺项整组不允许提交；重报沿用最早批次
// ─────────────────────────────────────────────────────────────────────────────

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|')
}

export function submitVolumes(input: {
  role: Role
  operator: string
  volumeIds: string[]
}): { batchId: string; reused: boolean } {
  requireRole(input.role, '资料员', '提交移交')
  const ids = [...new Set(input.volumeIds)]
  if (ids.length === 0) {
    throw new Error('请至少勾选一卷再提交')
  }
  let batchId = ''
  let reused = false
  commitArchive((draft) => {
    const volumes = ids.map((id) => {
      const volume = draft.volumes.find((candidate) => candidate.id === id)
      if (!volume) {
        throw new Error(`卷 ${id} 不存在，提交整体撤销`)
      }
      return volume
    })
    for (const volume of volumes) {
      if (volume.status === '待移交') {
        throw new Error(`案卷 ${volume.code} 已在待核对批次中，不能重复提交`)
      }
      if (volume.status === '已签收') {
        throw new Error(`案卷 ${volume.code} 已签收，结论不能改回待移交`)
      }
    }
    // 落库前：双入口口径校验 + 现算法判定，任何一卷缺件都不允许提交。
    assertCrossEntryConsistency(draft, ids, evidenceOf)
    const missing = computeBatchMissing(draft, ids, evidenceOf)
    if (missing.count > 0) {
      const named = missing.volumes
        .filter((item) => item.count > 0)
        .map((item) => {
          const volume = draft.volumes.find((candidate) => candidate.id === item.volumeId)!
          return `${volume.code}（${item.entries
            .map((entry) => `${entry.itemName}：${entry.missingTypes.join('、')}`)
            .join('；')}）`
        })
        .join('；')
      throw new Error(`资料清单缺项，不允许提交移交：${named}`)
    }

    // 再递一遍仍按最早那次：卷册集合与某个已退回批次完全相同 → 沿用原批次。
    // 只报其中一部分不允许：防止老批次残留不再提交的卷引用。
    const rejectedBatches = draft.batches.filter((batch) => batch.outcome === '已退回')
    const overlapped = rejectedBatches.find((batch) => batch.volumeIds.some((id) => ids.includes(id)))
    if (overlapped && !sameSet(overlapped.volumeIds, ids)) {
      throw new Error(
        `所选卷册属于已退回批次 ${overlapped.code}，重报必须整组原卷册再递（可补齐缺件后整组重报）`,
      )
    }
    const prior = rejectedBatches.find((batch) => sameSet(batch.volumeIds, ids))
    const unitProjectIds = [...new Set(volumes.map((volume) => volume.unitProjectId))]
    const stamp = nowIso()
    for (const volume of volumes) {
      volume.status = '待移交'
      volume.updatedAt = stamp
    }
    if (prior) {
      reused = true
      batchId = prior.id
      prior.outcome = '待核对'
      prior.submittedAt = stamp
      prior.submitter = input.operator
      prior.submitNo += 1
      prior.rejectReason = undefined
      prior.snapshots = {
        ...prior.snapshots,
        [`重报${prior.submitNo}`]: snapshotOf(missing),
      }
      prior.events.push(
        event('资料员', '重新提交', `按原卷册第 ${prior.submitNo} 次提交，沿用最早批次 ${prior.code}，双入口缺件校验通过。`),
      )
    } else {
      draft.seq.batch += 1
      const seq = draft.seq.batch
      batchId = `B-${String(seq).padStart(4, '0')}`
      const code = `YJ-2026-${String(seq).padStart(3, '0')}`
      const batch: HandoverBatch = {
        id: batchId,
        code,
        unitProjectIds,
        volumeIds: ids,
        outcome: '待核对',
        submitter: input.operator,
        firstSubmittedAt: stamp,
        submittedAt: stamp,
        submitNo: 1,
        snapshots: { 提交: snapshotOf(missing) },
        events: [event('资料员', '提交移交', `${ids.length} 卷一次性提交，双入口缺件校验通过。`)],
      }
      draft.batches.push(batch)
    }
  })
  return { batchId, reused }
}

// ─────────────────────────────────────────────────────────────────────────────
// 建设单位核对：逐卷核对后整组签收；任何一卷缺件 → 整组退回并点名到卷
// ─────────────────────────────────────────────────────────────────────────────

export type SignResult =
  | { signed: true; batchId: string }
  | {
      signed: false
      batchId: string
      deficient: { volumeCode: string; volumeId: string; entries: MissingEntry[] }[]
    }

export function reviewBatch(input: { role: Role; operator: string; batchId: string }): SignResult {
  requireRole(input.role, '建设单位', '核对签收')
  let result: SignResult
  commitArchive((draft) => {
    const batch = draft.batches.find((item) => item.id === input.batchId)
    if (!batch) {
      throw new Error('没有找到这个移交批次')
    }
    if (batch.outcome !== '待核对') {
      throw new Error(`批次 ${batch.code} 当前结论为「${batch.outcome}」，不能重复核对`)
    }
    // 签收瞬间仍按现口径重算：防止提交后委托状态/卷册口径变化。
    assertCrossEntryConsistency(draft, batch.volumeIds, evidenceOf)
    const missing = computeBatchMissing(draft, batch.volumeIds, evidenceOf)
    const stamp = nowIso()
    if (missing.count > 0) {
      // 整组退回重报：所有卷（含不缺件的）一起回到组卷中，缺的卷点名到卷。
      const deficient = missing.volumes.filter((item) => item.count > 0)
      for (const volumeId of batch.volumeIds) {
        const volume = draft.volumes.find((item) => item.id === volumeId)!
        volume.status = '组卷中'
        volume.updatedAt = stamp
      }
      batch.outcome = '已退回'
      batch.rejectReason = {
        at: stamp,
        deficientVolumes: deficient.map((item) => ({
          volumeId: item.volumeId,
          volumeCode: draft.volumes.find((candidate) => candidate.id === item.volumeId)!.code,
          entries: item.entries,
        })),
      }
      batch.snapshots = { ...batch.snapshots, 退回: snapshotOf(missing) }
      batch.events.push(
        event(
          '建设单位',
          '整组退回',
          `逐卷核对发现 ${deficient
            .map((item) => draft.volumes.find((candidate) => candidate.id === item.volumeId)!.code)
            .join('、')} 缺件，整组退回重报（缺件口径：资料清单 ${ALGORITHM_VERSION}）。`,
        ),
      )
      result = {
        signed: false,
        batchId: batch.id,
        deficient: batch.rejectReason.deficientVolumes.map((item) => ({
          volumeCode: item.volumeCode,
          volumeId: item.volumeId,
          entries: item.entries,
        })),
      }
    } else {
      for (const volumeId of batch.volumeIds) {
        const volume = draft.volumes.find((item) => item.id === volumeId)!
        volume.status = '已签收'
        volume.updatedAt = stamp
      }
      batch.outcome = '已签收'
      batch.signer = input.operator
      batch.signedAt = stamp
      batch.snapshots = { ...batch.snapshots, 签收: snapshotOf(missing) }
      batch.events.push(event('建设单位', '整组签收', `逐卷核对齐全，整组签收，签收后卷册转只读。`))
      result = { signed: true, batchId: batch.id }
    }
  })
  return result!
}

/** 手工触发：已生成移交记录全部照现口径重算（签收结论不回退）。 */
export function recomputeExistingBatches(role: Role): { recalculated: number } {
  requireRole(role, '资料员', '口径重算')
  let recalculated = 0
  commitArchive((draft) => {
    draft.algorithmVersion = ALGORITHM_VERSION
    draft.batches = draft.batches.map((batch) => recalcBatchSnapshot(draft, batch, evidenceOf))
    recalculated = draft.batches.length
  })
  return { recalculated }
}

// ─────────────────────────────────────────────────────────────────────────────
// 与试验检测委托清单联动：出具报告即同步入资料池（同一份，两处可见）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 试验检测页「出具报告」成功后调用：把报告同步进资料池。
 * 名称优先取清单条目名（缺件口径以清单为准），页数回退清单要求页数。
 */
export function syncTestingReport(testingId: number): ArchiveState {
  return commitArchive((draft) => {
    const row = testingRows().find((item) => Number(item.id) === testingId)
    if (!row) {
      throw new Error('委托不存在，报告同步失败')
    }
    if (String(row.status) !== '已出报告') {
      throw new Error('委托尚未出具报告，不能同步入资料池')
    }
    const ref = String(row['委托编号'])
    // 同一份委托可能被多个单位工程/条目的清单引用：逐条入池，保持唯一证据源。
    const items = draft.checklist.filter((candidate) => candidate.testingRef === ref)
    if (items.length === 0) {
      throw new Error(`委托 ${ref} 没有对应的资料清单条目，报告暂不能归卷，请先在清单中登记`)
    }
    for (const item of items) {
      const docForItem = draft.docs.find(
        (doc) => doc.syncedFromTesting === testingId && doc.unitProjectId === item.unitProjectId,
      )
      if (docForItem) {
        docForItem.name = item.name
        docForItem.pages = item.requiredPages
        docForItem.testingRef = ref
        continue
      }
      draft.docs.push({
        id: nextDocId(draft),
        unitProjectId: item.unitProjectId,
        category: '试验报告',
        name: item.name,
        pages: item.requiredPages,
        submitter: String(row['检测机构'] ?? '检测机构'),
        syncedFromTesting: testingId,
        testingRef: ref,
        submittedAt: nowIso(),
      })
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 签收单导出：建设单位临时来查时直接打印，签收记录不会再找不着
// ─────────────────────────────────────────────────────────────────────────────

function csvCell(value: string | number | undefined): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function exportBatchReceipt(batchId: string): { filename: string; content: string } {
  const state = loadArchive()
  const batch = state.batches.find((item) => item.id === batchId)
  if (!batch) {
    throw new Error('没有找到这个移交批次')
  }
  const lines: string[] = []
  lines.push(['竣工资料移交签收单'].join(','))
  lines.push(['批次编号', csvCell(batch.code)].join(','))
  lines.push(['移交单位', csvCell(batch.submitter), '首次提交', csvCell(batch.firstSubmittedAt)].join(','))
  lines.push(
    [
      '核对结论',
      csvCell(batch.outcome),
      '签收人',
      csvCell(batch.signer ?? ''),
      '签收时间',
      csvCell(batch.signedAt ?? ''),
    ].join(','),
  )
  lines.push('')
  lines.push(['卷册编号', '单位工程', '类别', '清单条目数', '卷内挂接数', '现口径缺件数', '卷状态'].join(','))
  const live = computeBatchMissing(state, batch.volumeIds, evidenceOf)
  for (const volumeId of batch.volumeIds) {
    const volume = state.volumes.find((item) => item.id === volumeId)!
    const project = projectNameOf(state, volume.unitProjectId)
    const missingCount = live.volumes.find((item) => item.volumeId === volumeId)?.count ?? 0
    lines.push(
      [
        csvCell(volume.code),
        csvCell(project),
        csvCell(volume.category),
        volume.itemIds.length,
        volume.attachments.length,
        missingCount,
        csvCell(volume.status),
      ].join(','),
    )
  }
  if (batch.rejectReason) {
    lines.push('')
    lines.push(['退回时间', csvCell(batch.rejectReason.at)].join(','))
    for (const deficient of batch.rejectReason.deficientVolumes) {
      for (const entry of deficient.entries) {
        lines.push(
          ['点名缺件', csvCell(deficient.volumeCode), csvCell(entry.itemName), csvCell(entry.missingTypes.join('、'))].join(','),
        )
      }
    }
  }
  return { filename: `移交签收单-${batch.code}.csv`, content: `﻿${lines.join('\n')}` }
}
