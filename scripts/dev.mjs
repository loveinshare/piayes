// 本地开发 —— 一次起两个进程 (后端 API + vite 前端)
//
// 为什么不用 concurrently 之类的依赖:
//   就两个进程, 自己 spawn 一下更省事 (也少一个依赖).
//
// 行为:
//   - 两个子进程的输出都打到当前窗口, 加 [api] / [web] 前缀区分
//   - Ctrl+C (或关窗口) 时两个一起收掉
//
// 用法:
//   node scripts/dev.mjs        (或 npm run dev:all)

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')

/** 后端 API 端口 —— 跟 dev-server.mjs / vite.config.ts 的 proxy 保持一致. */
const API_PORT = Number(process.env.HTTP_PORT ?? 8131)
/** vite 前端端口 —— vite.config.ts 里写死 5173. */
const WEB_PORT = 5173

/** 端口上有没有人在听 (600ms 超时 —— 本机端口探测够快了). */
function portBusy(port, host = '127.0.0.1', timeoutMs = 600) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host })
    let settled = false
    const finish = (busy) => {
      if (settled) return
      settled = true
      sock.destroy()
      resolve(busy)
    }
    sock.once('connect', () => finish(true))
    sock.once('error', () => finish(false))
    sock.setTimeout(timeoutMs, () => finish(false))
  })
}

/** :8131/api/health 是不是我们自己的 dev API (而不是别的程序占着端口). */
async function apiLooksHealthy(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    })
    if (!res.ok) return false
    const body = await res.json()
    return body?.ok === true
  } catch {
    return false
  }
}

/** 给子进程的每行输出加个前缀 —— 两边混在一起才看得出谁在说话. */
function pipeWithPrefix(stream, prefix, target) {
  let buf = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    buf += chunk
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) target.write(`${prefix} ${line}\n`)
  })
  stream.on('end', () => {
    if (buf) target.write(`${prefix} ${buf}\n`)
  })
}

const children = []

function start(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    ...opts,
  })
  pipeWithPrefix(child.stdout, `[${name}]`, process.stdout)
  pipeWithPrefix(child.stderr, `[${name}]`, process.stderr)
  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      // 非 0 退出不一定等于"崩了": 130/143 = SIGINT/SIGTERM (被停掉).
      // 只有"自己挂的"才算错 —— 那种才值得指原因.
      const killed = signal !== null || code === 143 || code === 130
      if (code && !killed) {
        console.error(
          `[dev] ✗ ${name} 挂了 (code=${code} signal=${signal}) —— 原因见上面 [${name}] 的最后几行输出`,
        )
        if (name === 'api') {
          console.error('[dev]   常见原因: 8131 端口被别的进程占了 —— netstat -ano | findstr 8131')
        }
        if (name === 'web') {
          console.error('[dev]   常见原因: 5173 端口被别的进程占了 —— netstat -ano | findstr 5173')
        }
      } else {
        console.log(`[dev] ${name} 退出了 (code=${code} signal=${signal}) —— 一起收摊`)
      }
      shutdown(code ?? 0)
    }
  })
  children.push({ name, child })
  return child
}

let shuttingDown = false
function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const { child } of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    if (process.platform === 'win32') {
      // Windows 上 kill 父进程不会带走它的子进程 (npm → vite) —— 用 taskkill /T
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      } catch {}
    } else {
      try {
        child.kill('SIGTERM')
      } catch {}
    }
  }
  setTimeout(() => process.exit(code), 500).unref()
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

/**
 * 关键依赖 —— 少一个都起不来.
 *
 * 为什么要在起进程**之前**查:
 *   node_modules 装一半是这项目最常见的故障 (npm install 被 Ctrl+C / 断网掐断).
 *   症状是「vite 找不到」, 但真正缺的可能不止 vite —— 先全查一遍,
 *   一次性把缺的列出来, 省得跑一次 npm install 又撞下一个.
 */
const CRITICAL_DEPS = [
  'vite',
  'react',
  'react-dom',
  'zustand',
  'tone',
  '@tonejs/midi',
  'fflate',
  'ws',
]

function missingDeps() {
  return CRITICAL_DEPS.filter(
    (p) => !fs.existsSync(path.join(REPO, 'node_modules', p, 'package.json')),
  )
}

const missing = missingDeps()
if (missing.length > 0) {
  console.error(`[dev] ✗ 依赖不完整, 缺: ${missing.join(', ')}`)
  if (!fs.existsSync(path.join(REPO, 'node_modules'))) {
    console.error('[dev]   node_modules 目录都没有 —— 从没装过依赖')
  } else {
    console.error('[dev]   node_modules 在, 但内容是半截的 —— 上次 npm install 没跑完')
  }
  console.error('[dev]   修法: npm install   (装完再跑一次这个脚本)')
  process.exit(1)
}

/**
 * 端口预检 —— 最常见的一种「start-dev 报错」是**上次的 dev 还开着**.
 *
 * 以前这里不查: 8131 上的旧 API 先占住端口 → 新起的 dev-server.mjs 抛
 * `EADDRINUSE` 的**整段 Node 堆栈** → dev.mjs 再把刚起来的 vite 一起收掉.
 * 用户看到的就是一屏红字, 其实只要打开已经在跑的那个页面就行.
 *
 * 现在:
 *   - API + 前端都占着, 且 /api/health 正常 → 明确说「已经在跑了」+ 地址,
 *     退出码 3 (start-dev.bat 认这个码, 不当成失败).
 *   - 只占了一个 → 说清楚是哪个端口、怎么释放, 退出码 1.
 */
const apiBusy = await portBusy(API_PORT)
const webBusy = await portBusy(WEB_PORT)
if (apiBusy || webBusy) {
  if (apiBusy && webBusy) {
    const healthy = await apiLooksHealthy(API_PORT)
    console.log(`[dev] 已经有一个 dev 在跑了 —— 不用再起一个.`)
    console.log(`[dev]   前端: http://127.0.0.1:${WEB_PORT}`)
    console.log(`[dev]   后端: http://127.0.0.1:${API_PORT}  (${healthy ? '/api/health 正常' : '端口被占用, 健康检查没通过'})`)
    console.log('[dev]   直接用浏览器打开上面的地址即可.')
    console.log('[dev]   要重启 (比如改了后端代码): 关掉跑着它的那个窗口; 或:')
    console.error(`[dev]     netstat -ano | findstr :${API_PORT}`)
    console.error(`[dev]     taskkill /PID <pid> /T /F`)
    process.exit(3)
  }
  const which = apiBusy ? `后端 API 端口 :${API_PORT}` : `前端端口 :${WEB_PORT}`
  console.error(`[dev] ✗ ${which} 被占用了 (另一个没占) —— 没法只起一半.`)
  console.error(`[dev]   查是谁: netstat -ano | findstr :${apiBusy ? API_PORT : WEB_PORT}`)
  console.error('[dev]   如果是上次残留: taskkill /PID <pid> /T /F')
  console.error('[dev]   如果是有意只跑其中一个: dev-server.mjs / vite 各自单独起.')
  process.exit(1)
}

console.log(`[dev] 起后端 API (127.0.0.1:${API_PORT}) 和 vite 前端 (${WEB_PORT})…`)
// node 自己的路径可能有空格 (C:\Program Files\...) —— 不能走 shell
start('api', process.execPath, ['scripts/dev-server.mjs'], { shell: false })
// vite 直接起 (不过 npm): 少一层 shell, 也不会触发 Node 关于 shell:true 的告警
const viteBin = path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js')
if (!fs.existsSync(viteBin)) {
  console.error('[dev] ✗ node_modules/vite 装了一半 —— 找不到 bin/vite.js')
  console.error('[dev]   修法: npm install')
  shutdown(1)
} else {
  start('web', process.execPath, [viteBin], { shell: false })
}
