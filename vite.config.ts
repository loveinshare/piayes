import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // 修访问: 显式 host='127.0.0.1' 强制 IPv4. 默认 vite 听 'localhost' 时
  // Windows 上有时只解析到 IPv6 ([::1]), 部分浏览器/代理走 IPv4 拿到 timeout.
  server: {
    host: '127.0.0.1',
    port: 5173,
    open: true,
    // 开发时前端跑在 5173, 后端 API 在 8131 (scripts/serve-dist.mjs 的 HTTP 监听)
    proxy: { '/api': 'http://127.0.0.1:8131' },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.mjs'],
    exclude: ['node_modules', 'dist', 'refs/**'],
    // ★ 假定时器要连 performance 一起假 (2026-11-06).
    //
    // Player 的歌曲时钟在「没有音频时钟」时按**真实经过的时间**推进
    // (performance.now 差值) —— 否则浏览器把后台标签页的定时器压到 1s 一次时,
    // 整首曲子会慢几十倍. 测试里同理: performance.now 不跟着假时钟走的话,
    // 每帧的 dt 会变成真实墙钟 (几毫秒) 而不是 16ms → 曲子几乎不走.
    fakeTimers: {
      toFake: [
        'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
        'setImmediate', 'clearImmediate', 'Date', 'performance',
      ],
    },
  },
})
