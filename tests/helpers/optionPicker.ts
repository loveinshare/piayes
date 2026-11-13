// <OptionPicker> (选项卡片) 的测试助手.
//
// 2026-11-01 起「灯带后端 / 灯带模式」不再是左右箭头切换, 换成**所有选项同时可见**
// 的选项卡片: 每张卡是 role="radio", 整组是 role="radiogroup".
//
// 助手按**行标题**定位 (浮窗里同时有后端组和模式组, 扫整个浮窗会串).

import { expect } from 'vitest'

/** 找某一行的选项卡片组. */
export function optionGroup(host: HTMLElement, rowLabel: string): HTMLElement {
  const label = [...host.querySelectorAll('*')].find(
    (el) => el.children.length === 0 && (el.textContent ?? '').trim() === rowLabel,
  )
  expect(label, `没有「${rowLabel}」这一行`).toBeTruthy()
  let el: HTMLElement | null = label!.parentElement
  while (el) {
    const group = el.querySelector('[role="radiogroup"]')
    if (group) return group as HTMLElement
    el = el.parentElement
  }
  throw new Error(`「${rowLabel}」这一行里没有选项卡片组`)
}

/** 组里某个选项 (按可见文字, 如「树莓派」/「双色带」). */
export function optionButton(group: HTMLElement, label: string): HTMLElement {
  const btn = [...group.querySelectorAll('[role="radio"]')].find((el) =>
    (el.textContent ?? '').includes(label),
  )
  expect(btn, `选项组里没有「${label}」`).toBeTruthy()
  return btn as HTMLElement
}

/** 组里当前选中的那个选项的文字. */
export function selectedLabel(group: HTMLElement): string {
  const checked = group.querySelector('[role="radio"][aria-checked="true"]')
  expect(checked, '选项组里没有选中项').toBeTruthy()
  return (checked!.textContent ?? '').trim()
}

/** 点某个选项. */
export function clickOption(group: HTMLElement, label: string) {
  optionButton(group, label).click()
}

/** 组里所有选项的文字 (按顺序). */
export function optionLabels(group: HTMLElement): string[] {
  return [...group.querySelectorAll('[role="radio"]')].map((el) =>
    (el.textContent ?? '').trim(),
  )
}
