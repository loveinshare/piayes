// 开发用后端 —— 只起 HTTP 那条 (vite 把 /api 代理到这儿)
//
// 为什么要有这个:
//   `npm run dev` 只是 vite (纯前端). 登录 / 上传 / 私有谱子全在 /api 上 ——
//   后端不起的话, 前端一调 /api 就 404, 本地根本没法试账号功能.
//
// 和 serve-dist.mjs 的区别:
//   - 只监听 HTTP 127.0.0.1:8131 (vite.config.ts 的 proxy 指向这个口)
//   - 不监听 HTTPS (开发不需要 Web MIDI 的 secure context)
//   - 不做灯带 WSS 反代 (开发页面是 http://, 前端直连 ws://192.168.1.113:8080)
//   - 静态资源由 vite 提供, 这里只兜底 /api 和 /library
//
// 用法:
//   node scripts/dev-server.mjs
//   DATA_DIR=... PUBLIC_LIB_DIR=... node scripts/dev-server.mjs

import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { openDb, cleanupExpiredSessions } from './server/db.mjs'
import { createHandler } from './server/handler.mjs'
import { ensureAdminUser } from './server/auth.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')

const HTTP_HOST = process.env.HTTP_HOST ?? '127.0.0.1'
const HTTP_PORT = Number(process.env.HTTP_PORT ?? 8131)
const ROOT = path.resolve(REPO, 'dist')
const DATA_DIR = expandHome(process.env.DATA_DIR ?? '~/.config/piano-follow/data')
const PUBLIC_LIB_DIR = path.resolve(REPO, process.env.PUBLIC_LIB_DIR ?? 'public/library')

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p
}

const db = openDb(DATA_DIR)
try {
  const n = cleanupExpiredSessions(db)
  if (n > 0) console.log(`[dev-api] 清掉 ${n} 条过期会话`)
} catch (e) {
  console.warn('[dev-api] 清理过期会话失败:', e.message)
}

// 管理员账号 —— 跟生产一样, 启动时确保存在.
// 密码: ADMIN_PASSWORD 优先; 没设就随机生成 (第一次建号时打印出来).
const adminPassword = process.env.ADMIN_PASSWORD
try {
  const r = await ensureAdminUser(db, adminPassword ? { password: adminPassword } : {})
  if (r.created) {
    console.log(`[dev-api] 建了管理员账号 ${r.username}`)
    if (r.generatedPassword) {
      console.log(`[dev-api] 管理员密码 (随机生成, 只打印这一次): ${r.generatedPassword}`)
    }
  } else if (r.promoted) {
    console.log(`[dev-api] ${r.username} 提升为管理员`)
  }
} catch (e) {
  console.warn('[dev-api] 建管理员账号失败:', e.message)
}

const handler = createHandler({ db, dataDir: DATA_DIR, root: ROOT, publicLibDir: PUBLIC_LIB_DIR })

const server = http.createServer(handler)
// 端口被占是最常见的启动失败 —— 不给用户看一整段 Node 堆栈.
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[dev-api] ✗ 端口 ${HTTP_PORT} 已被占用 —— 是不是已经有一个 dev 在跑?`)
    console.error(`[dev-api]   查:  netstat -ano | findstr :${HTTP_PORT}`)
    console.error('[dev-api]   停:  taskkill /PID <pid> /T /F')
    console.error('[dev-api]   (如果只是想看看页面, 直接打开已经在跑的 http://127.0.0.1:5173)')
  } else {
    console.error(`[dev-api] ✗ HTTP 服务启动失败: ${e.code ?? ''} ${e.message}`)
  }
  process.exit(e.code === 'EADDRINUSE' ? 2 : 1)
})
server.listen(HTTP_PORT, HTTP_HOST, () => {
  console.log(`[dev-api] http://${HTTP_HOST}:${HTTP_PORT}   (vite 把 /api 代理到这儿)`)
  console.log(`[dev-api] 数据目录 ${DATA_DIR}`)
  console.log(`[dev-api] 公共乐库 ${PUBLIC_LIB_DIR}`)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[dev-api] ${sig} -> exit`)
    server.close(() => {})
    try {
      db.close()
    } catch {}
    setTimeout(() => process.exit(0), 3000).unref()
  })
}
