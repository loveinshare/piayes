// 右下角浮动按钮列: 乐库 / 统计 / 音量
//
// ★ 2026-11-14 (用户要求): 「把乐库 统计 放到右边侧栏, 和音量设置那种类似」
//   —— 三个都收成右下角一列圆形按钮, 点哪个开哪个.
//   乐库/统计的内容还是原来那两个居中浮层 (LibraryOverlay / StatsPopup),
//   只是入口从顶栏挪到了这里 —— 顶栏右边少两个图标, 干净些.
//
// 音量那部分是从 VolumePanel.tsx 搬过来的 (2026-11-06 用户要求):
//   收成一个圆按钮 —— 点开才出现竖滑块, 再点收起.
//   竖滑块的做法: 拿横着的 <input type=range> 整体 rotate(-90deg) ——
//   转完「左端 (最小值)」跑到了下面, 所以已填充段是「从下往上」, 正是竖滑块该有的样子.
//   (writing-mode 那套各浏览器支持不齐, 旋转最稳.)

import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { Slider } from './controls'
import { IconChart, IconMusic, IconVolume } from './icons'

interface Props {
  onOpenLibrary: () => void
  onOpenStats: () => void
}

export function RightDock({ onOpenLibrary, onOpenStats }: Props) {
  const [volOpen, setVolOpen] = useState(false)
  const volume = useStore((s) => s.volume)
  const setVolume = useStore((s) => s.setVolume)
  const wrapRef = useRef<HTMLDivElement>(null)

  // 点外面 / 按 Esc → 收起音量面板
  useEffect(() => {
    if (!volOpen) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setVolOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setVolOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [volOpen])

  const pct = Math.round(volume * 100)
  const muted = pct === 0

  return (
    // ★ bottom-[122px]: 画布底部 110px 是**画出来的键盘** (KEYBOARD_HEIGHT),
    //   按钮贴在 bottom-3 → 正落在琴键上, 弹出来还挡键. 抬到键盘上方.
    <div
      ref={wrapRef}
      className="absolute bottom-[122px] right-3 z-20 flex flex-col items-end gap-2 select-none"
    >
      <RoundBtn title="乐库 / 文件 (B)" onClick={() => { setVolOpen(false); onOpenLibrary() }}>
        <IconMusic size={16} />
      </RoundBtn>
      <RoundBtn title="统计" onClick={() => { setVolOpen(false); onOpenStats() }}>
        <IconChart size={16} />
      </RoundBtn>

      {/* 音量: 面板贴着按钮上面 —— 单独套一层, 别让面板把上面两个按钮挤走 */}
      <div className="relative flex flex-col items-end gap-2">
        {volOpen && (
          <div className="flex flex-col items-center gap-1.5 rounded-xl border border-border bg-panel/95 px-3 py-2.5 backdrop-blur shadow-xl shadow-black/40 anim-fade-in">
            <span className="text-[11px] text-muted tabular-nums leading-none">{pct}%</span>
            {/* 竖滑块: 容器 32×128, 滑块本体 112 宽横放, 转 -90° */}
            <div className="relative h-32 w-8 grid place-items-center">
              <Slider
                value={volume}
                min={0}
                max={1}
                step={0.01}
                onChange={setVolume}
                ariaLabel="主音量"
                title="主音量 (合成器 + MIDI Out 力度)"
                className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-28 rotate-[-90deg]"
              />
            </div>
          </div>
        )}

        <button
          onClick={() => setVolOpen((v) => !v)}
          className={
            volOpen
              ? 'size-9 grid place-items-center rounded-full bg-panel/95 border border-accent text-accent backdrop-blur shadow-lg shadow-black/40 transition-colors'
              : 'size-9 grid place-items-center rounded-full bg-panel/80 border border-border text-muted hover:text-text hover:border-accent backdrop-blur transition-colors'
          }
          title={volOpen ? '收起音量' : `音量 ${pct}% (点击展开)`}
          aria-label={volOpen ? '收起音量' : '展开音量'}
          aria-expanded={volOpen}
        >
          <span aria-hidden>
            <IconVolume size={16} />
          </span>
        </button>
        {/* 静音时给个红点, 免得用户以为音量还在 */}
        {!volOpen && muted && (
          <span className="absolute right-0 bottom-0 size-2 rounded-full bg-miss ring-2 ring-panel" aria-hidden />
        )}
      </div>
    </div>
  )
}

/** 这一列里的普通圆按钮 (乐库 / 统计) */
function RoundBtn({
  title,
  onClick,
  children,
}: {
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className="size-9 grid place-items-center rounded-full bg-panel/80 border border-border text-muted hover:text-text hover:border-accent backdrop-blur shadow-lg shadow-black/40 transition-colors"
    >
      <span aria-hidden>{children}</span>
    </button>
  )
}
