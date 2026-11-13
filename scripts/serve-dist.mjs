// piano-follow 伺服 (静态 + 用户 API + WSS 反代)
//
// 为什么要 HTTPS 而不是 HTTP:
//   Web MIDI (navigator.requestMIDIAccess) 只在 secure context 可用.
//   局域网用 http:// 访问 → 浏览器直接禁用 MIDI 输入/输出, 接不了电钢.
//
// 为什么要 /led-proxy:
//   LED 灯带桥在树莓派上跑 ws:// (明文). HTTPS 页面里连 ws:// 会被浏览器
//   当成 mixed content 拦掉. 所以这里开一个 WSS 端点, 透明转发到 Pi 的
//   ws://192.168.1.113:8080 —— 前端改连同源 wss, 混合内容问题消失.
//
// ★ 2026-11-10: 按设备分流 —— 前端现在有「树莓派 / ESP32」选择器, 两台设备
//   跑的是同一套 WS 协议 (端口都是 8080), 所以反代按路径段选上游:
//     /led-proxy/pi     -> LED_WS_TARGET_PI     (默认 ws://192.168.1.113:8080)
//     /led-proxy/esp32  -> LED_WS_TARGET_ESP32  (默认 ws://192.168.1.108:8080)
//     /led-proxy        -> 树莓派 (老路径, 兼容旧书签/文档)
//   ★ HTTPS 下前端填的设备地址**不生效** —— 生效的是服务器上配的目标.
//
// 为什么要两个监听:
//   - HTTPS (192.168.1.111:8130) —— 局域网直连, 自签证书, Web MIDI 可用
//   - HTTP  (127.0.0.1:8131)      —— 只绑本地, 给 FRP 隧道用.
//     公网侧是 ECS nginx (LE 证书) → frps vhost → frpc → 这里.
//     隧道那头是明文 HTTP, 所以 frpc 那侧不能连 HTTPS.
//
// 用法 (环境变量都有默认值):
//   HOST=192.168.1.111 PORT=8130 HTTP_PORT=8131 \
//   CERT=~/.config/piano-follow/cert.pem KEY=~/.config/piano-follow/key.pem \
//   DATA_DIR=~/.config/piano-follow/data \
//   PUBLIC_LIB_DIR=./public/library \
//   ADMIN_PASSWORD=... \
//   LED_WS_TARGET_PI=ws://192.168.1.113:8080 \
//   LED_WS_TARGET_ESP32=ws://192.168.1.108:8080 \
//   node scripts/serve-dist.mjs

import https from 'node:https'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import { openDb, cleanupExpiredSessions } from './server/db.mjs'
import { createHandler } from './server/handler.mjs'
import { ensureAdminUser, ADMIN_USERNAME } from './server/auth.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', 'dist')
const REPO = path.resolve(__dirname, '..')

const HOST = process.env.HOST ?? '192.168.1.111'
const PORT = Number(process.env.PORT ?? 8130)
const HTTP_HOST = process.env.HTTP_HOST ?? '127.0.0.1'
const HTTP_PORT = Number(process.env.HTTP_PORT ?? 8131)
const CERT = expandHome(process.env.CERT ?? '~/.config/piano-follow/cert.pem')
const KEY = expandHome(process.env.KEY ?? '~/.config/piano-follow/key.pem')
const DATA_DIR = expandHome(process.env.DATA_DIR ?? '~/.config/piano-follow/data')
// 公共乐库 —— 仓库里的源目录 (git 跟踪), 不是 dist/library (构建产物)
const PUBLIC_LIB_DIR = path.resolve(REPO, process.env.PUBLIC_LIB_DIR ?? 'public/library')
// 灯带反代的上游 —— 按设备一台一个.
// (老变量 LED_WS_TARGET 保留: 有人只配了它的话, 树莓派那条就用它)
const LED_TARGETS = {
  pi: process.env.LED_WS_TARGET_PI ?? process.env.LED_WS_TARGET ?? 'ws://192.168.1.113:8080',
  esp32: process.env.LED_WS_TARGET_ESP32 ?? 'ws://192.168.1.108:8080',
  // ★ 2026-11-11: 点阵屏 (HUB75 面板) —— 不是灯带, 是另一台服务 + 另一个端口.
  //   树莓派上跑 matrix_server.py (8081), 推的是整屏 RGB888 图像帧.
  screen: process.env.LED_WS_TARGET_SCREEN ?? 'ws://192.168.1.113:8081',
}
/** 反代路径前缀 —— 后面跟设备段 (/led-proxy/pi, /led-proxy/esp32, /led-proxy/screen). */
const LED_PROXY_PATH = '/led-proxy'

/**
 * 从请求路径解析出该转发到哪台设备.
 *
 * @returns 上游 URL; 路径不认识就 null (直接毁掉这个 socket).
 */
function ledTargetFor(pathname) {
  if (pathname === LED_PROXY_PATH) return LED_TARGETS.pi
  if (pathname === `${LED_PROXY_PATH}/pi`) return LED_TARGETS.pi
  if (pathname === `${LED_PROXY_PATH}/esp32`) return LED_TARGETS.esp32
  if (pathname === `${LED_PROXY_PATH}/screen`) return LED_TARGETS.screen
  return null
}

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p
}

// ---- 数据层 (用户 / 会话 / 私有谱子) ----
const db = openDb(DATA_DIR)
// 会话表只增不减 —— 启动时清一遍过期的
try {
  const n = cleanupExpiredSessions(db)
  if (n > 0) console.log(`[serve] 清掉 ${n} 条过期会话`)
} catch (e) {
  console.warn('[serve] 清理过期会话失败:', e.message)
}

// ---- 管理员账号 ----
// 启动时确保存在 (只建一次, 之后库里那条就是管理员).
// 密码: ADMIN_PASSWORD 环境变量优先; 没设就**随机生成**一个 (没有公开的默认口令),
// 只在首次建号时打印一次 —— 记不住就重置库里那条的 password_hash.
const adminPassword = process.env.ADMIN_PASSWORD
try {
  const r = await ensureAdminUser(db, adminPassword ? { password: adminPassword } : {})
  if (r.created) {
    console.log(`[serve] 建了管理员账号 ${r.username}`)
    if (r.generatedPassword) {
      console.log(
        `[serve] 管理员密码 (这次随机生成的, 只打印这一次): ${r.generatedPassword}`,
      )
      console.log('[serve] 想自己定密码 → 设 ADMIN_PASSWORD 环境变量后重建这个账号')
    }
  } else if (r.promoted) {
    console.log(`[serve] ${r.username} 提升为管理员`)
  } else {
    console.log(`[serve] 管理员账号 ${r.username} 已存在, 密码没动`)
  }
} catch (e) {
  console.warn('[serve] 建管理员账号失败:', e.message)
}

const handler = createHandler({ db, dataDir: DATA_DIR, root: ROOT, publicLibDir: PUBLIC_LIB_DIR })

// ---- WSS 反代: /led-proxy/<设备> -> 对应的 ws://...:8080 ----
// 透明转发 (只做字节管道), 鉴权令牌等逻辑仍由前端的 LedController 处理.
const wss = new WebSocketServer({ noServer: true })

wss.on('connection', (client, req) => {
  // 上游目标由**路径**决定 —— 连接时上游可能还没建好, 但目标必须先定下来.
  let target = LED_TARGETS.pi
  try {
    const { pathname } = new URL(req?.url ?? '/', 'https://placeholder')
    target = ledTargetFor(pathname) ?? LED_TARGETS.pi
  } catch {}

  let upstream
  try {
    upstream = new WebSocket(target)
  } catch (err) {
    console.error('[led-proxy] upstream connect failed:', err)
    client.close(1011, 'upstream unavailable')
    return
  }

  const teardown = () => {
    try { client.close() } catch {}
    try { upstream.close() } catch {}
  }

  // 客户端一连上就可能立刻发 auth (Pi 桥要求第一条消息是 auth, 迟了就断).
  // 上游握手还没完成时到达的消息必须缓存, 否则会被静默丢掉 -> 客户端永远等不到 auth 回包.
  const pending = []
  let upstreamReady = false

  client.on('message', (data, isBinary) => {
    if (upstreamReady && upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary })
    } else {
      pending.push([data, isBinary])
    }
  })

  upstream.on('open', () => {
    upstreamReady = true
    for (const [data, isBinary] of pending) upstream.send(data, { binary: isBinary })
    pending.length = 0
  })

  upstream.on('message', (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary })
  })

  upstream.on('close', teardown)
  upstream.on('error', (err) => {
    console.error(`[led-proxy] upstream error (${target}):`, err.message)
    teardown()
  })
  client.on('close', teardown)
  client.on('error', teardown)
})

function attachUpgrade(server) {
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'https://placeholder')
    if (!ledTargetFor(pathname)) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })
}

/** 所有监听的 server (退出时统一关) */
const servers = []

// 明文 HTTP 监听 (只绑 127.0.0.1) —— 给 FRP 隧道用
const httpServer = http.createServer(handler)
attachUpgrade(httpServer)
servers.push(httpServer)
httpServer.listen(HTTP_PORT, HTTP_HOST, () => {
  console.log(`[serve] http://${HTTP_HOST}:${HTTP_PORT}  (FRP 隧道入口)`)
})

// HTTPS 监听 (局域网直连, 自签证书) —— 证书不存在就跳过, 不影响 HTTP 那条
if (fs.existsSync(CERT) && fs.existsSync(KEY)) {
  const httpsServer = https.createServer(
    { cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) },
    handler,
  )
  attachUpgrade(httpsServer)
  servers.push(httpsServer)
  httpsServer.listen(PORT, HOST, () => {
    console.log(`[serve] https://${HOST}:${PORT}  (局域网直连)`)
  })
} else {
  console.warn(`[serve] 找不到证书 (${CERT} / ${KEY}), 跳过 HTTPS 监听`)
}

console.log(`[serve] 静态根目录 ${ROOT}`)
console.log(`[serve] 公共乐库 ${PUBLIC_LIB_DIR}`)
console.log(`[serve] 数据目录 ${DATA_DIR}`)
console.log(`[serve] wss://...${LED_PROXY_PATH}/pi -> ${LED_TARGETS.pi}`)
console.log(`[serve] wss://...${LED_PROXY_PATH}/esp32 -> ${LED_TARGETS.esp32}`)
console.log(`[serve] wss://...${LED_PROXY_PATH}/screen -> ${LED_TARGETS.screen}`)

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[serve] ${sig} -> exit`)
    for (const s of servers) s.close(() => {})
    // 关掉 db 连接 —— sqlite 会在最后一个连接关闭时把 WAL checkpoint 掉,
    // 这样 `npm run db:backup` 拿到的快照是完整的.
    try {
      db.close()
    } catch {}
    // 兜底: 5s 后强制退
    setTimeout(() => process.exit(0), 5000).unref()
  })
}
