// 顶栏曲名 —— 点击复制 + 收藏 / 分享.
//
// 用户需求 (2026-11-02):
//   1. 顶栏最上面的曲名可以被复制: 悬浮变手型, 单击把**曲名**(不含作曲家) 写进剪贴板.
// 用户需求 (2026-11-13):
//   2. 曲名后面的 MIDI / MXL 徽章**去掉** (不重要信息), 换成「收藏 ☆」和「分享」两个图标.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { useStore } from '../src/store'
import { useAuth, setAuthModalOpener } from '../src/auth'
import { TopBar } from '../src/ui/TopBar'
import type { Song } from '../src/types'

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms))

function makeSong(over: Partial<Song> = {}): Song {
  return {
    notes: [],
    measures: [],
    bpms: [{ time: 0, bpm: 120 }],
    duration: 60,
    ppq: 480,
    hands: { left: 0, right: 1 },
    timeSignature: { numerator: 4, denominator: 4 },
    source: 'midi',
    title: 'Nocturne in E♭ Major',
    composer: 'Chopin',
    ...over,
  }
}

/** 顶栏里那个「可点的曲名」按钮. */
function titleButton(host: HTMLElement): HTMLButtonElement {
  const btn = [...host.querySelectorAll('button')].find(
    (b) => b.title === '点击复制曲名' || b.title === '已复制曲名',
  )
  expect(btn, '顶栏没有可点击的曲名').toBeTruthy()
  return btn as HTMLButtonElement
}

/** 按 title 找顶栏里的按钮. */
function buttonByTitle(host: HTMLElement, title: string): HTMLButtonElement {
  const btn = [...host.querySelectorAll('button')].find((b) => b.title === title)
  expect(btn, `顶栏没有「${title}」按钮`).toBeTruthy()
  return btn as HTMLButtonElement
}

describe('顶栏 · 曲名可复制', () => {
  let host: HTMLElement
  let root: ReturnType<typeof createRoot>
  let writeText: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    useStore.getState().setSong(makeSong())
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    root.render(
      React.createElement(TopBar, {
        onOpenSettings: () => {},
        onOpenStats: () => {},
        onOpenMidi: () => {},
        onOpenLibrary: () => {},
      }),
    )
    await wait()
  })

  afterEach(async () => {
    root.unmount()
    document.body.innerHTML = ''
    useStore.getState().setSong(null)
  })

  it('曲名是个按钮, 悬浮提示「点击复制曲名」', () => {
    const btn = titleButton(host)
    expect(btn.textContent).toBe('Nocturne in E♭ Major')
    expect(btn.className).toContain('cursor-pointer')
  })

  it('单击曲名 → 把曲名写进剪贴板 (只复制曲名, 不含作曲家)', async () => {
    titleButton(host).click()
    await wait()
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('Nocturne in E♭ Major')
  })

  it('复制成功后在顶栏显示「已复制」提示', async () => {
    expect(host.textContent ?? '').not.toContain('已复制')
    titleButton(host).click()
    await wait()
    expect(host.textContent ?? '').toContain('已复制')
  })

  it('换曲后提示复位, 曲名也跟着换', async () => {
    titleButton(host).click()
    await wait()
    useStore.getState().setSong(makeSong({ title: 'Gymnopédie No.1' }))
    await wait()
    expect(host.textContent ?? '').not.toContain('已复制曲名')
    expect(titleButton(host).textContent).toBe('Gymnopédie No.1')
  })

  it('曲名后面没有 MIDI / MXL 格式徽章了 (2026-11-13 用户要求去掉)', () => {
    const badge = [...host.querySelectorAll('span')].find((s) => {
      const t = (s.textContent ?? '').trim()
      return t === 'MIDI' || t === 'MXL'
    })
    expect(badge, '顶栏不该再有格式徽章').toBeFalsy()
  })
})

describe('顶栏 · 收藏 / 分享', () => {
  let host: HTMLElement
  let root: ReturnType<typeof createRoot>
  let writeText: ReturnType<typeof vi.fn>
  let authOpened: string | undefined

  beforeEach(async () => {
    writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    authOpened = undefined
    setAuthModalOpener((mode) => {
      authOpened = mode
    })
    useStore.getState().setSong(makeSong())
    useStore.getState().setLibrarySource({
      id: 'nocturne-eb-major-aigei',
      groupId: 'chopin',
      scope: 'public',
      file: 'chopin/nocturne-eb-major-aigei.mid',
      title: 'Nocturne in E♭ Major',
    })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    root.render(
      React.createElement(TopBar, {
        onOpenSettings: () => {},
        onOpenStats: () => {},
        onOpenMidi: () => {},
        onOpenLibrary: () => {},
      }),
    )
    await wait()
  })

  afterEach(async () => {
    root.unmount()
    document.body.innerHTML = ''
    setAuthModalOpener(null)
    useStore.getState().setSong(null)
    useStore.getState().setLibrarySource(null)
    useStore.setState({ favorites: [] })
    useAuth.setState({ user: null, checked: true })
  })

  it('分享按钮 → 把分享链接复制到剪贴板', async () => {
    buttonByTitle(host, '分享这首曲子 (复制链接)').click()
    await wait()
    expect(writeText).toHaveBeenCalledTimes(1)
    const url = writeText.mock.calls[0][0] as string
    expect(url).toContain('song=nocturne-eb-major-aigei')
    expect(url).toContain('scope=public')
    expect(host.textContent ?? '').toContain('链接已复制')
  })

  it('没登录时点收藏 → 弹登录框, 不收藏', async () => {
    buttonByTitle(host, '收藏这首曲子 (需要登录)').click()
    await wait()
    expect(authOpened).toBe('login')
    expect(useStore.getState().favorites).toHaveLength(0)
  })

  it('登录了点收藏 → 进收藏夹, 再点一次取消', async () => {
    useAuth.setState({ user: { id: 1, username: 'u', isAdmin: false }, checked: true })
    await wait()
    buttonByTitle(host, '收藏这首曲子').click()
    await wait()
    expect(useStore.getState().favorites).toHaveLength(1)
    expect(useStore.getState().favorites[0].id).toBe('nocturne-eb-major-aigei')
    // 收藏后按钮变成「取消收藏」, 而且标黄
    const btn = buttonByTitle(host, '取消收藏')
    expect(btn.className).toContain('text-yellow-400')
    btn.click()
    await wait()
    expect(useStore.getState().favorites).toHaveLength(0)
  })
})
