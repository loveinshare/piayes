// HTTP 请求分发 —— 静态资源 + /api
//
// 抽成独立模块 (而不是塞在 serve-dist.mjs 里) 是为了能在 vitest 里
// 拿一个随机端口真跑一遍 API 回归测试.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { handleApi } from './api.mjs'
import { SECURITY_HEADERS } from './http-headers.mjs'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',
  '.mp3': 'audio/mpeg',
  '.mxl': 'application/vnd.recordare.musicxml+xml',
  '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
}

/**
 * @param {object} ctx
 * @param {import('node:sqlite').DatabaseSync} ctx.db
 * @param {string} ctx.dataDir  数据目录 (SQLite + uploads)
 * @param {string} ctx.root      静态资源根目录 (dist)
 * @param {string} [ctx.publicLibDir] 公共乐库目录 (public/library) ——
 *   给了的话, /library/* 从这儿提供, 而不是 dist/library (构建产物, 会被覆盖)
 */
export function createHandler({ db, dataDir, root, publicLibDir }) {
  const apiCtx = { db, dataDir, publicLibDir }

  /**
   * 把 URL path 映射到 base 内的真实文件.
   *   越界 → 'forbidden'
   *   非法百分号编码 (%ZZ) → 'bad-request'  ← 2026-11-01 修
   *     以前 decodeURIComponent('%ZZ') 抛 URIError, 被 catch 吞成 500,
   *     其实应该是 400 (客户端发错了, 不是服务器的问题).
   */
  function resolveSafe(base, urlPath) {
    let decoded
    try {
      decoded = decodeURIComponent(urlPath.split('?')[0])
    } catch {
      return 'bad-request'
    }
    const rel = decoded.replace(/^\/+/, '')
    const abs = path.resolve(base, rel)
    // 防目录穿越: 必须仍在 base 之内
    if (abs !== base && !abs.startsWith(base + path.sep)) return null
    return abs
  }

  /** 把一个文件发出去 (HEAD 只发头). */
  function sendFile(req, res, file, stat, cacheControl) {
    const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': cacheControl,
      ...SECURITY_HEADERS,
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    const stream = fs.createReadStream(file)
    // 源流出错时 (文件被删/权限变了) 不能让它变成未捕获异常 —— pipe() 不转发 error
    stream.on('error', (err) => {
      console.error('[serve] 静态文件读取失败:', err)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
    stream.pipe(res)
  }

  async function serveStatic(req, res) {
    let file = resolveSafe(root, req.url ?? '/')
    if (file === 'bad-request') {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS })
      res.end('Bad request')
      return
    }
    if (!file) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS })
      res.end('Forbidden')
      return
    }

    let stat = await fsp.stat(file).catch(() => null)
    if (stat?.isDirectory()) {
      file = path.join(file, 'index.html')
      stat = await fsp.stat(file).catch(() => null)
    }
    // SPA 回退: 未知路径一律给 index.html (本项目目前无前端路由, 但留个兜底)
    if (!stat?.isFile()) {
      file = path.join(root, 'index.html')
      stat = await fsp.stat(file).catch(() => null)
      if (!stat?.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS })
        res.end('Not found')
        return
      }
    }

    // 缓存策略 (2026-11-01 修, 审核报告 §2.7 P1-5):
    //   以前一刀切 'public, max-age=3600' —— 但 public/ 下的文件没有内容 hash,
    //   改完 manifest.json / 曲库文件要等 1 小时才生效 (前端 60s 的 TTL 被盖掉了).
    //   只有 vite 产物 (assets/, 带 hash) 才可以长缓存.
    const rel = path.relative(root, file).replace(/\\/g, '/')
    const cacheControl = rel.startsWith('assets/')
      ? 'public, max-age=31536000, immutable'
      : rel.startsWith('samples/')
        // 钢琴采样 —— 文件名不带 hash, 但内容基本不变, 给一周缓存
        // (no-cache 会让浏览器每次都重下 2MB)
        ? 'public, max-age=604800'
        : 'no-cache'
    sendFile(req, res, file, stat, cacheControl)
  }

  /**
   * 公共乐库 —— 从 publicLibDir 提供 (仓库里的源目录, git 跟踪).
   * 不走 SPA 回退: 曲库里没有的文件就是没有 (404).
   */
  async function serveLibrary(req, res, urlPath) {
    const base = path.resolve(publicLibDir)
    const rel = urlPath.slice('/library'.length)
    // 归档目录 (_archive/) 装着被管理员删掉的曲子 —— 只在服务器本地留着
    // (误删了能捞回来), **不对外提供**. 否则删了还能从 URL 直接下载.
    if (/(^|\/)_archive(\/|$)/.test(rel)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS })
      res.end('Not found')
      return
    }
    const file = resolveSafe(base, rel)
    if (file === 'bad-request') {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS })
      res.end('Bad request')
      return
    }
    if (!file) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS })
      res.end('Forbidden')
      return
    }
    const stat = await fsp.stat(file).catch(() => null)
    if (!stat?.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS })
      res.end('Not found')
      return
    }
    sendFile(req, res, file, stat, 'no-cache')
  }

  return async function handler(req, res) {
    const urlPath = (req.url ?? '/').split('?')[0]
    if (urlPath === '/api' || urlPath.startsWith('/api/')) {
      try {
        await handleApi(req, res, apiCtx)
      } catch (err) {
        console.error('[api] unhandled:', err)
        if (!res.headersSent) res.writeHead(500)
        res.end('Internal error')
      }
      return
    }
    // 公共乐库: 优先从 publicLibDir 提供 (管理员保存的改动即时可见,
    // 且不会被下一次 npm run build 覆盖掉)
    if (publicLibDir && (urlPath === '/library' || urlPath.startsWith('/library/'))) {
      try {
        await serveLibrary(req, res, urlPath)
      } catch (err) {
        console.error('[serve] library request failed:', err)
        if (!res.headersSent) res.writeHead(500)
        res.end('Internal error')
      }
      return
    }
    try {
      await serveStatic(req, res)
    } catch (err) {
      console.error('[serve] request failed:', err)
      if (!res.headersSent) res.writeHead(500)
      res.end('Internal error')
    }
  }
}
