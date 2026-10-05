/* 竣工资料组卷与移交的逻辑验证脚本：esbuild 打包后用 node 跑。 */
import {
  KEYS,
  POOL_CODE,
  appendVolumeNote,
  attachDoc,
  classifyDoc,
  createVolume,
  loadArchiveState,
  loadVerifiedState,
  markDocPages,
  migrateLegacy,
  removeDoc,
  recomputeHandovers,
  returnHandover,
  signHandover,
  submitHandover,
} from '@/api/archive-service'
import { reloadFromStorage } from '@/data/local-store'

// ---- localStorage 桩 ----
const backing = new Map<string, string>()
let failWrites = false
// @ts-expect-error 测试环境注入
globalThis.window = {
  localStorage: {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => {
      if (failWrites) throw new Error('QuotaExceededError')
      backing.set(k, String(v))
    },
    removeItem: (k: string) => backing.delete(k),
  },
}

let passed = 0
let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL ${name}`, extra === undefined ? '' : JSON.stringify(extra))
  }
}

function corrupt(mutate: (state: Record<string, unknown[]>) => void) {
  const raw = backing.get('shield-tunnel-construction:entries')!
  const state = JSON.parse(raw)
  mutate(state)
  backing.set('shield-tunnel-construction:entries', JSON.stringify(state))
  reloadFromStorage()
}

// ---- 0. 首次加载：旧口径移交记录自动重算 ----
let board = loadArchiveState()
check('旧口径移交记录自动重算 1 条', board.recomputed === 1, board.recomputed)
check('VOL-0002 缺钢筋原材复试报告', board.missing['VOL-0002'].count === 1 && board.missing['VOL-0002'].missing[0] === '钢筋原材复试报告', board.missing['VOL-0002'])
check('VOL-0006 因待补页缺隐蔽工程验收记录', board.missing['VOL-0006'].count === 1 && board.missing['VOL-0006'].missing[0] === '隐蔽工程验收记录', board.missing['VOL-0006'])
check('缺报告案卷只点到 VOL-0002', board.missingReports.length === 1 && board.missingReports[0].code === 'VOL-0002')
check('两处入口缺件数一致', board.missingReports[0].missing.count === board.missing['VOL-0002'].count)
const ho1 = board.handovers.find((h) => h['移交编号'] === 'HO-0001')!
check('HO-0001 重算后口径版本升级', ho1['口径版本'] === 'v2-清单口径', ho1['口径版本'])

// ---- 1. 权限 ----
check('建设单位不能挂资料', !attachDoc('VOL-0001', { 资料名称: 'x', 清单项: '施工日志', 提交人: 'x', 页数: 1 }, '建设单位').ok)
check('建设单位不能建卷', !createVolume({ 单位工程: 'u', 案卷类别: '施工记录', 案卷题名: 't' }, '建设单位', '建设单位-王工').ok)
check('资料员不能签收', !signHandover('HO-0001', '资料员', '资料员-小李').ok)
check('建设单位不能迁移', !migrateLegacy('建设单位').ok)

// ---- 2. 提交移交：缺件拦截 + 幂等 ----
check('缺件案卷不允许提交', !submitHandover(['VOL-0002'], '资料员', '资料员-小李').ok)
const r1 = submitHandover(['VOL-0001'], '资料员', '资料员-小李')
check('VOL-0001 提交成功', r1.ok, r1.message)
const r2 = submitHandover(['VOL-0001'], '资料员', '资料员-小李')
check('重复提交仍按最早那次', r2.ok && r2.message.includes('仍按最早那次'), r2.message)
board = loadVerifiedState()
check('重复提交没有新增移交记录', board.handovers.filter((h) => h['案卷列表'] === 'VOL-0001').length === 1)
check('VOL-0001 进入待移交', board.volumes.find((v) => v['案卷编号'] === 'VOL-0001')!.status === '待移交')
check('待移交的卷不能再挂资料', !attachDoc('VOL-0001', { 资料名称: 'x', 清单项: '施工日志', 提交人: 'x', 页数: 1 }, '资料员').ok)

// ---- 3. 签收 ----
const r3 = signHandover('HO-0004', '建设单位', '建设单位-王工')
check('整组签收成功', r3.ok && r3.message.includes('整组签收'), r3.message)
board = loadVerifiedState()
check('VOL-0001 已签收', board.volumes.find((v) => v['案卷编号'] === 'VOL-0001')!.status === '已签收')
check('已签收不能再提交', !submitHandover(['VOL-0001'], '资料员', '资料员-小李').ok)
check('已签收签收结论不能改回去', !signHandover('HO-0004', '建设单位', '建设单位-王工').ok)
const r4 = appendVolumeNote('VOL-0001', '电子版光盘已补交', '资料员')
check('已签收卷可追加补充说明', r4.ok, r4.message)
board = loadVerifiedState()
const vol1 = board.volumes.find((v) => v['案卷编号'] === 'VOL-0001')!
check('补充说明追加了且状态没动', String(vol1['补充说明']).includes('电子版光盘已补交') && vol1.status === '已签收')
check('建设单位不能写补充说明', !appendVolumeNote('VOL-0001', 'x', '建设单位').ok)

// ---- 4. 退回重报：首次提交时间不动 ----
check('补齐 VOL-0002 缺的报告', attachDoc('VOL-0002', { 资料名称: '左线钢筋原材复试报告', 清单项: '钢筋原材复试报告', 提交人: '试验检测单位', 页数: 15 }, '资料员').ok)
board = loadVerifiedState()
check('VOL-0002 不再缺件', board.missing['VOL-0002'].count === 0)
const r5 = submitHandover(['VOL-0002'], '资料员', '资料员-小李')
check('退回重报成功且仍按最早那次', r5.ok && r5.message.includes('2026-09-27 09:00'), r5.message)
board = loadVerifiedState()
const ho3 = board.handovers.find((h) => h['移交编号'] === 'HO-0003')!
check('HO-0003 重报后待签收、首次提交时间不变', ho3.status === '待签收' && ho3['首次提交时间'] === '2026-09-27 09:00' && Number(ho3['退回次数']) === 1, ho3)
const r6 = signHandover('HO-0003', '建设单位', '建设单位-王工')
check('重报后整组签收', r6.ok, r6.message)

// ---- 5. 逐卷核对发现缺件 → 整组退回并点名 ----
corrupt((state) => {
  const docs = state[KEYS.docs] as { [k: string]: unknown }[]
  const doc = docs.find((d) => d['资料编号'] === 'DOC-0007')!
  doc['案卷编号'] = POOL_CODE // 模拟移交后卷内资料被抽走
})
const r7 = signHandover('HO-0001', '建设单位', '建设单位-王工')
check('核对发现缺件整组退回', r7.ok && r7.message.includes('整组退回') && r7.message.includes('VOL-0003'), r7.message)
board = loadVerifiedState()
const ho1b = board.handovers.find((h) => h['移交编号'] === 'HO-0001')!
check('退回点名到卷', ho1b['缺件卷'] === 'VOL-0003' && String(ho1b['缺件明细']).includes('导线测量成果'), ho1b)
check('退回后卷回组卷中', board.volumes.find((v) => v['案卷编号'] === 'VOL-0003')!.status === '组卷中' && board.volumes.find((v) => v['案卷编号'] === 'VOL-0004')!.status === '组卷中')
// 把抽走的资料归回去
corrupt((state) => {
  const docs = state[KEYS.docs] as { [k: string]: unknown }[]
  docs.find((d) => d['资料编号'] === 'DOC-0007')!['案卷编号'] = 'VOL-0003'
})

// ---- 6. 手动整组退回 ----
check('VOL-0004 单独提交', submitHandover(['VOL-0004'], '资料员', '资料员-小李').ok)
const r8 = returnHandover('HO-0005', '卷内缺签字页', '建设单位', '建设单位-王工')
check('手动整组退回', r8.ok, r8.message)
board = loadVerifiedState()
check('退回后 VOL-0004 回组卷中', board.volumes.find((v) => v['案卷编号'] === 'VOL-0004')!.status === '组卷中')

// ---- 7. 原子性：存不下整体撤销 ----
failWrites = true
const before = loadVerifiedState().volumes.length
const r9 = createVolume({ 单位工程: '中间风井主体结构', 案卷类别: '测量成果', 案卷题名: '风井测量成果卷' }, '资料员', '资料员-小李')
failWrites = false
check('写不进去整体撤销', !r9.ok && r9.message.includes('整体撤销'), r9.message)
check('撤销后卷数没变', loadVerifiedState().volumes.length === before)

// ---- 8. 存量迁移 + 归类 ----
const r10 = migrateLegacy('资料员')
check('存量迁移进待认领池', r10.ok && r10.message.includes('18'), r10.message)
const r11 = migrateLegacy('资料员')
check('重复迁移不重复入账', r11.ok && r11.message.includes('没有新增'), r11.message)
board = loadVerifiedState()
check('待认领池 18 份', board.docs.filter((d) => d['案卷编号'] === POOL_CODE).length === 18)
check('建新卷用于归类', createVolume({ 单位工程: '左线区间隧道(K0+000~K1+200)', 案卷类别: '试验报告', 案卷题名: '左线存量试验报告卷' }, '资料员', '资料员-小李').ok)
board = loadVerifiedState()
const newVol = board.volumes.find((v) => v['案卷题名'] === '左线存量试验报告卷')!
const r12 = classifyDoc('LS-testing-1', String(newVol['案卷编号']), '混凝土抗压强度报告', '资料员')
check('存量资料归类挂卷', r12.ok, r12.message)
check('清单项不匹配不能归', !classifyDoc('LS-testing-2', String(newVol['案卷编号']), '施工日志', '资料员').ok)
board = loadVerifiedState()
check('归类后池子少一份', board.docs.filter((d) => d['案卷编号'] === POOL_CODE).length === 17)

// ---- 9. 缺页补齐 ----
const r13 = markDocPages('DOC-0018', '补齐归档', '第12-14页扫描件已补', '资料员')
check('缺页补齐归档', r13.ok, r13.message)
board = loadVerifiedState()
check('VOL-0006 补齐后不缺件', board.missing['VOL-0006'].count === 0, board.missing['VOL-0006'])
check('补齐留痕', String(board.docs.find((d) => d['资料编号'] === 'DOC-0018')!['缺页说明']).includes('已补齐'))

// ---- 10. 落库前校验：数据对不上就拒绝写入 ----
corrupt((state) => {
  const vols = state[KEYS.volumes] as { [k: string]: unknown }[]
  vols.find((v) => v['案卷编号'] === 'VOL-0004')!['status'] = '待移交' // 没有对应待签收记录
})
const r14 = createVolume({ 单位工程: '中间风井主体结构', 案卷类别: '测量成果', 案卷题名: '风井测量成果卷' }, '资料员', '资料员-小李')
check('状态对不上落库被拒', !r14.ok && r14.message.includes('校验未通过'), r14.message)
corrupt((state) => {
  const vols = state[KEYS.volumes] as { [k: string]: unknown }[]
  vols.find((v) => v['案卷编号'] === 'VOL-0004')!['status'] = '组卷中'
})

// ---- 11. 重算入口 + 撤出资料 ----
check('现行口径下重算无新增', recomputeHandovers().message.includes('无需重算'))
check('组卷中的卷可撤出资料', removeDoc('LS-axis-1', '资料员').ok)

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
