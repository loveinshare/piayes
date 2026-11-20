// 点阵屏「摆放方向」的一次性迁移 (2026-11-16).
//
// 现状（用户实测）：四块屏 1x4 从左往右串、进线在左边 ⇒ 左右**不翻**；
// 面板倒装（行 0 在物理下边）⇒ 画面**要上下翻**，否则琴键区跑到顶上。
//
// 老存档里 `ledScreenFlip` 默认 true（当年一块屏时它是 no-op），
// `ledScreenVFlip` 一律 false —— 在四块屏上都不对，所以用 `ledScreenOrientV3`
// 做一次性修正；用户自己切过之后（带 V3 标记）永久以存档为准。
//
// store 是模块级单例（import 时就初始化），所以每个用例都 `vi.resetModules()`
// 后重新 import，用不同的 localStorage 模拟各种用户。

import { describe, it, expect, beforeEach, vi } from 'vitest'

const LS_KEY = 'piayes.prefs.v1'

function writePrefs(patch: Record<string, unknown>) {
  localStorage.setItem(LS_KEY, JSON.stringify(patch))
}
function readPrefs(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')
}

async function loadStore() {
  vi.resetModules()
  // 配置同步会打 /api —— 测试里挡掉
  vi.stubGlobal('fetch', () =>
    Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })),
  )
  const mod = await import('../src/store')
  return mod.useStore
}

describe('点阵屏摆放方向的一次性迁移', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('老存档 (flip=true / vflip=false, 没有 V3 标记) -> 纠正成 左右不翻 + 上下翻, 并写回', async () => {
    writePrefs({ ledScreenFlip: true, ledScreenVFlip: false })
    const useStore = await loadStore()
    const st = useStore.getState()

    expect(st.ledScreenFlip).toBe(false)
    expect(st.ledScreenVFlip).toBe(true)
    expect(readPrefs().ledScreenFlip).toBe(false)
    expect(readPrefs().ledScreenVFlip).toBe(true)
    expect(readPrefs().ledScreenOrientV3).toBe(true)
  })

  it('迁过的存档 -> 完全以用户存的方向为准', async () => {
    writePrefs({ ledScreenFlip: true, ledScreenVFlip: false, ledScreenOrientV3: true })
    const useStore = await loadStore()
    expect(useStore.getState().ledScreenFlip).toBe(true)
    expect(useStore.getState().ledScreenVFlip).toBe(false)
  })

  it('用户切过之后, 再启动不会被迁移改回去', async () => {
    writePrefs({ ledScreenOrientV3: true })
    let useStore = await loadStore()
    useStore.getState().setLedScreenFlip(true)
    useStore.getState().setLedScreenVFlip(false)
    expect(readPrefs().ledScreenOrientV3).toBe(true)

    useStore = await loadStore() // 模拟刷新页面
    expect(useStore.getState().ledScreenFlip).toBe(true)
    expect(useStore.getState().ledScreenVFlip).toBe(false)
  })

  it('全新用户 -> 默认 左右不翻 / 上下翻', async () => {
    const useStore = await loadStore()
    expect(useStore.getState().ledScreenFlip).toBe(false)
    expect(useStore.getState().ledScreenVFlip).toBe(true)
  })
})
