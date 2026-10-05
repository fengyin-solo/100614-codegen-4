import { runAction } from '@/api/local-service'
import { allRows } from '@/data/local-store'
import {
  attachDoc,
  addVolumeNote,
  detachDoc,
  exportBatchReceipt,
  fixPages,
  loadArchive,
  migrateUnitProject,
  registerDoc,
  reviewBatch,
  submitVolumes,
  syncTestingReport,
  testingArchiveRows,
  testingReportDeficientVolumeIds,
  volumeViews,
} from '@/api/archive-service'
import { archiveStorageKey, readArchive, resetArchive } from '@/data/archive/store'
import type { ArchiveState } from '@/data/archive/types'

type Assert = (cond: unknown, label: string) => asserts cond
type Eq = <T>(actual: T, expected: T, label: string) => void

type Ctx = {
  storage: Storage
  assert: Assert
  eq: Eq
}

const clerk = { role: '资料员' as const, operator: '周岚' }
const owner = { role: '建设单位' as const, operator: '高磊' }

export function run(ctx: Ctx): void {
  const { assert, eq } = ctx

  // 业务表（试验委托等）按真实种子落库，供缺件算法取证。
  allRows()

  // 0. 首次载入：v1 → v2 自动换版，已生成批次 B-0001 照新口径重算。
  let state = loadArchive()
  eq(state.algorithmVersion, 'v2-2026-10-05', '载入后口径应升级到 v2')
  const b0001 = state.batches.find((b) => b.id === 'B-0001')!
  assert(b0001.snapshots.重算 !== undefined, '历史批次应有重算快照')
  assert(b0001.snapshots.重算!.missingCount > 0, 'v1 放行的批次按 v2 应算出缺件')
  assert(b0001.outcome === '待核对', '换版重算不改变待核对结论')
  const recalcEvent = b0001.events.some((e) => e.action === '口径换版重算')
  assert(recalcEvent, '换版应留痕事件')

  const views = () => volumeViews(readArchive())
  const byId = (id: string) => views().find((v) => v.volume.id === id)!
  // v2 缺件点名：施工卷缺 2 页；试验卷两个委托没出报告（空挂）。
  eq(byId('V-001-SG').missingCount, 1, '施工卷应点名页数不足')
  eq(byId('V-001-CL').missingCount, 0, '测量卷应齐全')
  eq(byId('V-001-SY').missingCount, 2, '试验卷应点名 2 份未出具报告')
  eq(testingReportDeficientVolumeIds(readArchive()), ['V-001-SY'], '试验检测侧缺报告卷数应与组卷侧一致')

  // 1. 建设单位不能改构成、不能提交；资料员不能签收。
  expectThrow(() => attachDoc({ role: '建设单位', volumeId: 'V-001-SG', itemId: 'I-0101', docId: 'D-0101' }), '建设单位挂件应被拒')
  expectThrow(() => submitVolumes({ ...clerk, volumeIds: ['V-001-CL'] }), '待移交卷重复提交应被拒')
  expectThrow(() => reviewBatch({ ...clerk, batchId: 'B-0001' }), '资料员签收应被拒')

  // 2. 建设单位核对 B-0001：有缺件 → 整组退回，卷全部回组卷中，缺件点名到卷。
  const rejected = reviewBatch({ ...owner, batchId: 'B-0001' })
  assert(!rejected.signed, '有缺件不能签收')
  if (!rejected.signed) {
    eq(rejected.deficient.map((d) => d.volumeCode).sort(), ['SG-2026-U001', 'SY-2026-U001'].sort(), '应点名施工卷与试验卷')
  }
  for (const id of ['V-001-SG', 'V-001-CL', 'V-001-SY']) {
    eq(byId(id).volume.status, '组卷中', `退回后 ${id} 应回到组卷中（整组）`)
  }
  eq(readArchive().batches[0].outcome, '已退回', '批次结论应为已退回')

  // 3. 缺件未补齐时资料员整组提交应被闸住。
  expectThrow(() => submitVolumes({ ...clerk, volumeIds: ['V-001-SG', 'V-001-CL', 'V-001-SY'] }), '缺件批次提交应被拒')

  // 3b. 已退回批次只挑部分卷重报也被闸住（防止老批次残留不再提交的卷）。
  expectThrow(
    () => submitVolumes({ ...clerk, volumeIds: ['V-001-CL'] }),
    '已退回批次只挑部分卷重报应被拒（必须整组原卷册再递）',
  )

  // 4. 缺件补齐：施工卷补页；委托 1/2 出具报告 → 同步入池 → 挂卷。
  fixPages({ role: '资料员', volumeId: 'V-001-SG', itemId: 'I-0101', actualPages: 100 })
  eq(byId('V-001-SG').missingCount, 0, '补页后施工卷应齐全')

  runAction('testing', 1, '送样委托')
  runAction('testing', 1, '出具报告')
  syncTestingReport(1)
  runAction('testing', 2, '出具报告')
  syncTestingReport(2)
  const afterSync = readArchive()
  assert(afterSync.docs.some((d) => d.testingRef === 'TEST-0001'), 'TEST-0001 报告应同步入资料池')
  assert(afterSync.docs.some((d) => d.testingRef === 'TEST-0002'), 'TEST-0002 报告应同步入资料池')
  const doc1 = afterSync.docs.find((d) => d.testingRef === 'TEST-0001' && d.unitProjectId === 'U-001')!
  const doc2 = afterSync.docs.find((d) => d.testingRef === 'TEST-0002' && d.unitProjectId === 'U-001')!
  eq(doc1.name, '混凝土抗渗试验报告', '同步报告名称应取资料清单条目名')
  eq(doc2.name, '同步注浆浆液配比试验报告', '同步报告名称应取资料清单条目名')
  attachDoc({ role: '资料员', volumeId: 'V-001-SY', itemId: 'I-0103', docId: doc1.id })
  attachDoc({ role: '资料员', volumeId: 'V-001-SY', itemId: 'I-0105', docId: doc2.id })
  eq(byId('V-001-SY').missingCount, 0, '报告出具并挂件后试验卷应齐全')
  eq(testingReportDeficientVolumeIds(readArchive()), [], '试验检测侧缺报告卷数应清零')

  // 5. 委托清单侧逐行结论可查到批次。
  const rows = testingArchiveRows()
  const t1 = rows.find((r) => r.row['委托编号'] === 'TEST-0001')!
  eq(t1.reportReady, true, 'TEST-0001 应为已出具')
  eq(t1.links[0].missingTypes, [], 'TEST-0001 对应条目应无缺件')

  // 6. 重报：按原卷册再递，沿用最早批次号、首次提交时间，submitNo=2。
  const firstTime = b0001.firstSubmittedAt
  const submit = submitVolumes({ ...clerk, volumeIds: ['V-001-SG', 'V-001-CL', 'V-001-SY'] })
  assert(submit.reused, '同卷册重报应沿用原批次')
  eq(submit.batchId, 'B-0001', '重报批次号必须是最早那次')
  const rebatch = readArchive().batches.find((b) => b.id === 'B-0001')!
  eq(rebatch.code, 'YJ-2026-001', '重报沿用最早批次编号')
  eq(rebatch.firstSubmittedAt, firstTime, '重报首次提交时间不变')
  eq(rebatch.submitNo, 2, '重报次数应为 2')
  eq(rebatch.outcome, '待核对', '重报后回到待核对')

  // 7. 建设单位整组签收 → 三卷全部已签收、转只读。
  const signed = reviewBatch({ ...owner, batchId: 'B-0001' })
  assert(signed.signed, '齐全时应签收成功')
  for (const id of ['V-001-SG', 'V-001-CL', 'V-001-SY']) {
    eq(byId(id).volume.status, '已签收', `签收后 ${id} 应为已签收`)
  }
  expectThrow(() => detachDoc({ role: '资料员', volumeId: 'V-001-CL', itemId: 'I-0102' }), '已签收卷摘挂应被拒')
  expectThrow(() => submitVolumes({ ...clerk, volumeIds: ['V-001-CL'] }), '已签收卷不能改回待移交')
  // 只能补说明：
  addVolumeNote({ role: '建设单位', volumeId: 'V-001-CL', text: '建设单位补充：原件留存档案室A柜。' })
  assert(byId('V-001-CL').volume.notes.some((n) => n.text.includes('档案室A柜')), '签收卷补说明应允许')

  // 8. 签收单可导出且含三卷。
  const receipt = exportBatchReceipt('B-0001')
  assert(receipt.content.includes('YJ-2026-001') && receipt.content.includes('SG-2026-U001'), '签收单应包含批次与卷册')

  // 9. 存量迁移 U-002：散件齐全（2 类齐），另 1 份对不上清单进 loose。
  const migrated2 = migrateUnitProject({ role: '资料员', unitProjectId: 'U-002' })
  assert(migrated2, 'U-002 迁移应成功')
  const m2 = readArchive().migrations.find((m) => m.unitProjectId === 'U-002')!
  eq(m2.createdVolumeIds.length, 2, 'U-002 应建 SG/CL 两卷')
  eq(m2.attachedCount, 2, '应自动归卷 2 份散件')
  eq(m2.deficiencies.length, 0, 'U-002 不应有缺件')
  eq(m2.looseDocIds, ['D-0203'], '班前讲话记录对不上清单，应为 loose')
  const u002Views = volumeViews(readArchive()).filter((v) => v.volume.unitProjectId === 'U-002')
  eq(u002Views.every((v) => v.missingCount === 0), true, 'U-002 两卷迁移即齐套')
  expectThrow(() => migrateUnitProject({ role: '资料员', unitProjectId: 'U-002' }), '重复迁移应被幂等拒绝')

  // 10. U-002 齐套卷可直接提交并签收（跨工程批次流程）。
  const ids2 = u002Views.map((v) => v.volume.id)
  const s2 = submitVolumes({ ...clerk, volumeIds: ids2 })
  assert(!s2.reused, '新卷册应生成新批次')
  const signed2 = reviewBatch({ ...owner, batchId: s2.batchId })
  assert(signed2.signed, 'U-002 批次应签收成功')

  // 11. 存量迁移 U-003：缺页 + 整件缺 + 无关 loose，全部点名并给补齐方式。
  migrateUnitProject({ role: '资料员', unitProjectId: 'U-003' })
  const m3 = readArchive().migrations.find((m) => m.unitProjectId === 'U-003')!
  const vol3 = volumeViews(readArchive()).filter((v) => v.volume.unitProjectId === 'U-003')
  eq(vol3.length, 2, 'U-003 应建两卷')
  const sg3 = vol3.find((v) => v.volume.category === '施工记录')!
  const cl3 = vol3.find((v) => v.volume.category === '测量成果')!
  eq(sg3.missingEntries[0].missingTypes, ['页数不足'], '施工卷应为页数不足')
  eq(cl3.missingEntries[0].missingTypes, ['未挂件'], '测量卷整件缺失应为未挂件')
  eq(m3.looseDocIds, ['D-0302'], '控制点复测对不上清单名称，应为 loose')
  expectThrow(() => submitVolumes({ ...clerk, volumeIds: vol3.map((v) => v.volume.id) }), 'U-003 缺件不应允许提交')

  // 12. 资料不能一稿两挂（先把 U-003 施工卷摘下再试挂到别处不可能；换测：附件互斥）
  expectThrow(
    () => attachDoc({ role: '资料员', volumeId: cl3.volume.id, itemId: 'I-0302', docId: 'D-0202' }),
    '跨工程资料挂件应被类别/工程校验拒绝',
  )

  // 13. 配额存不下 → 整体撤销：提交前把 setItem 换成抛错，现场状态不变。
  const beforeFail = readArchive()
  const originalSet = ctx.storage.setItem.bind(ctx.storage)
  let calls = 0
  ctx.storage.setItem = () => {
    calls += 1
    throw new DOMException('QuotaExceededError', 'QuotaExceededError')
  }
  expectThrow(
    () => registerDoc({ role: '资料员', operator: '测试', unitProjectId: 'U-002', category: '施工记录', name: '不应落库的资料', pages: 1 }),
    '存储失败应整体撤销抛错',
  )
  assert(calls >= 1, '落库确实尝试过写入')
  ctx.storage.setItem = originalSet
  eq(readArchive(), beforeFail, '存不下时状态必须与操作前完全一致')

  // 14. 现读不兜底：直接改 localStorage 后服务读到的必须是新值。
  const raw = JSON.parse(ctx.storage.getItem(archiveStorageKey())!) as ArchiveState
  raw.unitProjects[0].name = '地铁3号线江北站—江洲站盾构区间（外部已更新）'
  ctx.storage.setItem(archiveStorageKey(), JSON.stringify(raw))
  eq(readArchive().unitProjects[0].name, raw.unitProjects[0].name, '每次必须现读存储，不允许老缓存兜底')

  // 15. 重置恢复种子。
  const seeded = resetArchive()
  eq(seeded.algorithmVersion, 'v1-2026-08-01', '重置应回到种子口径（下次载入再升级）')
  eq(volumeViews(loadArchive()).length, 3, '重新载入后为种子 3 卷')

  console.log('✓ 档案域全部 15 组校验通过')
}

function expectThrow(fn: () => unknown, label: string, allowOk = false): void {
  try {
    fn()
    if (!allowOk) {
      throw new Error(`预期抛错但没有：${label}`)
    }
  } catch (error) {
    if (allowOk) {
      return
    }
    if (error instanceof Error && error.message.includes('预期抛错')) {
      throw error
    }
  }
}
