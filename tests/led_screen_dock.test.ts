// 点阵屏的入口 + 亮度设置 (2026-11-13)
//
// 用户要求:
//   1. 「加上 LED 亮度设置」—— 点阵屏单独一个亮度滑块 (0..100), 落 localStorage;
//   2. 「把 LED 屏幕从进阶设置里提出来, 放到首页右上角」——
//      顶栏图标排里多一个格子图标 (灯带那个 💡 旁边), 设置抽屉里不再有它.
//
// 这里钉住三件事:
//   - 顶栏 / 全屏浮窗都能打开它, 里面**有**亮度滑块;
//   - 拖滑块 -> store 变 + 写进 localStorage;
//   - 设置抽屉 (SettingsDrawer) 里**不再**渲染点阵屏设置.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { useStore } from '../src/store'
import { LedScreenDock } from '../src/ui/LedScreenDock'
import { SettingsDrawer } from '../src/ui/SettingsDrawer'

const LS_KEY = 'piayes.prefs.v1'
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms))

function prefs(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')
}

/** 打开点阵屏浮窗. */
async function openDock(host: HTMLElement) {
  const btn = host.querySelector('button[aria-label="LED 点阵屏设置"]')
  expect(btn, '顶栏里没有点阵屏入口').toBeTruthy()
  ;(btn as HTMLElement).click()
  await wait()
}

describe('点阵屏 · 右上角浮窗 + 亮度', () => {
  let host: HTMLElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    localStorage.clear()
    useStore.getState().setLedScreenEnabled(true)
    useStore.getState().setLedScreenBrightness(60)
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    root.unmount()
    host.remove()
    localStorage.clear()
  })

  it('浮窗里有亮度滑块, 默认 60%', async () => {
    root.render(React.createElement(LedScreenDock, { variant: 'inline' }))
    await wait()
    await openDock(host)

    const label = [...host.querySelectorAll('*')].find(
      (el) => el.children.length === 0 && (el.textContent ?? '').trim() === '亮度',
    )
    expect(label, '浮窗里没有「亮度」这一行').toBeTruthy()
    const range = host.querySelector('input[type="range"]') as HTMLInputElement
    expect(range).toBeTruthy()
    expect(range.value).toBe('60')
    // 滑块的 aria-label 要能定位到 (无障碍 + 测试都靠它)
    expect(range.getAttribute('aria-label')).toBe('点阵屏亮度')
  })

  it('拖亮度 -> store 跟着变 + 写进 localStorage', async () => {
    root.render(React.createElement(LedScreenDock, { variant: 'inline' }))
    await wait()
    await openDock(host)

    const range = host.querySelector('input[type="range"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set
    setter?.call(range, '35')
    range.dispatchEvent(new Event('input', { bubbles: true }))
    range.dispatchEvent(new Event('change', { bubbles: true }))
    await wait()

    expect(useStore.getState().ledScreenBrightness).toBe(35)
    expect(prefs().ledScreenBrightness).toBe(35)
  })

  it('亮度越界会被夹回来 (1..100), 不会把屏关成黑的', () => {
    const st = useStore.getState()
    st.setLedScreenBrightness(0)
    expect(useStore.getState().ledScreenBrightness).toBe(1)
    st.setLedScreenBrightness(999)
    expect(useStore.getState().ledScreenBrightness).toBe(100)
    st.setLedScreenBrightness(Number.NaN)
    expect(useStore.getState().ledScreenBrightness).toBe(60)
  })

  it('设置抽屉里不再有点阵屏设置 (已经挪到右上角)', async () => {
    root.render(
      React.createElement(SettingsDrawer, {
        open: true,
        onClose: () => {},
      } as never),
    )
    await wait(50)
    const text = host.textContent ?? ''
    expect(text).toContain('LED 灯带')
    expect(text).not.toContain('LED 点阵屏')
    expect(text).not.toContain('点阵屏亮度')
  })
})
