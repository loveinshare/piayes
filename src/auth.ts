// 认证状态 —— 独立的 zustand store
//
// 不放进 store.ts: 练习相关的 UI 状态 (song/hand/score...) 和账号状态是两回事,
// 分开存免得互相触发重渲染.
//
// 密码永远不落盘. 「记住我」= 服务端发一个长期 session token (HttpOnly cookie),
// 浏览器这边只留用户名用来预填输入框.

import { create } from 'zustand'

export interface AuthUser {
  id: number
  username: string
  /** 管理员 —— 只有管理员能把改动存到公共乐库 (见 POST /api/scores/public). */
  isAdmin: boolean
}

interface AuthState {
  user: AuthUser | null
  /** 启动时 /api/auth/me 查过了没 (没查完之前不要弹「请登录」) */
  checked: boolean
  login: (username: string, password: string, remember: boolean) => Promise<void>
  register: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  /** 启动时查一次当前登录态 */
  check: () => Promise<void>
}

/** 用户名预填用的 key (只存用户名, 不存密码) */
const LS_USERNAME = 'piayes.username'
/** 老版本用的 key —— 只读, 兼容改名前存下来的. */
const LS_USERNAME_LEGACY = 'piano-follow.username'

export function rememberedUsername(): string {
  for (const key of [LS_USERNAME, LS_USERNAME_LEGACY]) {
    try {
      const v = localStorage.getItem(key)
      if (v) return v
    } catch {
      // 读不了 (隐私模式等) —— 换下一个 key 试
    }
  }
  return ''
}

function rememberUsername(name: string) {
  try {
    localStorage.setItem(LS_USERNAME, name)
  } catch {}
}

/** 调 API, 失败时抛服务端给的错误信息. */
export async function apiRequest<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const resp = await fetch(path, { credentials: 'same-origin', ...init })
  const text = await resp.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    // 非 JSON 响应 (比如网关挂了返回 HTML) —— 走下面的通用报错
  }
  if (!resp.ok) {
    const msg =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : `请求失败 (${resp.status})`
    throw new Error(msg)
  }
  return data as T
}

export const useAuth = create<AuthState>((set) => ({  user: null,
  checked: false,

  login: async (username, password, remember) => {
    const data = await apiRequest<{ user: AuthUser }>('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, remember }),
    })
    rememberUsername(username)
    set({ user: { ...data.user, isAdmin: Boolean(data.user.isAdmin) }, checked: true })
  },

  register: async (username, password) => {
    const data = await apiRequest<{ user: AuthUser }>('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    rememberUsername(username)
    set({ user: { ...data.user, isAdmin: Boolean(data.user.isAdmin) }, checked: true })
  },

  logout: async () => {
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' })
    } catch {
      // 登出失败 (网络断了) 也照样清本地状态
    }
    set({ user: null, checked: true })
  },

  check: async () => {
    try {
      const data = await apiRequest<{ user: AuthUser }>('/api/auth/me')
      set({ user: { ...data.user, isAdmin: Boolean(data.user.isAdmin) }, checked: true })
    } catch {
      set({ user: null, checked: true })
    }
  },
}))

// ---- 登录弹窗的全局开关 ----
// 登录弹窗在 App 里挂一次, 但顶栏 / 乐库 / 文件上传好几处都要能弹它.
// 用模块级 opener (跟 src/led/emit.ts 的 led bus 一个套路), 免得层层传 props.
type AuthModalOpener = (mode?: 'login' | 'register') => void

let authModalOpener: AuthModalOpener | null = null

export function setAuthModalOpener(fn: AuthModalOpener | null) {
  authModalOpener = fn
}

/** 打开登录弹窗. 没注册 opener (比如单测) 时静默返回. */
export function openAuthModal(mode?: 'login' | 'register') {
  authModalOpener?.(mode)
}
