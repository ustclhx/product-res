#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { constants, existsSync } from 'node:fs'
import {
  access,
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { normalizeParams, serializeBaseRecord, sourceState, themeNames } from './template-base.mjs'
import { projectOwnedPaths } from './template-sync/merge.mjs'

const root = resolve(import.meta.dirname, '..')
const featureNames = ['publicApi', 'blog', 'docs', 'waitlist', 'newsletter', 'guides']
const aiNames = ['text', 'image', 'video']
const mediaProviderNames = ['fal', 'workers-ai']
const excluded = new Set([
  '.git',
  'node_modules',
  '.wrangler',
  'dist',
  '.turbo',
  'coverage',
  '.output',
  '.content-collections',
  'project.inlang',
  'paraglide',
  'playwright-report',
  'test-results',
  'image-artifacts',
  'image-set',
  'release-bundle',
  'feature-artifacts',
  '__pycache__',
  '.DS_Store',
  '.omp',
  '.codex',
  'secrets',
  'certs',
  '.data',
  'job-owners',
])

// 模板自身的开发、运营和验收材料不属于新项目交付内容。
const templateOnly = new Set([
  'docs/08-roadmap.md',
  'docs/requirements/analytics-plausible-geo.md',
  'docs/09-parallel-plan.md',
  'docs/runbooks/hyperdrive-tunnel.md',
  'docs/runbooks/p2-acceptance-paypal.md',
  'docs/runbooks/p2-acceptance-stripe.md',
  'docs/runbooks/p2-offline-acceptance.md',
  'docs/runbooks/staging-acceptance.md',
  'docs/runbooks/selfhost-a-final.md',
  'docs/runbooks/selfhost-a4-billing.md',
  'docs/runbooks/selfhost-a4-storage.md',
  'docs/runbooks/selfhost-a46.md',
  'docs/runbooks/selfhost-a5.md',
  'docs/runbooks/selfhost-a7.md',
  'docs/runbooks/selfhost-c-jobs-wire.md',
  'docs/runbooks/selfhost-c-profile.md',
  'docs/runbooks/selfhost-c-profile-resources.json',
  'docs/runbooks/selfhost-c-storage.md',
  'docs/runbooks/selfhost-c-wire.md',
  'docs/runbooks/selfhost-delivery-handoff.md',
  'orca.yaml',
  '.worktreeinclude',
  '.github/workflows/selfhost-features.yml',
  '.github/workflows/selfhost-release-acceptance.yml',
  'scripts/selfhost-features.mjs',
  'scripts/selfhost-features-routes.mjs',
  'scripts/create-project.test.mjs',
  'scripts/create-project.verify.test.mjs',
  'scripts/template-base.test.mjs',
  'scripts/template-sync.test.mjs',
  'scripts/template-sync/infer.test.mjs',
  'scripts/template-sync/migrations.test.mjs',
  'scripts/template-release.mjs',
  'scripts/template-release.test.mjs',
  '.github/workflows/template-release.yml',
  '.github/workflows/template-release-checks.yml',
])
const templateOnlyDirectories = [
  ['docs', 'runbooks', 'evidence'].join('/'),
  'openspec/changes',
  'docs/design-system/prototypes',
  'scripts/orca',
  'scripts/probes',
]
// 业务单测和类型检查直接依赖的本地夹具，保留其传递依赖；远程验收入口不交付。
const acceptanceFixtures = new Set([
  'accounts.ts',
  'diagnostic.ts',
  'fault-definitions.ts',
  'fault-local-media.ts',
  'local-admin.ts',
  'local-media.ts',
  'local-text-model.ts',
  'models.ts',
  'reporter.ts',
  'support.ts',
])

function projectText(text, path) {
  if (path === '.gitignore') return text.replaceAll(`/${templateOnlyDirectories[0]}/\n`, '')
  if (path === '.github/workflows/ci.yml')
    return text.replace(/^ *- run: pnpm test:create-project\r?\n/gm, '')
  if (!path.endsWith('.md')) return text
  if (path === 'docs/create-project.md')
    text = text.replace(
      /(git clone --branch \S+ )https:\/\/github\.com\/\S+/g,
      `$1"$(node -p "require('./.template-base.json').repository")"`,
    )
  text = text.replace(/^\| `pnpm test:create-project(?::verify)?`.*\n/gm, '')
  text = text.replace(/<!-- template-only:start -->[\s\S]*?<!-- template-only:end -->\n?/g, '')
  // 保留通用操作说明；模板证据只在主仓库可追溯。
  text = text.replace(/私有证据库 `[^`]*`/g, '项目自身的私有验收记录')
  text = text.replace(/\[([^\]\n]*)\]\(([^)\n]+)\)/g, (match, label, href) => {
    if (/^(?:[a-z]+:|#|\/)/i.test(href)) return match
    const target = posix.normalize(posix.join(posix.dirname(path), href.split('#')[0]))
    return omit(target) ? `${label}（模板维护资料；请为本项目建立相应记录）` : match
  })
  text = text.replace(
    /；并行(?:开发|修改导航或文案时)读 `docs\/09-parallel-plan\.md` §3\/§6。/g,
    '；并行开发先明确文件所有权与数据库隔离。',
  )
  if (path.endsWith('/SKILL.md')) {
    text = text
      .replace(
        /需完整矩阵时才运行[^。]*，\n其真实副本、CI 环境与清理模式见[^。]*。/g,
        '新增组合通过临时副本的安装、类型检查和单元测试核验。',
      )
      .replace(
        /修改生成器时执行[^\n]*/g,
        '修改生成器时，通过临时副本执行依赖安装、类型检查、单元测试与目标构建。',
      )
  }
  for (const entry of templateOnly) text = text.replaceAll(entry, '项目维护约定')
  text = text.replace(
    /\[([^\]]+)\]\(https:\/\/github\.com\/[^/]+\/[^/]+\/(?:pull|actions\/runs)\/\d+\)/g,
    '$1（模板实现参考）',
  )
  text = text.replace(/`(?:\.\.\/)?scripts\/(?:probes|orca)\/[^`]*`/g, '项目自身的隔离验证')
  return text
}

function omit(path) {
  const parts = path.split('/')
  const name = parts.at(-1)
  return (
    parts.some((part) => excluded.has(part)) ||
    path === '.template-base.json' ||
    templateOnly.has(path) ||
    templateOnlyDirectories.some(
      (directory) => path === directory || path.startsWith(`${directory}/`),
    ) ||
    (path.startsWith('apps/web/e2e/staging-acceptance/') && !acceptanceFixtures.has(name)) ||
    ((name === '.env' ||
      name.startsWith('.env.') ||
      name === '.dev.vars' ||
      name.startsWith('.dev.vars.')) &&
      !name.endsWith('.example')) ||
    name === 'routeTree.gen.ts' ||
    (path.startsWith('deploy/selfhost/') &&
      parts.some((part) =>
        [
          'secrets',
          'certs',
          'ownership',
          '.ownership',
          'owners',
          'backups',
          'backup-data',
          'releases',
          'release-state',
          'state',
          '.state',
        ].includes(part),
      )) ||
    /^(?:id_rsa|id_ed25519|id_ecdsa|id_dsa)(?:\.pub)?$/.test(name) ||
    /^selfhost-release-.*\.tar\.gz$/.test(name) ||
    /\.(?:tsbuildinfo|pyc|log|pem|key|crt|p12|pfx|p8)$/.test(name)
  )
}

function list(value, allowed, label) {
  const items = value === '' ? [] : value.split(',')
  if (items.some((item) => !allowed.includes(item)) || new Set(items).size !== items.length) {
    throw new Error(`${label} 只接受：${allowed.join(',')}`)
  }
  return items
}

function boolean(value, label) {
  if (value !== 'true' && value !== 'false') throw new Error(`${label} 只接受 true 或 false`)
  return value === 'true'
}

function appValues(source) {
  const app = source.match(/app:\s*\{([^}]+)\}/)?.[1]
  if (!app) throw new Error('template.config.ts 缺少 app 配置')
  return Object.fromEntries(
    ['name', 'url', 'supportEmail'].map((key) => {
      const value = app.match(new RegExp(`${key}['"]?:\\s*['"]([^'"]+)['"]`))?.[1]
      if (!value) throw new Error(`template.config.ts 缺少 app.${key}`)
      return [key, value]
    }),
  )
}

export function projectOptions(input) {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(input.name ?? '') || input.name.length > 40) {
    throw new Error('名称必须为小写字母开头的 kebab-case，最多 40 字符')
  }
  const url = new URL(input.domain.includes('://') ? input.domain : `https://${input.domain}`)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !url.hostname.includes('.')
  ) {
    throw new Error('域名必须为 HTTPS 主机名，不含端口、路径或凭据')
  }
  if (!['en', 'zh'].includes(input.locale ?? 'en')) throw new Error('语言只接受 en 或 zh')
  const theme = input.theme ?? 'neutral'
  if (!themeNames.includes(theme)) throw new Error(`--theme 只接受：${themeNames.join(', ')}`)
  const supportEmail = input['support-email'] ?? `support@${url.hostname}`
  if (!/^[\w.+-]+@[a-z0-9.-]+\.[a-z]+$/i.test(supportEmail)) throw new Error('支持邮箱格式无效')
  const target = input.target ?? 'cloudflare'
  if (!['cloudflare', 'selfhost'].includes(target)) {
    throw new Error(
      '--target 只接受 cloudflare 或 selfhost；旧输出路径参数已迁移，请使用 --output <path>',
    )
  }
  const imageNamespace = input['image-namespace'] ?? `ghcr.io/configure-owner/${input.name}`
  if (
    !/^ghcr\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*\/[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(imageNamespace)
  ) {
    throw new Error(
      '--image-namespace 必须匹配当前发布 CI：ghcr.io/<owner>/<project>（小写，不含标签或凭据）',
    )
  }
  const billingEnabled = boolean(input['billing-enabled'] ?? 'true', 'billing-enabled')
  const creditsEnabled = boolean(input['credits-enabled'] ?? 'true', 'credits-enabled')
  const ai = list(input.ai ?? 'text,image,video', aiNames, 'ai')
  const analytics = input.analytics ?? 'plausible'
  if (analytics !== 'plausible' && analytics !== 'off')
    throw new Error('--analytics 只接受 plausible（新词站默认）或 off（长期词站可选关闭）')
  const plausibleHost = input['plausible-host'] ?? ''
  if (
    plausibleHost &&
    (!URL.canParse(plausibleHost) || new URL(plausibleHost).protocol !== 'https:')
  )
    throw new Error('--plausible-host 必须是自建 Plausible 实例的 HTTPS 地址')
  const plausibleDomain = input['plausible-domain'] ?? input.name
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(plausibleDomain))
    throw new Error('--plausible-domain 只接受小写字母、数字、点与连字符')
  if (billingEnabled && !creditsEnabled) throw new Error('启用 billing 必须启用 credits')
  if (!billingEnabled && ai.length)
    throw new Error('关闭 billing 时需使用 --ai "" 关闭 AI（当前额度依赖套餐）')
  return {
    name: input.name,
    url: url.origin,
    supportEmail,
    locale: input.locale ?? 'en',
    theme,
    ai,
    mediaProviders: list(
      input['media-providers'] ?? 'fal,workers-ai',
      mediaProviderNames,
      'media-providers',
    ),
    features: list(input.features ?? 'blog', featureNames, 'features'),
    billing: list(input.billing ?? 'stripe,paypal', ['stripe', 'paypal'], 'billing'),
    oauth: list(input.oauth ?? 'google,github', ['google', 'github'], 'oauth'),
    turnstile: boolean(input.turnstile ?? 'true', 'turnstile'),
    multiTenant: boolean(input['multi-tenant'] ?? 'false', 'multi-tenant'),
    billingEnabled,
    creditsEnabled,
    marketing: boolean(input.marketing ?? 'true', 'marketing'),
    i18n: boolean(input.i18n ?? 'true', 'i18n'),
    analytics,
    plausibleDomain,
    plausibleHost: plausibleHost ? new URL(plausibleHost).origin : '',
    target,
    imageNamespace,
    output: resolve(input.output ?? join('..', input.name)),
  }
}

function templateConfig(source, options) {
  let result = source.replace(
    /app:\s*\{[^}]+\}/,
    `app: ${JSON.stringify({
      name: options.name,
      url: options.url,
      supportEmail: options.supportEmail,
    })}`,
  )
  result = result
    .replace(/defaultLocale:\s*['"][^'"]+['"]/, `defaultLocale: '${options.locale}'`)
    .replace(/multiTenant:\s*(?:true|false)/, `multiTenant: ${options.multiTenant}`)
    .replace(/oauth:\s*\[[^\]]*\]/, `oauth: ${JSON.stringify(options.oauth)}`)
    .replace(/turnstile:\s*(?:true|false)/, `turnstile: ${options.turnstile}`)
    .replace(
      /mediaProviders:\s*\[[^\]]*\]/,
      `mediaProviders: ${JSON.stringify(options.mediaProviders)}`,
    )
    .replace(/providers:\s*\[[^\]]*\]/, `providers: ${JSON.stringify(options.billing)}`)
  if (/ui:\s*\{/.test(result)) {
    result = result.replace(/(ui:\s*\{)([^}]*)(\})/, (_match, start, fields, end) => {
      const preset = `preset: '${options.theme}'`
      const configured = /preset:\s*['"][^'"]+['"]/.test(fields)
        ? fields.replace(/preset:\s*['"][^'"]+['"]/, preset)
        : fields.trim()
          ? ` ${preset},${fields}`
          : ` ${preset} `
      return `${start}${configured}${end}`
    })
  } else {
    result = result.replace(
      /(defineTemplateConfig\(\{)/,
      `$1\n  ui: { preset: '${options.theme}' },`,
    )
  }
  for (const [section, enabled] of [
    ['billing', options.billingEnabled],
    ['credits', options.creditsEnabled],
    ['marketing', options.marketing],
    ['i18n', options.i18n],
  ]) {
    const pattern = new RegExp(`(${section}:\\s*\\{)(\\s*enabled:\\s*(?:true|false),?)?`)
    if (pattern.test(result)) result = result.replace(pattern, `$1 enabled: ${enabled},`)
    else
      result = result.replace(
        /(defineTemplateConfig\(\{)/,
        `$1\n  ${section}: { enabled: ${enabled} },`,
      )
  }
  result = result.replace(
    /(text:\s*\{\s*enabled:)\s*(?:true|false)/,
    `$1 ${options.ai.includes('text')}`,
  )
  for (const name of ['image', 'video']) {
    result = result.replace(
      new RegExp(`${name}:\\s*(?:true|false)`),
      `${name}: ${options.ai.includes(name)}`,
    )
  }
  const site = options.analytics === 'plausible'
  result = result.replace(
    /features:\s*\{[^}]*\}/,
    `features: ${JSON.stringify({
      analytics: site ? 'plausible' : false,
      ...Object.fromEntries(featureNames.map((name) => [name, options.features.includes(name)])),
    })}`,
  )
  const analytics = `analytics: ${JSON.stringify({
    // selfhost 预渲染读这里；Cloudflare 以各环境 wrangler vars 为准。
    plausibleDomain: site && options.target === 'selfhost' ? options.plausibleDomain : '',
    plausibleHost: site && options.target === 'selfhost' ? options.plausibleHost : '',
    // 多站映射属于衍生项目自己的域名，生成器不继承也不提供参数，需要时手工配置。
    plausibleSites: '',
  })}`
  // 衍生项目也可作为生成源；已有分析配置需替换，不能重复插入顶层属性。
  return /analytics:\s*\{/.test(result)
    ? result.replace(/analytics:\s*\{[^}]*\}/, analytics)
    : result.replace(/(features:\s*\{[^}]*\})/, `$1,\n  ${analytics}`)
}

function stagingUrl(options) {
  return `https://staging.${new URL(options.url).hostname}`
}

// 仅在配置语义位置改 Worker / Queue 名；资源 ID 清空，避免新项目复用模板的 staging / production。
function wranglerConfig(source, options, app) {
  const media = options.ai.includes('image') || options.ai.includes('video')
  let resourceIndex = 0
  let result = source
    .replace(
      /("(?:name|script_name|queue|dead_letter_queue|bucket_name)"\s*:\s*")([^"\n]+)"/g,
      (_match, prefix, value) =>
        /^(?:web|jobs|email|events(?:-dlq)?|ai-media|files)(?:-staging|-production)?$/.test(value)
          ? `${prefix}${options.name}-${value}"`
          : `${prefix}${value}"`,
    )
    // 各环境的占位 ID 也要互异，满足 staging / production 隔离检查。
    .replace(/("id"\s*:\s*")[a-f0-9]{32}"/g, (_match, prefix) => {
      const id = (resourceIndex++).toString(16).padStart(32, '0')
      return `${prefix}${id}"`
    })
    .replace(/("APP_URL"\s*:\s*")https:[^"]+"/g, `$1${options.url}"`)
    // staging 绝不能沿用生产域名：sitemap / canonical / 埋点都由它决定，部署前改成实际 staging 地址。
    .replace(/("staging"\s*:\s*\{[\s\S]*?"APP_URL"\s*:\s*")[^"]+"/, `$1${stagingUrl(options)}"`)
    // 一站一 site：生产用项目名，staging 用 -staging 后缀；未启用时留空即不注入。
    .replace(
      /("(staging|production)"\s*:\s*\{[\s\S]*?"PLAUSIBLE_DOMAIN"\s*:\s*")[^"]*("\s*,\s*"PLAUSIBLE_HOST"\s*:\s*")[^"]*"/g,
      (_match, before, environment, between) =>
        options.analytics === 'plausible'
          ? `${before}${options.plausibleDomain}${environment === 'staging' ? '-staging' : ''}${between}${options.plausibleHost}"`
          : `${before}${between}"`,
    )
    // 多站映射指向具体域名，新项目一律清空（--analytics off 时也随之移除）。
    .replace(/("PLAUSIBLE_SITES"\s*:\s*")[^"]*"/g, '$1"')
    // 模板生产自定义域名与真实 Turnstile 站点 key 不能被新项目复用；部署前按新项目配置（测试 key 1x… 保留）
    .replace(/("TURNSTILE_SITE_KEY"\s*:\s*")0x[^"]*"/g, '$1"')
    .replace(/("pattern"\s*:\s*")[^"]+"/g, '$1configure-production-domain.invalid"')
  result = result
    .replace(/("(?:AI_GATEWAY_ACCOUNT_ID|AI_GATEWAY_ID|R2_ACCOUNT_ID)"\s*:\s*")[^"]*"/g, '$1"')
    .replace(
      /("R2_FILES_BUCKET"\s*:\s*")(files(?:-staging|-production)?)"/g,
      `$1${options.name}-$2"`,
    )
  if (!media || !options.mediaProviders.includes('workers-ai')) {
    result = result.replace(/"ai"\s*:\s*\{[^}]*\},?/g, '')
  }
  if (!media) result = result.replace(/"workflows"\s*:\s*\[[\s\S]*?\],?/g, '')
  if (app === 'web' && !options.turnstile) {
    result = result.replace(/,?\s*"TURNSTILE_SITE_KEY"\s*:\s*"[^"]*"/g, '')
  }
  return result
}

function selfhostChecklist(options) {
  const resources = [
    `OCI namespace：${options.imageNamespace}；替换 configure-owner 为自己的 registry owner，发布项目自身镜像`,
    'Linux / Docker Engine / Compose v2；只拉取同一个完整 SHA 的镜像与 release bundle，不在服务器构建',
    'Postgres 17 TLS 与 app / migrator / readonly；Valkey；专用 ingress，默认 Caddy 或现有代理',
    '受限 secrets/ 与 certs/；非 root 服务 UID 可读，数据服务不开放宿主端口',
    '邮件：默认 EMAIL_TRANSPORT=log；生产按 Node 邮件适配器配置 SMTP 或 Resend',
    '外部应用 S3/R2：需要文件存储或清理能力时叠加 compose.s3.yaml，核对 release bundle 已装配 S3 env / _FILE 与受限应用身份；缺失则停在配置缺口',
    '备份：主 S3 与独立凭据恢复副本目标（允许不同供应商/账号）；同一 R2 账号方案使用独立桶与桶级独立 token，记录失去供应商独立性及账号级共同故障风险；核验副本 token 无主桶权限、WAL/base/dump、保留策略与新空卷恢复演练',
    '副本健康：BACKUP_REPLICA_MAX_AGE_SECONDS 必须大于 BACKUP_REPLICA_INTERVAL_SECONDS，至少为间隔 3 倍，并覆盖完整同步、verify/锁等待与余量；默认 300/3600 秒，检查主机显式旧值，健康预算不等于 RPO',
    'ownership 持久卷、唯一 executor ID、容器重建与宿主重启退出证据；未签收前禁止声明恢复验收成功',
    '发布后有界检查 /api/health 与 jobs 的完整 SHA 和成功 heartbeat；回滚须确认 schema/持久任务兼容',
  ]
  if (options.billingEnabled)
    resources.push('数据库：迁移后运行 pnpm billing:seed；AI 模型与套餐授权在后台配置')
  const secrets = [
    'BETTER_AUTH_SECRET',
    'BOOTSTRAP_ADMIN_EMAILS',
    'DATABASE_URL',
    'MIGRATION_DATABASE_URL',
    'VALKEY_URL',
  ]
  const vars = [
    'APP_URL',
    'APP_VERSION',
    'EMAIL_TRANSPORT',
    'EMAIL_FROM',
    'EMAIL_REPLY_TO',
    'SENTRY_ENVIRONMENT',
  ]
  if (options.analytics === 'plausible') {
    resources.push(...plausibleChecklist(options))
    vars.push('PLAUSIBLE_DOMAIN', 'PLAUSIBLE_HOST')
  }
  if (options.marketing) resources.push(...searchChecklist(options))
  for (const provider of options.oauth) {
    resources.push(`${provider} OAuth 应用：登记新域名的回调 URL`)
    vars.push(`${provider.toUpperCase()}_CLIENT_ID`)
    secrets.push(`${provider.toUpperCase()}_CLIENT_SECRET`)
  }
  if (options.turnstile) {
    resources.push('Turnstile 站点')
    vars.push('TURNSTILE_SITE_KEY')
    secrets.push('TURNSTILE_SECRET_KEY')
  }
  for (const provider of options.billingEnabled ? options.billing : []) {
    resources.push(`${provider} 账号与 Webhook（先测试 / 沙箱）`)
    secrets.push(
      ...(provider === 'stripe'
        ? ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']
        : ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID']),
    )
  }
  if (options.billingEnabled) vars.push('PAYMENT_MODE')
  if (options.ai.includes('text')) {
    resources.push('文本服务商：按 Node Provider 配置密钥与后台模型价格')
    secrets.push('OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'DEEPSEEK_API_KEY')
  }
  if (options.ai.includes('image') || options.ai.includes('video')) {
    resources.push('S3 兼容私有文件桶：endpoint / region / bucket / path-style / CA 与应用受限身份')
    vars.push('S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_FORCE_PATH_STYLE')
    secrets.push('S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY')
    if (options.mediaProviders.includes('fal')) secrets.push('FAL_KEY', 'MEDIA_WEBHOOK_SECRET')
    if (options.mediaProviders.includes('workers-ai'))
      resources.push(
        'workers-ai 为 Cloudflare Provider；selfhost 请在模板 mediaProviders 中选择 Node 已支持的 Provider',
      )
  }
  return { resources, secrets, vars, ciSecrets: [] }
}

function plausibleChecklist(options) {
  const host =
    options.plausibleHost ||
    '（未填写：在 web / jobs 的 wrangler vars 或 selfhost .env 配置 PLAUSIBLE_HOST 后才启用）'
  return [
    `Plausible：在自建实例 ${host} 添加 site ${options.plausibleDomain}（生产）与 ${options.plausibleDomain}-staging（staging），两者不得共用`,
    'Plausible 目标（Goals）：添加 sign_up、upload、generate_start、generate_success、generate_fail、paywall_view、checkout_start、payment_success；并在 Site settings 启用自定义属性 source、landing_path、locale、plan、device',
    'Plausible 开关：长期词站把 template.config.ts 的 features.analytics 改为 false（或生成时 --analytics off）；发布门禁 scripts/staging/check-site-isolation.mjs 会校验脚本 site 与本环境一致',
    'GEO 链接统一带 utm_source=chatgpt 等 UTM：AI 助手流量常无 referrer，不能只靠来源页判断',
  ]
}

function searchChecklist(options) {
  const sitemap = `${options.url}/sitemap.xml`
  return [
    `Google Search Console：添加网域资源 ${new URL(options.url).hostname}，用 DNS TXT 记录验证所有权，在“站点地图”提交 ${sitemap}`,
    `Bing Webmaster Tools：添加 ${options.url}（可从 Search Console 导入），按提示验证，在 Sitemaps 提交 ${sitemap}`,
    'IndexNow（可选）：生成密钥后写入 INDEXNOW_KEY（web 运行环境与生产部署 CI secret 相同），生产发布后自动提交站点地图地址',
    '发布前：替换法律页顶部的模板声明，由法律专业人士审阅；app.supportEmail 必须是可收信的真实地址',
  ]
}

export function setupChecklist(options) {
  if (options.target === 'selfhost') return selfhostChecklist(options)
  const media = options.ai.includes('image') || options.ai.includes('video')
  const resources = [
    'Postgres（app / migrator / readonly 账号；Neon TLS 直连或自建库的 Tunnel / Workers VPC）',
    ...(options.billingEnabled
      ? [
          '数据库：迁移后运行 pnpm billing:seed；首次 free.models=[]，模型授权在后台套餐页面配置，重跑保留已有 models',
        ]
      : []),
    `Workers：${options.name}-web、${options.name}-jobs（staging 使用 -staging 后缀）`,
    'Hyperdrive：HYPERDRIVE（关缓存）/ HYPERDRIVE_CACHED（开缓存），替换所有环境的 id',
    'KV：CACHE，替换所有环境的 id；Rate Limiting：RL_AUTH / RL_AI / RL_API / RL_SHARE_CARD，分配独立 namespace_id',
    `Queues：${options.name}-email、${options.name}-events（staging 使用 -staging 后缀）`,
    'Resend：验证发件域名；本地 EMAIL_TRANSPORT=log 不需要凭据',
    '域名 / DNS 与 Cloudflare 部署账号；CI 的 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID',
    `R2：FILES 私有桶 ${options.name}-files（staging 使用 -staging 后缀）；文本模式也保留文件清理 Cron 所需绑定`,
    'Sentry：为 web / jobs 配置 DSN；CI 上传 source map 并使用部署提交 SHA 作为 release',
  ]
  if (options.analytics === 'plausible') resources.push(...plausibleChecklist(options))
  if (options.marketing) resources.push(...searchChecklist(options))
  const secrets = ['BETTER_AUTH_SECRET', 'BOOTSTRAP_ADMIN_EMAILS', 'RESEND_API_KEY', 'SENTRY_DSN']
  const vars = [
    'APP_URL',
    'EMAIL_TRANSPORT',
    'EMAIL_FROM',
    'EMAIL_REPLY_TO',
    'SENTRY_ENVIRONMENT',
    ...(options.billingEnabled ? ['PAYMENT_MODE'] : []),
    'APP_VERSION',
  ]
  const ciSecrets = [
    'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_ACCOUNT_ID',
    'STAGING_MIGRATION_DATABASE_URL',
    'SENTRY_AUTH_TOKEN',
    'SENTRY_ORG',
    'SENTRY_PROJECT',
  ]
  for (const provider of options.oauth) {
    resources.push(`${provider} OAuth 应用：登记新域名的回调 URL`)
    secrets.push(`${provider.toUpperCase()}_CLIENT_ID`, `${provider.toUpperCase()}_CLIENT_SECRET`)
  }
  if (options.turnstile) {
    resources.push('Turnstile 站点')
    secrets.push('TURNSTILE_SECRET_KEY')
    vars.push('TURNSTILE_SITE_KEY')
  }
  for (const provider of options.billingEnabled ? options.billing : []) {
    resources.push(`${provider} 账号与 Webhook（先测试 / 沙箱）`)
    secrets.push(
      ...(provider === 'stripe'
        ? ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']
        : ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID']),
    )
  }
  if (options.ai.includes('text')) {
    // 服务商密钥默认存于 AI Gateway BYOK；放 Worker 的 OPENAI/ANTHROPIC/GOOGLE/DEEPSEEK_API_KEY 为可选。
    resources.push(
      'AI Gateway（开启鉴权，在 Provider Keys 保存所用文本服务商的密钥）；后台登记模型与价格',
    )
    secrets.push('AI_GATEWAY_TOKEN')
    vars.push('AI_GATEWAY_ACCOUNT_ID', 'AI_GATEWAY_ID')
  }
  if (media) {
    resources.push(
      `Workflow：${options.name}-ai-media（定义在 jobs，web 的 script_name 指向 jobs）`,
      'R2：配置 FILES 桶 CORS 与仅授权该桶的 S3 令牌；R2_FILES_BUCKET 必须与绑定桶名一致',
    )
    secrets.push('R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY')
    if (options.mediaProviders.includes('fal')) {
      resources.push('fal.ai 账号与回调地址')
      secrets.push('FAL_KEY', 'MEDIA_WEBHOOK_SECRET')
    }
    if (options.mediaProviders.includes('workers-ai')) {
      resources.push('Workers AI：web 与 jobs 的 AI 绑定（含 staging），无需服务商密钥')
    }
    vars.push('R2_ACCOUNT_ID', 'R2_FILES_BUCKET')
  }
  return { resources, secrets, vars, ciSecrets }
}

async function replacements(source, packageName, options, app) {
  const pairs = [
    [packageName, options.name],
    [app.name, options.name],
    [app.url, options.url],
    [app.supportEmail, options.supportEmail],
    ['product-res', options.name],
    ['product-res', options.name],
  ]
  for (const folder of ['apps', 'packages']) {
    for (const name of (await readdir(join(source, folder))).sort()) {
      const file = join(source, folder, name, 'package.json')
      try {
        const pkg = JSON.parse(await readFile(file, 'utf8'))
        if (pkg.name.startsWith('@'))
          pairs.push([`${pkg.name.split('/')[0]}/`, `@${options.name}/`])
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
  }
  // 数据库 / Orca 命名与隔离检查必须同步改名。
  const scope = pairs.find(([from]) => from.startsWith('@'))?.[0].slice(1, -1)
  if (scope)
    pairs.push(
      [`${scope}-`, `${options.name}-`],
      [`${scope}_`, `${options.name.replaceAll('-', '_')}_`],
      [`${scope.toUpperCase()}_`, `${options.name.replaceAll('-', '_').toUpperCase()}_`],
    )
  const map = new Map(pairs.filter(([from]) => from))
  const pattern = [...map.keys()]
    .sort((a, b) => b.length - a.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  return (value) => value.replace(new RegExp(pattern, 'g'), (match) => map.get(match))
}

async function formatProject(target, source, version) {
  const installed = join(source, 'node_modules/@biomejs/biome')
  const installedManifest = join(installed, 'package.json')
  const pinnedInstalled =
    existsSync(installedManifest) &&
    JSON.parse(await readFile(installedManifest, 'utf8')).version === version
  const config = ['biome.json', 'biome.jsonc'].find((path) => existsSync(join(target, path)))
  // 模板组件和锁文件按字节校验，排除格式化和 import 排序。
  const temporaryConfig = join(target, '.biome-create-project.json')
  await writeFile(
    temporaryConfig,
    JSON.stringify({
      ...(config ? { extends: [`./${config}`] } : {}),
      overrides: [
        {
          includes: ['packages/ui/src/components/**', 'packages/ui/components.lock.json'],
          formatter: { enabled: false },
          assist: { enabled: false },
        },
      ],
    }),
    { flag: 'wx' },
  )
  try {
    // 同步从 git archive 生成参照副本，此时只下载模板锁定的 Biome。
    const [command, ...prefix] = pinnedInstalled
      ? [process.execPath, join(installed, 'bin/biome')]
      : ['pnpm', `--package=@biomejs/biome@${version}`, 'dlx', 'biome']
    // scope 的字母顺序也可能改变，使用同一次 Biome 调用整理 import。
    const result = spawnSync(
      command,
      [
        ...prefix,
        'check',
        '--write',
        '--linter-enabled=false',
        '--config-path',
        temporaryConfig,
        '.',
      ],
      { cwd: target, encoding: 'utf8' },
    )
    if (result.error) throw result.error
    if (result.status !== 0) {
      throw new Error(`副本 Biome 格式化失败（${result.status}）\n${result.stdout}${result.stderr}`)
    }
  } finally {
    await rm(temporaryConfig)
  }
}

export async function createProject(input, source = root) {
  const options = projectOptions(input)
  const sourcePath = await realpath(source)
  const state = sourceState(sourcePath)
  const lexicalRel = relative(sourcePath, options.output)
  if (
    !lexicalRel ||
    (lexicalRel !== '..' && !lexicalRel.startsWith(`..${sep}`) && !isAbsolute(lexicalRel))
  ) {
    throw new Error('目标不能位于模板目录内')
  }
  // realpath 父目录避免通过符号链接把输出放回源树中。
  await mkdir(dirname(options.output), { recursive: true })
  const target = join(await realpath(dirname(options.output)), basename(options.output))
  const rel = relative(sourcePath, target)
  if (!rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)))
    throw new Error('目标不能位于模板目录内')
  try {
    await access(target, constants.F_OK)
    throw new Error('目标已存在，请使用新的目录')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const config = await readFile(join(sourcePath, 'template.config.ts'), 'utf8')
  const manifest = JSON.parse(await readFile(join(sourcePath, 'package.json'), 'utf8'))
  const replace = await replacements(sourcePath, manifest.name, options, appValues(config))
  await mkdir(target)
  await chmod(target, 0o755)
  async function copy(folder = '') {
    for (const name of (await readdir(join(sourcePath, folder))).sort()) {
      const path = folder ? `${folder}/${name}` : name
      if (omit(path)) continue
      // 自托管项目不继承 CF 发布和 Neon 备份工作流，避免要求另一目标的凭据。
      if (
        options.target === 'selfhost' &&
        ['deploy-staging.yml', 'deploy-production.yml', 'backup-production.yml'].some(
          (name) => path === `.github/workflows/${name}`,
        )
      )
        continue
      const from = join(sourcePath, path)
      const to = join(target, replace(path))
      const stat = await lstat(from)
      // 不跟随链接，防止源目录外的密钥或共享缓存进入副本。
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        await mkdir(to, { recursive: true })
        await chmod(to, 0o755)
        await copy(path)
      } else if (stat.isFile()) {
        const buffer = await readFile(from)
        let content = buffer
        let decoded = null
        if (!buffer.includes(0)) {
          try {
            decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
          } catch {
            // 无效 UTF-8 为二进制，原样复制。
          }
        }
        // 模板组件与指纹清单必须可原样移植；需要改名的内容会破坏副本或使清单过期。
        const templateUi =
          path.startsWith('packages/ui/src/components/') ||
          path === 'packages/ui/components.lock.json'
        if (decoded !== null && templateUi && replace(decoded) !== decoded) {
          throw new Error(
            `${path} 包含需要项目改名的模板标识；请先移除模板组件或指纹清单中的项目耦合`,
          )
        }
        if (decoded !== null && projectOwnedPaths.has(path)) {
          // 项目扩展只改名，跳过下方模板专属的内容处理。
          content = Buffer.from(replace(decoded))
        } else if (decoded !== null && !templateUi) {
          // 先替换源标识，再插入新名称，避免新名称含旧 scope 前缀时被二次替换。
          let text = replace(projectText(decoded, path))
          if (path === 'package.json') {
            const manifest = JSON.parse(text)
            // 生成器维护矩阵只在模板运行；副本仍可用 create-project 再生成。
            delete manifest.scripts?.['test:create-project']
            delete manifest.scripts?.['test:create-project:verify']
            text = `${JSON.stringify(manifest, null, 2)}\n`
          }
          if (path === 'template.config.ts') text = templateConfig(text, options)
          if (/^apps\/(web|jobs)\/wrangler.jsonc$/.test(path)) {
            text = wranglerConfig(text, options, path.split('/')[1])
          }
          // 消费者与测试 fixture 使用同一组队列名，避免改 manifest 后消息全部进入未知队列分支。
          if (
            [
              'apps/jobs/src/index.ts',
              'apps/jobs/src/handlers.ts',
              'apps/jobs/src/queues/events-dead-letter.ts',
              'apps/jobs/src/node/runtime.ts',
              'apps/web/src/node/runtime.ts',
            ].includes(path) ||
            /^apps\/jobs\/test\/.*\.ts$/.test(path)
          ) {
            text = text.replace(
              /(['"])(email|events(?:-dlq)?)(-staging|-production)?\1/g,
              (_match, quote, queue, suffix = '') =>
                `${quote}${options.name}-${queue}${suffix}${quote}`,
            )
            // 生命周期测试记录的队列名也必须与实际 Node 注册一致。
            if (/^apps\/jobs\/test\//.test(path))
              text = text.replace(
                /(['"]queue\.register:)(email|events)(['"])/g,
                `$1${options.name}-$2$3`,
              )
          }
          // runbook 中创建/删除队列的命令要与改名后的 Wrangler 队列一致，否则照做会建出无人消费的队列。
          if (/^docs\/.*\.md$/.test(path)) {
            text = text.replace(
              /(queues (?:create|delete) )(email|events(?:-dlq)?)(-staging|-production)?\b/g,
              (_match, command, queue, suffix = '') =>
                `${command}${options.name}-${queue}${suffix}`,
            )
          }
          // 文件桶签名白名单与绑定桶名一致：新项目的 FILES 桶已改名为 <name>-files*，否则上传签名一律 503
          if (
            path === 'packages/storage/src/cloudflare/presign.ts' ||
            path === 'packages/storage/test/presign.unit.test.ts'
          ) {
            text = text.replace(
              /(?<=['"`/])files(-staging|-production)?(?=['"`/])/g,
              (_match, suffix = '') => `${options.name}-files${suffix}`,
            )
          }
          if (path === '.github/workflows/deploy-production.yml') {
            text = text.replace(
              /(PRODUCTION_URL:\s*)https:\/\/\S+/g,
              '$1https://configure-production-url.invalid',
            )
          }
          if (path === '.github/workflows/deploy-staging.yml') {
            text = text.replace(
              /(STAGING_URL:\s*)https:\/\/\S+/g,
              '$1https://configure-staging-url.invalid',
            )
          }
          if (path === 'scripts/staging/files-cors.json') {
            text = text.replace(/https:\/\/web-staging\.[^"\s]+/g, options.url)
          }
          if (!options.billingEnabled && path === '.env.example') {
            text = text.replace(/^(?:STRIPE_[A-Z_]+|PAYPAL_[A-Z_]+|PAYMENT_MODE)=.*\n?/gm, '')
          }
          if (options.target === 'selfhost' && path === 'deploy/selfhost/.env.example') {
            text = text.replace(
              /^IMAGE_NAMESPACE=.*$/m,
              `IMAGE_NAMESPACE=${options.imageNamespace}`,
            )
            if (!/^IMAGE_NAMESPACE=/m.test(text))
              text = `IMAGE_NAMESPACE=${options.imageNamespace}\n${text}`
            text = text
              .replace(
                /^([A-Z_]+)_IMAGE=.*$/gm,
                (_match, service) =>
                  `${service}_IMAGE=${options.imageNamespace}/${service.toLowerCase().replaceAll('_', '-')}:<full-40-character-sha>`,
              )
              .replace(
                /^COMPOSE_PROJECT_NAME=.*$/m,
                `COMPOSE_PROJECT_NAME=${options.name}-selfhost`,
              )
              .replace(/^APP_DOMAIN=.*$/m, `APP_DOMAIN=${new URL(options.url).hostname}`)
              .replace(/^APP_URL=.*$/m, `APP_URL=${options.url}`)
              .replace(/^PLAUSIBLE_SITES=.*$/m, 'PLAUSIBLE_SITES=')
              .replace(/^ACME_EMAIL=.*$/m, `ACME_EMAIL=${options.supportEmail}`)
            for (const provider of ['google', 'github']) {
              if (!options.oauth.includes(provider))
                text = text.replace(
                  new RegExp(`^${provider.toUpperCase()}_CLIENT_ID=.*\\n?`, 'm'),
                  '',
                )
            }
            if (!options.turnstile) text = text.replace(/^TURNSTILE_SITE_KEY=.*\n?/m, '')
            if (!options.billingEnabled)
              text = text.replace(/^# billing 开启时 PAYMENT_MODE.*\nPAYMENT_MODE=.*\n?/m, '')
          }
          if (options.target === 'selfhost' && path === 'deploy/selfhost/compose.yaml') {
            if (!options.billingEnabled) text = text.replace(/^ {2}PAYMENT_MODE:.*\n?/m, '')
            for (const provider of ['google', 'github', 'turnstile']) {
              if (provider === 'turnstile' ? options.turnstile : options.oauth.includes(provider))
                continue
              const secret =
                provider === 'turnstile' ? 'turnstile_secret' : `${provider}_client_secret`
              text = text
                .replace(new RegExp(`^  ${provider.toUpperCase()}_[A-Z_]+:.*\\n?`, 'gm'), '')
                .replace(new RegExp(`^  - ${secret}\\n?`, 'gm'), '')
                .replace(new RegExp(`^  ${secret}:.*\\n?`, 'gm'), '')
            }
          }
          if (path === '.github/workflows/selfhost-publish.yml') {
            // 只设置手动输入默认值，保留 trust/publish 共用的 inputs.namespace 表达式。
            text = text.replace(
              /( {6}namespace:\n)((?: {8}[^\n]*\n)+)/,
              (_match, prefix, fields) =>
                `${prefix}${fields.replace(/^ {8}default:.*\n/gm, '')}        default: ${options.imageNamespace}\n`,
            )
          }
          content = Buffer.from(text)
        }
        await writeFile(to, content)
        // Git 只记录可执行位，统一其余权限，避免源检出的 umask 影响生成结果。
        await chmod(to, stat.mode & 0o111 ? 0o755 : 0o644)
      }
    }
  }
  await copy()
  async function writeGenerated(path, content) {
    const file = join(target, path)
    await mkdir(dirname(file), { recursive: true })
    await chmod(dirname(file), 0o755)
    await writeFile(file, content)
    await chmod(file, 0o644)
  }
  await writeGenerated(
    'scripts/check-ui.allow.local.json',
    `${JSON.stringify({ exceptions: {}, pendingReplacement: {} }, null, 2)}\n`,
  )
  await writeGenerated(
    'docs/design/README.md',
    `# 项目设计记录\n\n此目录归项目所有。模板设计规范见 \`docs/design-system.md\`。\n\n- \`visual-system.md\`：项目视觉方向、品牌 token 与多站点规则。\n- \`references/\`：采用的参考网站说明、截图与素材来源。\n- \`prototypes/\`：经使用者确认、可离线打开的设计稿副本；\`prototypes/README.md\` 为原型索引，每页一行（页面/路由、画布链接、确认日期、使用者确认原话、副本文件、所属 change），需求的 OpenSpec 设计文档只引用索引行。流程见 \`ui-design\` 技能与 \`docs/design-system.md\` §8.2。\n- \`forks.md\`：复制到 \`packages/ui/src/project/\` 的模板组件、来源版本与定制原因。\n\n品牌 token 写入 \`apps/web/src/styles/brand.css\`，项目组件经 \`@${options.name}/ui/project\` 导出；复制的模板组件仍受 UI 规范检查；如需保留上游的 \`arbitrary-class\`、颜色字面量等写法，须在 \`scripts/check-ui.allow.local.json\` 按文件登记所需规则与原因，不能只登记 \`forks.md\`。\n`,
  )
  // 原型索引：new-page / ui-design 技能按它判断设计关卡，生成时就要存在（空表）
  await writeGenerated(
    'docs/design/prototypes/README.md',
    `# 项目设计稿索引\n\n经使用者确认的设计稿副本与索引（流程见 \`ui-design\` 技能与 \`docs/design-system.md\` §8.2）。\n关卡检查：页面在下表中有一行，且「副本文件」（相对本目录）存在。确认只接受使用者本人在会话中的明确确认，附原话。\n\n| 页面 / 路由 | 画布链接 | 确认日期 | 使用者确认原话 | 副本文件 | 所属 change |\n|---|---|---|---|---|---|\n`,
  )
  const journal = JSON.parse(
    await readFile(join(target, 'packages/db/migrations/meta/_journal.json'), 'utf8'),
  )
  await writeGenerated(
    '.template-base.json',
    serializeBaseRecord({
      schemaVersion: 1,
      ...state,
      params: normalizeParams(options),
      migrations: journal.entries.map((entry) => entry.tag),
    }),
  )
  const checklist = setupChecklist(options)
  const vars = [...checklist.vars, ...checklist.secrets]
    .map(
      (key) => `${key}=${key === 'APP_URL' ? options.url : key === 'PAYMENT_MODE' ? 'test' : ''}`,
    )
    .join('\n')
  const example = `# 密钥为空，APP_URL 为公开默认值；复制到对应 app 的 .dev.vars 后填写。\n${vars}\n`
  await writeGenerated('.dev.vars.example', example)
  for (const app of ['web', 'jobs']) {
    await writeGenerated(`apps/${app}/.dev.vars.example`, example)
  }
  let report = `# ${options.name} 初始化清单\n\n## 基础设施与账号\n\n${checklist.resources.map((s) => `- [ ] ${s}`).join('\n')}\n\n## Worker Secrets\n\n${checklist.secrets.map((s) => (s === 'BOOTSTRAP_ADMIN_EMAILS' ? '- BOOTSTRAP_ADMIN_EMAILS（可选，仅 web：逗号分隔邮箱名单；已验证且未封禁才提升，空值禁用）' : `- ${s}`)).join('\n')}\n\n## 非敏感 Worker Vars\n\n${checklist.vars.map((s) => `- ${s}`).join('\n')}\n\n## GitHub staging environment Secrets（不写入 Worker）\n\n${checklist.ciSecrets.map((s) => `- ${s}`).join('\n')}\n\n所有部署资源 ID 为占位值，部署前逐项配置；参考 docs/07-infrastructure.md。\nAI Gateway / R2 账号标识已清空；配置所选功能使用的新资源。\n将 .github/workflows/deploy-staging.yml 的 STAGING_URL 占位值改为实际可访问的 staging URL，并核对该环境的 APP_URL。\nSENTRY_DSN 分别写入 web 与 jobs secrets；SENTRY_ENVIRONMENT 设为 staging、production 或临时验收专用 smoke。\nAPP_VERSION 使用同一个完整提交 SHA，CI 已负责注入并上传 source map；手动部署按 docs/runbooks/sentry.md 操作。\n复制 apps/web 与 apps/jobs 的 .dev.vars.example 后填写，本地密钥不提交；线上 secrets 需分别写入 Worker。\n自检只运行单元测试，集成测试需独立数据库与迁移配置；上线前另做 staging 验收。\n\n## 首次运行\n\n1. 迁移后运行 pnpm billing:seed，首次 free 的 models=[]。\n2. 为 web 配置可选 Worker secret BOOTSTRAP_ADMIN_EMAILS（本地填 apps/web/.dev.vars，逗号分隔、忽略大小写与两侧空白），名单内账号必须先验证邮箱且未封禁。\n3. 用名单账号登录；Google OAuth 返回已验证邮箱可直接提升，邮箱密码账号在账号设置验证后提升，已有账号重新登录也会检查。\n4. 在 /admin/models 创建模型，再到 /admin/billing/plans 为有效套餐（新用户通常为 free）多选模型 key 或 * 并保存；仅建模型或发积分仍不足以授权。\n5. models 在下一次请求生效；历史 key 会警告并保留，其他权益及价格不改。重跑 seed 保留已有 models，其他示例配置仍按 seed 更新。\n\n移除名单不会自动撤销既有管理员；需要撤权时先移除名单，再由运维显式修改数据库中的平台角色（当前后台不提供角色修改入口），否则下次登录会再次提升。\n线上通过 wrangler secret put BOOTSTRAP_ADMIN_EMAILS --env staging 在 web Worker 配置；本地 .dev.vars 不上传。部署流水线不写入或替换此 secret；不要在模板、PR 或日志中保存真实邮箱。\n`
  if (!options.billingEnabled) {
    report = report
      .replace(
        /1\. 迁移后运行 pnpm billing:seed[^\n]*\n/,
        '1. 应用现有数据库迁移；支付模块关闭。\n',
      )
      .replace(/4\. 在 \/admin\/models[^\n]*\n5\. models[^\n]*\n/, '')
  }
  if (options.target === 'selfhost') {
    const required = [
      'deploy/selfhost/compose.yaml',
      '.github/workflows/selfhost-images.yml',
      '.github/workflows/selfhost-publish.yml',
      'deploy/selfhost/images/catalog.json',
      'deploy/selfhost/deploy.sh',
      'deploy/selfhost/deploy.py',
      'deploy/selfhost/health.py',
      'deploy/selfhost/init-server.sh',
      'deploy/selfhost/init-server.py',
      'deploy/selfhost/init-firewall.sh',
      'deploy/selfhost/compose.proxy.yaml',
      'deploy/selfhost/compose.s3.yaml',
      'deploy/selfhost/release/bundle.py',
      'deploy/selfhost/OPERATIONS.md',
      'deploy/selfhost/restore.sh',
      'deploy/selfhost/restore-drill.sh',
    ]
    const missing = []
    for (const path of required) {
      try {
        await access(join(target, path))
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        missing.push(path)
      }
    }
    report = `# ${options.name} selfhost 初始化清单\n\n## 启用功能\n\n- billing=${options.billingEnabled} / credits=${options.creditsEnabled} / marketing=${options.marketing} / i18n=${options.i18n}（默认语言 ${options.locale}）\n- AI：${options.ai.join(',') || '关闭'}\n\n## 运维与资源\n\n${checklist.resources.map((item) => `- [ ] ${item}`).join('\n')}\n\n## 应用配置键（密钥使用受限文件与对应 _FILE；值保持为空）\n\n${[...checklist.vars, ...checklist.secrets].map((key) => `- ${key}`).join('\n')}\n\n## Compose secret 文件\n\n${['postgres_password', 'app_db_password', 'migrator_db_password', 'readonly_db_password', 'app_database_url', 'migrator_database_url', 'valkey_password', 'valkey_url', 'auth_secret', ...options.oauth.map((provider) => `${provider}_client_secret`), ...(options.turnstile ? ['turnstile_secret'] : [])].map((key) => `- secrets/${key}`).join('\n')}\n\n复制 deploy/selfhost/.env.example 后配置 namespace、同 SHA 镜像、域名、TLS 与受限 secret 文件；参考 deploy/selfhost/README.md 和 secrets.example。\n发布 CI 以 namespace 输入装配 IMAGE_NAMESPACE：\n\n    gh workflow run selfhost-publish.yml --ref main -f sha=<full-40-character-main-sha> -f namespace=${options.imageNamespace}\n\n生成副本的功能配置必须重新构建镜像。PR 不获得 registry 写入或服务器 secret，正式发布使用受信提交和完整集合 gate。\n${options.billingEnabled ? '迁移后运行 pnpm billing:seed，并配置模型与套餐授权。' : '应用现有数据库迁移；支付模块关闭。'}\nBOOTSTRAP_ADMIN_EMAILS 可选，仅 web；已验证且未封禁账号才提升；移除名单不会自动撤销管理员。\n自检仅验证单元测试；上线前独立完成 Compose、登录/空间、heartbeat、SHA 与恢复验收。\n\n## 交付材料状态\n\n部署/回滚：deploy/selfhost/deploy.sh；初始化：deploy/selfhost/init-server.sh；bundle：deploy/selfhost/release/bundle.py；外部代理：deploy/selfhost/compose.proxy.yaml。检查同 SHA 发布集合包含所需运行材料；有缺失时先补齐并重新发布。首次发布前核对镜像、部署与备份恢复验收。\n\n${missing.length ? missing.map((path) => `- 待交付：${path}`).join('\n') : '生成副本已继承现有发布/Compose 材料；仍需实际发布与部署验收。'}\n`
  }
  const entryChecklist = `## 页面与语言\n\n- ${options.marketing ? '营销页面已启用，/ 为营销首页。' : '营销页面关闭，/ 重定向至 /app，作为应用入口；营销路由不可用。'}\n- ${options.i18n ? `多语言已启用，默认语言 ${options.locale}；其他语言使用语言前缀。` : `仅编译所选默认语言 ${options.locale}；页面路径无语言前缀，其他语言前缀返回 404；不显示语言控件，忽略账号语言、cookie 与 Accept-Language。`}\n`
  report += `\n${entryChecklist}`
  await writeGenerated('PROJECT_SETUP.md', report)
  const biomeVersion = manifest.devDependencies?.['@biomejs/biome']
  if (biomeVersion) await formatProject(target, sourcePath, biomeVersion)
  return { target, options, checklist, report }
}

export function verifyProject(target, { nodeBuild = false } = {}) {
  // 清除调用者的数据库真值，CI 模式关闭本地库 fallback；不对模板数据库执行测试。
  const env = { ...process.env, CI: 'true', TURBO_ENV_MODE: 'loose', TURBO_TELEMETRY_DISABLED: '1' }
  // 矩阵由 node --test 启动，副本中的各级测试需要自己的运行器。
  delete env.NODE_TEST_CONTEXT
  for (const key of Object.keys(env)) {
    if (/DATABASE_URL|HYPERDRIVE_LOCAL_CONNECTION_STRING/.test(key)) delete env[key]
  }
  // 副本没有 Git 提交，Node 构建需要显式完整 SHA，且不上传 source map 到调用者的 Sentry。
  if (nodeBuild) {
    env.APP_VERSION = '0123456789abcdef0123456789abcdef01234567'
    delete env.SENTRY_AUTH_TOKEN
    delete env.SENTRY_ORG
    delete env.SENTRY_PROJECT
    delete env.SENTRY_RELEASE
  }
  // 完整矩阵逐包执行测试，避免多个 Node 构建探针争抢 CPU；保持用例断言与时限不变。
  const commands = [
    ['install', '--frozen-lockfile'],
    ...(nodeBuild ? [['check']] : []),
    ['typecheck'],
    nodeBuild ? ['test', '--concurrency=1'] : ['test'],
  ]
  if (nodeBuild) commands.push(['build:node'])
  for (const args of commands) {
    const result = spawnSync('pnpm', args, { cwd: target, env, stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`副本 pnpm ${args.join(' ')} 失败（${result.status}）`)
  }
}

const help = `用法：pnpm create-project [参数]\n无参数时交互输入；非交互必须提供 --name 与 --domain。\n  --name acme --domain acme.example --target cloudflare|selfhost --output /tmp/acme\n  --image-namespace ghcr.io/owner/acme（selfhost，默认 ghcr.io/configure-owner/acme）\n  --locale en|zh --support-email support@acme.example\n  --theme ${themeNames.join('|')}（默认 neutral）\n  --analytics plausible|off（默认 plausible；长期词站可 off）--plausible-domain acme --plausible-host https://plausible.example\n  --ai text,image,video --features blog,docs,waitlist,newsletter,publicApi\n  --media-providers fal,workers-ai\n  --billing stripe,paypal --billing-enabled true|false --credits-enabled true|false\n  --marketing true|false --i18n true|false --oauth google,github\n  --turnstile true|false --multi-tenant true|false\n旧 --target <path> 已迁移至 --output <path>；部署目标默认 cloudflare。\n列表参数传空字符串可关闭全部；默认 ai / billing / oauth 全开，features=blog。\n生成后使用 Biome 格式化并整理 import。默认安装依赖并运行 typecheck 与单元测试；--skip-check 只跳过安装与自检。\n  --help 显示帮助\n`

export async function main() {
  const { values } = parseArgs({
    options: {
      ...Object.fromEntries(
        [
          'name',
          'domain',
          'target',
          'output',
          'image-namespace',
          'billing-enabled',
          'credits-enabled',
          'marketing',
          'i18n',
          'locale',
          'theme',
          'support-email',
          'ai',
          'media-providers',
          'features',
          'billing',
          'oauth',
          'turnstile',
          'multi-tenant',
          'analytics',
          'plausible-domain',
          'plausible-host',
        ].map((name) => [name, { type: 'string' }]),
      ),
      help: { type: 'boolean' },
      'skip-check': { type: 'boolean' },
    },
  })
  if (values.help) return console.log(help)
  if (!values.name || !values.domain) {
    if (!process.stdin.isTTY) throw new Error('非交互模式必须提供 --name 与 --domain')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      for (const [key, label, fallback] of [
        ['name', '项目名称（kebab-case）', ''],
        ['domain', '域名', ''],
        ['target', '部署目标（cloudflare/selfhost）', 'cloudflare'],
        ['output', '输出目录', values.name ?? ''],
        ['image-namespace', '镜像 namespace（ghcr.io/owner/project）', ''],
        ['billing-enabled', '启用支付模块', 'true'],
        ['credits-enabled', '启用积分模块', 'true'],
        ['marketing', '启用营销页面', 'true'],
        ['i18n', '启用多语言', 'true'],
        ['locale', '默认语言', 'en'],
        ['theme', `主题预设（${themeNames.join('/')}）`, 'neutral'],
        ['ai', 'AI 功能（逗号列表，- 关闭全部）', 'text,image,video'],
        ['media-providers', '媒体服务商（逗号列表，- 关闭全部）', 'fal,workers-ai'],
        ['features', '可选功能（逗号列表，- 关闭全部）', 'blog'],
        ['billing', '支付（逗号列表，- 关闭全部）', 'stripe,paypal'],
        ['oauth', 'OAuth（逗号列表，- 关闭全部）', 'google,github'],
        ['turnstile', 'Turnstile', 'true'],
        ['multi-tenant', '多租户', 'false'],
        ['analytics', '产品分析（plausible 新词站默认 / off 长期词站可关）', 'plausible'],
      ]) {
        if (values[key] !== undefined) continue
        if (key === 'image-namespace' && values.target !== 'selfhost') continue
        const suggestion =
          key === 'output'
            ? join('..', values.name)
            : key === 'image-namespace'
              ? `ghcr.io/configure-owner/${values.name}`
              : fallback
        const answer = (
          await rl.question(`${label}${suggestion ? ` [${suggestion}]` : ''}：`)
        ).trim()
        values[key] = answer === '-' ? '' : answer || suggestion
      }
    } finally {
      rl.close()
    }
  }
  const result = await createProject(values)
  console.log(`已生成：${result.target}\n${result.report}`)
  if (!values['skip-check']) verifyProject(result.target)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`创建失败：${error.message}`)
    process.exitCode = 1
  })
}
