/* 档案域端到端校验：直接跑真实的 store/service（localStorage 用内存替身）。
   运行：node scripts/verify-archive.mjs（由本脚本先用 esbuild 即时打包 TS）。 */
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))
const srcRoot = path.join(root, '..', 'src')

function memStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value))
    },
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
    _dump: () => Object.fromEntries(map),
  }
}

// 业务表（testing 等）与档案库的播种都在测试包内部完成，保证共享同一份模块与存储。
const storage = memStorage()
globalThis.window = { localStorage: storage }

const result = await build({
  entryPoints: [path.join(root, 'verify-archive-entry.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  alias: { '@': srcRoot },
})
const code = result.outputFiles[0].text
const tempFile = path.join(os.tmpdir(), `verify-archive-${Date.now()}.mjs`)
fs.writeFileSync(tempFile, code)
try {
  const mod = await import(pathToFileURL(tempFile).href)
  mod.run({ storage, assert: check, eq })
} finally {
  fs.rmSync(tempFile, { force: true })
}

function check(cond, label) {
  if (!cond) {
    throw new Error(`断言失败：${label}`)
  }
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    throw new Error(`断言失败：${label}\n  期望 ${e}\n  实际 ${a}`)
  }
}
