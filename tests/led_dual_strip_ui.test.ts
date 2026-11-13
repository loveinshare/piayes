// 双色带模式的 UI —— 💡 浮窗 (LedDock) + ⚙ 设置抽屉 (SettingsDrawer).
//
// 用户需求 (2026-10-29): 双色带模式要在**次级菜单 (设置抽屉)** 里能选,
// 上灯带亮度也要在那里能改. 所以这两处都得有:
//   1. 「灯带模式」切换键 (单灯带 / 双色带)
//   2. 「上灯带亮度」滑块 —— **只在双色带时出现** (默认 70%)
//   3. 选完要**记住** (写进 localStorage)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { useStore } from '../src/store'
import { LedDock } from '../src/ui/LedDock'
import { SettingsDrawer } from '../src/ui/SettingsDrawer'
import {
  clickOption,
  optionGroup,
  optionLabels,
  selectedLabel,
} from './helpers/optionPicker'

const LS_KEY = 'piayes.prefs.v1'

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms))

/** 打开 💡 浮窗. */
async function openDock(host: HTMLElement) {
  const btn = host.querySelector('button[aria-label="LED 灯带设置"]')
  expect(btn).toBeTruthy()
  ;(btn as HTMLElement).click()
  await wait()
}

/**
 * 「上灯带亮度」那个滑块.
 *
 * 两处 UI 结构不一样 (浮窗用 div 行, 抽屉用 label 行), 所以不按容器找,
 * 而是: 先找到写着「上灯带亮度」的那段文字, 再往上走到**只含一个滑块**
 * 的那一层 —— 那层就是这一行.
 */
function upperSlider(host: HTMLElement): HTMLInputElement | null {
  const leaf = [...host.querySelectorAll('*')].find((el) => {
    if (el.children.length > 0) return false
    const t = (el.textContent ?? '').trim()
    return t.startsWith('上灯带亮度') && t.length < 20
  })
  if (!leaf) return null
  let el: HTMLElement | null = leaf.parentElement
  while (el) {
    const ranges = el.querySelectorAll('input[type="range"]')
    if (ranges.length === 1) return ranges[0] as HTMLInputElement
    if (ranges.length > 1) break
    el = el.parentElement
  }
  return null
}

/**
 * 某个 Row 里的按钮 (按行标题找).
 *
 * 浮窗里现在有好几行 segmented 控件 (灯带后端 / 灯带模式), 所以「选中态有几个」
 * 必须**按行**统计, 不能扫整个浮窗.
 */
function rowButtons(host: HTMLElement, rowLabel: string): HTMLElement[] {
  const label = [...host.querySelectorAll('*')].find(
    (el) => el.children.length === 0 && (el.textContent ?? '').trim() === rowLabel,
  )
  expect(label, `没有「${rowLabel}」这一行`).toBeTruthy()
  let el: HTMLElement | null = label!.parentElement
  while (el) {
    const btns = [...el.querySelectorAll('button')]
    if (btns.length > 0) return btns
    el = el.parentElement
  }
  return []
}


describe('双色带 · 💡 浮窗 (LedDock)', () => {
  let host: HTMLElement
  let root: ReturnType<typeof createRoot>

  beforeEach(async () => {
    localStorage.clear()
    useStore.getState().setLedDualStrip(false)
    useStore.getState().setLedUpperBrightnessRatio(0.7)
    useStore.getState().setLedUpperNoteCount(3)
    useStore.getState().setLedDevice('pi')
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    root.render(React.createElement(LedDock))
    await wait()
  })

  afterEach(async () => {
    root.unmount()
    document.body.innerHTML = ''
    localStorage.clear()
  })

  it('浮窗里有「灯带模式」切换键, 默认显示 单灯带', async () => {
    await openDock(host)
    expect(host.textContent ?? '').toContain('灯带模式')
    expect(selectedLabel(optionGroup(host, '灯带模式'))).toContain('单灯带')
  })

  it('切到「双色带」→ ledDualStrip 变 true 并被记住', async () => {
    await openDock(host)
    clickOption(optionGroup(host, '灯带模式'), '双色带')
    await wait()

    expect(selectedLabel(optionGroup(host, '灯带模式'))).toContain('双色带')
    expect(useStore.getState().ledDualStrip).toBe(true)
    const saved = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')
    expect(saved.ledDualStrip).toBe(true)
  })

  it('从双色带切回「单灯带」→ 变回 false 并被记住', async () => {
    useStore.getState().setLedDualStrip(true)
    await openDock(host)
    clickOption(optionGroup(host, '灯带模式'), '单灯带')
    await wait()

    expect(selectedLabel(optionGroup(host, '灯带模式'))).toContain('单灯带')
    expect(useStore.getState().ledDualStrip).toBe(false)
    const saved = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')
    expect(saved.ledDualStrip).toBe(false)
  })

  it('单灯带模式下看不到「上灯带亮度」滑块, 切到双色带后出现', async () => {
    await openDock(host)
    expect(upperSlider(host)).toBeNull()

    clickOption(optionGroup(host, '灯带模式'), '双色带')
    await wait()
    expect(upperSlider(host)).not.toBeNull()
  })

  it('上灯带亮度默认 70%, 拖滑块会落库', async () => {
    expect(useStore.getState().ledUpperBrightnessRatio).toBe(0.7)
    await openDock(host)
    clickOption(optionGroup(host, '灯带模式'), '双色带')
    await wait()

    const slider = upperSlider(host)!
    expect(slider.value).toBe('0.7')

    // React 的 range onChange 认原生 'input' 事件 (jsdom 里直接派发);
    // 用原型上的 setter 改 value, 绕过 React 的 value tracker.
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!
    setter.call(slider, '0.3')
    slider.dispatchEvent(new Event('input', { bubbles: true }))
    await wait()

    expect(useStore.getState().ledUpperBrightnessRatio).toBe(0.3)
    const saved = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')
    expect(saved.ledUpperBrightnessRatio).toBe(0.3)
  })

  it('后端是 ESP32 时双色带**也可用** (固件的 count 白名单是 176/352)', async () => {
    useStore.getState().setLedDevice('esp32')
    await openDock(host)
    // 旧的限制提示没了 —— ESP32 固件现在也认 352 颗.
    expect(host.textContent ?? '').not.toContain('ESP32 固件固定 176 颗')
    clickOption(optionGroup(host, '灯带模式'), '双色带')
    await wait()
    expect(useStore.getState().ledDualStrip).toBe(true)
    // 措辞随 UI 改过 (「上面那条」→「上条」) —— 只断言**意思**在
    expect(host.textContent ?? '').toContain('显示左右手接下来要弹的音')
  })

  // ── 上灯带显示几个音 (每只手各 N 个) —— 用户 2026-10-31 要求放首页 ──

  it('浮窗里有「上灯带显示几个」这一行 (双色带时才出现)', async () => {
    await openDock(host)
    // 单灯带 → 没有这一行
    expect(host.textContent ?? '').not.toContain('上灯带显示几个')

    clickOption(optionGroup(host, '灯带模式'), '双色带')
    await wait()
    expect(host.textContent ?? '').toContain('上灯带显示几个')
    // 档位 1..6 (用户 2026-11-02 要求把「1」也加上)
    const btns = rowButtons(host, '上灯带显示几个').map((b) => (b.textContent ?? '').trim())
    expect(btns).toEqual(['1', '2', '3', '4', '5', '6'])
  })

  it('点档位 → ledUpperNoteCount 变 + 落库', async () => {
    await openDock(host)
    clickOption(optionGroup(host, '灯带模式'), '双色带')
    await wait()
    const btn = rowButtons(host, '上灯带显示几个').find(
      (b) => (b.textContent ?? '').trim() === '5',
    )
    expect(btn, '没有「5」这个档位').toBeTruthy()
    ;(btn as HTMLElement).click()
    await wait()

    expect(useStore.getState().ledUpperNoteCount).toBe(5)
    const saved = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')
    expect(saved.ledUpperNoteCount).toBe(5)
  })

  it('「灯带模式」那一行两个选项**同时可见**, 只有当前项高亮', async () => {
    await openDock(host)
    const group = optionGroup(host, '灯带模式')
    const labels = optionLabels(group)
    expect(labels).toHaveLength(2)
    expect(labels[0]).toContain('单灯带')
    expect(labels[1]).toContain('双色带')
    expect(group.querySelectorAll('[role="radio"][aria-checked="true"]')).toHaveLength(1)
    expect(selectedLabel(group)).toContain('单灯带')

    clickOption(optionGroup(host, '灯带模式'), '双色带')
    await wait()
    const group2 = optionGroup(host, '灯带模式')
    expect(group2.querySelectorAll('[role="radio"]')).toHaveLength(2)
    expect(selectedLabel(group2)).toContain('双色带')
  })
})

describe('双色带 · ⚙ 设置抽屉 (次级菜单)', () => {
  let host: HTMLElement
  let root: ReturnType<typeof createRoot>

  const drawerProps = {
    open: true,
    onClose: () => {},
  }

  beforeEach(async () => {
    localStorage.clear()
    useStore.getState().setLedDualStrip(false)
    useStore.getState().setLedUpperBrightnessRatio(0.7)
    useStore.getState().setLedUpperNoteCount(3)
    useStore.getState().setLedDevice('pi')
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    root.render(React.createElement(SettingsDrawer, drawerProps))
    await wait()
  })

  afterEach(async () => {
    root.unmount()
    document.body.innerHTML = ''
    localStorage.clear()
  })

  it('抽屉里有「灯带模式」切换键, 默认显示 单灯带', () => {
    expect(host.textContent ?? '').toContain('灯带模式')
    expect(selectedLabel(optionGroup(host, '灯带模式'))).toContain('单灯带')
  })

  it('切到「双色带」→ 状态 + 落库', async () => {
    clickOption(optionGroup(host, '灯带模式'), '双色带')
    await wait()
    expect(selectedLabel(optionGroup(host, '灯带模式'))).toContain('双色带')
    expect(useStore.getState().ledDualStrip).toBe(true)
    const saved = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')
    expect(saved.ledDualStrip).toBe(true)
  })

  it('单灯带 → 无「上灯带亮度」滑块; 双色带 → 有', async () => {
    expect(upperSlider(host)).toBeNull()
    clickOption(optionGroup(host, '灯带模式'), '双色带')
    await wait()
    const slider = upperSlider(host)
    expect(slider).not.toBeNull()
    expect(slider!.value).toBe('0.7')
  })

  it('抽屉里显示「上灯带 = 主灯带 × 比例」的实际值', async () => {
    clickOption(optionGroup(host, '灯带模式'), '双色带')
    await wait()
    const text = host.textContent ?? ''
    expect(text).toContain('上灯带亮度')
    // 说明行带的是**实际值**: 主灯带 50% × 70% → 上灯带 35%
    // (措辞随 UI 改过 —— 只断言这两个数在说明里, 不绑句式)
    const hint = text.split('上灯带 = ')[1] ?? ''
    expect(hint).toMatch(/50%/)
    expect(hint).toMatch(/35%/)
  })

  it('抽屉里也有「上灯带显示几个」这一行 (1..6 档)', async () => {
    clickOption(optionGroup(host, '灯带模式'), '双色带')
    await wait()
    expect(host.textContent ?? '').toContain('上灯带显示几个')
    const btns = rowButtons(host, '上灯带显示几个').map((b) => (b.textContent ?? '').trim())
    expect(btns).toEqual(['1', '2', '3', '4', '5', '6'])
  })

  it('抽屉里点档位 → 状态 + 落库', async () => {
    clickOption(optionGroup(host, '灯带模式'), '双色带')
    await wait()
    const btn = rowButtons(host, '上灯带显示几个').find(
      (b) => (b.textContent ?? '').trim() === '4',
    )
    expect(btn, '没有「4」这个档位').toBeTruthy()
    ;(btn as HTMLElement).click()
    await wait()
    expect(useStore.getState().ledUpperNoteCount).toBe(4)
    const saved = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')
    expect(saved.ledUpperNoteCount).toBe(4)
  })
})

describe('双色带 · prefs 读取', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('老 prefs 没这个字段 → 默认单灯带 + 70% + 3 个音', async () => {
    localStorage.clear()
    localStorage.setItem(LS_KEY, JSON.stringify({ ledEnabled: true, ledBackend: 'ws' }))
    vi.resetModules()
    const { useStore: fresh } = await import('../src/store')
    expect(fresh.getState().ledDualStrip).toBe(false)
    expect(fresh.getState().ledUpperBrightnessRatio).toBe(0.7)
    expect(fresh.getState().ledUpperNoteCount).toBe(3)
  })

  it('存的 prefs 里有 → 按存的来', async () => {
    localStorage.clear()
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({ ledDualStrip: true, ledUpperBrightnessRatio: 0.5 }),
    )
    vi.resetModules()
    const { useStore: fresh } = await import('../src/store')
    expect(fresh.getState().ledDualStrip).toBe(true)
    expect(fresh.getState().ledUpperBrightnessRatio).toBe(0.5)
  })

  it('存的 ledUpperNoteCount 越界 → 夹到 2..6', async () => {
    localStorage.clear()
    localStorage.setItem(LS_KEY, JSON.stringify({ ledUpperNoteCount: 99 }))
    vi.resetModules()
    const { useStore: fresh } = await import('../src/store')
    expect(fresh.getState().ledUpperNoteCount).toBe(6)
  })
})
