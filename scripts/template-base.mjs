import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const themeNames = ['neutral', 'blue', 'violet', 'green']

const lists = {
  ai: ['text', 'image', 'video'],
  billing: ['stripe', 'paypal'],
  features: ['publicApi', 'blog', 'docs', 'waitlist', 'newsletter', 'guides'],
  'media-providers': ['fal', 'workers-ai'],
  oauth: ['google', 'github'],
}
const switches = [
  'billing-enabled',
  'credits-enabled',
  'i18n',
  'marketing',
  'multi-tenant',
  'turnstile',
]
const optionalParamKeys = ['analytics', 'plausible-domain', 'plausible-host', 'theme']
const paramKeys = [
  ...Object.keys(lists),
  ...switches,
  'domain',
  'image-namespace',
  'locale',
  'name',
  'support-email',
  'target',
].sort()
const recordKeys = [
  'schemaVersion',
  'repository',
  'commit',
  'version',
  'clean',
  'params',
  'migrations',
]
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

/**
 * Convert projectOptions() output into complete, sorted CLI parameter keys.
 * Arrays retain the first occurrence of each item; output paths are omitted.
 * @param {object} options Parsed projectOptions() result.
 * @returns {Record<string, string | boolean | string[]>} Reproducible generation parameters.
 */
export function normalizeParams(options) {
  const values = {
    ai: options.ai ?? ['text', 'image', 'video'],
    billing: options.billing ?? ['stripe', 'paypal'],
    'billing-enabled': options.billingEnabled ?? true,
    'credits-enabled': options.creditsEnabled ?? true,
    domain: options.url,
    features: options.features ?? ['blog'],
    i18n: options.i18n ?? true,
    'image-namespace': options.imageNamespace ?? `ghcr.io/configure-owner/${options.name}`,
    locale: options.locale ?? 'en',
    marketing: options.marketing ?? true,
    'media-providers': options.mediaProviders ?? ['fal', 'workers-ai'],
    'multi-tenant': options.multiTenant ?? false,
    name: options.name,
    oauth: options.oauth ?? ['google', 'github'],
    'support-email': options.supportEmail ?? `support@${new URL(options.url).hostname}`,
    target: options.target ?? 'cloudflare',
    theme: options.theme ?? 'neutral',
    turnstile: options.turnstile ?? true,
  }
  return {
    ...Object.fromEntries(
      [...paramKeys, 'theme']
        .sort()
        .map((key) => [key, Array.isArray(values[key]) ? [...new Set(values[key])] : values[key]]),
    ),
    ...optionalParams(options),
  }
}

/**
 * 后加的参数只在偏离默认值时记录：旧项目的基准不含这些键，同步时也不能把它们传给
 * 基准提交上不认识它们的旧生成器。
 */
function optionalParams(options) {
  return Object.fromEntries(
    [
      ['analytics', options.analytics, 'plausible'],
      ['plausible-domain', options.plausibleDomain, options.name],
      ['plausible-host', options.plausibleHost, ''],
    ]
      .filter(([, value, fallback]) => value !== undefined && value !== fallback)
      .map(([key, value]) => [key, value]),
  )
}

/**
 * Restore non-interactive generator arguments, without execution controls or paths.
 * @param {Record<string, string | boolean | string[]>} params Complete normalized parameters.
 * @returns {string[]} Alternating CLI flags and values.
 */
export function paramsToArgs(params) {
  validateParams(params)
  return [...paramKeys, ...optionalParamKeys.filter((key) => Object.hasOwn(params, key))].flatMap(
    (key) => [`--${key}`, Array.isArray(params[key]) ? params[key].join(',') : String(params[key])],
  )
}

function exactKeys(value, keys, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(`Invalid ${label}: expected fields ${keys.join(', ')}`)
  }
}

function validateParams(params) {
  const {
    analytics,
    'plausible-domain': domain_,
    'plausible-host': host,
    theme,
    ...required
  } = params
  exactKeys(required, paramKeys, 'params')
  if (analytics !== undefined && analytics !== 'plausible' && analytics !== 'off')
    throw new Error('Invalid params.analytics')
  if (domain_ !== undefined && typeof domain_ !== 'string')
    throw new Error('Invalid params.plausible-domain')
  if (host !== undefined && typeof host !== 'string')
    throw new Error('Invalid params.plausible-host')
  if (theme !== undefined && !themeNames.includes(theme)) throw new Error('Invalid params.theme')
  for (const [key, allowed] of Object.entries(lists)) {
    if (
      !Array.isArray(params[key]) ||
      params[key].some((item) => !allowed.includes(item)) ||
      new Set(params[key]).size !== params[key].length
    ) {
      throw new Error(`Invalid params.${key}`)
    }
  }
  for (const key of switches) {
    if (typeof params[key] !== 'boolean') throw new Error(`Invalid params.${key}`)
  }
  if (
    typeof params.name !== 'string' ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(params.name) ||
    params.name.length > 40
  ) {
    throw new Error('Invalid params.name')
  }
  let domain
  try {
    domain = new URL(params.domain)
  } catch {
    throw new Error('Invalid params.domain')
  }
  if (
    domain.protocol !== 'https:' ||
    domain.username ||
    domain.password ||
    domain.port ||
    !domain.hostname.includes('.') ||
    domain.origin !== params.domain
  )
    throw new Error('Invalid params.domain')
  if (
    typeof params['support-email'] !== 'string' ||
    !/^[\w.+-]+@[a-z0-9.-]+\.[a-z]+$/i.test(params['support-email'])
  ) {
    throw new Error('Invalid params.support-email')
  }
  if (
    typeof params['image-namespace'] !== 'string' ||
    !/^ghcr\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*\/[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(
      params['image-namespace'],
    )
  ) {
    throw new Error('Invalid params.image-namespace')
  }
  if (!['en', 'zh'].includes(params.locale)) throw new Error('Invalid params.locale')
  if (!['cloudflare', 'selfhost'].includes(params.target)) throw new Error('Invalid params.target')
  if (
    (params['billing-enabled'] && !params['credits-enabled']) ||
    (!params['billing-enabled'] && params.ai.length)
  ) {
    throw new Error('Invalid params: billing and credits must support enabled AI')
  }
}

/**
 * Validate schema version 1 and return a fresh object in canonical field order.
 * Invalid, incomplete, or credential-bearing records throw an Error.
 * @param {unknown} record Parsed baseline JSON.
 * @returns {object} Validated baseline with sorted parameters.
 */
export function validateBaseRecord(record) {
  exactKeys(record, recordKeys, 'template baseline')
  if (record.schemaVersion !== 1) throw new Error('Unsupported template baseline schemaVersion')
  if (
    record.repository !== null &&
    (typeof record.repository !== 'string' ||
      normalizeRepository(record.repository) !== record.repository)
  ) {
    throw new Error(
      'Invalid template baseline repository: expected credential-free canonical HTTPS URL',
    )
  }
  if (
    record.commit !== null &&
    (typeof record.commit !== 'string' || !/^[a-f0-9]{40}$/i.test(record.commit))
  ) {
    throw new Error('Invalid template baseline commit')
  }
  if (
    record.version !== null &&
    (typeof record.version !== 'string' || !semverPattern.test(record.version))
  ) {
    throw new Error('Invalid template baseline version')
  }
  if (typeof record.clean !== 'boolean') throw new Error('Invalid template baseline clean')
  if (record.commit === null && (record.clean || record.version !== null)) {
    throw new Error('Invalid template baseline: clean/version require a commit')
  }
  validateParams(record.params)
  if (
    !Array.isArray(record.migrations) ||
    record.migrations.some((tag) => typeof tag !== 'string')
  ) {
    throw new Error('Invalid template baseline migrations')
  }
  return {
    schemaVersion: 1,
    repository: record.repository,
    commit: record.commit,
    version: record.version,
    clean: record.clean,
    params: Object.fromEntries(
      [...paramKeys, ...optionalParamKeys.filter((key) => Object.hasOwn(record.params, key))]
        .sort()
        .map((key) => [
          key,
          Array.isArray(record.params[key]) ? [...record.params[key]] : record.params[key],
        ]),
    ),
    migrations: [...record.migrations],
  }
}

/**
 * Read and validate a project's root .template-base.json; I/O and schema errors throw.
 * @param {string} directory Project directory.
 * @returns {Promise<object>} Validated baseline record.
 */
export async function readBaseRecord(directory) {
  return validateBaseRecord(
    JSON.parse(await readFile(join(directory, '.template-base.json'), 'utf8')),
  )
}

/**
 * Serialize a valid baseline deterministically: two spaces, fixed fields, final newline.
 * @param {object} record Baseline record.
 * @returns {string} Canonical JSON document.
 */
export function serializeBaseRecord(record) {
  return `${JSON.stringify(validateBaseRecord(record), null, 2)}\n`
}

function normalizeRepository(origin) {
  let candidate = origin
  const ssh = origin.match(/^(?:[^/@:]+@)?([^/:]+):(.+)$/)
  if (!origin.includes('://') && ssh) candidate = `https://${ssh[1]}/${ssh[2]}`
  try {
    const url = new URL(candidate)
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) || !url.hostname) return null
    const path = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '')
    if (!path || path === '/') return null
    return `https://${url.hostname}${url.port ? `:${url.port}` : ''}${path}`
  } catch {
    return null
  }
}

function compareVersions(left, right) {
  const a = left.match(semverPattern)
  const b = right.match(semverPattern)
  for (let index = 1; index <= 3; index++) {
    if (BigInt(a[index]) !== BigInt(b[index])) return BigInt(a[index]) > BigInt(b[index]) ? 1 : -1
  }
  if (!a[4] || !b[4]) return a[4] ? -1 : b[4] ? 1 : left > right ? 1 : left < right ? -1 : 0
  const preA = a[4].split('.')
  const preB = b[4].split('.')
  for (let index = 0; index < Math.max(preA.length, preB.length); index++) {
    if (preA[index] === undefined) return -1
    if (preB[index] === undefined) return 1
    if (preA[index] === preB[index]) continue
    const numericA = /^\d+$/.test(preA[index])
    const numericB = /^\d+$/.test(preB[index])
    if (numericA && numericB) return BigInt(preA[index]) > BigInt(preB[index]) ? 1 : -1
    if (numericA !== numericB) return numericA ? -1 : 1
    return preA[index] > preB[index] ? 1 : -1
  }
  return left > right ? 1 : left < right ? -1 : 0
}

/**
 * Inspect only a Git root (including worktrees), without walking into a parent repo.
 * Origins are sanitized to HTTPS; only template-v<SemVer> tags exactly at HEAD count.
 * @param {string} directory Template source root.
 * @returns {{repository: string | null, commit: string | null, version: string | null, clean: boolean}}
 */
export function sourceState(directory) {
  const empty = { repository: null, commit: null, version: null, clean: false }
  // 调用者的仓库、索引和配置覆盖不能改变来源判定。
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  )
  env.GIT_OPTIONAL_LOCKS = '0'
  const git = (...args) => {
    const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8', env })
    return result.status === 0 ? result.stdout.trim() : null
  }
  const top = git('rev-parse', '--show-toplevel')
  if (!top || realpathSync(top) !== realpathSync(directory)) return empty
  const commit = git('rev-parse', '--verify', 'HEAD')
  if (!commit || !/^[a-f0-9]{40}$/i.test(commit)) return empty
  const origin = git('remote', 'get-url', 'origin')
  const versions = (git('tag', '--points-at', 'HEAD', '--list', 'template-v*') ?? '')
    .split('\n')
    .map((tag) => tag.slice('template-v'.length))
    .filter((version) => semverPattern.test(version))
    .sort(compareVersions)
  return {
    repository: origin ? normalizeRepository(origin) : null,
    commit,
    version: versions.at(-1) ?? null,
    clean: git('status', '--porcelain', '--untracked-files=all') === '',
  }
}
