import { describe, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseMidi } from '../src/parser/parseMidi'

describe('all download tracks', () => {
  const dir = resolve(__dirname, '../downloads')
  // 本地下载目录是 gitignore 掉的临时素材 —— 干净克隆 / CI 上不存在, 整组跳过
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    it.skip('downloads/ 目录不存在, 跳过下载曲目诊断', () => {})
    return
  }
  for (const f of readdirSync(dir)) {
    if (!f.toLowerCase().endsWith('.mid')) continue
    it(f, async () => {
      const buf = readFileSync(resolve(dir, f))
      let song
      try { song = parseMidi(new Uint8Array(buf)) } catch (e) { console.log(f, '— PARSE FAIL', e); return }
      const byTrack = new Map<number, { count: number; min: number; max: number; avg: number; sum: number }>()
      for (const n of song.notes) {
        const cur = byTrack.get(n.track)
        if (!cur) byTrack.set(n.track, { count: 1, min: n.midiNote, max: n.midiNote, avg: n.midiNote, sum: n.midiNote })
        else { cur.count++; cur.min = Math.min(cur.min, n.midiNote); cur.max = Math.max(cur.max, n.midiNote); cur.sum += n.midiNote; cur.avg = cur.sum / cur.count }
      }
      const dur = song.duration ? (Math.floor(song.duration/60)+':'+Math.floor(song.duration%60).toString().padStart(2,'0')) : '?'
      const ts = song.timeSignature ? (song.timeSignature.numerator + '/' + song.timeSignature.denominator) : '?'
      console.log(`${f} — ${song.notes.length} notes, dur=${dur}, ts=${ts}, ${byTrack.size} track(s):`)
      for (const [id, s] of byTrack) console.log(`  t${id}: ${s.count} notes, midi ${s.min}..${s.max} (avg ${s.avg.toFixed(1)})`)
    })
  }
})
