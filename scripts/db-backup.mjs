// 数据库备份 —— 把活库快照进 server-data/
//
// 为什么是「快照」而不是把活库放进仓库:
//   活库在 DATA_DIR (默认 ~/.config/piano-follow/data), 服务一直在写它.
//   如果活库文件在仓库目录里, `git pull` 会因为「本地有改动」直接失败,
//   强行还原又会丢掉服务器上新注册的用户. 所以:
//     活库   → DATA_DIR (仓库外, 部署/拉代码都不碰它)
//     快照   → server-data/ (**不入库** —— 里面有密码哈希, 只留在机器上)
//
// 快照怎么做的:
//   `VACUUM INTO 'xxx.db'` —— sqlite 在一个事务快照里写出一个完整、干净的库文件.
//   比「复制 .db 文件」可靠: 不受 WAL 影响, 也不会被并发写打断.
//
// 还原:
//   把 server-data/piano-follow.db 拷回 DATA_DIR/,
//   把 server-data/uploads/ 拷回 DATA_DIR/uploads/.
//
// 用法:
//   npm run db:backup
//   DATA_DIR=... BACKUP_DIR=... node scripts/db-backup.mjs

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')

const DATA_DIR = expandHome(process.env.DATA_DIR ?? '~/.config/piano-follow/data')
const BACKUP_DIR = path.resolve(REPO, process.env.BACKUP_DIR ?? 'server-data')
const DB_NAME = 'piano-follow.db'
const UPLOAD_DIR = 'uploads'

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p
}

const liveDbPath = path.join(DATA_DIR, DB_NAME)
if (!fs.existsSync(liveDbPath)) {
  console.error(`[db-backup] 找不到活库 ${liveDbPath} —— 服务还没起过?`)
  process.exit(1)
}

fs.mkdirSync(BACKUP_DIR, { recursive: true })
const backupDbPath = path.join(BACKUP_DIR, DB_NAME)

// VACUUM INTO 不接受已存在的目标 —— 先删旧的
for (const f of [backupDbPath, `${backupDbPath}-wal`, `${backupDbPath}-shm`]) {
  try {
    fs.unlinkSync(f)
  } catch {}
}

// SQL 字符串字面量里的单引号要双写
const sqlPath = backupDbPath.replace(/'/g, "''")
const db = new DatabaseSync(liveDbPath)
try {
  db.exec(`VACUUM INTO '${sqlPath}'`)
} finally {
  db.close()
}

const dbSize = fs.statSync(backupDbPath).size

// uploads 一起拷 —— 库里的记录指向这些文件, 只拷库等于半个备份
const liveUploads = path.join(DATA_DIR, UPLOAD_DIR)
const backupUploads = path.join(BACKUP_DIR, UPLOAD_DIR)
let fileCount = 0
let byteCount = 0
if (fs.existsSync(liveUploads)) {
  fs.rmSync(backupUploads, { recursive: true, force: true })
  fs.cpSync(liveUploads, backupUploads, { recursive: true })
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else {
        fileCount++
        byteCount += fs.statSync(p).size
      }
    }
  }
  walk(backupUploads)
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`
console.log(`[db-backup] 库快照   ${backupDbPath}  (${mb(dbSize)})`)
console.log(`[db-backup] 谱子文件 ${fileCount} 个 (${mb(byteCount)}) → ${backupUploads}`)
console.log(`[db-backup] 记得到 git 里: git add ${path.relative(REPO, BACKUP_DIR)}`)
