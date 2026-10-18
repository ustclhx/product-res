import type { TemplateConfig } from '@product-res/config'
import { isAppAreaPath } from '../i18n/app-area.ts'

/** 无 Cookie 的流量统计只放在公开页面；未配置公开 token 时不输出脚本。 */
export function analyticsHeadScripts(pathname: string, config: TemplateConfig) {
  if (isAppAreaPath(pathname) || !config.analytics.cloudflareToken.trim()) return []
  return [
    {
      src: 'https://static.cloudflareinsights.com/beacon.min.js',
      defer: true,
      // 自动 SPA 监听会跨到后台路径；这里只统计公开页面的文档加载。
      'data-cf-beacon': JSON.stringify({ token: config.analytics.cloudflareToken, spa: false }),
    },
  ]
}
