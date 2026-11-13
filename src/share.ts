// 分享链接 —— 一首曲子 = 一个 URL.
//
// 格式: `?song=<乐库条目 id>&scope=public|mine`
//   - public → 公共乐库里的那一条 (manifest 的 id), 谁都能打开
//   - mine   → 某个用户自己的私有谱子 (id 形如 `u-12`), 只有登录的人打得开
//
// 为什么用 query 而不是路径 (`/s/<id>`): 服务端是静态托管, query 不用改路由,
// 而且原来的 `?autoload=0` 就是这个套路.
//
// 私有谱子的链接在别人那儿打开 → 需要登录 → 登录完自动继续打开那首 (见 App).

export interface SongLink {
  id: string
  scope: 'public' | 'mine'
}

/** 生成分享链接 (用当前站点的 origin —— 公网部署就是公网地址). */
export function buildShareUrl(link: SongLink): string {
  const { origin, pathname } = window.location
  const params = new URLSearchParams()
  params.set('song', link.id)
  params.set('scope', link.scope)
  return `${origin}${pathname}?${params.toString()}`
}

/** 从 URL 里解析分享链接. 没有 song 参数 → null. */
export function parseShareLink(search: string = window.location.search): SongLink | null {
  const params = new URLSearchParams(search)
  const id = params.get('song')
  if (!id) return null
  const scope = params.get('scope') === 'mine' ? 'mine' : 'public'
  return { id, scope }
}
