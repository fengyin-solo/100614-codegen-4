import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'shield-tunnel-construction:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

/** 取一份全量草稿：多表改动先在草稿上算完，再一次性提交。 */
export function draftState(): Record<string, EntryRow[]> {
  return clone(allRows())
}

/**
 * 原子提交：整份状态一次写入。写不进去（如存储超限）就整体撤销，
 * 内存缓存回滚到提交前，不落下一半的脏数据。
 */
export function saveAll(next: Record<string, EntryRow[]>): void {
  const previous = cache
  cache = next
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    }
  } catch (error) {
    cache = previous
    throw error
  }
}

/**
 * 严格重读：绕开内存缓存，强制从 localStorage 重新解析。
 * 读不到或解析失败直接抛错，由调用方重试——不拿缓存里的老数据兜底。
 */
export function reloadFromStorage(): Record<string, EntryRow[]> {
  if (typeof window === 'undefined' || !window.localStorage) {
    throw new Error('当前环境没有本地存储，无法重新核对数据')
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    throw new Error('本地存储里还没有数据，无法重新核对')
  }
  const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
  cache = { ...clone(SEED_ROWS), ...parsed }
  return cache
}

export function storageKey(): string {
  return STORAGE_KEY
}
