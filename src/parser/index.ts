// 解析统一入口: 根据文件后缀分发

import type { Song } from '../types'
import { parseMidi } from './parseMidi'
import { parseXml } from './parseXml'
import { parseMxl } from './parseMxl'

export async function parseFile(file: File): Promise<Song> {
  const name = file.name.toLowerCase()
  if (name.endsWith('.mid') || name.endsWith('.midi')) {
    const buf = await file.arrayBuffer()
    return parseMidi(new Uint8Array(buf))
  }
  if (name.endsWith('.mxl')) {
    const buf = await file.arrayBuffer()
    return parseMxl(new Uint8Array(buf))
  }
  if (name.endsWith('.xml') || name.endsWith('.musicxml')) {
    return parseXml(await file.text())
  }
  throw new Error(
    `Unsupported file: ${file.name}（仅支持 .mid / .midi / .mxl / .xml / .musicxml）`,
  )
}

// URL 版 (用于自动加载 public/library/*.*)
export async function parseUrl(url: string): Promise<Song> {
  const lower = url.toLowerCase()
  const resp = await fetch(url)
  // ★ 2026-11-01 修 (审核报告 §3.1 P1-7): 之前不看 HTTP 状态 ——
  //   404/500 返回的 HTML 会被当成 MIDI 字节去解析, 报一个莫名其妙的
  //   "Invalid MIDI file", 用户完全看不出是"文件没了"还是"解析炸了".
  if (!resp.ok) {
    throw new Error(`拉取失败 (${resp.status} ${resp.statusText || ''})：${url}`.trim())
  }
  if (lower.endsWith('.mid') || lower.endsWith('.midi')) {
    const buf = await resp.arrayBuffer()
    return parseMidi(new Uint8Array(buf))
  }
  if (lower.endsWith('.mxl')) {
    const buf = await resp.arrayBuffer()
    return parseMxl(new Uint8Array(buf))
  }
  if (lower.endsWith('.xml') || lower.endsWith('.musicxml')) {
    return parseXml(await resp.text())
  }
  throw new Error(`Unsupported URL: ${url}`)
}
