import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * add-cloud-production-neon 2.1：web / jobs 的 env.production 与 env.staging 绑定名集合一致，
 * production 不含任何 staging 资源 ID 或名称，且不设 PAYMENT_MODE（Q9 前关闭支付）、AI_FAULT_INJECTION（生产禁止）
 * 与 UI_PREVIEW（组件预览页 /dev/ui 只在开发与 staging 开放，openspec add-ui-design-system D6）；
 * web 在开发、staging、production 都声明 RL_SHARE_CARD，且各限流 namespace_id 互不相同。
 */
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
/** 各 Cron 档位独有的触发器；档位与 triggers 不一致时 Worker 运行期会拒绝触发。 */
const CRON_PROFILE_TRIGGERS = { reduced: '*/30 * * * *', default: '*/5 * * * *' }
const FORBIDDEN_PRODUCTION_VARS = ['PAYMENT_MODE', 'AI_FAULT_INJECTION', 'UI_PREVIEW']
/** ratelimits 不从顶层继承：这些绑定在开发、staging 与 production 都必须各自声明（add-og-images 5.2）。 */
const REQUIRED_RATE_LIMITS = { web: ['RL_SHARE_CARD'] }

/** 去掉 JSONC 注释与尾逗号；字符串内的 `//`（如 URL）保持不变 */
export function parseJsonc(text) {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      out += char
      if (char === '\\') {
        out += text[i + 1]
        i += 1
      } else if (char === '"') inString = false
    } else if (char === '"') {
      inString = true
      out += char
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      out += '\n'
    } else if (char === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1
    } else out += char
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

/**
 * PLAUSIBLE_SITES 解析：与 packages/config/src/analytics.ts 同一规则（门禁是 .mjs，只能复制一份），
 * 两份实现由 packages/config/src/plausible-sites.cases.json 的同一组用例约束一致。
 */
export function normalizeSiteHost(host) {
  return host
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/\.$/, '')
    .replace(/^www\./, '')
}

export function parsePlausibleSites(raw) {
  const sites = {}
  if (!raw?.trim()) return { sites }
  for (const item of raw.split(',')) {
    const entry = item.trim()
    const at = entry.indexOf('=')
    if (at < 0) return { error: `entry "${entry}" has no "="` }
    const host = normalizeSiteHost(entry.slice(0, at))
    const site = entry.slice(at + 1).trim()
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(host))
      return { error: `entry "${entry}" has an invalid host` }
    if (!/^[^\s=,]+$/.test(site)) return { error: `entry "${entry}" has an invalid site` }
    if (Object.hasOwn(sites, host)) return { error: `host ${host} is mapped twice` }
    sites[host] = site
  }
  return { sites }
}

export function resolvePlausibleSite(sites, fallback, host) {
  const key = normalizeSiteHost(host)
  return sites && Object.hasOwn(sites, key) ? (sites[key] ?? fallback) : fallback
}

/** 一个环境会上报到的全部 site：映射值加上兜底 PLAUSIBLE_DOMAIN；映射无法解析时为空。 */
function plausibleSiteIds(vars = {}) {
  const parsed = parsePlausibleSites(vars.PLAUSIBLE_SITES)
  return new Set(
    [...Object.values(parsed.sites ?? {}), vars.PLAUSIBLE_DOMAIN ?? ''].filter(Boolean),
  )
}

export function bindingNames(env = {}) {
  const names = [
    ...(env.ai ? [`ai:${env.ai.binding}`] : []),
    ...(env.r2_buckets ?? []).map((item) => `r2:${item.binding}`),
    ...(env.kv_namespaces ?? []).map((item) => `kv:${item.binding}`),
    ...(env.hyperdrive ?? []).map((item) => `hyperdrive:${item.binding}`),
    ...(env.workflows ?? []).map((item) => `workflow:${item.binding}`),
    ...(env.queues?.producers ?? []).map((item) => `queue-producer:${item.binding}`),
    ...(env.queues?.consumers ?? []).map((_item, index) => `queue-consumer:${index}`),
    ...(env.ratelimits ?? []).map((item) => `ratelimit:${item.name}`),
  ]
  return names.sort()
}

/** 收集 env 中所有字符串值，用于查找 staging 资源泄漏 */
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) strings(item, out)
  else if (value && typeof value === 'object')
    for (const item of Object.values(value)) strings(item, out)
  return out
}

export function checkEnvs(app, config) {
  const problems = []
  const staging = config.env?.staging
  const production = config.env?.production
  if (!staging || !production) return [`${app}: env.staging and env.production are both required`]
  const a = bindingNames(staging)
  const b = bindingNames(production)
  for (const name of a.filter((item) => !b.includes(item)))
    problems.push(`${app}: production is missing binding ${name}`)
  for (const name of b.filter((item) => !a.includes(item)))
    problems.push(`${app}: production has extra binding ${name}`)
  const stagingIds = new Set(strings(staging).filter((value) => /^[a-f0-9]{32}$/.test(value)))
  // 账号 ID 在两个环境中合法相同（R2 / Gateway 账号）
  for (const value of strings(staging.vars ?? {})) stagingIds.delete(value)
  for (const value of strings(production)) {
    if (stagingIds.has(value))
      problems.push(`${app}: production reuses staging resource id ${value}`)
    if (/-staging$|workers\.dev/.test(value))
      problems.push(`${app}: production references staging value ${value}`)
  }
  for (const key of FORBIDDEN_PRODUCTION_VARS)
    if (production.vars && key in production.vars)
      problems.push(`${app}: production must not set ${key}`)
  // 站点串扰：staging 不得复用生产域名或分析 site，否则 sitemap / canonical / 埋点都会串站。
  if (staging.vars?.APP_URL && staging.vars.APP_URL === production.vars?.APP_URL)
    problems.push(`${app}: staging and production share APP_URL ${staging.vars.APP_URL}`)
  if (
    staging.vars?.PLAUSIBLE_DOMAIN &&
    staging.vars.PLAUSIBLE_DOMAIN === production.vars?.PLAUSIBLE_DOMAIN
  )
    problems.push(
      `${app}: staging and production share PLAUSIBLE_DOMAIN ${staging.vars.PLAUSIBLE_DOMAIN}`,
    )
  // 多站映射同样不得把 staging 的任何访问域名指向生产 site（含生产兜底），反之亦然。
  for (const [environment, env] of [
    ['staging', staging],
    ['production', production],
  ]) {
    const parsed = parsePlausibleSites(env.vars?.PLAUSIBLE_SITES)
    if (parsed.error) problems.push(`${app}: env.${environment} PLAUSIBLE_SITES ${parsed.error}`)
  }
  const productionSites = plausibleSiteIds(production.vars)
  for (const site of plausibleSiteIds(staging.vars)) {
    // 两边兜底相同已在上面报告，这里只报涉及映射的共用。
    const bothFallback =
      site === staging.vars?.PLAUSIBLE_DOMAIN && site === production.vars?.PLAUSIBLE_DOMAIN
    if (productionSites.has(site) && !bothFallback)
      problems.push(`${app}: staging and production share Plausible site ${site}`)
  }
  // 限流命名空间按账号计数：任意两个环境共用 namespace_id 会让计数串到一起。
  const environments = [
    ['top-level', config],
    ['staging', staging],
    ['production', production],
  ]
  const namespaces = new Map()
  for (const [environment, env] of environments) {
    const names = new Set((env.ratelimits ?? []).map((item) => item.name))
    for (const name of REQUIRED_RATE_LIMITS[app] ?? [])
      if (!names.has(name)) problems.push(`${app}: ${environment} is missing ratelimit ${name}`)
    for (const item of env.ratelimits ?? []) {
      const owner = namespaces.get(item.namespace_id)
      if (owner)
        problems.push(
          `${app}: ratelimit namespace_id ${item.namespace_id} is shared by ${owner} and ${environment} ${item.name}`,
        )
      else namespaces.set(item.namespace_id, `${environment} ${item.name}`)
    }
  }
  // 成本基线（docs/runbooks/production-neon.md §4）：五分钟心跳会让 Neon 常驻，恢复默认档须显式声明。
  if (app === 'jobs') {
    const profile = production.vars?.CRON_PROFILE
    const crons = production.triggers?.crons ?? []
    if (!Object.hasOwn(CRON_PROFILE_TRIGGERS, profile))
      problems.push('jobs: production CRON_PROFILE must be declared as reduced or default')
    else if (
      Object.entries(CRON_PROFILE_TRIGGERS).some(
        ([name, trigger]) => crons.includes(trigger) !== (name === profile),
      )
    )
      problems.push(`jobs: production crons do not match CRON_PROFILE=${profile}`)
  }
  return problems
}

/** 同一环境的 web 与 jobs 必须上报到同一站点，否则服务端事件会串到别的 site。 */
export function checkSiteVars(web, jobs) {
  const problems = []
  for (const environment of ['staging', 'production'])
    for (const key of ['APP_URL', 'PLAUSIBLE_DOMAIN', 'PLAUSIBLE_HOST', 'PLAUSIBLE_SITES']) {
      const a = web.env?.[environment]?.vars?.[key]
      const b = jobs.env?.[environment]?.vars?.[key]
      if ((a ?? '') !== (b ?? ''))
        problems.push(`${environment}: web and jobs disagree on ${key} (${a ?? ''} / ${b ?? ''})`)
    }
  return problems
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const read = (app) =>
    parseJsonc(readFileSync(resolve(repoRoot, `apps/${app}/wrangler.jsonc`), 'utf8'))
  const problems = [
    ...['web', 'jobs'].flatMap((app) => checkEnvs(app, read(app))),
    ...checkSiteVars(read('web'), read('jobs')),
  ]
  for (const line of problems) console.error(line)
  process.exitCode = problems.length ? 1 : 0
}
