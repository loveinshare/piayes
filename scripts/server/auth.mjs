// 密码哈希 + 会话令牌 + cookie 辅助
//
// 密码: scrypt (Node 内置 crypto), 16 字节随机盐, 64 字节输出.
//   存储格式: scrypt$N$r$p$<saltBase64>$<hashBase64>
//   永远不存明文, 也不把密码写进日志.
//   ★ 2026-11-01: 改成**异步** scrypt (走线程池, 不阻塞事件循环).
//     之前用的 scryptSync —— N=16384/r=8 要 16MB 内存 + 几十~上百毫秒纯 CPU,
//     期间整个 Node 事件循环停摆: 静态资源 / LED 代理 / 所有 API 全部排队.
//     这个后端同时扛着「静态站点 + 用户 API + WSS 反代(灯带控制)」,
//     一次登录就能把灯带控制和网页一起卡住.
//
// 会话: 32 字节随机 token (base64url) 发给浏览器 (HttpOnly cookie),
//   数据库只存 token 的 sha256 —— 拿到 DB 也无法直接冒充登录.
//   「记住我」= 1 年有效期的长期 token; 普通登录 = 30 天.
//   长期会话还带**滑动续期**: 剩余有效期不到一半时自动往后延 ——
//   天天用的人永远不会被踢下线 (见 sessionUser).

import crypto from 'node:crypto'
import { promisify } from 'node:util'

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LEN = 64
/** scrypt 需要的内存 = 128 * N * r ≈ 16MB, 给点余量. */
const SCRYPT_MAXMEM = 64 * 1024 * 1024

const scrypt = promisify(crypto.scrypt)

export const SESSION_COOKIE = 'pf_session'

/** 「记住我」= 1 年. */
export const REMEMBER_TTL_MS = 365 * 24 * 60 * 60 * 1000
/** 普通登录 = 30 天 (cookie 仍然是会话 cookie —— 关掉浏览器就没了). */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** 管理员账号 —— 启动时确保存在 (见 ensureAdminUser). */
export const ADMIN_USERNAME = 'loveinshare'

/**
 * 管理员密码 —— **绝不能有公开的默认值**.
 *
 * 原来这里是 DEFAULT_ADMIN_PASSWORD = <一个写死在源码里的口令>: 那是全网都看得见的
 * 口令 —— 谁都能登录别人机器上的管理员账号 (公网部署 = 公共乐库的写权限送人).
 * 现在: 没设 ADMIN_PASSWORD 环境变量就**随机生成**一个, 只在首次建号时打印一次.
 */
export function generateAdminPassword() {
  return crypto.randomBytes(12).toString('base64url')
}

/**
 * 「用户不存在」时也要跑一遍等价的 scrypt, 否则用响应时间就能区分
 * 「用户不存在」和「密码错了」. 见 api.mjs 的 login().
 */
export const DUMMY_HASH = `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${Buffer.alloc(
  16,
  0,
).toString('base64')}$${Buffer.alloc(KEY_LEN, 0).toString('base64')}`

/**
 * 并发上限 —— scrypt 走 Node 线程池 (默认 4 个), 不加限制的话
 * 一波并发登录会把线程池塞满, 反而拖慢所有请求. 超出的排队等.
 */
const MAX_CONCURRENT_HASH = 8
let hashing = 0
const hashQueue = []

async function withHashSlot(fn) {
  if (hashing >= MAX_CONCURRENT_HASH) {
    await new Promise((resolve) => hashQueue.push(resolve))
  }
  hashing++
  try {
    return await fn()
  } finally {
    hashing--
    const next = hashQueue.shift()
    if (next) next()
  }
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const hash = await withHashSlot(() =>
    scrypt(password, salt, KEY_LEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM,
    }),
  )
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, saltB64, hashB64] = parts

  // ★ 2026-11-01: 参数必须跟本服务写进去的**完全一致**.
  //   N/r/p 来自数据库里的哈希串 —— 正常流程下没问题, 但库被篡改
  //   (备份被改 / 误操作 / 将来的 SQL 注入) 时 N 就能被设成 2^30,
  //   scrypt 会去申请巨量内存把进程 OOM 掉. 不匹配直接拒.
  if (Number(n) !== SCRYPT_N || Number(r) !== SCRYPT_R || Number(p) !== SCRYPT_P) {
    return false
  }

  let expected
  let salt
  try {
    expected = Buffer.from(hashB64, 'base64')
    salt = Buffer.from(saltB64, 'base64')
  } catch {
    return false
  }
  // 长度也必须有界 —— keylen 直接喂给 scrypt
  if (expected.length < 16 || expected.length > 128) return false
  let actual
  try {
    actual = await withHashSlot(() =>
      scrypt(password, salt, expected.length, {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        maxmem: SCRYPT_MAXMEM,
      }),
    )
  } catch {
    return false
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

/**
 * 建会话, 返回要发给浏览器的 cookie 值.
 * @param {boolean} remember 勾了「记住我」→ 1 年
 */
export function createSession(db, userId, remember) {
  const token = crypto.randomBytes(32).toString('base64url')
  const now = Date.now()
  const ttl = remember ? REMEMBER_TTL_MS : SESSION_TTL_MS
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, remember, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  ).run(hashToken(token), userId, remember ? 1 : 0, now, now + ttl)
  return { token, maxAge: Math.floor(ttl / 1000) }
}

/**
 * token → 用户 (过期自动清理). 拿不到返回 null.
 *
 * 「记住我」的会话做**滑动续期**: 剩余有效期不到一半时自动往后延,
 * 天天在用的人永远不掉线. 续期了要告诉调用方 —— 光改数据库没用,
 * 浏览器那边的 cookie 还有自己的 Max-Age, 得重新下发一次 (见 api.mjs).
 */
export function sessionUser(db, token) {
  if (!token) return null
  const row = db
    .prepare(
      `SELECT s.user_id AS userId, s.expires_at AS expiresAt, s.remember AS remember,
              u.username AS username, u.is_admin AS isAdmin
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
    )
    .get(hashToken(token))
  if (!row) return null
  const now = Date.now()
  if (row.expiresAt <= now) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token))
    return null
  }
  const remember = Number(row.remember ?? 0) === 1
  let expiresAt = Number(row.expiresAt)
  let renewed = false
  if (remember && expiresAt - now < REMEMBER_TTL_MS / 2) {
    expiresAt = now + REMEMBER_TTL_MS
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(
      expiresAt,
      hashToken(token),
    )
    renewed = true
  }
  return {
    id: row.userId,
    username: row.username,
    isAdmin: Number(row.isAdmin ?? 0) === 1,
    remember,
    expiresAt,
    renewed,
    token,
  }
}

/**
 * 管理员账号 —— 启动时确保存在.
 *
 * 用户名默认 loveinshare; 密码**不给默认值** —— 传了就用传的, 没传就随机生成一个
 * (只有首次建号时才会用到, 见 generateAdminPassword).
 * 用户已存在但不是管理员 → 直接提权 (这个库本来只有服务器管理员能改).
 *
 * @returns {{created: boolean, promoted: boolean, username: string, generatedPassword?: string}}
 */
export async function ensureAdminUser(db, { username = ADMIN_USERNAME, password } = {}) {
  const row = db.prepare('SELECT id, is_admin FROM users WHERE username = ?').get(username)
  if (row) {
    if (Number(row.is_admin ?? 0) === 1) {
      return { created: false, promoted: false, username }
    }
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(row.id)
    return { created: false, promoted: true, username }
  }
  const usePassword = password ?? generateAdminPassword()
  const passwordHash = await hashPassword(usePassword)
  db.prepare(
    'INSERT INTO users (username, password_hash, created_at, is_admin) VALUES (?, ?, ?, 1)',
  ).run(username, passwordHash, Date.now())
  return {
    created: true,
    promoted: false,
    username,
    // 只有「这次随机生成」的才回传 —— 调用方要打印给运维看.
    generatedPassword: password ? undefined : usePassword,
  }
}

export function destroySession(db, token) {
  if (!token) return
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token))
}

export function parseCookies(header) {
  const out = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    if (!k) continue
    out[k] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

/**
 * @param {number|undefined} maxAge 秒. 不给 = session cookie (关浏览器即失效)
 * @param {boolean} secure 加 Secure 属性 (只走 https 时)
 */
export function serializeCookie(name, value, { maxAge, secure } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax']
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`)
  if (secure) parts.push('Secure')
  return parts.join('; ')
}
