#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import {
  access,
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '..')
const featureNames = ['publicApi', 'blog', 'docs', 'waitlist', 'newsletter']
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
  '__pycache__',
  '.DS_Store',
  '.omp',
  '.codex',
  'secrets',
  'certs',
  '.data',
  'job-owners',
])

function omit(path) {
  const parts = path.split('/')
  const name = parts.at(-1)
  return (
    parts.some((part) => excluded.has(part)) ||
    path === 'openspec/changes' ||
    path.startsWith('openspec/changes/') ||
    (path.startsWith('scripts/probes/') && parts.includes('results')) ||
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
  if (billingEnabled && !creditsEnabled) throw new Error('启用 billing 必须启用 credits')
  if (!billingEnabled && ai.length)
    throw new Error('关闭 billing 时需使用 --ai "" 关闭 AI（当前额度依赖套餐）')
  return {
    name: input.name,
    url: url.origin,
    supportEmail,
    locale: input.locale ?? 'en',
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
  return result.replace(
    /features:\s*\{[^}]*\}/,
    `features: ${JSON.stringify(
      Object.fromEntries(featureNames.map((name) => [name, options.features.includes(name)])),
    )}`,
  )
}

// 仅在配置语义位置改 Worker / Queue 名；资源 ID 清空，避免新项目复用模板的 staging / production。
function wranglerConfig(source, options, app) {
  const media = options.ai.includes('image') || options.ai.includes('video')
  let result = source
    .replace(
      /("(?:name|script_name|queue|bucket_name)"\s*:\s*")([^"\n]+)"/g,
      (_match, prefix, value) =>
        /^(?:web|jobs|email|events|ai-media|files)(?:-staging|-production)?$/.test(value)
          ? `${prefix}${options.name}-${value}"`
          : `${prefix}${value}"`,
    )
    .replace(/("id"\s*:\s*")[a-f0-9]{32}"/g, '$100000000000000000000000000000000"')
    .replace(/("APP_URL"\s*:\s*")https:[^"]+"/g, `$1${options.url}"`)
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
    'KV：CACHE，替换所有环境的 id；Rate Limiting：RL_AUTH / RL_AI / RL_API，分配独立 namespace_id',
    `Queues：${options.name}-email、${options.name}-events（staging 使用 -staging 后缀）`,
    'Resend：验证发件域名；本地 EMAIL_TRANSPORT=log 不需要凭据',
    '域名 / DNS 与 Cloudflare 部署账号；CI 的 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID',
    `R2：FILES 私有桶 ${options.name}-files（staging 使用 -staging 后缀）；文本模式也保留文件清理 Cron 所需绑定`,
    'Sentry：为 web / jobs 配置 DSN；CI 上传 source map 并使用部署提交 SHA 作为 release',
  ]
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

async function replacements(source, options, app) {
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  const pairs = [
    [manifest.name, options.name],
    [app.name, options.name],
    [app.url, options.url],
    [app.supportEmail, options.supportEmail],
    ['product-res', options.name],
    ['product-res', options.name],
  ]
  for (const folder of ['apps', 'packages']) {
    for (const name of await readdir(join(source, folder))) {
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

export async function createProject(input, source = root) {
  const options = projectOptions(input)
  const sourcePath = await realpath(source)
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
  const replace = await replacements(sourcePath, options, appValues(config))
  await mkdir(target)
  async function copy(folder = '') {
    for (const name of await readdir(join(sourcePath, folder))) {
      const path = folder ? `${folder}/${name}` : name
      if (omit(path)) continue
      // 自托管项目不继承自动 CF staging 发布，避免要求另一部署目标的凭据。
      if (options.target === 'selfhost' && path === '.github/workflows/deploy-staging.yml') continue
      const from = join(sourcePath, path)
      const to = join(target, replace(path))
      const stat = await lstat(from)
      // 不跟随链接，防止源目录外的密钥或共享缓存进入副本。
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        await mkdir(to, { recursive: true })
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
        if (decoded !== null) {
          // 先替换源标识，再插入新名称，避免新名称含旧 scope 前缀时被二次替换。
          let text = replace(decoded)
          if (path === 'template.config.ts') text = templateConfig(text, options)
          if (/^apps\/(web|jobs)\/wrangler.jsonc$/.test(path)) {
            text = wranglerConfig(text, options, path.split('/')[1])
          }
          // 消费者与测试 fixture 使用同一组队列名，避免改 manifest 后消息全部进入未知队列分支。
          if (
            [
              'apps/jobs/src/index.ts',
              'apps/jobs/src/handlers.ts',
              'apps/jobs/src/node/runtime.ts',
              'apps/web/src/node/runtime.ts',
            ].includes(path) ||
            /^apps\/jobs\/test\/.*\.ts$/.test(path)
          ) {
            text = text.replace(
              /(['"])(email|events)(-staging|-production)?\1/g,
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
              .replace(/^ACME_EMAIL=.*$/m, `ACME_EMAIL=${options.supportEmail}`)
            for (const provider of ['google', 'github']) {
              if (!options.oauth.includes(provider))
                text = text.replace(
                  new RegExp(`^${provider.toUpperCase()}_CLIENT_ID=.*\\n?`, 'm'),
                  '',
                )
            }
            if (!options.turnstile) text = text.replace(/^TURNSTILE_SITE_KEY=.*\n?/m, '')
          }
          if (options.target === 'selfhost' && path === 'deploy/selfhost/compose.yaml') {
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
          if (options.target === 'selfhost' && path === '.github/workflows/selfhost-publish.yml') {
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
        await chmod(to, stat.mode & 0o777)
      }
    }
  }
  await copy()
  const checklist = setupChecklist(options)
  const vars = [...checklist.vars, ...checklist.secrets]
    .map(
      (key) => `${key}=${key === 'APP_URL' ? options.url : key === 'PAYMENT_MODE' ? 'test' : ''}`,
    )
    .join('\n')
  const example = `# 密钥为空，APP_URL 为公开默认值；复制到对应 app 的 .dev.vars 后填写。\n${vars}\n`
  await writeFile(join(target, '.dev.vars.example'), example)
  for (const app of ['web', 'jobs']) {
    await writeFile(join(target, 'apps', app, '.dev.vars.example'), example)
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
    report = `# ${options.name} selfhost 初始化清单\n\n## 启用功能\n\n- billing=${options.billingEnabled} / credits=${options.creditsEnabled} / marketing=${options.marketing} / i18n=${options.i18n}（默认语言 ${options.locale}）\n- AI：${options.ai.join(',') || '关闭'}\n\n## 运维与资源\n\n${checklist.resources.map((item) => `- [ ] ${item}`).join('\n')}\n\n## 应用配置键（密钥使用受限文件与对应 _FILE；值保持为空）\n\n${[...checklist.vars, ...checklist.secrets].map((key) => `- ${key}`).join('\n')}\n\n## Compose secret 文件\n\n${['postgres_password', 'app_db_password', 'migrator_db_password', 'readonly_db_password', 'app_database_url', 'migrator_database_url', 'valkey_password', 'valkey_url', 'auth_secret', ...options.oauth.map((provider) => `${provider}_client_secret`), ...(options.turnstile ? ['turnstile_secret'] : [])].map((key) => `- secrets/${key}`).join('\n')}\n\n复制 deploy/selfhost/.env.example 后配置 namespace、同 SHA 镜像、域名、TLS 与受限 secret 文件；参考 deploy/selfhost/README.md 和 secrets.example。\n发布 CI 以 namespace 输入装配 IMAGE_NAMESPACE：\n\n    gh workflow run selfhost-publish.yml --ref main -f sha=<full-40-character-main-sha> -f namespace=${options.imageNamespace}\n\n生成副本的功能配置必须重新构建镜像。PR 不获得 registry 写入或服务器 secret，正式发布使用受信提交和完整集合 gate。\n${options.billingEnabled ? '迁移后运行 pnpm billing:seed，并配置模型与套餐授权。' : '应用现有数据库迁移；支付模块关闭。'}\nBOOTSTRAP_ADMIN_EMAILS 可选，仅 web；已验证且未封禁账号才提升；移除名单不会自动撤销管理员。\n自检仅验证单元测试；上线前独立完成 Compose、登录/空间、heartbeat、SHA 与恢复验收。\n\n## 交付材料状态\n\n部署/回滚：deploy/selfhost/deploy.sh；初始化：deploy/selfhost/init-server.sh；bundle：deploy/selfhost/release/bundle.py；外部代理：deploy/selfhost/compose.proxy.yaml。仅继承已交付文件，下列缺失项仍待 owner 交付；恢复脚本尚未交付不代表可做异机恢复。首次真实 registry 发布与 B/D ownership 签收仍待协调者确认，部署成功不等于备份/恢复验收。\n\n${missing.length ? missing.map((path) => `- 待交付：${path}`).join('\n') : '生成副本已继承现有发布/Compose 材料；仍需实际发布与部署验收。'}\n`
  }
  const entryChecklist = `## 页面与语言\n\n- ${options.marketing ? '营销页面已启用，/ 为营销首页。' : '营销页面关闭，/ 重定向至 /app，作为应用入口；营销路由不可用。'}\n- ${options.i18n ? `多语言已启用，默认语言 ${options.locale}；其他语言使用语言前缀。` : `仅编译所选默认语言 ${options.locale}；页面路径无语言前缀，其他语言前缀返回 404；不显示语言控件，忽略账号语言、cookie 与 Accept-Language。`}\n`
  report += `\n${entryChecklist}`
  await writeFile(join(target, 'PROJECT_SETUP.md'), report)
  return { target, options, checklist, report }
}

export function verifyProject(target, { nodeBuild = false } = {}) {
  // 清除调用者的数据库真值，CI 模式关闭本地库 fallback；不对模板数据库执行测试。
  const env = { ...process.env, CI: 'true', TURBO_ENV_MODE: 'loose', TURBO_TELEMETRY_DISABLED: '1' }
  for (const key of Object.keys(env)) {
    if (/DATABASE_URL|HYPERDRIVE_LOCAL_CONNECTION_STRING/.test(key)) delete env[key]
  }
  // 副本不包含 .git，Node 构建需要显式完整 SHA，且不上传 source map 到调用者的 Sentry。
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

const help = `用法：pnpm create-project [参数]\n无参数时交互输入；非交互必须提供 --name 与 --domain。\n  --name acme --domain acme.example --target cloudflare|selfhost --output /tmp/acme\n  --image-namespace ghcr.io/owner/acme（selfhost，默认 ghcr.io/configure-owner/acme）\n  --locale en|zh --support-email support@acme.example\n  --ai text,image,video --features blog,docs,waitlist,newsletter,publicApi\n  --media-providers fal,workers-ai\n  --billing stripe,paypal --billing-enabled true|false --credits-enabled true|false\n  --marketing true|false --i18n true|false --oauth google,github\n  --turnstile true|false --multi-tenant true|false\n旧 --target <path> 已迁移至 --output <path>；部署目标默认 cloudflare。\n列表参数传空字符串可关闭全部；默认 ai / billing / oauth 全开，features=blog。\n默认安装依赖并运行 typecheck 与单元测试；--skip-check 仅生成，随后必须自行验证。\n  --help 显示帮助\n`

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
          'support-email',
          'ai',
          'media-providers',
          'features',
          'billing',
          'oauth',
          'turnstile',
          'multi-tenant',
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
        ['ai', 'AI 功能（逗号列表，- 关闭全部）', 'text,image,video'],
        ['media-providers', '媒体服务商（逗号列表，- 关闭全部）', 'fal,workers-ai'],
        ['features', '可选功能（逗号列表，- 关闭全部）', 'blog'],
        ['billing', '支付（逗号列表，- 关闭全部）', 'stripe,paypal'],
        ['oauth', 'OAuth（逗号列表，- 关闭全部）', 'google,github'],
        ['turnstile', 'Turnstile', 'true'],
        ['multi-tenant', '多租户', 'false'],
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
