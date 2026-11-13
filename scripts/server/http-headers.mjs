// 公共 HTTP 响应头 —— 静态资源和 API 共用.
//
// ★ 2026-11-01 新增 (审核报告 §2.8 P1-6):
//   之前所有响应只有 Content-Type / Content-Length / Cache-Control,
//   缺这几个基础安全头.
//
// CSP 说明:
//   前端没有任何外部资源 (index.html + /assets/* 全是本站),
//   所以可以上比较严的 CSP. 'unsafe-inline' 只留给 style-src ——
//   VexFlow / 内联 style 属性需要它, 但 style 注入的破坏力远小于 script.
//   worker-src 加 blob: 是给可能用到的 Worker (如 fflate 的解压) 留门.

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
}