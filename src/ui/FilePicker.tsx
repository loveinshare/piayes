// 文件选择: 点击 / 拖入
// 自动识别 .mid / .xml / .musicxml / .mxl
//
// 登录状态下, 选中的文件会**自动上传保存**到服务端的「我的谱子」——
// 不用手动点保存, 拖进来就存下来了.

import { useRef, useState } from 'react'
import { useStore } from '../store'
import { useAuth, openAuthModal } from '../auth'
import { parseFile } from '../parser'
import { uploadMyScore } from '../library'
import { IconAlert, IconCheck, IconFolder, IconLoader } from './icons'

export function FilePicker() {
  const setSong = useStore((s) => s.setSong)
  const user = useAuth((s) => s.user)
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  /** 上传结果提示 (null = 还没传过) */
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)

  const handle = async (file: File) => {
    setError(null)
    setSaveMsg(null)
    setSaveFailed(false)
    setLoading(true)
    try {
      const s = await parseFile(file)
      setSong(s)
      // 本地文件没有乐库出处 —— 清掉, 保存时只能当新曲子存
      useStore.getState().setLibrarySource(null)
      // 修 #11: file kind 不入最近 (没法还原). 弹窗顶部会提示 "浏览器无法保存文件".
      // 登录了 → 自动存到服务端; 没登录 → 本地照样能弹, 只是存不下来
      if (user) {
        try {
          await uploadMyScore(file, s)
          setSaveMsg('已保存到「我的谱子」')
          setSaveFailed(false)
        } catch (e) {
          setSaveMsg(`保存失败: ${(e as Error).message}`)
          setSaveFailed(true)
        }
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 w-full">
      <div
        className={`px-4 py-6 rounded-lg border-2 border-dashed text-center text-sm cursor-pointer transition ${
          dragOver
            ? 'border-accent bg-accent/10'
            : 'border-border hover:border-accent/50 hover:bg-bg/30'
        }`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          const f = e.dataTransfer.files[0]
          if (f) handle(f)
        }}
      >
        <div className="size-10 mx-auto mb-2 grid place-items-center rounded-xl border border-border bg-panel text-muted">
          {loading ? <IconLoader size={20} className="anim-spin" /> : <IconFolder size={20} />}
        </div>
        <div className="text-text">{loading ? '解析中…' : '拖入文件 或 点击选择'}</div>
        <div className="text-xs text-muted mt-1">
          支持 .mid · .midi · .xml · .musicxml · .mxl
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".mid,.midi,.xml,.musicxml,.mxl,audio/midi,audio/x-midi"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) handle(f)
          e.target.value = ''
        }}
      />
      {error && (
        <div className="text-xs text-miss bg-miss/10 border border-miss/25 rounded-md px-2 py-1.5 flex items-start gap-1.5">
          <IconAlert size={13} className="mt-px shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {saveMsg && (
        <div
          className={`text-xs rounded px-2 py-1.5 ${
            saveFailed ? 'text-miss bg-miss/10' : 'text-hit bg-hit/10'
          }`}
        >
          <span className="inline-flex items-start gap-1.5">
            {saveFailed ? <IconAlert size={13} className="mt-px shrink-0" /> : <IconCheck size={13} className="mt-px shrink-0" />}
            {saveMsg}
          </span>
        </div>
      )}
      {!user && (
        <div className="text-xs text-muted flex items-center gap-2">
          <span>登录后, 拖进来的谱子会自动存到你的谱库</span>
          <button
            onClick={() => openAuthModal('login')}
            className="shrink-0 px-2 py-0.5 rounded border border-accent/40 text-accent hover:bg-accent/10 transition"
          >
            登录
          </button>
        </div>
      )}
    </div>
  )
}
