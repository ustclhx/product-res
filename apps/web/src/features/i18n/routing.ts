import type { LocationRewrite } from '@tanstack/react-router'
import { deLocalizeUrl, localizeUrl } from '../../paraglide/runtime.js'
import { templateConfig } from '../../server/template-config.ts'
import { isAppAreaPath } from './app-area.ts'

/**
 * 语言路由（tasks.md 1.1，design.md 决策 3）：默认语言无前缀，其他配置语言 `/<locale>/...`。
 *
 * - 语言识别与 URL 映射由 Paraglide 负责（src/server.ts 的 `paraglideMiddleware` 与这里的 rewrite）；
 *   `/<默认语言>/...` 由中间件 307 到无前缀地址。
 * - 未配置的前缀（如 `/fr/pricing`）不会被去掉，路由器找不到对应页面而返回 404。
 * - 应用区不加语言前缀：带前缀访问由 gate.ts 改写到 404，生成链接时也不给应用区加前缀。
 */

/** 路由器的 URL 改写：进入时去掉语言前缀，生成链接时按当前语言加前缀（应用区除外） */
export const localeRewrite = {
  input: ({ url }) => (templateConfig.i18n.enabled ? deLocalizeUrl(url) : url),
  output: ({ url }) =>
    !templateConfig.i18n.enabled || isAppAreaPath(url.pathname) ? url : localizeUrl(url),
} satisfies LocationRewrite
