/**
 * 竣工资料组卷与移交域的类型。
 * 与既有业务模块不同，这一块的状态机（组卷中→待移交→已签收）和缺件口径单独维护。
 */

export type Role = '资料员' | '建设单位'

export type DocCategory = '施工记录' | '测量成果' | '试验报告'

/** 案卷状态：只能按 组卷中→待移交→已签收 单向走，退回时整组回到「组卷中」。 */
export type VolumeStatus = '组卷中' | '待移交' | '已签收'

/** 批次结论：待核对（待签收）/已签收/已退回。批次一旦签收，只能补说明，不能改回。 */
export type BatchOutcome = '待核对' | '已签收' | '已退回'

export type UnitProject = {
  id: string
  code: string
  name: string
  remark?: string
}

/**
 * 资料池：施工记录、测量成果、试验报告三类资料的唯一登记处。
 * 试验报告的资料记录由「试验检测」页出具报告时同步生成/更新，页面不允许手工新建。
 */
export type ArchiveDoc = {
  id: string
  unitProjectId: string
  category: DocCategory
  name: string
  pages: number
  submitter: string
  syncedFromTesting?: number
  testingRef?: string
  submittedAt: string
}

/** 资料清单条目：缺件口径的唯一基准。 */
export type ChecklistItem = {
  id: string
  unitProjectId: string
  category: DocCategory
  name: string
  requiredPages: number
  /** 试验报告类条目：必须能对上试验委托清单里的委托编号才算到位。 */
  testingRef?: string
}

/** 卷内挂接：itemId 指向清单条目，docId 指向资料池资料（试验报告允许历史空挂）。 */
export type Attachment = {
  itemId: string
  docId: string | null
  /** 实测页数允许在挂接时修正（页码不清的情况），缺件判断以它为准，缺省回退资料页数。 */
  actualPages?: number
  remark?: string
  attachedAt: string
}

export type VolumeNote = {
  at: string
  role: Role
  text: string
}

export type Volume = {
  id: string
  code: string
  unitProjectId: string
  category: DocCategory
  /** 该卷负责覆盖的清单条目，建卷时按单位工程+类别一次定全。 */
  itemIds: string[]
  attachments: Attachment[]
  status: VolumeStatus
  notes: VolumeNote[]
  createdAt: string
  updatedAt: string
}

/** 缺件明细条目：missingType 决定点名口径，供两个入口共用。 */
export type MissingEntry = {
  itemId: string
  itemName: string
  category: DocCategory
  requiredPages: number
  testingRef?: string
  docId: string | null
  docName: string | null
  actualPages: number | null
  missingTypes: MissingType[]
}

export type MissingType = '未挂件' | '试验报告未出具' | '页数不足'

export type MissingSnapshot = {
  /** 按当时算法版本计算，现口径展示始终走 computeMissing 现算。 */
  algorithmVersion: string
  missingCount: number
  entries: MissingEntry[]
}

export type BatchEvent = {
  at: string
  role: Role
  action: string
  detail: string
}

export type HandoverBatch = {
  id: string
  /** 同卷册重复移交沿用最早的批次号（幂等），另用 submitNo 记录第几次提交。 */
  code: string
  unitProjectIds: string[]
  volumeIds: string[]
  outcome: BatchOutcome
  submitter: string
  /** 首次提交时间：重报时保持不变，「再递一遍仍按最早那次」。 */
  firstSubmittedAt: string
  submittedAt: string
  submitNo: number
  signer?: string
  signedAt?: string
  /** 退回时点名到卷的结论。 */
  rejectReason?: { at: string; deficientVolumes: { volumeId: string; volumeCode: string; entries: MissingEntry[] }[] }
  /** 各动作节点冻结的快照（提交/重算/签收/退回），便于追溯。 */
  snapshots: Record<string, MissingSnapshot>
  events: BatchEvent[]
}

export type MigrationResult = {
  unitProjectId: string
  migratedAt: string
  createdVolumeIds: string[]
  attachedCount: number
  /** 缺页/缺件点名，含建议补齐方式。 */
  deficiencies: {
    volumeId: string
    volumeCode: string
    itemId: string
    itemName: string
    missingTypes: MissingType[]
    remedy: string
  }[]
  /** 散件没能归卷的（按名称对不上清单），提示人工认领。 */
  looseDocIds: string[]
}

export type ArchiveState = {
  schemaVersion: number
  algorithmVersion: string
  unitProjects: UnitProject[]
  docs: ArchiveDoc[]
  checklist: ChecklistItem[]
  volumes: Volume[]
  batches: HandoverBatch[]
  migrations: MigrationResult[]
  seq: { batch: number }
}

/** 现口径算法版本：换版后已生成移交记录照此重算（见 recomputeExistingBatches）。 */
export const ALGORITHM_VERSION = 'v2-2026-10-05'
