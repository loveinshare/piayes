// 登录 / 注册 弹窗
//
// 密码永远不落盘 —— 「记住我」走服务端的长效 session (HttpOnly cookie),
// 浏览器这边只把用户名存 localStorage 用来预填.

import { useEffect, useState } from 'react'
import { useAuth, rememberedUsername } from '../auth'
import { Switch } from './controls'
import { IconAlert, IconClose } from './icons'

interface Props {
  open: boolean
  onClose: () => void
  /** 打开时默认落在哪个 tab */
  defaultTab?: 'login' | 'register'
}

export function AuthModal({ open, onClose, defaultTab = 'login' }: Props) {
  const login = useAuth((s) => s.login)
  const register = useAuth((s) => s.register)

  const [tab, setTab] = useState<'login' | 'register'>(defaultTab)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // 每次打开: 用户名预填, 密码清空 (不保留), 错误清掉
  useEffect(() => {
    if (!open) return
    setTab(defaultTab)
    setUsername(rememberedUsername())
    setPassword('')
    setError(null)
    setBusy(false)
  }, [open, defaultTab])

  // Esc 关闭 (capture 阶段 + stopPropagation, 免得同时把乐库弹窗也关了)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [open, onClose])

  if (!open) return null

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      if (tab === 'login') {
        await login(username.trim(), password, remember)
      } else {
        await register(username.trim(), password)
      }
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const isRegister = tab === 'register'

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 animate-in fade-in"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm bg-panel border border-border rounded-2xl shadow-2xl shadow-black/40 p-5 flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={isRegister ? '注册' : '登录'}
      >
        <div className="flex items-center gap-1 border-b border-border -mx-1">
          <TabBtn on={!isRegister} onClick={() => { setTab('login'); setError(null) }}>
            登录
          </TabBtn>
          <TabBtn on={isRegister} onClick={() => { setTab('register'); setError(null) }}>
            注册
          </TabBtn>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="size-7 grid place-items-center rounded-lg text-muted hover:text-text hover:bg-raised transition-colors"
            title="关闭 (Esc)"
            aria-label="关闭"
          >
            <IconClose size={14} />
          </button>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">用户名</span>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              placeholder="3-32 个字符"
              className="px-3 py-2 text-sm bg-bg border border-border rounded-lg placeholder-muted focus:border-accent focus:outline-none transition"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">密码</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              placeholder={isRegister ? '至少 6 位' : ''}
              className="px-3 py-2 text-sm bg-bg border border-border rounded-lg placeholder-muted focus:border-accent focus:outline-none transition"
            />
          </label>

          {!isRegister && (
            <Switch
              size="sm"
              checked={remember}
              onChange={setRemember}
              labelClassName="text-[13px]"
              label="记住我 (30 天内免登录)"
            />
          )}

          {/* 预留固定高度 —— 否则报错时会把下面的内容整体顶下去 */}
          <div className="min-h-[30px]">
            {error && (
              <div className="text-xs text-miss bg-miss/10 border border-miss/30 rounded-md px-2 py-1.5 flex items-start gap-1.5">
                <IconAlert size={13} className="mt-px shrink-0" />
                {error}
              </div>
            )}
          </div>

          <button
            type="submit"
            disabled={busy || !username.trim() || !password}
            className="px-3 py-2 text-sm font-semibold rounded-lg bg-accent/20 text-accent border border-accent/40 hover:bg-accent/30 transition disabled:opacity-40"
          >
            {busy ? '处理中…' : isRegister ? '注册并登录' : '登录'}
          </button>

          <p className="text-xs text-subtle leading-relaxed">
            密码只在服务端做哈希后存储, 浏览器不会保存密码.
            {isRegister ? ' 注册后自动登录.' : ' 「记住我」靠长效登录凭证实现, 不落地密码.'}
          </p>
        </form>
      </div>
    </div>
  )
}

function TabBtn({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-2 text-sm transition border-b-2 ${
        on
          ? 'border-accent text-text font-semibold'
          : 'border-transparent text-muted hover:text-text'
      }`}
    >
      {children}
    </button>
  )
}
