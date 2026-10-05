import { defineStore } from 'pinia'
import type { Role } from '@/data/archive/types'

// 两个账号：资料员能改案卷构成并提交移交；建设单位只核对签收，签收后卷册转只读。
export const ACCOUNTS: { role: Role; name: string; desc: string }[] = [
  { role: '资料员', name: '周岚', desc: '施工单位资料员：组卷、挂件、提交移交' },
  { role: '建设单位', name: '高磊', desc: '建设单位：逐卷核对、整组签收/退回' },
]

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: ACCOUNTS[0].name,
    role: ACCOUNTS[0].role as Role,
    accountDesc: ACCOUNTS[0].desc,
    shiftLabel: '白班 08:00-20:00',
    scope: '盾构隧道掘进施工管理平台',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    isDocumentarian: (state) => state.role === '资料员',
    isOwner: (state) => state.role === '建设单位',
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    switchAccount(index: number) {
      const account = ACCOUNTS[index] ?? ACCOUNTS[0]
      this.role = account.role
      this.operator = account.name
      this.accountDesc = account.desc
    },
  },
})
