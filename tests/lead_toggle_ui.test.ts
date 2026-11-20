// 抢先模式的开关 (UI) —— 跟弹控制条上 Wait 后面那个复选框.
//
// 需求: 「把跟弹 wait 模式的后面加一个可选框」 —— 位置在 Wait 之后,
// 依赖 Wait (Wait 关掉 → 变灰失效, 但勾选状态保留).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { useStore } from '../src/store'
import { LeadToggle } from '../src/ui/LeadToggle'

const LS_KEY = 'piayes.prefs.v1'
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms))

function leadSwitch(host: HTMLElement): HTMLButtonElement {
  const btn = [...host.querySelectorAll('button[role="switch"]')].find((b) =>
    (b.textContent ?? '').includes('抢先'),
  )
  expect(btn, '没有「抢先」这个开关').toBeTruthy()
  return btn as HTMLButtonElement
}

describe('抢先开关 (LeadToggle)', () => {
  let host: HTMLElement
  let root: ReturnType<typeof createRoot>

  beforeEach(async () => {
    localStorage.clear()
    useStore.setState({ hand: 'right', wait: true, leadNext: false })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    root.render(React.createElement(LeadToggle))
    await wait()
  })

  afterEach(async () => {
    root.unmount()
    document.body.innerHTML = ''
    localStorage.clear()
  })

  it('渲染出「抢先」开关, 默认关', () => {
    const btn = leadSwitch(host)
    expect(btn.getAttribute('aria-checked')).toBe('false')
  })

  it('Wait 关掉 → 变灰 (disabled)', async () => {
    useStore.setState({ wait: false })
    await wait()
    expect(leadSwitch(host).disabled).toBe(true)
  })

  it('playback 模式 → 变灰 (disabled)', async () => {
    useStore.setState({ hand: 'playback' })
    await wait()
    expect(leadSwitch(host).disabled).toBe(true)
  })

  it('点一下 → 打开, 并落进 localStorage', async () => {
    leadSwitch(host).click()
    await wait()
    expect(useStore.getState().leadNext).toBe(true)
    expect(leadSwitch(host).getAttribute('aria-checked')).toBe('true')
    const saved = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')
    expect(saved.leadNext).toBe(true)
  })

  it('Wait 关掉时勾选状态**保留** (再打开 Wait 就自动恢复抢先)', async () => {
    leadSwitch(host).click()
    await wait()
    expect(useStore.getState().leadNext).toBe(true)

    useStore.setState({ wait: false })
    await wait()
    // 开关显示成「关」 (effectiveLead = false), 但记住的值没丢
    expect(leadSwitch(host).getAttribute('aria-checked')).toBe('false')
    expect(useStore.getState().leadNext).toBe(true)

    useStore.setState({ wait: true })
    await wait()
    expect(leadSwitch(host).getAttribute('aria-checked')).toBe('true')
  })
})
