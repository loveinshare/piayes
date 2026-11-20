import zlib from 'node:zlib'
import fs from 'node:fs'

// 一个够用的 Canvas2D 替身 —— 只实现点阵屏渲染器用到的那几个方法.
//
// 为什么需要: jsdom 不带 canvas 实现 (getContext('2d') 返回 null),
// 而点阵屏的渲染器是**每帧**往画布上画再 getImageData 抠像素 —— 没有画布
// 就没法在测试里验证「画出来对不对」.
//
// 只支持: fillRect / strokeRect / getImageData, 以及 fillStyle / strokeStyle /
// lineWidth. 矩形按**面积覆盖率**混合 (跟浏览器对轴对齐矩形的算法一致),
// 所以抗锯齿效果跟真浏览器基本相同.
//
// 另外附一个极简 PNG 编码器 —— 把渲染结果写成图片, 好用眼睛看.

export interface Rgb {
  r: number
  g: number
  b: number
}

/** 解析 #rgb / #rrggbb / rgb(r,g,b) / rgba(r,g,b,a) */
export function parseColor(css: string): Rgb {
  if (css.startsWith('#')) {
    let h = css.slice(1)
    if (h.length === 3) h = h.split('').map((c) => c + c).join('')
    const n = parseInt(h.slice(0, 6), 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
  }
  const m = css.match(/-?\d+(\.\d+)?/g)
  if (m && m.length >= 3) {
    return { r: +m[0], g: +m[1], b: +m[2] }
  }
  return { r: 0, g: 0, b: 0 }
}

export class ShimContext2D {
  fillStyle = '#000000'
  strokeStyle = '#000000'
  lineWidth = 1
  private w: number
  private h: number
  private data: Uint8ClampedArray

  constructor(w: number, h: number) {
    this.w = w
    this.h = h
    this.data = new Uint8ClampedArray(w * h * 4)
    // 背景透明黑
    for (let i = 3; i < this.data.length; i += 4) this.data[i] = 255
  }

  /** 面积覆盖率混合 —— 跟浏览器对轴对齐矩形的处理一致. */
  fillRect(x: number, y: number, w: number, h: number) {
    const c = parseColor(this.fillStyle)
    const x0 = Math.max(0, Math.floor(x))
    const y0 = Math.max(0, Math.floor(y))
    const x1 = Math.min(this.w, Math.ceil(x + w))
    const y1 = Math.min(this.h, Math.ceil(y + h))
    for (let py = y0; py < y1; py++) {
      const fy = Math.min(py + 1, y + h) - Math.max(py, y)
      if (fy <= 0) continue
      for (let px = x0; px < x1; px++) {
        const fx = Math.min(px + 1, x + w) - Math.max(px, x)
        if (fx <= 0) continue
        const a = Math.min(1, fx * fy)
        const i = (py * this.w + px) * 4
        this.data[i] = this.data[i] * (1 - a) + c.r * a
        this.data[i + 1] = this.data[i + 1] * (1 - a) + c.g * a
        this.data[i + 2] = this.data[i + 2] * (1 - a) + c.b * a
      }
    }
  }

  /** 只描边 —— 线宽 1 时按四条 0.5px 的边画 (够用了). */
  strokeRect(x: number, y: number, w: number, h: number) {
    const lw = this.lineWidth
    const prev = this.fillStyle
    this.fillStyle = this.strokeStyle
    this.fillRect(x, y, w, lw / 2)
    this.fillRect(x, y + h - lw / 2, w, lw / 2)
    this.fillRect(x, y, lw / 2, h)
    this.fillRect(x + w - lw / 2, y, lw / 2, h)
    this.fillStyle = prev
  }

  getImageData(_x: number, _y: number, w: number, h: number) {
    const out = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = (y * this.w + x) * 4
        const d = (y * w + x) * 4
        out[d] = this.data[s]
        out[d + 1] = this.data[s + 1]
        out[d + 2] = this.data[s + 2]
        out[d + 3] = this.data[s + 3]
      }
    }
    return { data: out, width: w, height: h }
  }

  /** 整个画布的 RGBA (给 PNG 编码器用) */
  raw(): Uint8ClampedArray {
    return this.data
  }
}

/** 把 shim 装到 jsdom 的 HTMLCanvasElement 上. */
export function installCanvasShim() {
  const proto = globalThis.HTMLCanvasElement.prototype as unknown as {
    getContext: (id: string) => unknown
    width: number
    height: number
  }
  proto.getContext = function (id: string) {
    if (id !== '2d') return null
    const self = this as unknown as { width: number; height: number }
    const ctx = new ShimContext2D(self.width || 300, self.height || 150)
    ;(self as unknown as { __ctx?: ShimContext2D }).__ctx = ctx
    return ctx
  }
  // 每次 getContext 都新建一个 —— 渲染器只 get 一次, 够用.
}

/** 取回某个 canvas 的 shim 上下文 (installCanvasShim 之后). */
export function ctxOf(canvas: HTMLCanvasElement): ShimContext2D {
  return (canvas as unknown as { __ctx: ShimContext2D }).__ctx
}

// ---- 极简 PNG 编码器 (RGB, 8bit, 无隔行) ----

function crc32(buf: Buffer): number {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** 把 RGB888 缓冲写成 PNG 文件. */
export function writePng(path: string, width: number, height: number, rgb: Uint8Array) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0 // filter: none
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(
      raw,
      y * (width * 3 + 1) + 1,
    )
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolor
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
  fs.writeFileSync(path, png)
}
