// 剪贴板 —— 全站共用一份.
//
// navigator.clipboard 只在**安全上下文** (https / localhost) 可用;
// 局域网 http 部署时 writeText 会抛 NotAllowedError, 这时退回老路
// (隐藏 textarea + execCommand('copy')).
//
// 返回 true = 复制成功, false = 两条路都不行 (调用方决定要不要提示).

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 非安全上下文 / 用户拒绝 —— 走下面的 fallback
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}
