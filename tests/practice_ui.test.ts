// 2026-11-06 用户提的 4 条 UI 改动 —— 各钉一条测试:
//
//   1. 容差上限最大能到 2000ms (原来 500)
//   2. 音量挪到右下角, 可收起, 点开是**竖向**滑块
//   3. 模式选择器: 去掉「手别」两个字, 「钢琴播放」→「播放」
//   4. 速度多一档 1.25×
//
// 第 2 条最难回归 (位置/朝向都不在 DOM 里能直接断言), 这里钉的是
// 「默认收起 / 点开才出现滑块 / 滑块能动」这三件用户真正感知到的事.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { useStore } from '../src/store'
import { VolumePanel } from '../src/ui/VolumePanel'
import { ToleranceInput } from '../src/ui/ToleranceInput'
import { SpeedControl } from '../src/ui/SpeedControl'
import { HandSelector } from '../src/ui/HandSelector'

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms))

/** 改 input 的值并触发 React 的 onChange (range/number 走 'input' 事件). */
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('练习条 UI (2026-11-06 四条改动)', () => {
  let host: HTMLElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    root.unmount()
    document.body.innerHTML = ''
  })

  it('1. 容差: 上限 2000ms, 填 2000 真的存得住', async () => {
    root.render(React.createElement(ToleranceInput))
    await wait()

    const input = host.querySelector('input[type="number"]') as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input.max).toBe('2000')

    setInputValue(input, '2000')
    await wait()
    expect(useStore.getState().toleranceMs).toBe(2000)
  })

  it('2. 音量: 默认收起 → 点开才出滑块 → 滑块能动', async () => {
    root.render(React.createElement(VolumePanel))
    await wait()

    // 默认收起: 只有个圆按钮, 没有滑块
    expect(host.querySelector('input[type="range"]')).toBeNull()
    const btn = host.querySelector('button[aria-label="展开音量"]') as HTMLElement
    expect(btn).toBeTruthy()

    btn.click()
    await wait()

    const slider = host.querySelector('input[type="range"]') as HTMLInputElement
    expect(slider).toBeTruthy()
    expect(slider.getAttribute('aria-label')).toBe('主音量')
    // 竖向: 靠 rotate(-90deg) 摆起来
    expect(slider.className).toContain('rotate-[-90deg]')
    expect(host.querySelector('button[aria-label="收起音量"]')).toBeTruthy()

    setInputValue(slider, '0.5')
    await wait()
    expect(useStore.getState().volume).toBeCloseTo(0.5, 5)
  })

  it('3. 模式选择器: 没有「手别」标签, 第一档叫「播放」', async () => {
    root.render(React.createElement(HandSelector))
    await wait()

    const text = host.textContent ?? ''
    expect(text).not.toContain('手别')
    expect(text).toContain('播放')
    expect(text).not.toContain('钢琴播放')
  })

  it('4. 速度: 有 1.25× 这一档, 选了就生效', async () => {
    root.render(React.createElement(SpeedControl))
    await wait()

    const select = host.querySelector('select') as HTMLSelectElement
    expect(select).toBeTruthy()
    const values = Array.from(select.options).map((o) => o.value)
    expect(values).toContain('1.25')
    expect(values).toContain('1')

    // select 走 'change' 事件 (React 对 select 用的是 change, 不是 input)
    select.value = '1.25'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await wait()
    expect(useStore.getState().speed).toBe(1.25)
  })
})
