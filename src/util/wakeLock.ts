// 屏幕常亮 —— 程序在前台时不熄屏.
//
// 为什么: 练琴的时候人离键盘远, 屏幕一进屏保就黑了 —— 瀑布、灯带提示、谱面
// 全都看不见 (用户: 「能不能让程序在前台时不要让屏幕熄灭」).
//
// 用浏览器标准的 **Screen Wake Lock API**: `navigator.wakeLock.request('screen')`.
// 浏览器会在页面切到后台时**自动**释放锁, 切回前台要**重新申请** —— 所以这里
// 监听 visibilitychange, 回来就再要一次.
//
// 兼容性: Chrome / Edge / Firefox 桌面版支持; iOS Safari 不支持 (返回 undefined
// → 直接不做事); 申请被拒 (比如页面刚打开还没交互过) 也只是不做事 —— 绝不报错。

interface WakeLockSentinelLike {
  released: boolean
  release(): Promise<void>
  addEventListener(type: 'release', fn: () => void): void
}

interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>
}

/** 拿浏览器的 wakeLock (没有就返回 null —— iOS Safari / 老浏览器). */
function wakeLockApi(): WakeLockLike | null {
  const nav = globalThis.navigator as unknown as { wakeLock?: WakeLockLike } | undefined
  return nav?.wakeLock ?? null
}

/**
 * 申请屏幕常亮, 一直维持到返回的清理函数被调用.
 *
 * 返回一个 cleanup: 释放锁 + 摘掉监听. 组件卸载时调它.
 */
export function setupWakeLock(): () => void {
  const api = wakeLockApi()
  if (!api) return () => {}

  let sentinel: WakeLockSentinelLike | null = null
  let disposed = false

  const acquire = async () => {
    // 已经拿着锁 / 页面不在前台 / 已经卸载 → 不用申请.
    if (disposed || sentinel) return
    if (globalThis.document?.visibilityState === 'hidden') return
    try {
      const s = await api.request('screen')
      if (disposed) {
        // 申请的这段时间里被卸载了 → 立刻还回去, 别泄漏.
        void s.release()
        return
      }
      sentinel = s
    } catch {
      // 申请被拒 (没有用户交互 / 策略禁止) —— 静默: 常亮只是锦上添花.
      sentinel = null
    }
  }

  const onVisibility = () => {
    if (globalThis.document?.visibilityState === 'visible') void acquire()
  }

  // 页面切到后台 → 浏览器自己会释放锁; 我们把句柄清掉, 回来再申请.
  const onRelease = () => {
    sentinel = null
  }

  globalThis.document?.addEventListener('visibilitychange', onVisibility)
  void acquire()

  return () => {
    disposed = true
    globalThis.document?.removeEventListener('visibilitychange', onVisibility)
    const s = sentinel
    sentinel = null
    if (s && !s.released) {
      s.addEventListener('release', onRelease)
      void s.release().catch(() => {})
    }
  }
}
