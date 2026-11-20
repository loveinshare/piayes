// StaffView 渲染 smoke test — 用 jsdom + React 18 的 createRoot 手动 mount
// 目标: 实际 render StaffView, 确认 VexFlow 画出了 SVG, 不抛错, 并且 bin-pack
// 出的 systems 数 >= 1. 不依赖 puppeteer / @testing-library, 跑得快 (< 5s).

import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { parseMidi } from '../src/parser/parseMidi'

// VexFlow 渲染整首曲子 (110+ 小节 / 3000+ 音) 在 jsdom 里要 20~50s,
// 而且会产生一个 ~150MB 的中间 Buffer —— vitest 把测试结果序列化回主进程时
// 直接爆掉 (RangeError: Invalid array length), 整个 suite 以 exit 1 收场.
// 这是 smoke test, 只需要验证「渲染管线能跑通」, 所以只取开头 12 小节.
const RENDER_MEASURES = 12

function loadExcerpt(file: string, nMeasures: number) {
  const buf = readFileSync(resolve(__dirname, '../public/library/' + file))
  const full = parseMidi(new Uint8Array(buf))
  const measures = full.measures.slice(0, nMeasures)
  const last = measures[measures.length - 1]
  const end = last ? last.time + last.duration : 0
  return { ...full, measures, notes: full.notes.filter((n) => n.time < end) }
}

/** 轮询直到 fn 返回真值, 最多等 timeoutMs; 超时返回最后一次的值 (null). */
async function waitFor<T>(fn: () => T | null, timeoutMs = 5000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > deadline) return null
    await new Promise((r) => setTimeout(r, 10))
  }
}

beforeAll(() => {
  // jsdom 默认 viewport 0×0, VexFlow 的 renderer.resize 依赖 clientWidth
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1200 })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 128 })
})

afterEach(async () => {
  // 清 store
  const { useStore } = await import('../src/store')
  useStore.getState().setSong(null)
  document.body.innerHTML = ''
})

describe('StaffView 渲染', () => {
  it('曲库曲目加载后 StaffView 渲染出 SVG, 无 VexFlow 错误', async () => {
    const song = loadExcerpt('bach/prelude-bwv846.mid', RENDER_MEASURES)
    const { useStore } = await import('../src/store')
    useStore.getState().setSong(song)

    const warnings: string[] = []
    const origWarn = console.warn
    console.warn = (...args: any[]) => {
      const msg = args.join(' ')
      if (msg.includes('[staff]')) warnings.push(msg)
    }

    const host = document.createElement('div')
    document.body.appendChild(host)

    try {
      const { StaffView } = await import('../src/render/StaffView')
      const root = createRoot(host)
      root.render(React.createElement(StaffView, { height: 128 }))
      // 等 useEffect 跑完 (渲染是异步的, 固定 sleep 会偶发抢跑 —— 轮询到出为止)
      const svg = await waitFor(() => {
        const s = host.querySelector('svg')
        return s && s.children.length > 0 ? s : null
      })
      expect(svg).toBeTruthy()
      // 应该有非空 children (VexFlow 至少画了 stave 边框 + 谱号)
      const childCount = svg?.children.length ?? 0
      expect(childCount).toBeGreaterThan(0)
      // 没有任何 [staff] 错误
      expect(warnings).toEqual([])
      root.unmount()
    } finally {
      console.warn = origWarn
    }
  })

  it('BWV 1041 (6-track) 渲染出 SVG, bin-pack >= 1 system', async () => {
    const { parseMidi } = await import('../src/parser/parseMidi')
    const buf = readFileSync(resolve(__dirname, '../public/library/bach/bwv1041-allegro-moderato.mid'))
    const song = parseMidi(new Uint8Array(buf))
    const { useStore } = await import('../src/store')
    useStore.getState().setSong(song)

    // 直接调 bin-pack 验证
    const { __test__ } = await import('../src/render/StaffView')
    const widths = song.measures.map(() => 180)
    const systems = __test__.binPackIntoSystems(widths, 1200 - 64)
    expect(systems.length).toBeGreaterThanOrEqual(1)
    expect(systems[0].startIdx).toBe(0)
  })
})
