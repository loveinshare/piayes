// 谱子 vs 灯条 —— 对照测试 (2026-10-22 起, 2026-10-31 按新语义重订)
//
// 用户报: "现在有灯光残留, 右手很混乱". 用**同一时间轴**把谱子和灯对照起来:
//   真值 = 从谱子算出每个 note 的灯该亮的区间
//          (开灯 = note.time, 灭灯 = min(下一组开始, note.time + 音条寿命))
//   实际 = 把物理灯的 noteOn/noteOff 事件回放成每盏灯的亮灭区间
//   逐 note 对照 → 灯在 note 发声时亮没亮 / 这一组结束后灭没灭
//
// ★ 2026-10-31 用户要求 (「第一排只显示当前弹的…」):
//   灯不再提前亮 (提前量已跟灯带解耦), 第一排任何时刻最多只有**一组**音亮着.
//
// 两个根因 (都在 pre-scanner 路径):
//
//  B1 · 灯不能比声音早灭 —— 灭灯跟着「这一组结束」(下一组开始) 走.
//
//  B2 · 同一个 midi 的**多个 note** 共用一个像素 —— 旧 note 的灭灯事件
//      会把新 note 的灯误灭 (或推迟的补灭更晚才到 → 灭错灯).
//      BWV 846 右手 C5/E5/G5 反复出现, 必然踩中.
//
// B3/B4 (切歌清灯 / 重播游标) 见 tests/led_switch_clear.test.ts.
//
// 对照用的 harness 在 tests/helpers/ledHarness.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runLedHarness, hasBWV846 } from './helpers/ledHarness'

describe('谱 vs 灯: 第一排只亮当前这一组', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it.skipIf(!hasBWV846)('B1 · 灯不能比声音早灭 (灭灯跟着这一组结束)', () => {
    const r = runLedHarness({
      hand: 'both', wait: false, offsetUnits: 4, seconds: 4, press: 'none',
    })
    // 右手第一个音: note t=0.508, end=0.762.
    // 提前量已解耦 → 灯不再提前亮: 开灯 = 0.508 (音符落键那一刻).
    const events = r.events.filter((e) => e.midi === 67)
    const firstOn = events.find((e) => e.op === 'on')
    expect(firstOn).toBeDefined()
    expect(firstOn!.t).toBeGreaterThanOrEqual(0.508 - 0.02)
    expect(firstOn!.t).toBeLessThanOrEqual(0.508 + 0.02)

    // 下一个音在 0.762 落 → 这一组的灯到 0.762 就灭 (下一组开始就换灯).
    const firstOff = events.find((e) => e.op === 'off' && e.t >= firstOn!.t)
    expect(firstOff).toBeDefined()
    expect(firstOff!.t).toBeGreaterThanOrEqual(0.762 - 0.02)
  })

  it.skipIf(!hasBWV846)('B1 · 每个 note 发声时灯都亮着 (右手不能乱闪)', () => {
    const r = runLedHarness({
      hand: 'both', wait: false, offsetUnits: 4, seconds: 4, press: 'none',
    })
    // 右手 note 的发声时刻灯必须亮着 —— 这是"跟得上谱子"的判据
    const dark = r.noteChecks.filter((c) => !c.onDuring)
    expect(dark.map((c) => `midi=${c.midi}@${c.expectOn.toFixed(3)}`)).toEqual([])
  })

  it.skipIf(!hasBWV846)('B2 · 同一 midi 的旧 note 灭灯不能误灭新 note 的灯', () => {
    const r = runLedHarness({
      hand: 'both', wait: false, offsetUnits: 4, seconds: 4, press: 'none',
    })
    const ons = r.events.filter((e) => e.midi === 67 && e.op === 'on')
    expect(ons.length).toBeGreaterThan(1)
    // 不能出现"多灭了一次" —— 深度不能掉到负数
    let depth = 0
    let minDepth = 0
    for (const e of r.events) {
      if (e.midi !== 67) continue
      if (e.op === 'on') depth++
      else depth--
      if (depth < minDepth) minDepth = depth
    }
    expect(minDepth).toBeGreaterThanOrEqual(0)
  })

  it.skipIf(!hasBWV846)('整体: note 结束后灯必须灭掉 (无残留)', () => {
    const r = runLedHarness({
      hand: 'both', wait: false, offsetUnits: 4, seconds: 4, press: 'none',
    })
    const residue = r.noteChecks.filter((c) => c.residue)
    expect(residue.map((c) => `midi=${c.midi} idx=${c.idx} 实测灭=${c.actualOff}`)).toEqual([])
  })

  it.skipIf(!hasBWV846)('任何时刻最多只有一组音亮着 (用户: 不能同时亮好几个音)', () => {
    const r = runLedHarness({
      hand: 'both', wait: false, offsetUnits: 0, seconds: 4, press: 'none',
    })
    // 「组」= 同一时刻的所有 note
    const groupsOf = new Map<number, number[]>()
    for (const n of r.notes) {
      const arr = groupsOf.get(n.time) ?? []
      arr.push(n.midiNote)
      groupsOf.set(n.time, arr)
    }
    // 每个 midi 出现在哪些组里
    const timesOf = new Map<number, number[]>()
    for (const [time, midis] of groupsOf) {
      for (const m of midis) {
        const arr = timesOf.get(m) ?? []
        arr.push(time)
        timesOf.set(m, arr)
      }
    }
    for (const arr of timesOf.values()) arr.sort((a, b) => a - b)

    const on = new Map<number, number>()
    const off = new Map<number, number>()
    const bad: string[] = []
    let sawLit = false
    for (let f = 0; f < 80; f++) {
      const t = 0.2 + f * 0.05
      for (const e of r.events) {
        if (e.t > t) break
        if (e.midi === -1) continue
        if (e.op === 'on') on.set(e.midi, e.t)
        else off.set(e.midi, e.t)
      }
      const alive = [...on.keys()].filter((m) => (off.get(m) ?? Infinity) > t)
      if (alive.length === 0) continue
      sawLit = true
      // 活着的 midi 必须全都属于**同一组** (最近的那个 <= t 的组)
      const cur = new Set<number>()
      for (const m of alive) {
        let g = -Infinity
        for (const x of timesOf.get(m) ?? []) if (x <= t + 1e-6 && x > g) g = x
        cur.add(g)
      }
      if (cur.size > 1) {
        bad.push(
          `t=${t.toFixed(2)} 同时亮了 ${[...cur].map((x) => x.toFixed(3)).join(',')}`,
        )
      }
    }
    expect(sawLit).toBe(true)
    expect(bad).toEqual([])
  })

  it.skipIf(!hasBWV846)('对照基线: 灯跟谱子完全一致', () => {
    const r = runLedHarness({
      hand: 'both', wait: false, offsetUnits: 0, seconds: 4, press: 'all',
    })
    expect(r.noteChecks.filter((c) => !c.onDuring)).toEqual([])
    expect(r.noteChecks.filter((c) => c.residue)).toEqual([])
  })
})
