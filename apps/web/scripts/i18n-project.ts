// Paraglide 的 inlang 项目、编译选项与文案缺失检查（openspec add-marketing-i18n-seo tasks.md 1.1、1.3）。
//
// 文案按功能拆分为 messages/<locale>/<feature>.json（docs/09-parallel-plan.md §3 第 5 条）。
// project.inlang/settings.json 由这里按模板配置的 i18n 与现有文案文件生成（已 gitignore），
// 语言列表只在 template.config.ts 中维护。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type CompilerOptions, compile, paraglideVitePlugin } from '@inlang/paraglide-js'
import { EMAIL_LOCALES } from '@product-res/email/queue'
import type { Plugin } from 'vite'

export interface I18nConfig {
  readonly enabled?: boolean
  readonly locales: readonly string[]
  readonly defaultLocale: string
}

export interface MissingMessage {
  readonly locale: string
  readonly feature: string
  readonly key: string
}

const WEB_ROOT = new URL('..', import.meta.url).pathname
// settings.json 中的相对路径以 project.inlang 的上级目录为基准；文案格式插件从本地加载，构建不依赖 CDN
const MESSAGE_FORMAT_PLUGIN = './node_modules/@inlang/plugin-message-format/dist/index.js'

/** messages/ 下所有语言目录中出现过的功能文件名（不含 .json） */
export function listFeatures(root = WEB_ROOT): string[] {
  const messagesDir = join(root, 'messages')
  if (!existsSync(messagesDir)) return []
  const features = new Set<string>()
  for (const locale of readdirSync(messagesDir, { withFileTypes: true })) {
    if (!locale.isDirectory()) continue
    for (const file of readdirSync(join(messagesDir, locale.name))) {
      if (file.endsWith('.json')) features.add(file.slice(0, -'.json'.length))
    }
  }
  return [...features].sort()
}

/** 单语言仍复用 Paraglide 文案调用，只编译所选默认语言。 */
export function activeLocales(i18n: I18nConfig): readonly string[] {
  return i18n.enabled === false ? [i18n.defaultLocale] : i18n.locales
}

/** 写入 `<root>/project.inlang/settings.json`；内容未变化时不写，避免触发 Paraglide 重新编译 */
export function writeInlangProject(i18n: I18nConfig, root = WEB_ROOT): void {
  const { defaultLocale } = i18n
  const locales = activeLocales(i18n)
  const settings = {
    $schema: 'https://inlang.com/schema/project-settings',
    baseLocale: defaultLocale,
    locales: [...locales],
    modules: [MESSAGE_FORMAT_PLUGIN],
    'plugin.inlang.messageFormat': {
      pathPattern: listFeatures(root).map((feature) => `./messages/{locale}/${feature}.json`),
    },
  }
  const projectDir = join(root, 'project.inlang')
  const path = join(projectDir, 'settings.json')
  const content = `${JSON.stringify(settings, null, 2)}\n`
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(path, content)
}

/**
 * Paraglide 编译选项（design.md 决策 3）：公开页面按 URL 前缀确定语言（默认语言无前缀），
 * 其他配置语言 `/<locale>/...`；应用区不进入 URL，按 Cookie 取语言、没有时用默认语言。
 * 两者都不含 preferredLanguage，首次访问不会按浏览器语言自动跳转。
 */
export function paraglideOptions(
  appAreaPrefixes: readonly string[],
  root = WEB_ROOT,
  enabled = true,
): CompilerOptions {
  return {
    project: join(root, 'project.inlang'),
    outdir: join(root, 'src/paraglide'),
    // tsconfig 未开启 allowJs，生成 .d.ts 供类型检查
    emitTsDeclarations: true,
    strategy: enabled ? ['url', 'baseLocale'] : ['baseLocale'],
    // 与路由器一致：去掉末尾的 `/`（否则 `/zh` 会被本地化为 `/zh/`，再被路由器 307 回来）
    trailingSlash: 'never',
    routeStrategies: (enabled ? [...appAreaPrefixes, '/_serverFn'] : []).map((prefix) => ({
      match: `${prefix}/:path(.*)?`,
      strategy: ['cookie', 'baseLocale'],
    })),
  }
}

function readKeys(path: string): Set<string> {
  if (!existsSync(path)) return new Set()
  const messages = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  return new Set(Object.keys(messages).filter((key) => key !== '$schema'))
}

/**
 * 以默认语言为准，列出其他语言缺失的文案。
 * 缺失的文案在运行时由 Paraglide 回退到默认语言（不会显示键名），这里只负责报告。
 */
export function findMissingMessages(
  { locales, defaultLocale }: I18nConfig,
  root = WEB_ROOT,
): MissingMessage[] {
  const messagesDir = join(root, 'messages')
  const missing: MissingMessage[] = []
  for (const feature of listFeatures(root)) {
    const base = readKeys(join(messagesDir, defaultLocale, `${feature}.json`))
    for (const locale of locales) {
      if (locale === defaultLocale) continue
      const keys = readKeys(join(messagesDir, locale, `${feature}.json`))
      for (const key of base) if (!keys.has(key)) missing.push({ locale, feature, key })
    }
  }
  return missing
}

/** 缺失项的日志文本；没有缺失时返回 null */
export function formatMissingMessages(missing: readonly MissingMessage[]): string | null {
  if (missing.length === 0) return null
  return [
    `[i18n] ${missing.length} 条文案缺少翻译，运行时回退到默认语言：`,
    ...missing.map(
      ({ locale, feature, key }) => `  - ${locale}: ${key} (messages/${locale}/${feature}.json)`,
    ),
  ].join('\n')
}

/**
 * Vite 插件：生成 inlang 项目后交给 Paraglide 编译；构建开始时在日志中列出缺失的文案。
 * `api.compile()` 供不经过 vite dev / build 的场景（typecheck 前生成 src/paraglide）使用。
 */
export function i18nMessages({
  i18n,
  appAreaPrefixes,
}: {
  readonly i18n: I18nConfig
  readonly appAreaPrefixes: readonly string[]
}): Plugin[] {
  const unsupported = activeLocales(i18n).filter(
    (locale) => !(EMAIL_LOCALES as readonly string[]).includes(locale),
  )
  if (unsupported.length) throw new Error(`[i18n] 邮件模板缺少语言：${unsupported.join(', ')}`)
  writeInlangProject(i18n)
  const options = paraglideOptions(appAreaPrefixes, WEB_ROOT, i18n.enabled)
  let reported = false
  return [
    paraglideVitePlugin(options) as Plugin,
    {
      name: 'saas:i18n-messages',
      api: { compile: () => compile(options) },
      buildStart() {
        // client 与 ssr 两个环境各触发一次 buildStart，只报告一次
        if (reported) return
        reported = true
        const report = formatMissingMessages(
          findMissingMessages({ ...i18n, locales: activeLocales(i18n) }),
        )
        if (report) this.warn(report)
      },
    },
  ]
}
