// HTTP API —— 用户系统 + 私有谱子 + 公共乐库
//
// 路由:
//   POST   /api/auth/register        注册 (直接建会话)
//   POST   /api/auth/login           登录 (remember=true → 1 年)
//   POST   /api/auth/logout          登出
//   GET    /api/auth/me              当前用户 (没有就是 401)
//   GET    /api/prefs                账号那份前端配置 (需登录)
//   PUT    /api/prefs                存账号那份前端配置 (需登录)
//   GET    /api/scores               我的谱子列表 (需登录)
//   POST   /api/scores               上传谱子到「我的谱子」 (需登录)
//   POST   /api/scores/public        保存到**公共乐库** (仅管理员)
//   DELETE /api/scores/public/:itemId 删公共乐库里的曲子 (仅管理员)
//   GET    /api/scores/:id/file      取谱子文件 (需登录且是 owner)
//   DELETE /api/scores/:id           删谱子 (需登录且是 owner)
//
// 上传用 **raw body** (文件字节直接当 body), 元数据走 query string ——
// 省掉手写 multipart 解析器, 零额外依赖.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  hashPassword,
  verifyPassword,
  createSession,
  sessionUser,
  destroySession,
  parseCookies,
  serializeCookie,
  SESSION_COOKIE,
  DUMMY_HASH,
} from './auth.mjs'
import { uploadPath } from './db.mjs'
import {
  readManifest,
  writeManifest,
  findItem,
  ensureGroup,
  safeLibraryPath,
  newItemId,
  slugify,
  withLibraryLock,
  removeItem,
  archiveItemFile,
  DEFAULT_GROUP_ID,
  DEFAULT_GROUP_NAME,
} from './publicLibrary.mjs'
import { SECURITY_HEADERS } from './http-headers.mjs'

const MAX_JSON_BYTES = 64 * 1024
/** 单文件硬顶 (不是配额, 是防 OOM). 用户选了不限额上传. */
const MAX_FILE_BYTES = 50 * 1024 * 1024
/** 单用户谱子库上限 (1GB) —— 防"一个账号把磁盘写满". */
const MAX_USER_BYTES = 1024 * 1024 * 1024

/** 允许的扩展名 → 落盘用的规范扩展名 */
const EXT_CANON = { mid: 'mid', midi: 'mid', mxl: 'mxl', xml: 'xml', musicxml: 'xml' }
const MIME_BY_EXT = {
  mid: 'audio/midi',
  mxl: 'application/vnd.recordare.musicxml+xml',
  xml: 'application/xml; charset=utf-8',
}

// ---- IP 级限流 (防公网暴力注册/爆破) ----
const REGISTER_LIMIT = { n: 20, ms: 60 * 60 * 1000 }
const LOGIN_LIMIT = { n: 20, ms: 10 * 60 * 1000 }
const UPLOAD_LIMIT = { n: 60, ms: 60 * 60 * 1000 }
const buckets = new Map()

function allowAttempt(key, limit) {
  const now = Date.now()
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k)
  }
  const b = buckets.get(key)
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + limit.ms })
    return true
  }
  if (b.count >= limit.n) return false
  b.count++
  return true
}

// 客户端 IP —— 决定限流桶.
//
// ★ 2026-11-01 修 (审核报告 §2.3 P1-1):
//   之前直接取 X-Forwarded-For 的**第一段**. nginx 默认的
//   `$proxy_add_x_forwarded_for` 是**追加**语义 —— 客户端自己带的
//   `X-Forwarded-For: 10.0.0.1` 会被放在最前面, 真正的客户端 IP 排在后面.
//   于是攻击者每个请求换一个头就能让限流完全失效, 无限撞库 + 无限触发同步 scrypt.
//
//   现在: 从**右往左**跳过 TRUSTED_PROXY_HOPS 段 (每经过一跳反代就追加一段),
//   剩下的第一段才是客户端 IP.
//     TRUSTED_PROXY_HOPS=0 → 完全不信 XFF, 直接用 TCP 对端地址.
//     TRUSTED_PROXY_HOPS=1 → 只有一层反代 (nginx) —— 默认值.
//     TRUSTED_PROXY_HOPS=2 → nginx + frps 两层.
//   前提: 反代侧用**追加**语义 ($proxy_add_x_forwarded_for).
//   如果反代改成了覆盖语义 ($remote_addr), hop 数要相应调整.
const TRUSTED_PROXY_HOPS = Math.max(0, Number(process.env.TRUSTED_PROXY_HOPS ?? 1))

function clientIp(req) {
  if (TRUSTED_PROXY_HOPS === 0) return req.socket.remoteAddress ?? 'unknown'
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.length > 0) {
    const parts = xff
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (parts.length > 0) {
      const idx = parts.length - TRUSTED_PROXY_HOPS
      return idx >= 0 ? parts[idx] : parts[parts.length - 1]
    }
  }
  return req.socket.remoteAddress ?? 'unknown'
}

/** 请求是不是走 https (决定 cookie 加不加 Secure). */
function isSecure(req) {
  if (req.socket.encrypted) return true
  // x-forwarded-proto: 直连反代 (nginx) 时有效; 但 frps 转发时会把这一项
  // 覆写成它自己到 frpc 的协议 (http), 所以公网链路另看 x-original-proto.
  const proto = req.headers['x-forwarded-proto']
  if (typeof proto === 'string' && proto.split(',')[0].trim() === 'https') return true
  // nginx 用 proxy_set_header 覆写, 客户端伪造不了
  const orig = req.headers['x-original-proto']
  if (typeof orig === 'string' && orig.split(',')[0].trim() === 'https') return true
  return false
}

function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...headers,
  })
  res.end(body)
}

function fail(status, message) {
  const e = new Error(message)
  e.status = status
  return e
}

async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw fail(413, '文件太大 (上限 50MB)')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readJson(req) {
  const buf = await readBody(req, MAX_JSON_BYTES)
  if (buf.length === 0) return {}
  try {
    const parsed = JSON.parse(buf.toString('utf8'))
    if (parsed === null || typeof parsed !== 'object') throw new Error('not object')
    return parsed
  } catch {
    throw fail(400, '请求体不是合法 JSON')
  }
}

// ---- 流式落盘 ----

/** 边收边数字节, 超过上限就掐断 —— 内存占用恒定, 不会因为 50MB 上传爆内存. */
class ByteLimit extends Transform {
  constructor(limit) {
    super()
    this.limit = limit
    this.size = 0
  }
  _transform(chunk, _enc, cb) {
    this.size += chunk.length
    if (this.size > this.limit) {
      cb(Object.assign(new Error('文件太大'), { status: 413 }))
      return
    }
    cb(null, chunk)
  }
}

/**
 * 把请求体流式写进文件. 返回实际写入的字节数.
 * 之前是 readBody() 全量收进内存再 Buffer.concat —— 单次上传峰值 ≈ 2 倍文件大小.
 */
async function writeBodyToFile(req, absPath, limit) {
  const limiter = new ByteLimit(limit)
  await pipeline(req, limiter, fs.createWriteStream(absPath))
  return limiter.size
}

/**
 * 当前登录用户 (没登录就是 null).
 *
 * res 用来在会话**滑动续期**之后重新下发 cookie ——
 * 浏览器那边的 cookie 有自己的 Max-Age, 光把数据库里的过期时间往后延没用.
 */
function currentUser(req, res, ctx) {
  const cookies = parseCookies(req.headers.cookie)
  const user = sessionUser(ctx.db, cookies[SESSION_COOKIE])
  if (user?.renewed && res) {
    const maxAge = Math.max(0, Math.floor((user.expiresAt - Date.now()) / 1000))
    setSessionCookie(res, req, user.token, maxAge)
  }
  return user
}

function requireUser(req, res, ctx) {
  const user = currentUser(req, res, ctx)
  if (!user) throw fail(401, '请先登录')
  return user
}

/** 给前端看的用户信息 —— 不带 token / 过期时间那些内部字段. */
function publicUser(user) {
  return { id: user.id, username: user.username, isAdmin: Boolean(user.isAdmin) }
}

function validateUsername(raw) {
  if (typeof raw !== 'string') throw fail(400, '用户名格式不对')
  const name = raw.trim()
  if (name.length < 3 || name.length > 32) throw fail(400, '用户名长度要 3-32 个字符')
  if (/\s/.test(name)) throw fail(400, '用户名不能有空格')
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) throw fail(400, '用户名不能有控制字符')
  return name
}

function validatePassword(raw) {
  if (typeof raw !== 'string') throw fail(400, '密码格式不对')
  if (raw.length < 6) throw fail(400, '密码至少 6 位')
  if (raw.length > 200) throw fail(400, '密码太长了')
  return raw
}

/** 上传文件名的安全化: 只留 basename, 去掉路径分隔符和控制字符. */
function safeFilename(raw) {
  const base = String(raw ?? '').split(/[\\/]/).pop() ?? ''
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return cleaned.slice(0, 200) || 'score'
}

function extOf(filename) {
  const i = filename.lastIndexOf('.')
  if (i < 0) return ''
  return filename.slice(i + 1).toLowerCase()
}

function scoreRowToJson(row) {
  let tags = []
  try {
    const parsed = JSON.parse(row.tags)
    if (Array.isArray(parsed)) tags = parsed.filter((t) => typeof t === 'string')
  } catch {}
  return {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    composer: row.composer,
    key: row.key_name,
    duration: row.duration,
    difficulty: row.difficulty,
    tracks: row.tracks,
    tags,
    filename: row.filename,
    size: row.size,
    createdAt: row.created_at,
  }
}

function setSessionCookie(res, req, token, maxAge) {
  const header = serializeCookie(SESSION_COOKIE, token, { maxAge, secure: isSecure(req) })
  res.setHeader('Set-Cookie', header)
}

function clearSessionCookie(res, req) {
  res.setHeader(
    'Set-Cookie',
    serializeCookie(SESSION_COOKIE, '', { maxAge: 0, secure: isSecure(req) }),
  )
}

// ---- 各路由 ----

async function register(req, res, ctx) {
  if (!allowAttempt(`reg:${clientIp(req)}`, REGISTER_LIMIT)) {
    throw fail(429, '注册太频繁了, 过一会儿再试')
  }
  const body = await readJson(req)
  const username = validateUsername(body.username)
  const password = validatePassword(body.password)

  const exists = ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(username)
  if (exists) throw fail(409, '这个用户名已经被占了')

  const now = Date.now()
  let info
  try {
    const passwordHash = await hashPassword(password)
    info = ctx.db
      .prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
      .run(username, passwordHash, now)
  } catch (e) {
    // 并发注册同名 —— UNIQUE 兜底
    if (String(e.message).includes('UNIQUE')) throw fail(409, '这个用户名已经被占了')
    throw e
  }
  const userId = Number(info.lastInsertRowid)

  // 注册完直接登录, 并按「记住我」给长期会话
  const { token, maxAge } = createSession(ctx.db, userId, true)
  setSessionCookie(res, req, token, maxAge)
  sendJson(res, 201, { user: { id: userId, username, isAdmin: false } })
}

async function login(req, res, ctx) {
  const body = await readJson(req)
  const username = typeof body.username === 'string' ? body.username.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  const remember = body.remember === true

  if (!allowAttempt(`login:${clientIp(req)}`, LOGIN_LIMIT)) {
    throw fail(429, '尝试太多次了, 过一会儿再试')
  }

  const row = ctx.db
    .prepare('SELECT id, username, password_hash, is_admin FROM users WHERE username = ?')
    .get(username)
  // 用户不存在时也走一遍 verify (拿固定假哈希比), 免得用响应时间区分"用户不存在"
  const stored = row ? row.password_hash : DUMMY_HASH
  const ok = await verifyPassword(password, stored)
  if (!row || !ok) throw fail(401, '用户名或密码不对')

  const { token, maxAge } = createSession(ctx.db, row.id, remember)
  setSessionCookie(res, req, token, maxAge)
  sendJson(res, 200, { user: publicUser({ id: row.id, username: row.username, isAdmin: row.is_admin }) })
}

async function logout(req, res, ctx) {
  const cookies = parseCookies(req.headers.cookie)
  destroySession(ctx.db, cookies[SESSION_COOKIE])
  clearSessionCookie(res, req)
  res.writeHead(204).end()
}

function me(req, res, ctx) {
  const user = currentUser(req, res, ctx)
  if (!user) throw fail(401, '没登录')
  sendJson(res, 200, { user: publicUser(user) })
}

/**
 * 用户的前端配置 —— 服务器上那份 (localStorage 是本地那份).
 *
 * 整个 prefs 对象原样存成 JSON 文本: 前端加字段不用改后端.
 */
function getPrefs(req, res, ctx) {
  const user = requireUser(req, res, ctx)
  const row = ctx.db.prepare('SELECT prefs FROM user_prefs WHERE user_id = ?').get(user.id)
  let prefs = {}
  if (row) {
    try {
      prefs = JSON.parse(row.prefs)
    } catch {
      prefs = {}
    }
  }
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) prefs = {}
  sendJson(res, 200, { prefs })
}

async function putPrefs(req, res, ctx) {
  const user = requireUser(req, res, ctx)
  const body = await readJson(req)
  const prefs = body.prefs
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
    throw fail(400, 'prefs 得是一个对象')
  }
  const text = JSON.stringify(prefs)
  if (text.length > MAX_JSON_BYTES) throw fail(413, '配置太大了')
  ctx.db
    .prepare(
      `INSERT INTO user_prefs (user_id, prefs, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at`,
    )
    .run(user.id, text, Date.now())
  sendJson(res, 200, { ok: true })
}

function listScores(req, res, ctx) {
  const user = requireUser(req, res, ctx)
  const rows = ctx.db
    .prepare('SELECT * FROM scores WHERE user_id = ? ORDER BY created_at DESC')
    .all(user.id)
  sendJson(res, 200, { scores: rows.map(scoreRowToJson) })
}

/**
 * 谱子元数据 —— 从 query string 里抠出来.
 * 私有上传和公共乐库保存共用一套解析 (省得两边规则跑偏).
 */
function parseScoreMeta(q, filename) {
  const title = (q.get('title') ?? '').trim() || path.basename(filename, path.extname(filename))
  const composer = (q.get('composer') ?? '').trim()
  const keyName = (q.get('key') ?? '').trim()
  const subtitle = (q.get('subtitle') ?? '').trim()
  const durationRaw = Number(q.get('duration'))
  const duration = Number.isFinite(durationRaw) && durationRaw > 0 ? Math.round(durationRaw) : null
  const difficultyParam = q.get('difficulty')
  const difficultyRaw = difficultyParam === null || difficultyParam === '' ? NaN : Number(difficultyParam)
  const difficulty = Number.isFinite(difficultyRaw)
    ? Math.max(1, Math.min(5, Math.round(difficultyRaw)))
    : 3
  const tracks = ['1', '2', 'mxl'].includes(q.get('tracks')) ? q.get('tracks') : '1'
  const tags = (q.get('tags') ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 12)
  return { title, composer, keyName, subtitle, duration, difficulty, tracks, tags }
}

async function createScore(req, res, ctx) {
  const user = requireUser(req, res, ctx)
  const url = new URL(req.url ?? '/', 'http://localhost')
  const q = url.searchParams

  const filename = safeFilename(q.get('filename'))
  const ext = EXT_CANON[extOf(filename)]
  if (!ext) throw fail(400, '只支持 .mid / .midi / .mxl / .xml / .musicxml')

  const { title, composer, keyName, subtitle, duration, difficulty, tracks, tags } = parseScoreMeta(
    q,
    filename,
  )

  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > MAX_FILE_BYTES) {
    req.destroy()
    throw fail(413, '文件太大 (上限 50MB)')
  }
  if (!allowAttempt(`upload:${user.id}`, UPLOAD_LIMIT)) {
    throw fail(429, '上传太频繁了, 过一会儿再试')
  }

  // 用户配额 —— 防止一个账号把磁盘吃满
  const used = ctx.db
    .prepare('SELECT COALESCE(SUM(size), 0) AS total FROM scores WHERE user_id = ?')
    .get(user.id)
  if (Number(used?.total ?? 0) + Math.max(0, declared) > MAX_USER_BYTES) {
    throw fail(413, '你的谱子库满了 (上限 1GB), 先删几个再传')
  }

  // ★ 2026-11-01 修 (审核报告 §2.1 P0-1): 改成「先落盘, 再一次性入库」.
  //   旧流程是 INSERT(stored_path='') → 写文件 → UPDATE(stored_path).
  //   中间那个空 stored_path 一旦留下 (UPDATE 撞 SQLITE_BUSY / 进程被 kill),
  //   下载接口就会去 read 一个**目录** → EISDIR → 整个进程退出, 且重启后仍在.
  //   现在文件名不再依赖自增 id, 可以先把文件写到临时路径再改名, 最后一条 INSERT
  //   写全 stored_path —— 根本不存在中间态.
  //   stored_path 一律用**正斜杠** —— 库是要备份进 git 的, 可能在 Windows 上生成、
  //   在 Linux 上还原. 反斜杠在 Linux 上会被当成文件名的一部分, 文件就找不到了.
  const relDir = `uploads/${user.id}`
  const absDir = uploadPath(ctx.dataDir, relDir)
  fs.mkdirSync(absDir, { recursive: true })
  const relPath = `${relDir}/${crypto.randomBytes(8).toString('hex')}.${ext}`
  const absPath = uploadPath(ctx.dataDir, relPath)
  const tmpPath = `${absPath}.part`

  let size
  try {
    size = await writeBodyToFile(req, tmpPath, MAX_FILE_BYTES)
    if (size === 0) throw fail(400, '文件是空的')
    fs.renameSync(tmpPath, absPath)
  } catch (e) {
    try {
      fs.unlinkSync(tmpPath)
    } catch {}
    if (e?.status) throw e
    throw fail(500, `保存文件失败: ${e.message}`)
  }

  const now = Date.now()
  let info
  try {
    info = ctx.db
      .prepare(
        `INSERT INTO scores (user_id, title, subtitle, composer, key_name, duration, difficulty,
                             tracks, tags, filename, ext, size, stored_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        user.id,
        title,
        subtitle,
        composer,
        keyName,
        duration,
        difficulty,
        tracks,
        JSON.stringify(tags),
        filename,
        ext,
        size,
        relPath,
        now,
      )
  } catch (e) {
    // 入库失败就把文件清掉, 不留孤儿文件
    try {
      fs.unlinkSync(absPath)
    } catch {}
    throw e
  }
  const id = Number(info.lastInsertRowid)

  const row = ctx.db.prepare('SELECT * FROM scores WHERE id = ?').get(id)
  sendJson(res, 201, { score: scoreRowToJson(row) })
}

function getScoreFile(req, res, ctx) {
  const user = requireUser(req, res, ctx)
  const id = Number(req.url?.match(/\/api\/scores\/(\d+)\/file/)?.[1])
  if (!Number.isInteger(id)) throw fail(404, '找不到')
  const row = ctx.db.prepare('SELECT * FROM scores WHERE id = ? AND user_id = ?').get(id, user.id)
  if (!row) throw fail(404, '找不到这个谱子')

  // ★ 2026-11-01 护栏 (审核报告 §2.1 P0-1):
  //   stored_path 为空 → uploadPath 返回 null (以前 path.join(dataDir,'') === dataDir,
  //   于是 createReadStream(目录) 抛 EISDIR, pipe() 不转发 error → 进程退出).
  //   这里再挡一层「不是普通文件」的情况, 并且给流挂 error 监听 (500 而不是崩).
  const abs = uploadPath(ctx.dataDir, row.stored_path)
  if (!abs) throw fail(404, '文件还没落盘')
  let stat
  try {
    stat = fs.statSync(abs)
  } catch {
    throw fail(404, '文件丢了')
  }
  if (!stat.isFile()) throw fail(404, '文件丢了')

  res.writeHead(200, {
    'Content-Type': MIME_BY_EXT[row.ext] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'private, max-age=0',
    ...SECURITY_HEADERS,
  })
  const stream = fs.createReadStream(abs)
  stream.on('error', (e) => {
    console.error('[api] 谱子文件读取失败:', e)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
  stream.pipe(res)
}

function deleteScore(req, res, ctx) {
  const user = requireUser(req, res, ctx)
  const id = Number(req.url?.match(/\/api\/scores\/(\d+)/)?.[1])
  if (!Number.isInteger(id)) throw fail(404, '找不到')
  const row = ctx.db.prepare('SELECT * FROM scores WHERE id = ? AND user_id = ?').get(id, user.id)
  if (!row) throw fail(404, '找不到这个谱子')
  ctx.db.prepare('DELETE FROM scores WHERE id = ?').run(id)
  try {
    const abs = uploadPath(ctx.dataDir, row.stored_path)
    if (abs) fs.unlinkSync(abs)
  } catch {}
  res.writeHead(204).end()
}

/**
 * 保存到**公共乐库** (仅管理员).
 *
 * 两种用法:
 *   - 带 itemId → 覆盖那一条 (文件原地替换, manifest 元数据更新) ——
 *     管理员改一首公共曲子时走这条, 不会多出一份重复的.
 *   - 不带 itemId → 新建一条 (新文件 + manifest 加一条).
 *
 * 落盘位置 = public/library/ (仓库里的源目录, git 跟踪).
 * 不是 dist/library/ —— 那是构建产物, 每次部署都会被覆盖掉.
 */
async function createPublicScore(req, res, ctx) {
  const user = requireUser(req, res, ctx)
  if (!user.isAdmin) throw fail(403, '只有管理员能保存到公共乐库')
  const libDir = ctx.publicLibDir
  if (!libDir) throw fail(500, '服务器没配置公共乐库目录')

  const url = new URL(req.url ?? '/', 'http://localhost')
  const q = url.searchParams

  const filename = safeFilename(q.get('filename'))
  const ext = EXT_CANON[extOf(filename)]
  if (!ext) throw fail(400, '只支持 .mid / .midi / .mxl / .xml / .musicxml')

  const meta = parseScoreMeta(q, filename)
  const itemId = (q.get('itemId') ?? '').trim()
  const groupId = (q.get('groupId') ?? '').trim() || DEFAULT_GROUP_ID
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(groupId)) throw fail(400, '分组 id 不合法')

  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > MAX_FILE_BYTES) {
    req.destroy()
    throw fail(413, '文件太大 (上限 50MB)')
  }
  if (!allowAttempt(`pubupload:${user.id}`, UPLOAD_LIMIT)) {
    throw fail(429, '上传太频繁了, 过一会儿再试')
  }

  // 整个「读文件 + 改 manifest」的过程串行 —— 两个管理员同时存不会互相覆盖.
  const item = await withLibraryLock(async () => {
    const manifest = readManifest(libDir)
    const found = itemId ? findItem(manifest, itemId) : null

    // 目标路径: 覆盖已有条目时沿用原路径 (扩展名变了才换新文件名),
    // 新建条目时用 <分组>/<slug>-<随机>.<ext>.
    let relPath
    if (found && found.item.file) {
      const oldExt = EXT_CANON[extOf(found.item.file)]
      relPath = oldExt === ext ? found.item.file : `${found.item.file.replace(/\.[^.]+$/, '')}.${ext}`
    } else {
      relPath = `${groupId}/${slugify(meta.title)}-${crypto.randomBytes(4).toString('hex')}.${ext}`
    }
    const absPath = safeLibraryPath(libDir, relPath)
    if (!absPath) throw fail(400, '保存路径不合法')

    fs.mkdirSync(path.dirname(absPath), { recursive: true })
    const tmpPath = `${absPath}.part`
    let size
    try {
      size = await writeBodyToFile(req, tmpPath, MAX_FILE_BYTES)
      if (size === 0) throw fail(400, '文件是空的')
      fs.renameSync(tmpPath, absPath)
    } catch (e) {
      try {
        fs.unlinkSync(tmpPath)
      } catch {}
      if (e?.status) throw e
      throw fail(500, `保存文件失败: ${e.message}`)
    }

    // manifest 里加/改这一条
    const group = found ? found.group : ensureGroup(manifest, groupId, DEFAULT_GROUP_NAME)
    let entry = found?.item
    if (!entry) {
      entry = { id: newItemId(), title: meta.title, subtitle: '', composer: '', key: '', difficulty: 3, tags: [], file: relPath, tracks: 1 }
      group.items.push(entry)
    }
    entry.title = meta.title
    entry.subtitle = meta.subtitle
    entry.composer = meta.composer
    entry.key = meta.keyName
    entry.difficulty = meta.difficulty
    entry.tags = meta.tags
    entry.file = relPath
    entry.tracks = meta.tracks === 'mxl' ? 'mxl' : Number(meta.tracks)
    if (meta.duration) entry.duration = meta.duration
    else delete entry.duration

    writeManifest(libDir, manifest)
    return { entry, groupId: group.id }
  })

  // groupId 一起给回去 —— 前端要知道存到哪个分组了 (才能展开那个分组;
  // 下次再存也能带上 itemId 覆盖同一条, 而不是多存一份)
  sendJson(res, 201, { item: { ...item.entry, groupId: item.groupId } })
}

/**
 * 删除公共乐库里的曲子 (仅管理员).
 *
 * 删两样东西:
 *   - manifest 里那一条 (曲库列表里就不见了)
 *   - 曲库文件挪进 _archive/ —— 不真删, 误删了还能捞回来.
 *     _archive/ 在 .gitignore 里 (不入仓), 也不对外提供 (见 handler.mjs).
 *
 * 跟「存到公共乐库」一样是**运行时改动**: manifest.json 会被改脏,
 * 下次部署前把它提交进 git.
 */
async function deletePublicScore(req, res, ctx, itemId) {
  const user = requireUser(req, res, ctx)
  if (!user.isAdmin) throw fail(403, '只有管理员能删除公共乐谱')
  const libDir = ctx.publicLibDir
  if (!libDir) throw fail(500, '服务器没配置公共乐库目录')

  try {
    itemId = decodeURIComponent(itemId)
  } catch {
    throw fail(400, 'id 不合法')
  }

  const result = await withLibraryLock(() => {
    const manifest = readManifest(libDir)
    const removed = removeItem(manifest, itemId)
    if (!removed) throw fail(404, '乐库里没有这一条')
    writeManifest(libDir, manifest)
    // 文件挪进 _archive/ —— 挪不动 (文件已经不在了) 也不影响清单
    const archived = removed.item.file ? archiveItemFile(libDir, removed.item.file) : null
    return {
      id: removed.item.id,
      title: removed.item.title,
      file: removed.item.file,
      archived: Boolean(archived),
    }
  })

  sendJson(res, 200, { ok: true, item: result })
}

// ---- 入口 ----

export async function handleApi(req, res, ctx) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const p = url.pathname
  const method = req.method ?? 'GET'

  try {
    if (p === '/api/health' && method === 'GET') {
      sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()) })
      return
    }
    if (p === '/api/auth/register' && method === 'POST') return await register(req, res, ctx)
    if (p === '/api/auth/login' && method === 'POST') return await login(req, res, ctx)
    if (p === '/api/auth/logout' && method === 'POST') return await logout(req, res, ctx)
    if (p === '/api/auth/me' && method === 'GET') return me(req, res, ctx)
    if (p === '/api/prefs' && method === 'GET') return getPrefs(req, res, ctx)
    if (p === '/api/prefs' && method === 'PUT') return await putPrefs(req, res, ctx)
    if (p === '/api/scores' && method === 'GET') return listScores(req, res, ctx)
    if (p === '/api/scores' && method === 'POST') return await createScore(req, res, ctx)
    if (p === '/api/scores/public' && method === 'POST') return await createPublicScore(req, res, ctx)
    if (/^\/api\/scores\/public\/[^/]+$/.test(p) && method === 'DELETE') {
      const itemId = p.slice('/api/scores/public/'.length)
      return await deletePublicScore(req, res, ctx, itemId)
    }
    if (/^\/api\/scores\/\d+\/file$/.test(p) && method === 'GET') return getScoreFile(req, res, ctx)
    if (/^\/api\/scores\/\d+$/.test(p) && method === 'DELETE') return deleteScore(req, res, ctx)

    sendJson(res, 404, { error: '没有这个接口' })
  } catch (e) {
    const status = Number(e?.status) || 500
    if (status >= 500) console.error('[api]', e)
    if (res.headersSent) {
      res.end()
      return
    }
    sendJson(res, status, { error: e?.message ?? '服务器出错了' })
  }
}
