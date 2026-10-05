import { defineStore } from 'pinia'

export type SessionRole = '资料员' | '建设单位'

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '盾构隧道掘进施工管理平台',
    // 竣工资料组卷与移交用的角色：只有资料员能改案卷构成，建设单位负责签收
    role: '资料员' as SessionRole,
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    isArchivist: (state) => state.role === '资料员',
    isOwner: (state) => state.role === '建设单位',
    // 角色下的账号名：签收、提交都落这个名字
    roleOperator: (state) => (state.role === '建设单位' ? '建设单位-王工' : '资料员-小李'),
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setRole(role: SessionRole) {
      this.role = role
    },
  },
})
