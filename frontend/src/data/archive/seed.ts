import type { ArchiveState } from './types'

// 档案域示例数据：一个单位工程已迁移组卷并提交了首批移交（v1 口径放行），
// 另外两个仍是散在资料池里的存量工程，留给「按单位工程迁移组卷」演示。
export const ARCHIVE_SEED: ArchiveState = {
  schemaVersion: 1,
  // 播种时还是 v1 口径：首次进入由 service 升到 v2，并对已生成批次做重算演示。
  algorithmVersion: 'v1-2026-08-01',
  unitProjects: [
    { id: 'U-001', code: 'DW-01', name: '地铁3号线江北站—江洲站盾构区间', remark: '盾构区间单位工程' },
    { id: 'U-002', code: 'DW-02', name: '地铁3号线江洲站主体结构工程', remark: '车站主体单位工程' },
    { id: 'U-003', code: 'DW-03', name: '地铁3号线中间风井工程', remark: '风井单位工程' },
  ],
  docs: [
    // U-001：施工记录缺 2 页；测量成果齐；试验报告只有 TEST-0003 出具。
    { id: 'D-0101', unitProjectId: 'U-001', category: '施工记录', name: '管片拼装记录（1~200环）', pages: 98, submitter: '拼装班组 张工', submittedAt: '2026-09-10T08:00:00.000Z' },
    { id: 'D-0102', unitProjectId: 'U-001', category: '测量成果', name: '盾构轴线测量成果', pages: 100, submitter: '测量班 李测', submittedAt: '2026-09-12T08:00:00.000Z' },
    { id: 'D-0103', unitProjectId: 'U-001', category: '试验报告', name: '管片抗压强度试验报告', pages: 6, submitter: '市建设工程检测中心', syncedFromTesting: 3, testingRef: 'TEST-0003', submittedAt: '2026-09-15T08:00:00.000Z' },
    // U-002：散件齐全，另夹带一份对不上清单的班前讲话记录（迁移时入 loose）。
    { id: 'D-0201', unitProjectId: 'U-002', category: '施工记录', name: '始发洞门凿除施工记录', pages: 60, submitter: '土建班组 王伟', submittedAt: '2026-09-05T08:00:00.000Z' },
    { id: 'D-0202', unitProjectId: 'U-002', category: '测量成果', name: '始发洞门测量成果', pages: 40, submitter: '测量班 李测', submittedAt: '2026-09-06T08:00:00.000Z' },
    { id: 'D-0203', unitProjectId: 'U-002', category: '施工记录', name: '班前安全讲话记录', pages: 12, submitter: '安全员 赵巡', submittedAt: '2026-09-07T08:00:00.000Z' },
    // U-003：施工记录缺页，测量成果整件缺失，另有一份对不上清单的散件。
    { id: 'D-0301', unitProjectId: 'U-003', category: '施工记录', name: '联络通道开挖施工记录', pages: 72, submitter: '土建班组 王伟', submittedAt: '2026-09-08T08:00:00.000Z' },
    { id: 'D-0302', unitProjectId: 'U-003', category: '测量成果', name: '临时控制点复测记录', pages: 5, submitter: '测量班 李测', submittedAt: '2026-09-09T08:00:00.000Z' },
  ],
  checklist: [
    { id: 'I-0101', unitProjectId: 'U-001', category: '施工记录', name: '管片拼装记录（1~200环）', requiredPages: 100 },
    { id: 'I-0102', unitProjectId: 'U-001', category: '测量成果', name: '盾构轴线测量成果', requiredPages: 100 },
    { id: 'I-0103', unitProjectId: 'U-001', category: '试验报告', name: '混凝土抗渗试验报告', requiredPages: 6, testingRef: 'TEST-0001' },
    { id: 'I-0104', unitProjectId: 'U-001', category: '试验报告', name: '管片抗压强度试验报告', requiredPages: 6, testingRef: 'TEST-0003' },
    { id: 'I-0105', unitProjectId: 'U-001', category: '试验报告', name: '同步注浆浆液配比试验报告', requiredPages: 4, testingRef: 'TEST-0002' },
    { id: 'I-0201', unitProjectId: 'U-002', category: '施工记录', name: '始发洞门凿除施工记录', requiredPages: 60 },
    { id: 'I-0202', unitProjectId: 'U-002', category: '测量成果', name: '始发洞门测量成果', requiredPages: 40 },
    { id: 'I-0301', unitProjectId: 'U-003', category: '施工记录', name: '联络通道开挖施工记录', requiredPages: 80 },
    { id: 'I-0302', unitProjectId: 'U-003', category: '测量成果', name: '联络通道贯通测量成果', requiredPages: 30 },
  ],
  volumes: [
    {
      id: 'V-001-SG',
      code: 'SG-2026-U001',
      unitProjectId: 'U-001',
      category: '施工记录',
      itemIds: ['I-0101'],
      attachments: [
        { itemId: 'I-0101', docId: 'D-0101', attachedAt: '2026-09-18T09:20:00.000Z' },
      ],
      status: '待移交',
      notes: [],
      createdAt: '2026-09-18T09:00:00.000Z',
      updatedAt: '2026-09-20T09:30:00.000Z',
    },
    {
      id: 'V-001-CL',
      code: 'CL-2026-U001',
      unitProjectId: 'U-001',
      category: '测量成果',
      itemIds: ['I-0102'],
      attachments: [
        { itemId: 'I-0102', docId: 'D-0102', attachedAt: '2026-09-18T09:25:00.000Z' },
      ],
      status: '待移交',
      notes: [],
      createdAt: '2026-09-18T09:00:00.000Z',
      updatedAt: '2026-09-20T09:30:00.000Z',
    },
    {
      id: 'V-001-SY',
      code: 'SY-2026-U001',
      unitProjectId: 'U-001',
      category: '试验报告',
      itemIds: ['I-0103', 'I-0104', 'I-0105'],
      attachments: [
        // v1 口径不卡委托状态，曾允许空挂：I-0103 / I-0105 都没有真实报告。
        { itemId: 'I-0103', docId: null, remark: 'v1 组卷时占位，报告待委托出具', attachedAt: '2026-09-18T09:30:00.000Z' },
        { itemId: 'I-0104', docId: 'D-0103', attachedAt: '2026-09-18T09:30:00.000Z' },
        { itemId: 'I-0105', docId: null, remark: 'v1 组卷时占位，报告待委托出具', attachedAt: '2026-09-18T09:30:00.000Z' },
      ],
      status: '待移交',
      notes: [
        { at: '2026-09-18T09:35:00.000Z', role: '资料员', text: '按 v1 口径组卷，试验委托尚未全部出具，先占位提交。' },
      ],
      createdAt: '2026-09-18T09:00:00.000Z',
      updatedAt: '2026-09-20T09:30:00.000Z',
    },
  ],
  batches: [
    {
      id: 'B-0001',
      code: 'YJ-2026-001',
      unitProjectIds: ['U-001'],
      volumeIds: ['V-001-SG', 'V-001-CL', 'V-001-SY'],
      outcome: '待核对',
      submitter: '周岚',
      firstSubmittedAt: '2026-09-20T09:30:00.000Z',
      submittedAt: '2026-09-20T09:30:00.000Z',
      submitNo: 1,
      snapshots: {
        提交: {
          algorithmVersion: 'v1-2026-08-01',
          missingCount: 0,
          entries: [],
        },
      },
      events: [
        { at: '2026-09-20T09:30:00.000Z', role: '资料员', action: '提交移交', detail: '3 卷一次性提交（SG/CL/SY-2026-U001），v1 口径校验通过。' },
      ],
    },
  ],
  migrations: [
    {
      unitProjectId: 'U-001',
      migratedAt: '2026-09-18T09:40:00.000Z',
      createdVolumeIds: ['V-001-SG', 'V-001-CL', 'V-001-SY'],
      attachedCount: 3,
      deficiencies: [
        {
          volumeId: 'V-001-SG',
          volumeCode: 'SG-2026-U001',
          itemId: 'I-0101',
          itemName: '管片拼装记录（1~200环）',
          missingTypes: ['页数不足'],
          remedy: '现有 98 页、清单要求 100 页：向拼装班组追回第 176、177 环记录并在卷内「修正页数/补页」。',
        },
        {
          volumeId: 'V-001-SY',
          volumeCode: 'SY-2026-U001',
          itemId: 'I-0103',
          itemName: '混凝土抗渗试验报告',
          missingTypes: ['试验报告未出具'],
          remedy: 'TEST-0001 仍在「待送样」：到试验检测页送样并出具报告，系统会自动入资料池，再回卷内补挂。',
        },
        {
          volumeId: 'V-001-SY',
          volumeCode: 'SY-2026-U001',
          itemId: 'I-0105',
          itemName: '同步注浆浆液配比试验报告',
          missingTypes: ['试验报告未出具'],
          remedy: 'TEST-0002「检测中」：跟踪检测中心出具报告后回卷内补挂。',
        },
      ],
      looseDocIds: [],
    },
  ],
  seq: { batch: 1 },
}
