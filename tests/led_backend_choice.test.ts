// 灯带设备「自己选 + 记住」—— 用户需求 (2026-10-26):
//
//   「在灯带的菜单弄一个切换键 并且可以记住 我自己选」
//
// ★ 2026-11-10: 蓝牙那条路删了 (ESP32 现在跟树莓派一样跑 WebSocket 程序),
//   所以这个选择器从「WiFi / 蓝牙」改成「**树莓派 / ESP32**」.
//
// 这条测试钉住两件事:
//   1. 💡 浮窗里有「灯带设备」切换键 (只有树莓派 / ESP32 两个选项 —— 没有
//      「自动」, 「自动」正是「换回树莓派但没自动连接」的根因)
//   2. 选完**记住** —— 写进 localStorage, 刷新后还在
//
// 顺带钉住老 prefs 的迁移: 老版本存过 ledBackend ('ble' | 'ws' | 'auto')
//   → 迁到新的 ledDevice.
//
// ★ 2026-11-01 (二轮): 切换键又从「左右箭头切换」换成了**选项卡片**
//   (<OptionPicker>) —— 用户反馈左右切换「看不到另一个选项」.
//   现在所有选项**同时可见**, 点哪张卡就切到哪张.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { useStore } from '../src/store'
import { LedDock } from '../src/ui/LedDock'
import {
  clickOption,
  optionGroup,
  optionLabels,
  selectedLabel,
} from './helpers/optionPicker'

const LS_KEY = 'piayes.prefs.v1'
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms))

/** 打开浮窗 (默认只露一个 💡 按钮). */
async function openDock(host: HTMLElement) {
  const btn = host.querySelector('button[aria-label="LED 灯带设置"]')
  expect(btn).toBeTruthy()
  ;(btn as HTMLElement).click()
  await wait()
}

describe('灯带设备切换 (LedDock)', () => {
  let host: HTMLElement
  let root: ReturnType<typeof createRoot>

  beforeEach(async () => {
    localStorage.clear()
    useStore.getState().setLedDevice('pi')
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    root.render(React.createElement(LedDock))
    // React 18 的 render() 是异步的 (concurrent) —— 等它真的画出来
    await wait()
  })

  afterEach(async () => {
    root.unmount()
    document.body.innerHTML = ''
    localStorage.clear()
  })

  it('浮窗里有「灯带设备」切换键, 默认显示树莓派', async () => {
    await openDock(host)
    expect(host.textContent ?? '').toContain('灯带设备')
    expect(selectedLabel(optionGroup(host, '灯带设备'))).toContain('树莓派')
    // 只有树莓派 / ESP32 两个选项 —— 没有「自动」了, 用户自己选, 不猜.
    clickOption(optionGroup(host, '灯带设备'), 'ESP32')
    await wait()
    expect(selectedLabel(optionGroup(host, '灯带设备'))).toContain('ESP32')
    clickOption(optionGroup(host, '灯带设备'), '树莓派')
    await wait()
    expect(selectedLabel(optionGroup(host, '灯带设备'))).toContain('树莓派')
  })

  it('切到「ESP32」→ 设备变成 esp32 并被记住', async () => {
    await openDock(host)
    expect(useStore.getState().ledDevice).toBe('pi')

    clickOption(optionGroup(host, '灯带设备'), 'ESP32')
    await wait()

    expect(selectedLabel(optionGroup(host, '灯带设备'))).toContain('ESP32')
    expect(useStore.getState().ledDevice).toBe('esp32')
    const saved = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')
    expect(saved.ledDevice).toBe('esp32')
  })

  it('切回「树莓派」→ 设备变回 pi 并被记住', async () => {
    useStore.getState().setLedDevice('esp32')
    await openDock(host)
    expect(selectedLabel(optionGroup(host, '灯带设备'))).toContain('ESP32')

    clickOption(optionGroup(host, '灯带设备'), '树莓派')
    await wait()

    expect(selectedLabel(optionGroup(host, '灯带设备'))).toContain('树莓派')
    expect(useStore.getState().ledDevice).toBe('pi')
    const saved = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')
    expect(saved.ledDevice).toBe('pi')
  })

  it('两个选项**同时可见** (用户看不到另一个选项 → 已修)', async () => {
    await openDock(host)
    const group = optionGroup(host, '灯带设备')
    const labels = optionLabels(group)
    expect(labels).toHaveLength(2)
    expect(labels[0]).toContain('树莓派')
    expect(labels[1]).toContain('ESP32')
    // 两个都在屏幕上 —— 不是只有一个当前值
    expect(group.querySelectorAll('[role="radio"]')).toHaveLength(2)
    expect(group.querySelectorAll('[role="radio"][aria-checked="true"]')).toHaveLength(1)
  })

  it('切换设备时, 地址跟着换成那台的默认地址', async () => {
    await openDock(host)
    // 默认在树莓派 (地址 = 树莓派默认 IP)
    expect(useStore.getState().ledHost).toBe('192.168.1.113')

    clickOption(optionGroup(host, '灯带设备'), 'ESP32')
    await wait()
    expect(useStore.getState().ledHost).toBe('192.168.1.108')
  })
})

describe('老 prefs 的 ledBackend 迁移', () => {
  it("老版本存的 'auto' → 当成 'pi' (树莓派)", async () => {
    localStorage.clear()
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({ ledEnabled: true, ledBackend: 'auto', ledHost: '192.168.1.113' }),
    )
    // store 把 prefs 缓存在模块级变量里 —— resetModules 让它重新读 localStorage
    vi.resetModules()
    const { useStore: fresh } = await import('../src/store')
    expect(fresh.getState().ledDevice).toBe('pi')
  })

  it("老版本存的 'ble' → 'esp32' (当年选蓝牙就是想用 ESP32)", async () => {
    localStorage.clear()
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({ ledEnabled: true, ledBackend: 'ble', ledHost: '192.168.1.113' }),
    )
    vi.resetModules()
    const { useStore: fresh } = await import('../src/store')
    expect(fresh.getState().ledDevice).toBe('esp32')
  })

  it("老版本存的 'ws' + ESP32 的地址 (.108) → 'esp32'", async () => {
    localStorage.clear()
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({ ledEnabled: true, ledBackend: 'ws', ledHost: '192.168.1.108' }),
    )
    vi.resetModules()
    const { useStore: fresh } = await import('../src/store')
    expect(fresh.getState().ledDevice).toBe('esp32')
  })
})
