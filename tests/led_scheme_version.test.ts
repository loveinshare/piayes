// 预设配色改版 → 老用户 localStorage 里的旧方案色自动升级.
//
// 背景: 方案 C 的配色改过一版 (浅粉 → 深红正蓝). 用户 localStorage 里存的还是
// 旧版方案色, 直接读会出现「代码改了但屏幕上没变」. 于是加了 SCHEME_COLOR_VERSION.
//
// 规则:
//   - 用预设方案 (c / d) → 版本对不上就自动换成新版预设色
//   - 手动调过色的 ('custom') → 一律不动

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { SCHEME_C, SCHEME_D, SCHEME_COLOR_VERSION, hexRgb } from '../src/led/schemes'

const LS_KEY = 'piayes.prefs.v1'

/** 旧版方案 C (浅粉) 的 8 个色 —— 用户 localStorage 里躺着的就是这组. */
const OLD_C = {
  leftWhite: [47, 107, 255],
  leftBlack: [127, 227, 255],
  rightWhite: [215, 38, 61],
  rightBlack: [255, 158, 207],
}

/** 灌一份 prefs 进 localStorage, 然后重新加载 store 模块 (它在 import 时读 prefs). */
async function loadStore(prefs: Record<string, unknown>) {
  localStorage.setItem(LS_KEY, JSON.stringify(prefs))
  vi.resetModules()
  const mod = await import('../src/store')
  return mod.useStore
}

describe('预设配色版本升级 (SCHEME_COLOR_VERSION)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('老用户存着旧版方案 C 的粉配色 → 启动后自动换成新版 (左手正蓝/品蓝, 右手深红)', async () => {
    const useStore = await loadStore({ ledScheme: 'c', ledColors: OLD_C })
    const s = useStore.getState()
    expect(s.ledScheme).toBe('c')
    expect(s.ledColors.leftWhite).toEqual(hexRgb('#1E1EFF'))
    expect(s.ledColors.leftBlack).toEqual(hexRgb('#4169E1'))
    expect(s.ledColors.rightWhite).toEqual(hexRgb('#FF0000'))
    expect(s.ledColors.rightBlack).toEqual(hexRgb('#C8102E'))
    expect(s.ledUpcomingColors.leftWhite).toEqual(hexRgb('#006AFF'))
    expect(s.ledUpcomingColors.leftBlack).toEqual(hexRgb('#11FF00'))
    expect(s.ledUpcomingColors.rightWhite).toEqual(hexRgb('#FF0000'))
    expect(s.ledUpcomingColors.rightBlack).toEqual(hexRgb('#FF0033'))
  })

  it('升级后把新颜色 + 新版本号写回 localStorage', async () => {
    await loadStore({ ledScheme: 'c', ledColors: OLD_C })
    const p = JSON.parse(localStorage.getItem(LS_KEY)!)
    expect(p.ledSchemeVersion).toBe(SCHEME_COLOR_VERSION)
    expect(p.ledColors.rightBlack).toEqual([...hexRgb('#C8102E')])
    expect(p.ledUpcomingColors.rightBlack).toEqual([...hexRgb('#FF0033')])
  })

  it('手动调过色的 (custom) → 一律不动', async () => {
    const useStore = await loadStore({ ledScheme: 'custom', ledColors: OLD_C })
    expect(useStore.getState().ledColors.rightBlack).toEqual(OLD_C.rightBlack)
    expect(useStore.getState().ledColors.leftBlack).toEqual(OLD_C.leftBlack)
  })

  it('版本号对得上 → 不动 (这组色就是这个版本的)', async () => {
    const useStore = await loadStore({
      ledScheme: 'c',
      ledColors: OLD_C,
      ledSchemeVersion: SCHEME_COLOR_VERSION,
    })
    expect(useStore.getState().ledColors.rightBlack).toEqual(OLD_C.rightBlack)
  })

  it('方案 D 同理 —— 升级成 D 的新版色', async () => {
    const useStore = await loadStore({
      ledScheme: 'd',
      ledColors: { leftWhite: [0, 0, 0], leftBlack: [0, 0, 0], rightWhite: [0, 0, 0], rightBlack: [0, 0, 0] },
    })
    const s = useStore.getState()
    expect(s.ledScheme).toBe('d')
    expect(s.ledColors.leftWhite).toEqual(SCHEME_D.current.leftWhite)
    expect(s.ledColors.rightWhite).toEqual(SCHEME_D.current.rightWhite)
  })

  it('auto 模式 → 存的色也刷成新版 (设置里的调色板不该显示旧配色)', async () => {
    const useStore = await loadStore({ ledScheme: 'auto', ledColors: OLD_C })
    expect(useStore.getState().ledScheme).toBe('auto')
    expect(useStore.getState().ledColors.rightBlack).toEqual(SCHEME_C.current.rightBlack)
  })

  it('新用户 (什么都没存) → 直接用方案 C 的默认色', async () => {
    const useStore = await loadStore({})
    const s = useStore.getState()
    expect(s.ledScheme).toBe('c')
    expect(s.ledColors.leftWhite).toEqual(SCHEME_C.current.leftWhite)
    expect(s.ledColors.rightBlack).toEqual(SCHEME_C.current.rightBlack)
  })
})
