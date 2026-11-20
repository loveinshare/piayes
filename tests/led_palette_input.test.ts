// LED 调色板 —— 色号可以直接输入 (例: #4169e1).
//
// 用户需求 (2026-11-02): 「给自定义颜色色板改成色号可以输入 #4169e1 这种形式的」
//
// 行为:
//   - 输入框里敲 #rrggbb (或 rrggbb), 回车/失焦 → 生效
//   - 敲错了 → 静默还原成当前颜色
//   - Esc → 放弃编辑
//   - 旁边的复制按钮 → 把色号写进剪贴板

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { useStore } from '../src/store'
import { LedSettings } from '../src/ui/LedSettings'

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms))

/** 找某个颜色的色号输入框. */
function hexInput(host: HTMLElement, label: string): HTMLInputElement {
  const el = host.querySelector<HTMLInputElement>(`input[aria-label="${label} 色号"]`)
  expect(el, `没找到「${label} 色号」输入框`).toBeTruthy()
  return el!
}

/** React 受控输入: 用原生 setter 改 value, 再派发 input 事件. */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function blur(input: HTMLInputElement) {
  input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  input.blur()
}

describe('LED 调色板 · 色号可输入', () => {
  let host: HTMLElement
  let root: ReturnType<typeof createRoot>
  let writeText: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    useStore.getState().resetLedColors()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    root.render(React.createElement(LedSettings, {}))
    await wait()
  })

  afterEach(async () => {
    root.unmount()
    document.body.innerHTML = ''
  })

  it('8 个色各有一个色号输入框', () => {
    const inputs = host.querySelectorAll<HTMLInputElement>('input[aria-label$="色号"]')
    expect(inputs.length).toBe(8)
    expect(inputs[0].value).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('每一行都带着名字 (左白键/左黑键/右白键/右黑键) —— 不能被色号框挤没', () => {
    // 加了色号输入框之后, 名字曾经被挤成一个「左」字 (面板太窄) ——
    // 所以现在名字和输入框分两行排, 这里钉住「名字还在、且没被改名」.
    for (const label of ['左白键', '左黑键', '右白键', '右黑键']) {
      const input = hexInput(host, label)
      const row = input.parentElement!
      const name = row.querySelector('span')
      expect(name?.textContent, `「${label}」这行没有名字`).toBe(label)
    }
  })

  it('输入 #4169e1 → 回车生效, 颜色真的变了', async () => {
    const input = hexInput(host, '左黑键')
    input.focus()
    typeInto(input, '#4169e1')
    await wait()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await wait()
    expect(useStore.getState().ledColors.leftBlack).toEqual([65, 105, 225])
  })

  it('不带 # 也能输 (4169e1)', async () => {
    const input = hexInput(host, '左黑键')
    input.focus()
    typeInto(input, '4169e1')
    await wait()
    blur(input)
    await wait()
    expect(useStore.getState().ledColors.leftBlack).toEqual([65, 105, 225])
  })

  it('大写也认 (#4169E1)', async () => {
    const input = hexInput(host, '右黑键')
    input.focus()
    typeInto(input, '#4169E1')
    await wait()
    blur(input)
    await wait()
    expect(useStore.getState().ledColors.rightBlack).toEqual([65, 105, 225])
  })

  it('敲错了 → 静默还原, 不改颜色', async () => {
    const before = [...useStore.getState().ledColors.leftWhite]
    const input = hexInput(host, '左白键')
    input.focus()
    typeInto(input, '#zzz')
    await wait()
    blur(input)
    await wait()
    expect(useStore.getState().ledColors.leftWhite).toEqual(before)
    expect(input.value).toBe('#1e1eff')
  })

  it('改了色 → 方案自动切到「自定义」', async () => {
    const input = hexInput(host, '左白键')
    input.focus()
    typeInto(input, '#00ff00')
    await wait()
    blur(input)
    await wait()
    expect(useStore.getState().ledColors.leftWhite).toEqual([0, 255, 0])
    expect(useStore.getState().ledScheme).toBe('custom')
  })

  it('复制按钮把色号写进剪贴板', async () => {
    const btn = [...host.querySelectorAll('button')].find(
      (b) => (b.getAttribute('aria-label') ?? '').startsWith('复制色号'),
    )
    expect(btn, '没找到复制色号按钮').toBeTruthy()
    ;(btn as HTMLButtonElement).click()
    await wait()
    expect(writeText).toHaveBeenCalledWith('#1e1eff')
  })
})
