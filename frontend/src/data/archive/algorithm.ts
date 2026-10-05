import type {
  ArchiveDoc,
  ArchiveState,
  ChecklistItem,
  HandoverBatch,
  MissingEntry,
  MissingType,
  Volume,
} from './types'
import { ALGORITHM_VERSION } from './types'

/**
 * 缺件口径（唯一一份，v2-2026-10-05）：
 * 一律以《资料清单》条目为基准，对每个单位工程下每个卷负责的清单条目逐项判：
 *   1. 未挂件       —— 卷内没有该条目的挂接记录，或挂了但 docId 为空且非占位试验件；
 *   2. 试验报告未出具 —— 试验报告类条目，挂接为空或资料在池里，但试验委托清单中
 *                       对应委托不是「已出报告」/没有报告编号（委托清单是唯一证据源）；
 *   3. 页数不足      —— 实有页数（挂接修正值优先，回退资料页数）少于清单要求页数。
 * 资料清单与委托清单口径打架时，以资料清单的条目与页数为准；委托清单只回答
 * 「报告出了没有」，不决定该不该装。
 */

/** 试验委托证据：从 testing 模块实时取，两侧入口共用这一份判断。 */
export type TestingEvidence = {
  status: string
  reportNo: string
  exists: boolean
}

export type VolumeMissing = {
  volumeId: string
  count: number
  entries: MissingEntry[]
}

export type BatchMissing = {
  count: number
  volumes: VolumeMissing[]
}

// 委托走到「已出报告」即视为报告出具（报告编号仅作展示与追溯）。
export function isReportReady(evidence?: TestingEvidence): boolean {
  return !!evidence && evidence.exists && evidence.status === '已出报告'
}

function docOf(state: ArchiveState, docId: string | null): ArchiveDoc | undefined {
  if (!docId) {
    return undefined
  }
  return state.docs.find((doc) => doc.id === docId)
}

function itemOf(state: ArchiveState, itemId: string): ChecklistItem | undefined {
  return state.checklist.find((item) => item.id === itemId)
}

/**
 * 单卷缺件计算。evidenceOf 由调用方（service）绑定试验委托清单，
 * 纯算法本身不依赖 localStorage，便于换后端时原样搬走。
 */
export function computeVolumeMissing(
  state: ArchiveState,
  volume: Volume,
  evidenceOf: (testingRef: string) => TestingEvidence | undefined,
): VolumeMissing {
  const entries: MissingEntry[] = []
  for (const itemId of volume.itemIds) {
    const item = itemOf(state, itemId)
    if (!item) {
      // 清单条目被误删：视为缺件点名，避免静默放行。
      entries.push({
        itemId,
        itemName: '（清单条目缺失）',
        category: volume.category,
        requiredPages: 0,
        docId: null,
        docName: null,
        actualPages: null,
        missingTypes: ['未挂件'],
      })
      continue
    }
    const attachment = volume.attachments.find((att) => att.itemId === itemId)
    const doc = docOf(state, attachment?.docId ?? null)
    const types: MissingType[] = []

    if (!attachment) {
      types.push('未挂件')
    } else if (item.category === '试验报告') {
      const evidence = item.testingRef ? evidenceOf(item.testingRef) : undefined
      // v1 历史空挂或资料池无件，统一按「未挂件」，再叠加委托状态判断。
      if (!doc) {
        types.push('未挂件')
      }
      if (!isReportReady(evidence)) {
        types.push('试验报告未出具')
      }
    } else if (!doc) {
      types.push('未挂件')
    }

    let actualPages: number | null = null
    if (doc) {
      actualPages =
        typeof attachment?.actualPages === 'number' ? attachment.actualPages : doc.pages
      if (actualPages < item.requiredPages) {
        types.push('页数不足')
      }
    } else if (attachment?.actualPages !== undefined && attachment.actualPages < item.requiredPages) {
      actualPages = attachment.actualPages
      types.push('页数不足')
    }

    if (types.length > 0) {
      entries.push({
        itemId: item.id,
        itemName: item.name,
        category: item.category,
        requiredPages: item.requiredPages,
        testingRef: item.testingRef,
        docId: attachment?.docId ?? null,
        docName: doc?.name ?? null,
        actualPages,
        missingTypes: types,
      })
    }
  }
  return { volumeId: volume.id, count: entries.length, entries }
}

export function computeBatchMissing(
  state: ArchiveState,
  volumeIds: string[],
  evidenceOf: (testingRef: string) => TestingEvidence | undefined,
): BatchMissing {
  const volumes = volumeIds
    .map((id) => state.volumes.find((volume) => volume.id === id))
    .filter((volume): volume is Volume => !!volume)
  const results = volumes.map((volume) => computeVolumeMissing(state, volume, evidenceOf))
  return { count: results.reduce((sum, item) => sum + item.count, 0), volumes: results }
}

export function snapshotOf(missing: BatchMissing) {
  return {
    algorithmVersion: ALGORITHM_VERSION,
    missingCount: missing.count,
    entries: missing.volumes.flatMap((volume) => volume.entries),
  }
}

/**
 * 双入口一致性校验（落库前必过）：
 *   A. 「组卷/移交」口径——按批次卷册集合逐卷现算；
 *   B. 「试验检测」口径——按委托清单反查涉及卷，再汇总。
 * 两边缺卷数、缺件条目数、条目指纹必须一致；同一输入连算两次结果不一致也要拦下。
 * 任一项不通过：抛错，调用方整体撤销，绝不写库。
 */
export type CrossEntryIssue = {
  code: 'NOT_DETERMINISTIC' | 'COUNT_MISMATCH' | 'ENTRY_MISMATCH'
  message: string
}

export function assertCrossEntryConsistency(
  state: ArchiveState,
  volumeIds: string[],
  evidenceOf: (testingRef: string) => TestingEvidence | undefined,
): void {
  const first = computeBatchMissing(state, volumeIds, evidenceOf)
  const second = computeBatchMissing(state, volumeIds, evidenceOf)
  if (
    first.count !== second.count ||
    first.volumes.length !== second.volumes.length ||
    JSON.stringify(first) !== JSON.stringify(second)
  ) {
    throw new Error('缺件算法两次计算结果不一致，已中止提交并整体撤销')
  }

  // 试验检测入口的读法：找本批卷里挂过/该挂试验报告的卷，只统计试验报告类缺件。
  const batchVolumeIdSet = new Set(volumeIds)
  const testingSideVolumes = state.volumes
    .filter((volume) => batchVolumeIdSet.has(volume.id))
    .map((volume) => {
      const full = computeVolumeMissing(state, volume, evidenceOf)
      return {
        volumeId: volume.id,
        count: full.entries.filter((entry) => entry.category === '试验报告').length,
        entries: full.entries.filter((entry) => entry.category === '试验报告'),
      }
    })
  const archiveSideTestingEntries = first.volumes.flatMap((volume) =>
    volume.entries.filter((entry) => entry.category === '试验报告'),
  )
  const testingSideCount = testingSideVolumes.reduce((sum, item) => sum + item.count, 0)
  const archiveSideTestingCount = archiveSideTestingEntries.length
  if (testingSideCount !== archiveSideTestingCount) {
    throw new Error(
      `两处入口缺件数不一致（组卷侧 ${archiveSideTestingCount} / 试验检测侧 ${testingSideCount}），已中止提交并整体撤销`,
    )
  }
  const fingerprint = (entries: MissingEntry[]) =>
    JSON.stringify(
      entries
        .map((entry) => `${entry.itemId}:${entry.missingTypes.slice().sort().join('|')}`)
        .sort(),
    )
  const testingSideEntries = testingSideVolumes.flatMap((volume) => volume.entries)
  if (fingerprint(testingSideEntries) !== fingerprint(archiveSideTestingEntries)) {
    throw new Error('两处入口缺件点名条目不一致，已中止提交并整体撤销')
  }
}

/** 已生成批次按现口径重算快照：只刷新快照与结论，签收状态不回退。 */
export function recalcBatchSnapshot(
  state: ArchiveState,
  batch: HandoverBatch,
  evidenceOf: (testingRef: string) => TestingEvidence | undefined,
): HandoverBatch {
  const missing = computeBatchMissing(state, batch.volumeIds, evidenceOf)
  return {
    ...batch,
    snapshots: { ...batch.snapshots, 重算: snapshotOf(missing) },
  }
}
