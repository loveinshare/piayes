// SQLite 数据层 —— 用户 / 会话 / 私有谱子
//
// 用 Node 22 内置的 node:sqlite (零外部依赖).
// 启动时 `node:sqlite` 会打印一条 ExperimentalWarning, 功能正常.
//
// 表:
//   users     —— 账号 (用户名大小写不敏感唯一, 密码存 scrypt 哈希)
//   sessions  —— 登录会话 (只存 token 的 sha256, 不存 token 本身)
//   scores    —— 用户私有谱子 (文件落盘, 这里只存元数据 + 相对路径)
//   user_prefs —— 用户的前端配置 (JSON 文本, localStorage 那份的账号副本)

import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

// node:sqlite 是实验特性, 而且不在 module.builtinModules 里 —— vite/vitest
// 看到静态 import 会想打包它 (报 "Failed to load url sqlite").
// 用 createRequire 走运行时 require, 绕开打包器的静态分析.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')

export const UPLOAD_DIR = 'uploads'

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(path.join(dataDir, UPLOAD_DIR), { recursive: true })

  const dbPath = path.join(dataDir, 'piano-follow.db')
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT    NOT NULL,
      created_at    INTEGER NOT NULL,
      is_admin      INTEGER NOT NULL DEFAULT 0
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT    PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      remember   INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS scores (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title      TEXT    NOT NULL,
      subtitle   TEXT    NOT NULL DEFAULT '',
      composer   TEXT    NOT NULL DEFAULT '',
      key_name   TEXT    NOT NULL DEFAULT '',
      duration   INTEGER,
      difficulty INTEGER NOT NULL DEFAULT 3,
      tracks     TEXT    NOT NULL DEFAULT '1',
      tags       TEXT    NOT NULL DEFAULT '',
      filename   TEXT    NOT NULL,
      ext        TEXT    NOT NULL,
      size       INTEGER NOT NULL,
      stored_path TEXT   NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_prefs (
      user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      prefs      TEXT    NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_scores_user ON scores(user_id, created_at DESC)')

  // 迁移: 老库没有 is_admin 列 (CREATE TABLE IF NOT EXISTS 不会补列).
  // 重复执行会报 "duplicate column name" —— 忽略即可.
  try {
    db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0')
  } catch {}

  // 数据库里有密码哈希 —— 只给本人读写 (POSIX). Windows 上 chmod 只能改只读位,
  // 失败了也不影响功能, 所以吞掉错误.
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.chmodSync(f, 0o600)
    } catch {}
  }

  // 启动自检: 把老库里用反斜杠写的 stored_path 统一成正斜杠.
  //   库要备份进 git —— 可能在 Windows 上生成、在 Linux 上还原,
  //   而 Linux 把 'uploads\2\x.mid' 当成一个文件名, 文件就找不到了.
  try {
    const info = db
      .prepare("UPDATE scores SET stored_path = REPLACE(stored_path, '\\', '/') WHERE stored_path LIKE '%\\%'")
      .run()
    if (Number(info.changes ?? 0) > 0) {
      console.log(`[db] 规整了 ${info.changes} 条 stored_path (反斜杠 → 正斜杠)`)
    }
  } catch {}

  // 启动自检: 清掉「文件没落盘」的坏行 (老版本的两步写入留下的).
  // 这类行一旦被访问, 下载接口会去读目录 → EISDIR → 进程崩 (见 api.mjs getScoreFile).
  try {
    const orphans = db
      .prepare("SELECT id, stored_path FROM scores WHERE stored_path IS NULL OR stored_path = ''")
      .all()
    for (const row of orphans) {
      db.prepare('DELETE FROM scores WHERE id = ?').run(row.id)
    }
    if (orphans.length > 0) {
      console.warn(`[db] 清掉 ${orphans.length} 条没有文件的谱子记录`)
    }
  } catch {}

  return db
}

/** 上传文件的绝对路径 (dataDir + stored_path). */
export function uploadPath(dataDir, storedPath) {
  // ★ 2026-11-01: 加护栏.
  //   以前是 path.join(dataDir, storedPath) —— stored_path 为空串时
  //   恰好等于 dataDir 本身 (目录!), 于是 createReadStream(目录) 抛 EISDIR,
  //   而 pipe() 不转发源流的 error → 未捕获异常 → 整个 Node 进程退出.
  //   现在空路径 / 越界路径一律返回 null, 由调用方转成 404.
  if (!storedPath) return null
  const root = path.resolve(dataDir)
  const abs = path.resolve(root, storedPath)
  if (abs !== root && !abs.startsWith(root + path.sep)) return null
  return abs
}

/** 清掉过期会话 —— 不然 sessions 表只增不减. */
export function cleanupExpiredSessions(db) {
  const info = db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now())
  return Number(info.changes ?? 0)
}
