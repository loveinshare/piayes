// PlayAlong 单元测试
//
// 验证 neothesia-style 跟弹状态机的核心约定:
//  - fileNoteOn 同 noteIndex 重复去重 (overlap)
//  - fileNoteOn 撞上 recent → early-matched (不进 required)
//  - fileNoteOff 在 required 中 → 记 miss
//  - fileNoteOff 不在 required (已 hit) → 不记
//  - userPress 没命中但 recent 内已有 midi → wrong
//  - userPress 没命中且 recent 内无 → 存 recent
//  - update() 过期 recent → wrong counter +1
//  - userPress 按 midi 查 required → 一次清空所有同 midi, playedDelta 加所有
//  - clear() 重置所有
//
// 新 API: userPress(midi, nowMs) — 内部按 midi 查 required (neothesia 同款)

import { describe, it, expect } from 'vitest'
import { PlayAlong } from '../src/engine/PlayAlong'
import { useStore } from '../src/store'

describe('PlayAlong', () => {
  it('fileNoteOn: 撞上 recent 内 midi → early-matched, 不入 required', () => {
    const pa = new PlayAlong()
    pa.userPress(60, 1000) // 用户 1000ms 按 C4 → recent[C4]={ts:1000}
    const r = pa.fileNoteOn(0, 60, 1050) // 文件 1050ms C4 NoteOn
    expect(r).toBe('early-matched')
    expect(pa.requiredSize()).toBe(0)
    expect(pa.stats.early).toBe(1)
  })

  it('fileNoteOn: 不撞 recent → required', () => {
    const pa = new PlayAlong()
    const r = pa.fileNoteOn(0, 60, 1000)
    expect(r).toBe('required')
    expect(pa.requiredSize()).toBe(1)
  })

  it('fileNoteOn: 同 noteIndex 重复 → duplicate (不去 required 再加)', () => {
    const pa = new PlayAlong()
    pa.fileNoteOn(0, 60, 1000)
    const r = pa.fileNoteOn(0, 60, 1100)
    expect(r).toBe('duplicate')
    expect(pa.requiredSize()).toBe(1) // 仍是 1, 不重复
  })

  it('fileNoteOff: idx 仍在 required → grace 后 miss +1', () => {
    const pa = new PlayAlong()
    useStore.setState({ toleranceMs: 500 })
    pa.fileNoteOn(0, 60, 1000)
    const r = pa.fileNoteOff(0, 1200)
    // 短音 grace 修复: fileNoteOff 只设 offTs, 不立即 miss
    expect(r.missed).toBe(false)
    expect(pa.stats.miss).toBe(0)
    expect(pa.requiredSize()).toBe(1) // 仍在 required 等 grace
    // update 推进到 grace 之外 → 升级为 miss
    pa.update(1800) // 1200 + 600 > 500 tolerance
    expect(pa.stats.miss).toBe(1)
    expect(pa.requiredSize()).toBe(0)
  })

  it('fileNoteOff: idx 不在 required (已被 userPress 命中) → 不算 miss', () => {
    const pa = new PlayAlong()
    pa.fileNoteOn(0, 60, 1000)
    // 用户先弹 → required 清空
    const pr = pa.userPress(60, 1050)
    expect(pr.kind).toBe('late')
    expect(pa.requiredSize()).toBe(0)
    // 文件随后 NoteOff
    const r = pa.fileNoteOff(0, 1100)
    expect(r.missed).toBe(false)
    expect(pa.stats.miss).toBe(0)
  })

  it('userPress: 没命中 + recent 内已有同 midi → wrong', () => {
    const pa = new PlayAlong()
    pa.userPress(60, 1000) // recent[C4]={ts:1000}
    const r = pa.userPress(60, 1050) // 50ms 内再按
    expect(r.kind).toBe('wrong')
    expect(pa.stats.wrong).toBe(1)
  })

  it('userPress: 没命中 + recent 内无 midi → recent-only', () => {
    const pa = new PlayAlong()
    const r = pa.userPress(60, 1000)
    expect(r.kind).toBe('recent-only')
  })

  it('userPress: 同 midi 多 noteIndex (chord) → 一次清空所有', () => {
    const pa = new PlayAlong()
    pa.fileNoteOn(0, 60, 1000)
    pa.fileNoteOn(1, 60, 1000) // 同 midi 不同 idx (Bach chord 同音多手)
    pa.fileNoteOn(2, 61, 1000)
    expect(pa.requiredSize()).toBe(3)
    // 用户按 60 → 内部按 midi 查 → 命中 idx 0 和 1
    const r = pa.userPress(60, 1100)
    expect(r.kind).toBe('late')
    if (r.kind === 'late') {
      expect(r.matched.sort()).toEqual([0, 1])
      expect(r.dtMs).toBe(100)
    }
    expect(pa.requiredSize()).toBe(1) // 61 仍 required
    expect(pa.stats.playedDelta.length).toBe(2)
  })

  it('update: recent 超过 tolerance → expire (不立即算 wrong, 等用户重复按才算)', () => {
    // 修 #10: 错按不应该立刻被记 wrong — recent 过期只是"不再是 early-hit 候选",
    // 真正的 wrong 来自 userPress 第二次按同 midi (recent 内重复).
    const pa = new PlayAlong()
    useStore.setState({ toleranceMs: 500 })
    pa.userPress(60, 1000) // recent[C4]={ts:1000}
    pa.update(1600)        // 600ms 后, 超出 tolerance
    expect(pa.stats.wrong).toBe(0)  // 不再自动 +1
    // 但再按一次同 midi → recent 已被清空, 走全新按键路径 (不入 wrong)
    pa.userPress(60, 1700)
    expect(pa.stats.wrong).toBe(0)  // 仍 0
  })

  it('areRequiredPressed: required 空 → true', () => {
    const pa = new PlayAlong()
    expect(pa.areRequiredPressed()).toBe(true)
    pa.fileNoteOn(0, 60, 1000)
    expect(pa.areRequiredPressed()).toBe(false)
  })

  it('clear: 所有状态归零', () => {
    const pa = new PlayAlong()
    pa.fileNoteOn(0, 60, 1000)
    pa.fileNoteOn(1, 62, 1000)
    pa.userPress(64, 1000)
    pa.fileNoteOff(0, 1100)
    pa.clear()
    expect(pa.requiredSize()).toBe(0)
    expect(pa.areRequiredPressed()).toBe(true)
    expect(pa.stats.miss).toBe(0)
    expect(pa.stats.wrong).toBe(0)
    expect(pa.stats.early).toBe(0)
  })
})

// =============================================================================
// 修 #10: toleranceMs 动态窗口
// =============================================================================
describe('修 #10: toleranceMs 窗口', () => {
  it('userPress 在 tolerance 内的 late rescue → 命中 (kind=late)', () => {
    const pa = new PlayAlong()
    useStore.setState({ toleranceMs: 500 })
    pa.setTempo(120)
    const w = pa.hitWindow() // 判定窗口按 tempo 缩放 (spec P1-5): 120bpm → 250ms
    pa.fileNoteOn(0, 60, 1000) // required[0]={ts:1000, midi:60}
    // 窗口内补弹
    const r = pa.userPress(60, 1000 + w - 10)
    expect(r.kind).toBe('late')
    expect(pa.areRequiredPressed()).toBe(true) // 已清空
  })

  it('userPress 超 tolerance 的 late rescue → 不命中 (走 recent-only)', () => {
    const pa = new PlayAlong()
    useStore.setState({ toleranceMs: 500 })
    pa.setTempo(120)
    const w = pa.hitWindow()
    pa.fileNoteOn(0, 60, 1000) // required[0]={ts:1000, midi:60}
    // 窗口外补弹
    const r = pa.userPress(60, 1000 + w + 100)
    expect(r.kind).toBe('recent-only') // 不算 hit
    expect(pa.areRequiredPressed()).toBe(false) // 仍 required
    // 让 fileNoteOff 走 miss 路径 (短音 grace 修复后: fileNoteOff 只设 offTs, 真正 miss
    // 要等 update() 把已 offTs 且过 grace 的 required 升级为 miss)
    const off = pa.fileNoteOff(0, 1000 + w + 200)
    expect(off.missed).toBe(false) // grace 内不立即 miss
    pa.update(1000 + w + 200 + w + 50) // 过了 grace → 升级为 miss
    expect(pa.stats.miss).toBe(1)
    expect(pa.areRequiredPressed()).toBe(true)
  })

  it('容差上限改小后立刻生效: 之前算 hit 的晚补, 改小后不算', () => {
    const pa = new PlayAlong()
    useStore.setState({ toleranceMs: 500 })
    pa.setTempo(120)
    pa.fileNoteOn(0, 60, 1000)
    // 窗口内补弹 → hit
    const w = pa.hitWindow()
    expect(pa.userPress(60, 1000 + w - 10).kind).toBe('late')
    // 用户把容差上限改到 100ms → 同样的晚补不再算 hit (上限立刻生效)
    const pa2 = new PlayAlong()
    useStore.setState({ toleranceMs: 100 })
    pa2.setTempo(120)
    pa2.fileNoteOn(0, 60, 1000)
    expect(pa2.hitWindow()).toBe(100)
    expect(pa2.userPress(60, 1000 + w - 10).kind).toBe('recent-only')
  })
})

// =============================================================================
// 容差口径 (2026-11-06): 用户填过的数 = 判定窗口本身
// =============================================================================
describe('容差: 填过 = 直接生效, 没填过 = 按曲速缩放', () => {
  it('没填过容差 → 仍按乐曲速度缩放 (120bpm → 250ms)', () => {
    const pa = new PlayAlong()
    useStore.setState({ toleranceMs: 300, toleranceCustom: false })
    pa.setTempo(120)
    expect(pa.hitWindow()).toBe(250)
  })

  it('用户填了 2000ms → 判定窗口就是 2000ms (上限 500 时这条是假的)', () => {
    const pa = new PlayAlong()
    useStore.getState().setToleranceMsPersistent(2000)
    pa.setTempo(120)
    expect(pa.hitWindow()).toBe(2000)
  })

  it('用户填了 100ms → 窗口 100ms (比曲速缩放更严)', () => {
    const pa = new PlayAlong()
    useStore.getState().setToleranceMsPersistent(100)
    pa.setTempo(120)
    expect(pa.hitWindow()).toBe(100)
  })

  it('填 2000ms → 晚 1 秒补弹也算命中', () => {
    const pa = new PlayAlong()
    useStore.getState().setToleranceMsPersistent(2000)
    pa.setTempo(120)
    pa.fileNoteOn(0, 60, 1000)
    expect(pa.userPress(60, 1000 + 1000).kind).toBe('late')
  })
})
