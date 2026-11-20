// 公共乐库 (public/library/) 的读写
//
// 公共乐库 = 仓库里的 public/library/ 目录 + 一份 manifest.json.
//   ★ 为什么写 public/library 而不是 dist/library:
//     dist/ 是 `npm run build` 的产物 —— 每次部署都会重新生成, 管理员存进去的
//     曲子会被覆盖掉. public/library/ 才是源目录 (git 跟踪), 改完立刻生效.
//
// manifest.json 长这样:
//   { version, groups: [ { id, name, items: [ { id, title, ..., file, tracks } ] } ] }
//
// 写操作用一把进程内的串行锁 —— 两个管理员同时保存不会互相覆盖 manifest.

import fs from 'node:fs'
import path from 'node:path'

/** manifest 在乐库目录里的文件名. */
export const MANIFEST_FILE = 'manifest.json'

/** 新建条目默认落在哪个分组. */
export const DEFAULT_GROUP_ID = 'admin'
export const DEFAULT_GROUP_NAME = '管理员上传'

/** 被删掉的曲子挪到这儿 (在 .gitignore 里, 不入仓). */
export const ARCHIVE_DIR = '_archive'

/** 进程内的写锁 —— 同一时刻只允许一个 manifest 写入. */
let lock = Promise.resolve()

/**
 * 排队执行一个会改 manifest 的操作.
 * @template T
 * @param {() => Promise<T>|T} fn
 * @returns {Promise<T>}
 */
export function withLibraryLock(fn) {
  const result = lock.then(() => fn())
  // 锁本身不能被上一个任务的失败打断
  lock = result.then(
    () => {},
    () => {},
  )
  return result
}

/** 读 manifest —— 文件不存在/坏了就当空乐库 (别把服务搞挂). */
export function readManifest(libDir) {
  const p = path.join(libDir, MANIFEST_FILE)
  let raw
  try {
    raw = fs.readFileSync(p, 'utf8')
  } catch {
    return { version: 1, groups: [] }
  }
  try {
    const m = JSON.parse(raw)
    if (!m || typeof m !== 'object') return { version: 1, groups: [] }
    if (!Array.isArray(m.groups)) m.groups = []
    for (const g of m.groups) {
      if (!Array.isArray(g.items)) g.items = []
    }
    return m
  } catch (e) {
    console.warn('[library] manifest 解析失败, 当空乐库处理:', e.message)
    return { version: 1, groups: [] }
  }
}

/**
 * 写 manifest —— 先写临时文件再改名, 避免写一半进程被杀导致 manifest 损坏.
 */
export function writeManifest(libDir, manifest) {
  fs.mkdirSync(libDir, { recursive: true })
  const p = path.join(libDir, MANIFEST_FILE)
  const tmp = `${p}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, p)
  return p
}

/** 按 id 找条目 → { group, item }. 找不到返回 null. */
export function findItem(manifest, itemId) {
  for (const g of manifest.groups) {
    for (const it of g.items) {
      if (it.id === itemId) return { group: g, item: it }
    }
  }
  return null
}

/** 找分组; 没有就建一个. */
export function ensureGroup(manifest, groupId, groupName) {
  let g = manifest.groups.find((x) => x.id === groupId)
  if (!g) {
    g = { id: groupId, name: groupName || groupId, items: [] }
    manifest.groups.push(g)
  }
  return g
}

/**
 * 把相对路径安全地拼到乐库目录下 —— 越界 (../) 一律返回 null.
 * 只允许 group/file 这种两段路径.
 */
export function safeLibraryPath(libDir, relPath) {
  if (typeof relPath !== 'string' || !relPath) return null
  const rel = relPath.replace(/\\/g, '/')
  if (rel.includes('..')) return null
  const root = path.resolve(libDir)
  const abs = path.resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + path.sep)) return null
  return abs
}

/**
 * 从 manifest 里删掉一条 —— 返回 { group, item }, 找不到返回 null.
 */
export function removeItem(manifest, itemId) {
  for (const g of manifest.groups) {
    const idx = g.items.findIndex((it) => it.id === itemId)
    if (idx >= 0) {
      const [item] = g.items.splice(idx, 1)
      return { group: g, item }
    }
  }
  return null
}

/**
 * 把乐库里的文件挪进 _archive/ —— 不真删, 误删了还能捞回来.
 *
 * 归档目录在 .gitignore 里 (不入仓), 原路径就空了 —— 曲库不再提供这个文件.
 * 文件不存在 / 路径越界 → 返回 null.
 */
export function archiveItemFile(libDir, relPath) {
  const abs = safeLibraryPath(libDir, relPath)
  if (!abs) return null
  if (!fs.existsSync(abs)) return null
  const dest = safeLibraryPath(libDir, `${ARCHIVE_DIR}/${relPath}`)
  if (!dest) return null
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  try {
    fs.renameSync(abs, dest)
  } catch {
    return null
  }
  return dest
}

/** 生成一个新条目的 id —— 短、唯一、不跟现有的撞. */
export function newItemId() {
  return `admin-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`
}

/**
 * 文件名用的 slug —— 只留 [a-z0-9-_], 中文等一律丢掉.
 * 全被丢掉时退回 'score'.
 */
export function slugify(text) {
  const s = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return s || 'score'
}
