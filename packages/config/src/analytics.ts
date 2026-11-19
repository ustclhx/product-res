/** 浏览器可见的 Plausible 配置：按环境取值，staging 与生产使用各自的 site（docs/analytics.md）。 */
export interface PlausibleSite {
  /**
   * Plausible 的 site_id（data-domain）。配置了 sites 时它是未登记访问域名的兜底，可为空串：
   * 空串表示预览地址等未登记域名不统计。
   */
  readonly domain: string
  /** 访问域名（已规范化）→ site_id；只在配置了 PLAUSIBLE_SITES 时出现，单站输出保持不变 */
  readonly sites?: Readonly<Record<string, string>>
  readonly origin: string
  readonly scriptUrl: string
  readonly eventUrl: string
}

/** manual 版脚本：页面事件由 trackEvent 发送，才能脱敏 URL 并携带统一属性。 */
const SCRIPT_PATH = '/js/script.manual.js'

/**
 * 访问域名的比较形式：小写、去端口、去结尾点与开头 `www.`。
 * 门禁脚本 scripts/production/check-wrangler-envs.mjs 复制了同一规则，
 * 两份实现由 plausible-sites.cases.json 的同一组用例约束一致。
 */
export function normalizeSiteHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/\.$/, '')
    .replace(/^www\./, '')
}

const HOST_PATTERN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/
const SITE_PATTERN = /^[^\s=,]+$/

/**
 * 解析 `host=site,host=site`。空值表示未配置；任一项格式错误时整体视为错误并由发布门禁拦截，
 * 运行时不猜测部分可用的映射，避免数据串到别的 site。
 */
export function parsePlausibleSites(
  raw: string | undefined,
): { sites: Record<string, string> } | { error: string } {
  const sites: Record<string, string> = {}
  if (!raw?.trim()) return { sites }
  for (const item of raw.split(',')) {
    const entry = item.trim()
    const at = entry.indexOf('=')
    if (at < 0) return { error: `entry "${entry}" has no "="` }
    const host = normalizeSiteHost(entry.slice(0, at))
    const site = entry.slice(at + 1).trim()
    if (!HOST_PATTERN.test(host)) return { error: `entry "${entry}" has an invalid host` }
    if (!SITE_PATTERN.test(site)) return { error: `entry "${entry}" has an invalid site` }
    if (Object.hasOwn(sites, host)) return { error: `host ${host} is mapped twice` }
    sites[host] = site
  }
  return { sites }
}

/** 按访问域名选择 site：命中映射用映射值，否则退回兜底；空串表示不统计。 */
export function resolvePlausibleSite(
  sites: Readonly<Record<string, string>> | undefined,
  fallback: string,
  host: string,
): string {
  const key = normalizeSiteHost(host)
  return sites && Object.hasOwn(sites, key) ? (sites[key] ?? fallback) : fallback
}

/** 模板关闭、未配置、映射无法解析或地址非法时返回 null，调用方不注入脚本也不发送事件。 */
export function plausibleSite(
  analytics: 'plausible' | 'posthog' | false,
  env: {
    PLAUSIBLE_DOMAIN?: string | undefined
    PLAUSIBLE_HOST?: string | undefined
    PLAUSIBLE_SITES?: string | undefined
  },
): PlausibleSite | null {
  const domain = env.PLAUSIBLE_DOMAIN?.trim() ?? ''
  const host = env.PLAUSIBLE_HOST?.trim()
  const parsed = parsePlausibleSites(env.PLAUSIBLE_SITES)
  if (analytics !== 'plausible' || 'error' in parsed || !host || !URL.canParse(host)) return null
  const mapped = Object.keys(parsed.sites).length > 0
  if (!domain && !mapped) return null
  const { origin, protocol } = new URL(host)
  if (protocol !== 'https:' && protocol !== 'http:') return null
  return {
    domain,
    ...(mapped ? { sites: parsed.sites } : {}),
    origin,
    scriptUrl: `${origin}${SCRIPT_PATH}`,
    eventUrl: `${origin}/api/event`,
  }
}
