// 修 #11: 最近弹过 (lastPlayedList) 行为
// - library kind 才入列表
// - 最多 5 个, 自动去重 (按 itemId+groupId), 移到头部
// - file kind 忽略
// - 老 lastPlayed 单字段迁移到 [0]

import { describe, it, expect, beforeEach } from 'vitest'
import { useStore, type LastPlayed } from '../src/store'

const libA = (overrides: Partial<{ itemId: string; groupId: string; title: string; composer: string; at: number }> = {}): LastPlayed => ({
  kind: 'library',
  itemId: 'a', groupId: 'g1', title: 'A', composer: 'X', at: 1000, ...overrides,
})

describe('修 #11: lastPlayedList', () => {
  beforeEach(() => {
    useStore.getState().clearLastPlayed()
  })

  it('addLastPlayed: library 加入列表', () => {
    useStore.getState().addLastPlayed(libA())
    const list = useStore.getState().lastPlayedList
    expect(list.length).toBe(1)
    expect((list[0] as Extract<LastPlayed, { kind: 'library' }>).itemId).toBe('a')
  })

  it('addLastPlayed: file kind 忽略', () => {
    const fileLp: LastPlayed = { kind: 'file', name: 'foo.mid', size: 1000, at: 1000 }
    useStore.getState().addLastPlayed(fileLp)
    expect(useStore.getState().lastPlayedList.length).toBe(0)
  })

  it('addLastPlayed: 同一 item 重复 → 去重 + 移到头部', () => {
    useStore.getState().addLastPlayed(libA({ itemId: 'a' }))
    useStore.getState().addLastPlayed(libA({ itemId: 'b' }))
    useStore.getState().addLastPlayed(libA({ itemId: 'a', at: 3000 }))
    const list = useStore.getState().lastPlayedList
    expect(list.length).toBe(2)
    expect((list[0] as any).itemId).toBe('a')
    expect((list[1] as any).itemId).toBe('b')
  })

  it('addLastPlayed: cap 5', () => {
    for (let i = 0; i < 8; i++) {
      useStore.getState().addLastPlayed(libA({ itemId: `i${i}`, at: 1000 + i }))
    }
    const list = useStore.getState().lastPlayedList
    expect(list.length).toBe(5)
    expect((list[0] as any).itemId).toBe('i7')
    expect(list.find((x) => (x as any).itemId === 'i0')).toBeUndefined()
  })

  it('clearLastPlayed: 清空', () => {
    useStore.getState().addLastPlayed(libA())
    useStore.getState().clearLastPlayed()
    expect(useStore.getState().lastPlayedList.length).toBe(0)
  })
})
