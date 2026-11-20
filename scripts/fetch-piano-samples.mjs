#!/usr/bin/env node
// 下载 Salamander Grand Piano 采样到 public/samples/piano/
//
// 采样来源: https://tonejs.github.io/audio/salamander/<note>.mp3
//   (Salamander Grand Piano v3, Alexander Holm, CC BY 3.0 —— 见同目录 LICENSE.md)
//
// 采样点每 3 个半音一个 (A / C / D# / F#), 中间的音用 playbackRate 移调,
//   所以只下 30 个文件 (~2MB) 就覆盖 A0..C8。
//
// 用法: node scripts/fetch-piano-samples.mjs [--force]

import { mkdir, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, 'public', 'samples', 'piano')
const BASE_URL = 'https://tonejs.github.io/audio/salamander'

/** 采样点: A0, 然后每 3 半音 (C, D#, F#) 一组到 C8 */
function buildNoteList() {
  const notes = ['A0']
  for (let octave = 1; octave <= 7; octave++) {
    notes.push(`C${octave}`, `Ds${octave}`, `Fs${octave}`, `A${octave}`)
  }
  notes.push('C8')
  return notes
}

const LICENSE = `# 钢琴采样 —— Salamander Grand Piano v3

- **来源**: https://tonejs.github.io/audio/salamander/ (Tone.js 官方转码的 mp3)
- **原始录音**: [Salamander Grand Piano v3](https://github.com/sfzinstruments/SalamanderGrandPiano)
  by Alexander Holm
- **许可**: [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) —— 署名即可商用
- **采样点**: A0, C1..C8, Ds1..Ds7, Fs1..Fs7, A1..A7 (每 3 个半音一个)

## 署名要求 (CC BY 3.0)

在应用里展示音频来源时保留下面这行:

    Piano samples: Salamander Grand Piano v3 by Alexander Holm (CC BY 3.0)

## 重新下载

    node scripts/fetch-piano-samples.mjs --force
`

async function exists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function main() {
  const force = process.argv.includes('--force')
  await mkdir(OUT_DIR, { recursive: true })
  const notes = buildNoteList()

  let downloaded = 0
  let skipped = 0
  for (const note of notes) {
    const dest = path.join(OUT_DIR, `${note}.mp3`)
    if (!force && (await exists(dest))) {
      skipped++
      continue
    }
    const res = await fetch(`${BASE_URL}/${note}.mp3`)
    if (!res.ok) {
      throw new Error(`${note}.mp3 下载失败: HTTP ${res.status}`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    await writeFile(dest, buf)
    downloaded++
    console.log(`  ${note}.mp3  ${(buf.length / 1024).toFixed(0)} KB`)
  }

  await writeFile(path.join(OUT_DIR, 'LICENSE.md'), LICENSE)
  console.log(`完成: 新下载 ${downloaded} 个, 已存在 ${skipped} 个 → ${path.relative(ROOT, OUT_DIR)}/`)
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
