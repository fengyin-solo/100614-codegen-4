import {
  ARCHIVE_CATEGORIES,
  CHECKLIST,
  DOC_STATUSES,
  HANDOVER_STATUSES,
  RULES_VERSION,
  VOLUME_STATUSES,
  buildHandoverSnapshot,
  computeMissingByVolume,
  missingReportVolumes,
  splitVolumeCodes,
  validateHandoverRecord,
  type MissingResult,
} from '@/data/archive-rules'
import { allRows, draftState, reloadFromStorage, saveAll } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 竣工资料组卷与移交的业务入口。
// 约定与 local-service 一致：页面只做渲染，状态流转、权限、校验全部收在这里。

export type Role = '资料员' | '建设单位'

export const KEYS = {
  units: 'archiveUnits',
  volumes: 'archiveVolumes',
  docs: 'archiveDocs',
  handovers: 'archiveHandovers',
} as const

/** 存量迁移的待认领池：未归类的资料先挂这个编号，不进任何正式案卷。 */
export const POOL_CODE = '待认领'

export type ArchiveBoard = {
  units: EntryRow[]
  volumes: EntryRow[]
  docs: EntryRow[]
  handovers: EntryRow[]
  /** 案卷编号 → 缺件（统一清单口径，两个入口共用这一份） */
  missing: Record<string, MissingResult>
  /** 缺报告案卷：试验检测页直接取这份，不另算 */
  missingReports: { code: string; unit: string; title: string; missing: MissingResult }[]
  /** 本次加载顺手按现行口径重算的移交记录数 */
  recomputed: number
  rulesVersion: string
}

function now(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function today(): string {
  return now().slice(0, 10)
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nextCode(rows: EntryRow[], field: string, prefix: string): string {
  const max = rows.reduce((acc, row) => {
    const match = String(row[field] ?? '').match(new RegExp(`^${prefix}-(\\d+)$`))
    return match ? Math.max(acc, Number(match[1])) : acc
  }, 0)
  return `${prefix}-${String(max + 1).padStart(4, '0')}`
}

function normalizeCodes(codes: string[]): string[] {
  return [...new Set(codes.map((code) => code.trim()).filter(Boolean))].sort()
}

function handoverKey(handover: EntryRow): string {
  return normalizeCodes(splitVolumeCodes(handover['案卷列表'])).join(',')
}

function findVolume(volumes: EntryRow[], code: string): EntryRow | undefined {
  return volumes.find((volume) => String(volume['案卷编号']) === code)
}

function missingLabel(missing: Record<string, MissingResult>, code: string): string {
  const result = missing[code]
  if (!result || result.count === 0) {
    return ''
  }
  return `${code}（缺${result.missing.join('、')}）`
}

/**
 * 落库前校验：案卷状态机、案卷↔移交记录一致性、待签收记录的缺件快照
 * 都要与清单口径现算结果对得上。校验不过就整体撤销，不把对不上的数据写进去。
 */
function validateState(draft: Record<string, EntryRow[]>): string[] {
  const problems: string[] = []
  const volumes = draft[KEYS.volumes] ?? []
  const docs = draft[KEYS.docs] ?? []
  const handovers = draft[KEYS.handovers] ?? []

  for (const volume of volumes) {
    const code = String(volume['案卷编号'])
    if (!VOLUME_STATUSES.includes(String(volume.status) as (typeof VOLUME_STATUSES)[number])) {
      problems.push(`${code} 状态「${volume.status}」不在组卷中/待移交/已签收里`)
    }
    const inPending = handovers.filter(
      (h) => String(h.status) === '待签收' && splitVolumeCodes(h['案卷列表']).includes(code),
    )
    const inSigned = handovers.filter(
      (h) => String(h.status) === '已签收' && splitVolumeCodes(h['案卷列表']).includes(code),
    )
    if (String(volume.status) === '待移交' && inPending.length !== 1) {
      problems.push(`${code} 待移交，但没有对应的待签收移交记录`)
    }
    if (String(volume.status) === '已签收' && inSigned.length !== 1) {
      problems.push(`${code} 已签收，但没有对应的已签收移交记录`)
    }
    if (String(volume.status) === '组卷中' && (inPending.length > 0 || inSigned.length > 0)) {
      problems.push(`${code} 仍在组卷中，却挂在移交记录里`)
    }
  }

  for (const handover of handovers) {
    const code = String(handover['移交编号'])
    if (!HANDOVER_STATUSES.includes(String(handover.status) as (typeof HANDOVER_STATUSES)[number])) {
      problems.push(`${code} 移交状态「${handover.status}」不合法`)
      continue
    }
    for (const volumeCode of splitVolumeCodes(handover['案卷列表'])) {
      const volume = findVolume(volumes, volumeCode)
      if (!volume) {
        problems.push(`${code} 指向不存在的案卷 ${volumeCode}`)
        continue
      }
      if (String(handover.status) === '待签收' && String(volume.status) !== '待移交') {
        problems.push(`${code} 待签收，但 ${volumeCode} 不是待移交`)
      }
      if (String(handover.status) === '已签收' && String(volume.status) !== '已签收') {
        problems.push(`${code} 已签收，但 ${volumeCode} 不是已签收`)
      }
      // 已退回是历史记录：其中的卷可能已补齐并换编组重新提交，不约束其当前状态
    }
    if (String(handover.status) === '待签收') {
      problems.push(...validateHandoverRecord(handover, volumes, docs))
    }
  }
  return problems
}

/** 先校验再落库；校验不过或写不进去都整体撤销。 */
function persist(draft: Record<string, EntryRow[]>): ActionResult {
  const problems = validateState(draft)
  if (problems.length > 0) {
    return { ok: false, message: `落库前校验未通过，已整体撤销：${problems.join('；')}` }
  }
  try {
    saveAll(draft)
    return { ok: true, message: '' }
  } catch {
    return { ok: false, message: '本地存储写入失败，本次操作已整体撤销，请重试' }
  }
}

function buildBoard(rows: Record<string, EntryRow[]>, recomputed: number): ArchiveBoard {
  const volumes = rows[KEYS.volumes] ?? []
  const docs = rows[KEYS.docs] ?? []
  return {
    units: rows[KEYS.units] ?? [],
    volumes,
    docs,
    handovers: rows[KEYS.handovers] ?? [],
    missing: computeMissingByVolume(volumes, docs),
    missingReports: missingReportVolumes(volumes, docs),
    recomputed,
    rulesVersion: RULES_VERSION,
  }
}

/** 按现行清单口径重算存量移交记录（口径升级后历史记录也要对齐）。 */
function recomputeStaleHandovers(): number {
  const draft = draftState()
  const volumes = draft[KEYS.volumes] ?? []
  const docs = draft[KEYS.docs] ?? []
  const handovers = draft[KEYS.handovers] ?? []
  const stale = handovers.filter((h) => String(h['口径版本']) !== RULES_VERSION)
  if (stale.length === 0) {
    return 0
  }
  const next = handovers.map((h) => {
    if (String(h['口径版本']) === RULES_VERSION) {
      return h
    }
    const codes = splitVolumeCodes(h['案卷列表'])
    const snapshot = buildHandoverSnapshot(volumes, docs, codes)
    return {
      ...h,
      缺件卷: Object.keys(snapshot).join(','),
      缺件明细: JSON.stringify(snapshot),
      口径版本: RULES_VERSION,
    }
  })
  draft[KEYS.handovers] = next
  persist(draft)
  return stale.length
}

/** 常规加载：读缓存即可，顺手把旧口径的移交记录重算一遍。 */
export function loadArchiveState(): ArchiveBoard {
  const recomputed = recomputeStaleHandovers()
  return buildBoard(allRows(), recomputed)
}

/**
 * 交完之后的核对加载：绕开缓存强制重读，中途断掉就重试，
 * 试不出来直接抛错——不拿内存里的老数据兜底。
 */
export function loadVerifiedState(attempts = 3): ArchiveBoard {
  let lastError: unknown = null
  for (let i = 0; i < attempts; i += 1) {
    try {
      return buildBoard(reloadFromStorage(), 0)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('重新核对失败，请刷新页面重试')
}

// ---------- 案卷构成（只有资料员能改） ----------

export function createVolume(
  input: { 单位工程: string; 案卷类别: string; 案卷题名: string },
  role: Role,
  operator: string,
): ActionResult {
  if (role !== '资料员') {
    return { ok: false, message: '只有资料员能建卷，建设单位账号只读' }
  }
  if (!ARCHIVE_CATEGORIES.includes(input.案卷类别 as (typeof ARCHIVE_CATEGORIES)[number])) {
    return { ok: false, message: `案卷类别只能是：${ARCHIVE_CATEGORIES.join('、')}` }
  }
  if (!input.单位工程.trim() || !input.案卷题名.trim()) {
    return { ok: false, message: '单位工程和案卷题名不能为空' }
  }
  const draft = draftState()
  const volumes = draft[KEYS.volumes] ?? []
  const volume: EntryRow = {
    id: nextId(volumes),
    status: '组卷中',
    pending: true,
    abnormal: false,
    案卷编号: nextCode(volumes, '案卷编号', 'VOL'),
    案卷题名: input.案卷题名.trim(),
    单位工程: input.单位工程.trim(),
    案卷类别: input.案卷类别,
    编制人: operator,
    补充说明: '',
    首次提交时间: '',
    签收时间: '',
    签收人: '',
  }
  draft[KEYS.volumes] = [...volumes, volume]
  const saved = persist(draft)
  if (!saved.ok) {
    return saved
  }
  return { ok: true, message: `已建卷 ${volume['案卷编号']}（组卷中）` }
}

export function attachDoc(
  volumeCode: string,
  input: { 资料名称: string; 清单项: string; 提交人: string; 页数: number },
  role: Role,
): ActionResult {
  if (role !== '资料员') {
    return { ok: false, message: '只有资料员能改案卷构成，建设单位账号只读' }
  }
  const draft = draftState()
  const volumes = draft[KEYS.volumes] ?? []
  const volume = findVolume(volumes, volumeCode)
  if (!volume) {
    return { ok: false, message: `没有找到案卷 ${volumeCode}` }
  }
  if (String(volume.status) !== '组卷中') {
    return { ok: false, message: `${volumeCode} 已是「${volume.status}」，构成不能再改` }
  }
  if (!input.资料名称.trim() || !input.清单项.trim()) {
    return { ok: false, message: '资料名称和清单项不能为空' }
  }
  const docs = draft[KEYS.docs] ?? []
  const doc: EntryRow = {
    id: nextId(docs),
    status: '已装卷',
    pending: false,
    abnormal: false,
    资料编号: nextCode(docs, '资料编号', 'DOC'),
    案卷编号: volumeCode,
    资料名称: input.资料名称.trim(),
    清单项: input.清单项.trim(),
    提交人: input.提交人.trim() || '资料员',
    提交日期: today(),
    页数: Math.max(0, Number(input.页数) || 0),
    缺页说明: '',
  }
  draft[KEYS.docs] = [...docs, doc]
  const saved = persist(draft)
  if (!saved.ok) {
    return saved
  }
  return { ok: true, message: `已把《${doc['资料名称']}》装入 ${volumeCode}` }
}

/** 归类：把待认领池或别卷的资料归到目标卷的指定清单项下。 */
export function classifyDoc(
  docCode: string,
  targetVolumeCode: string,
  item: string,
  role: Role,
): ActionResult {
  if (role !== '资料员') {
    return { ok: false, message: '只有资料员能改案卷构成，建设单位账号只读' }
  }
  const draft = draftState()
  const volumes = draft[KEYS.volumes] ?? []
  const docs = draft[KEYS.docs] ?? []
  const doc = docs.find((row) => String(row['资料编号']) === docCode)
  if (!doc) {
    return { ok: false, message: `没有找到资料 ${docCode}` }
  }
  const target = findVolume(volumes, targetVolumeCode)
  if (!target) {
    return { ok: false, message: `没有找到案卷 ${targetVolumeCode}` }
  }
  if (String(target.status) !== '组卷中') {
    return { ok: false, message: `${targetVolumeCode} 已是「${target.status}」，不能再往里装` }
  }
  const currentCode = String(doc['案卷编号'])
  if (currentCode !== POOL_CODE) {
    const current = findVolume(volumes, currentCode)
    if (current && String(current.status) !== '组卷中') {
      return { ok: false, message: `${docCode} 所在的 ${currentCode} 已移交，不能动` }
    }
  }
  const validItems = (CHECKLIST[String(target['案卷类别'])] ?? []).map((entry) => entry.item)
  if (!validItems.includes(item)) {
    return { ok: false, message: `清单项只能是：${validItems.join('、')}` }
  }
  draft[KEYS.docs] = docs.map((row) =>
    String(row['资料编号']) === docCode
      ? { ...row, 案卷编号: targetVolumeCode, 清单项: item }
      : row,
  )
  const saved = persist(draft)
  if (!saved.ok) {
    return saved
  }
  return { ok: true, message: `已把 ${docCode} 归入 ${targetVolumeCode} 的「${item}」` }
}

export function removeDoc(docCode: string, role: Role): ActionResult {
  if (role !== '资料员') {
    return { ok: false, message: '只有资料员能改案卷构成，建设单位账号只读' }
  }
  const draft = draftState()
  const volumes = draft[KEYS.volumes] ?? []
  const docs = draft[KEYS.docs] ?? []
  const doc = docs.find((row) => String(row['资料编号']) === docCode)
  if (!doc) {
    return { ok: false, message: `没有找到资料 ${docCode}` }
  }
  const volume = findVolume(volumes, String(doc['案卷编号']))
  if (volume && String(volume.status) !== '组卷中') {
    return { ok: false, message: `${doc['案卷编号']} 已移交，卷内资料不能撤` }
  }
  draft[KEYS.docs] = docs.filter((row) => String(row['资料编号']) !== docCode)
  const saved = persist(draft)
  if (!saved.ok) {
    return saved
  }
  return { ok: true, message: `已把 ${docCode} 撤出案卷` }
}

/** 缺页登记 / 补齐归档：缺页的资料不计入清单满足度，补齐后才算装齐。 */
export function markDocPages(
  docCode: string,
  action: '登记缺页' | '补齐归档',
  note: string,
  role: Role,
): ActionResult {
  if (role !== '资料员') {
    return { ok: false, message: '只有资料员能改案卷构成，建设单位账号只读' }
  }
  if (!note.trim()) {
    return { ok: false, message: `请写明${action === '登记缺页' ? '缺页情况（页码范围）' : '补齐情况'}` }
  }
  const draft = draftState()
  const volumes = draft[KEYS.volumes] ?? []
  const docs = draft[KEYS.docs] ?? []
  const doc = docs.find((row) => String(row['资料编号']) === docCode)
  if (!doc) {
    return { ok: false, message: `没有找到资料 ${docCode}` }
  }
  const volume = findVolume(volumes, String(doc['案卷编号']))
  if (volume && String(volume.status) !== '组卷中') {
    return { ok: false, message: `${doc['案卷编号']} 已移交，缺页状态不能改` }
  }
  let updated: EntryRow
  if (action === '登记缺页') {
    if (String(doc.status) !== '已装卷') {
      return { ok: false, message: `${docCode} 已是待补页，不用重复登记` }
    }
    updated = { ...doc, status: '待补页', pending: true, abnormal: true, 缺页说明: note.trim() }
  } else {
    if (String(doc.status) !== '待补页') {
      return { ok: false, message: `${docCode} 不在待补页，不用补齐` }
    }
    updated = {
      ...doc,
      status: '已装卷',
      pending: false,
      abnormal: false,
      缺页说明: `${doc['缺页说明']} → [${now()}]已补齐：${note.trim()}`,
    }
  }
  draft[KEYS.docs] = docs.map((row) => (String(row['资料编号']) === docCode ? updated : row))
  const saved = persist(draft)
  if (!saved.ok) {
    return saved
  }
  return { ok: true, message: `${docCode} ${action}完成` }
}

// ---------- 移交与签收 ----------

/**
 * 多选卷册一次提交。同一组卷册重复提交仍按最早那次：
 * 已有待签收记录就直接返回原记录，不重复登记；退回重报的保留首次提交时间。
 */
export function submitHandover(volumeCodes: string[], role: Role, operator: string): ActionResult {
  if (role !== '资料员') {
    return { ok: false, message: '只有资料员能提交移交，建设单位账号只读' }
  }
  const codes = normalizeCodes(volumeCodes)
  if (codes.length === 0) {
    return { ok: false, message: '请先勾选要移交的卷册' }
  }
  const draft = draftState()
  const volumes = draft[KEYS.volumes] ?? []
  const docs = draft[KEYS.docs] ?? []
  const handovers = draft[KEYS.handovers] ?? []
  const missing = computeMissingByVolume(volumes, docs)
  for (const code of codes) {
    if (!findVolume(volumes, code)) {
      return { ok: false, message: `没有找到案卷 ${code}` }
    }
  }
  const key = codes.join(',')
  const existing = handovers.find((h) => handoverKey(h) === key)
  if (existing) {
    if (String(existing.status) === '待签收') {
      return {
        ok: true,
        message: `该组卷册已于 ${existing['首次提交时间']} 提交过（${existing['移交编号']}），仍按最早那次，不重复登记`,
      }
    }
    if (String(existing.status) === '已签收') {
      return { ok: false, message: `该组卷册已由 ${existing['签收人']} 签收，不能再提交` }
    }
    // 已退回 → 重报：先过缺件关，再过状态关，首次提交时间不动
    const deficient = codes.map((code) => missingLabel(missing, code)).filter(Boolean)
    if (deficient.length > 0) {
      return { ok: false, message: `缺件案卷不允许提交移交：${deficient.join('；')}` }
    }
    const notReady = codes.filter((code) => String(findVolume(volumes, code)?.status) !== '组卷中')
    if (notReady.length > 0) {
      return { ok: false, message: `${notReady.join('、')} 不在组卷中，不能重报` }
    }
    const stamp = now()
    draft[KEYS.handovers] = handovers.map((h) =>
      String(h['移交编号']) === String(existing['移交编号'])
        ? {
            ...h,
            status: '待签收',
            pending: true,
            abnormal: false,
            最近提交时间: stamp,
            缺件卷: '',
            缺件明细: '{}',
            结论: '',
            退回原因: '',
            签收人: '',
            签收时间: '',
            口径版本: RULES_VERSION,
          }
        : h,
    )
    draft[KEYS.volumes] = volumes.map((v) =>
      codes.includes(String(v['案卷编号'])) ? { ...v, status: '待移交', pending: true } : v,
    )
    const saved = persist(draft)
    if (!saved.ok) {
      return saved
    }
    return {
      ok: true,
      message: `已重新提交（${existing['移交编号']}），首次提交仍按 ${existing['首次提交时间']}`,
    }
  }
  const notReady = codes.filter((code) => String(findVolume(volumes, code)?.status) !== '组卷中')
  if (notReady.length > 0) {
    return { ok: false, message: `${notReady.join('、')} 不在组卷中，不能提交移交` }
  }
  const deficient = codes.map((code) => missingLabel(missing, code)).filter(Boolean)
  if (deficient.length > 0) {
    return { ok: false, message: `缺件案卷不允许提交移交：${deficient.join('；')}` }
  }
  const stamp = now()
  const handover: EntryRow = {
    id: nextId(handovers),
    status: '待签收',
    pending: true,
    abnormal: false,
    移交编号: nextCode(handovers, '移交编号', 'HO'),
    案卷列表: key,
    卷数: codes.length,
    缺件卷: '',
    缺件明细: '{}',
    提交人: operator,
    首次提交时间: stamp,
    最近提交时间: stamp,
    签收人: '',
    签收时间: '',
    结论: '',
    退回原因: '',
    退回次数: 0,
    口径版本: RULES_VERSION,
  }
  draft[KEYS.handovers] = [...handovers, handover]
  draft[KEYS.volumes] = volumes.map((v) =>
    codes.includes(String(v['案卷编号']))
      ? { ...v, status: '待移交', pending: true, 首次提交时间: stamp }
      : v,
  )
  const saved = persist(draft)
  if (!saved.ok) {
    return saved
  }
  return { ok: true, message: `已提交 ${codes.length} 卷（${handover['移交编号']}），待建设单位签收` }
}

/**
 * 建设单位逐卷核对后整组签收：任何一卷缺件就整组退回重报，并点名到卷。
 * 签收后案卷到已签收，只能补充说明，不能再改回待移交。
 */
export function signHandover(handoverCode: string, role: Role, operator: string): ActionResult {
  if (role !== '建设单位') {
    return { ok: false, message: '只有建设单位账号能签收，资料员不能替签' }
  }
  const draft = draftState()
  const volumes = draft[KEYS.volumes] ?? []
  const docs = draft[KEYS.docs] ?? []
  const handovers = draft[KEYS.handovers] ?? []
  const handover = handovers.find((h) => String(h['移交编号']) === handoverCode)
  if (!handover) {
    return { ok: false, message: `没有找到移交记录 ${handoverCode}` }
  }
  if (String(handover.status) !== '待签收') {
    return { ok: false, message: `${handoverCode} 已是「${handover.status}」，签收结论不能改回去` }
  }
  const codes = splitVolumeCodes(handover['案卷列表'])
  const missing = computeMissingByVolume(volumes, docs)
  const deficient = codes.filter((code) => (missing[code]?.count ?? 0) > 0)
  const stamp = now()
  if (deficient.length > 0) {
    const snapshot = buildHandoverSnapshot(volumes, docs, codes)
    const reason = `逐卷核对发现 ${deficient
      .map((code) => `${code} 缺${(missing[code]?.missing ?? []).join('、')}`)
      .join('；')}，整组退回重报`
    draft[KEYS.handovers] = handovers.map((h) =>
      String(h['移交编号']) === handoverCode
        ? {
            ...h,
            status: '已退回',
            pending: false,
            abnormal: true,
            缺件卷: deficient.join(','),
            缺件明细: JSON.stringify(snapshot),
            签收人: operator,
            签收时间: stamp,
            结论: '整组退回',
            退回原因: reason,
            退回次数: (Number(h['退回次数']) || 0) + 1,
            口径版本: RULES_VERSION,
          }
        : h,
    )
    draft[KEYS.volumes] = volumes.map((v) =>
      codes.includes(String(v['案卷编号'])) ? { ...v, status: '组卷中', pending: true } : v,
    )
    const saved = persist(draft)
    if (!saved.ok) {
      return saved
    }
    return { ok: true, message: `核对未过，已整组退回：${reason}` }
  }
  draft[KEYS.handovers] = handovers.map((h) =>
    String(h['移交编号']) === handoverCode
      ? {
          ...h,
          status: '已签收',
          pending: false,
          abnormal: false,
          签收人: operator,
          签收时间: stamp,
          结论: '整组签收',
          口径版本: RULES_VERSION,
        }
      : h,
  )
  draft[KEYS.volumes] = volumes.map((v) =>
    codes.includes(String(v['案卷编号']))
      ? { ...v, status: '已签收', pending: false, 签收人: operator, 签收时间: stamp }
      : v,
  )
  const saved = persist(draft)
  if (!saved.ok) {
    return saved
  }
  return { ok: true, message: `逐卷核对通过，${handoverCode} 整组签收，卷册转只读` }
}

/** 建设单位主动整组退回（核对之外发现问题的兜底入口）。 */
export function returnHandover(
  handoverCode: string,
  reason: string,
  role: Role,
  operator: string,
): ActionResult {
  if (role !== '建设单位') {
    return { ok: false, message: '只有建设单位账号能退回' }
  }
  const draft = draftState()
  const volumes = draft[KEYS.volumes] ?? []
  const docs = draft[KEYS.docs] ?? []
  const handovers = draft[KEYS.handovers] ?? []
  const handover = handovers.find((h) => String(h['移交编号']) === handoverCode)
  if (!handover) {
    return { ok: false, message: `没有找到移交记录 ${handoverCode}` }
  }
  if (String(handover.status) !== '待签收') {
    return { ok: false, message: `${handoverCode} 已是「${handover.status}」，不能再退回` }
  }
  const codes = splitVolumeCodes(handover['案卷列表'])
  const snapshot = buildHandoverSnapshot(volumes, docs, codes)
  const stamp = now()
  draft[KEYS.handovers] = handovers.map((h) =>
    String(h['移交编号']) === handoverCode
      ? {
          ...h,
          status: '已退回',
          pending: false,
          abnormal: true,
          缺件卷: Object.keys(snapshot).join(','),
          缺件明细: JSON.stringify(snapshot),
          签收人: operator,
          签收时间: stamp,
          结论: '整组退回',
          退回原因: reason.trim() || '建设单位要求整组退回重报',
          退回次数: (Number(h['退回次数']) || 0) + 1,
          口径版本: RULES_VERSION,
        }
      : h,
  )
  draft[KEYS.volumes] = volumes.map((v) =>
    codes.includes(String(v['案卷编号'])) ? { ...v, status: '组卷中', pending: true } : v,
  )
  const saved = persist(draft)
  if (!saved.ok) {
    return saved
  }
  return { ok: true, message: `${handoverCode} 已整组退回，卷册回到组卷中` }
}

/** 已签收卷册的唯一改动入口：追加补充说明，状态一律不动。 */
export function appendVolumeNote(volumeCode: string, note: string, role: Role): ActionResult {
  if (role !== '资料员') {
    return { ok: false, message: '建设单位账号签收后即转只读，补充说明由资料员登记' }
  }
  if (!note.trim()) {
    return { ok: false, message: '补充说明不能为空' }
  }
  const draft = draftState()
  const volumes = draft[KEYS.volumes] ?? []
  const volume = findVolume(volumes, volumeCode)
  if (!volume) {
    return { ok: false, message: `没有找到案卷 ${volumeCode}` }
  }
  if (String(volume.status) !== '已签收') {
    return { ok: false, message: `${volumeCode} 还是「${volume.status}」，补充说明只针对已签收卷册` }
  }
  const line = `[${now()}] ${note.trim()}`
  draft[KEYS.volumes] = volumes.map((v) =>
    String(v['案卷编号']) === volumeCode
      ? { ...v, 补充说明: v['补充说明'] ? `${v['补充说明']}\n${line}` : line }
      : v,
  )
  const saved = persist(draft)
  if (!saved.ok) {
    return saved
  }
  return { ok: true, message: `已给 ${volumeCode} 追加补充说明` }
}

// ---------- 存量迁移与口径重算 ----------

const LEGACY_SOURCES: { key: string; category: string; label: (row: EntryRow) => string }[] = [
  { key: 'testing', category: '试验报告', label: (row) => `${row['检测项目']}（${row['委托编号']}）` },
  { key: 'axis', category: '测量成果', label: (row) => `轴线测量 ${row['测量编号']}` },
  { key: 'settlement', category: '测量成果', label: (row) => `沉降监测 ${row['测点编号']}` },
  { key: 'ring', category: '施工记录', label: (row) => `掘进环次记录 ${row['环号']}` },
  { key: 'segment', category: '施工记录', label: (row) => `管片拼装记录 ${row['管片环号']}` },
  { key: 'grouting', category: '施工记录', label: (row) => `同步注浆记录 ${row['注浆编号']}` },
]

/**
 * 存量工程迁移组卷：老模块里的施工记录、试验报告、测量成果按类别搬进
 * 待认领池（不进任何正式卷），再由资料员按单位工程逐份归类挂卷。
 * 重复执行安全：已迁移过的资料编号直接跳过。
 */
export function migrateLegacy(role: Role): ActionResult {
  if (role !== '资料员') {
    return { ok: false, message: '只有资料员能执行存量迁移' }
  }
  const draft = draftState()
  const docs = draft[KEYS.docs] ?? []
  const known = new Set(docs.map((doc) => String(doc['资料编号'])))
  const added: EntryRow[] = []
  let id = nextId(docs)
  for (const source of LEGACY_SOURCES) {
    for (const row of draft[source.key] ?? []) {
      const code = `LS-${source.key}-${row.id}`
      if (known.has(code)) {
        continue
      }
      known.add(code)
      added.push({
        id: id++,
        status: '已装卷',
        pending: true,
        abnormal: false,
        资料编号: code,
        案卷编号: POOL_CODE,
        资料名称: source.label(row),
        清单项: '待归类',
        提交人: '存量迁移',
        提交日期: today(),
        页数: 0,
        缺页说明: '',
      })
    }
  }
  if (added.length === 0) {
    return { ok: true, message: '存量资料都已迁移过，没有新增' }
  }
  draft[KEYS.docs] = [...docs, ...added]
  const saved = persist(draft)
  if (!saved.ok) {
    return saved
  }
  return {
    ok: true,
    message: `已迁移 ${added.length} 份存量资料到待认领池，请按单位工程逐份归类挂卷`,
  }
}

/** 手动触发口径重算（算法调整后用），返回重算的移交记录数。 */
export function recomputeHandovers(): ActionResult {
  const count = recomputeStaleHandovers()
  if (count === 0) {
    return { ok: true, message: `所有移交记录已是 ${RULES_VERSION}，无需重算` }
  }
  return { ok: true, message: `已按 ${RULES_VERSION} 重算 ${count} 条移交记录的缺件结论` }
}

export function checklistItems(category: string): string[] {
  return (CHECKLIST[category] ?? []).map((entry) => entry.item)
}

export function docStatuses(): readonly string[] {
  return DOC_STATUSES
}
