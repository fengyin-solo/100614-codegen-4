import { ARCHIVE_SEED } from './seed'
import type { ArchiveState } from './types'

// 与既有业务表分开存放：档案域自成一库，换库不影响原模块数据。
const ARCHIVE_KEY = 'shield-tunnel-construction:archive:v1'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function seedState(): ArchiveState {
  return clone(ARCHIVE_SEED)
}

/**
 * 读库：不保留内存长缓存——每次业务动作都重新从 localStorage 现读，
 * 保证「交完之后重新进页面核对，中途断掉就重试，不要拿老数据兜底」。
 */
export function readArchive(): ArchiveState {
  if (typeof window === 'undefined' || !window.localStorage) {
    return seedState()
  }
  const raw = window.localStorage.getItem(ARCHIVE_KEY)
  if (!raw) {
    const seeded = seedState()
    window.localStorage.setItem(ARCHIVE_KEY, JSON.stringify(seeded))
    return seeded
  }
  try {
    return JSON.parse(raw) as ArchiveState
  } catch {
    // 解析失败说明库已损坏：回到种子而不是把坏数据当现状往下走。
    const seeded = seedState()
    window.localStorage.setItem(ARCHIVE_KEY, JSON.stringify(seeded))
    return seeded
  }
}

/**
 * 整笔落库：mutator 在内存里改完整颗状态树，这里一次序列化写入。
 * 写后立即从存储读回核对，不一致就抛错（调用方负责重试一次）。
 * 任何异常（含配额已满存不下）都不会产生半成品状态——要么整笔成功，要么整体撤销。
 */
export function commitArchive(mutator: (draft: ArchiveState) => void): ArchiveState {
  const base = readArchive()
  const next = clone(base)
  mutator(next)
  return persistWithVerify(next)
}

function persistWithVerify(state: ArchiveState, attempt = 0): ArchiveState {
  const payload = JSON.stringify(state)
  try {
    window.localStorage.setItem(ARCHIVE_KEY, payload)
  } catch (error) {
    // 存不下（QuotaExceededError 等）：一次都没写进去，现场状态保持不动 → 整体撤销。
    if (attempt < 1) {
      return persistWithVerify(state, attempt + 1)
    }
    throw new Error('保存失败：浏览器存储空间不足，本次操作已整体撤销，没有写入任何数据')
  }
  // 读回核对：以存储里的那份为准重新解析，拒绝用内存对象冒充成功。
  const readBack = readArchive()
  if (JSON.stringify(readBack) !== payload) {
    if (attempt < 1) {
      return persistWithVerify(state, attempt + 1)
    }
    throw new Error('保存校验失败：写库后读回的数据与提交内容不一致，已按未提交处理，请重试')
  }
  return readBack
}

export function resetArchive(): ArchiveState {
  const seeded = seedState()
  return persistWithVerify(seeded)
}

export function archiveStorageKey(): string {
  return ARCHIVE_KEY
}
