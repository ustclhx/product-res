import type { ProjectShareCardSite, ShareCardSiteContext } from './site.ts'

// 项目自有：模板只创建本文件，之后不再修改。
// 一次部署服务多个品牌域名时，按请求 host（构建期默认分享图按页面 locale / pathname）返回该站点的
// 主题、品牌、规范域名与副标题覆盖；返回 undefined 时与单站点相同。说明见 docs/share-cards.md 第 6.1 节。
export function resolveProjectShareCardSite(
  _context: ShareCardSiteContext,
): ProjectShareCardSite | undefined {
  return undefined
}
