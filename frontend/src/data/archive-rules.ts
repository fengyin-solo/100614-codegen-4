import type { EntryRow } from './types'

// 竣工资料组卷与移交的统一口径。
// 缺件只认资料清单这一份算法：组卷页、移交签收页、试验检测页都从这里的函数取数，
// 任何地方不再自己写第二份缺件逻辑。口径调整后，用 recompute 把存量移交记录重算一遍。

/** 口径版本：算法或清单变动时升版本，存量移交记录按版本号识别并重算。 */
export const RULES_VERSION = 'v2-清单口径'

export const VOLUME_STATUSES = ['组卷中', '待移交', '已签收'] as const

export const HANDOVER_STATUSES = ['待签收', '已签收', '已退回'] as const

export const ARCHIVE_CATEGORIES = ['施工记录', '试验报告', '测量成果'] as const

/** 资料状态：已装卷计入清单满足度；待补页（缺页）不计入。 */
export const DOC_STATUSES = ['已装卷', '待补页'] as const

/**
 * 资料清单：每类案卷必装的清单项与要求份数。
 * 缺件判定只以这份清单为准——卷内实装与清单打架时，以清单为准。
 */
export const CHECKLIST: Record<string, { item: string; copies: number }[]> = {
  施工记录: [
    { item: '施工日志', copies: 1 },
    { item: '隐蔽工程验收记录', copies: 1 },
    { item: '管片拼装记录', copies: 1 },
    { item: '同步注浆记录', copies: 1 },
  ],
  试验报告: [
    { item: '混凝土抗压强度报告', copies: 1 },
    { item: '钢筋原材复试报告', copies: 1 },
    { item: '浆液试块强度报告', copies: 1 },
  ],
  测量成果: [
    { item: '导线测量成果', copies: 1 },
    { item: '沉降监测成果', copies: 1 },
    { item: '轴线偏差测量成果', copies: 1 },
  ],
}

export type MissingResult = {
  /** 未满足的清单项（点名到项） */
  missing: string[]
  /** 缺件数 = 未满足清单项数 */
  count: number
}

export function splitVolumeCodes(value: unknown): string[] {
  return String(value ?? '')
    .split(',')
    .map((code) => code.trim())
    .filter((code) => code.length > 0)
}

/** 卷内有效资料：挂在该卷下且已装卷（待补页的缺页资料不算装齐）。 */
function effectiveDocs(docs: EntryRow[], volumeCode: string): EntryRow[] {
  return docs.filter(
    (doc) => String(doc['案卷编号']) === volumeCode && String(doc.status) === '已装卷',
  )
}

/** 统一缺件算法：以资料清单为准，逐清单项核对卷内实装份数。 */
export function computeVolumeMissing(volume: EntryRow, docs: EntryRow[]): MissingResult {
  const required = CHECKLIST[String(volume['案卷类别'] ?? '')] ?? []
  const attached = effectiveDocs(docs, String(volume['案卷编号']))
  const missing: string[] = []
  for (const { item, copies } of required) {
    const got = attached.filter((doc) => String(doc['清单项']) === item).length
    if (got < copies) {
      missing.push(item)
    }
  }
  return { missing, count: missing.length }
}

/** 一次算完全部案卷的缺件，两个入口共用这一份结果。 */
export function computeMissingByVolume(
  volumes: EntryRow[],
  docs: EntryRow[],
): Record<string, MissingResult> {
  const result: Record<string, MissingResult> = {}
  for (const volume of volumes) {
    result[String(volume['案卷编号'])] = computeVolumeMissing(volume, docs)
  }
  return result
}

/** 移交记录里的缺件快照：只登记有缺件的卷，点名到卷、到清单项。 */
export function buildHandoverSnapshot(
  volumes: EntryRow[],
  docs: EntryRow[],
  volumeCodes: string[],
): Record<string, string[]> {
  const snapshot: Record<string, string[]> = {}
  const missingMap = computeMissingByVolume(volumes, docs)
  for (const code of volumeCodes) {
    const result = missingMap[code]
    if (result && result.count > 0) {
      snapshot[code] = [...result.missing].sort()
    }
  }
  return snapshot
}

/** 缺报告案卷：试验报告类且按清单口径有缺件的卷，试验检测页用它查缺。 */
export function missingReportVolumes(
  volumes: EntryRow[],
  docs: EntryRow[],
): { code: string; unit: string; title: string; missing: MissingResult }[] {
  const missingMap = computeMissingByVolume(volumes, docs)
  return volumes
    .filter((volume) => String(volume['案卷类别']) === '试验报告')
    .map((volume) => {
      const code = String(volume['案卷编号'])
      return {
        code,
        unit: String(volume['单位工程'] ?? ''),
        title: String(volume['案卷题名'] ?? ''),
        missing: missingMap[code] ?? { missing: [], count: 0 },
      }
    })
    .filter((item) => item.missing.count > 0)
}

function snapshotEquals(stored: string, computed: Record<string, string[]>): boolean {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(stored || '{}') as Record<string, unknown>
  } catch {
    return false
  }
  const storedKeys = Object.keys(parsed).sort()
  const computedKeys = Object.keys(computed).sort()
  if (storedKeys.join(',') !== computedKeys.join(',')) {
    return false
  }
  return computedKeys.every((key) => {
    const storedItems = Array.isArray(parsed[key]) ? (parsed[key] as unknown[]).map(String) : []
    return [...storedItems].sort().join(',') === computed[key].join(',')
  })
}

/**
 * 落库前校验：移交记录里的缺件快照必须与按清单口径现算的结果一致。
 * 返回不一致点，空数组表示通过。这是"两处入口缺件数一致"的兜底校验。
 */
export function validateHandoverRecord(
  record: EntryRow,
  volumes: EntryRow[],
  docs: EntryRow[],
): string[] {
  const problems: string[] = []
  const code = String(record['移交编号'])
  const volumeCodes = splitVolumeCodes(record['案卷列表'])
  const snapshot = buildHandoverSnapshot(volumes, docs, volumeCodes)
  const expectDeficient = Object.keys(snapshot).join(',')
  if (String(record['缺件卷'] ?? '') !== expectDeficient) {
    problems.push(`${code} 缺件卷登记为「${record['缺件卷'] || '无'}」，按清单口径应为「${expectDeficient || '无'}」`)
  }
  if (!snapshotEquals(String(record['缺件明细'] ?? '{}'), snapshot)) {
    problems.push(`${code} 缺件明细与清单口径不一致`)
  }
  return problems
}
