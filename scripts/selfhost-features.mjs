import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createProject } from './create-project.mjs'

const root = resolve(import.meta.dirname, '..')
const prepareOnly = process.argv[2] === '--prepare-only'
if (process.argv.length > 3)
  throw new Error('Usage: selfhost-features.mjs [output-dir|--prepare-only]')
const output = resolve(process.argv[2] && !prepareOnly ? process.argv[2] : 'feature-artifacts')
const temporary = mkdtempSync(join(tmpdir(), 'selfhost-features-'))
chmodSync(temporary, 0o700)
const source = join(temporary, 'source')
const project = `selfhost-features-${randomBytes(6).toString('hex')}`
const namespace = `local/${project}`
const domain = 'selfhost-features.test'
const composeFile = join(source, 'deploy/selfhost/compose.yaml')
const override = join(temporary, 'fixture.yaml')
const fixture = join(root, 'apps/web/e2e/selfhost')
// 不将调用者的支付、平台、数据库或邮件凭据传给隔离测试。
const env = Object.fromEntries(
  ['PATH', 'HOME', 'TMPDIR', 'CI', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
)
const events = []
let stage = 'generate'
let started = false
let failure
let sha
function run(command, args, { cwd = root, timeout = 60_000 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) {
    if (result.error?.code === 'ETIMEDOUT' && result.pid) {
      try {
        // 每条命令独立进程组；超时时连同本脚本启动的 bash/docker 子进程退出。
        process.kill(-result.pid, 'SIGTERM')
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    if (stage === 'build' || (stage === 'start' && args.includes('up'))) {
      // 构建尚无 secret；compose up 仅输出服务状态，不转储服务日志或 secret。
      console.error((result.stderr || result.stdout || '').split('\n').slice(-20).join('\n'))
    }
    if (stage === 'browser') {
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
      // 只提取测试位置和 matcher 名，原始错误可能包含会话或验证 URL。
      console.error(
        JSON.stringify({
          locations: [...new Set(output.match(/auth-workspace\.selfhost\.ts:\d+:\d+/g) ?? [])],
          matchers: [
            ...new Set(
              output.match(
                /(?:toHaveText|toHaveURL|toBeVisible|toHaveCount|toHaveAttribute|locator\.fill|browserType\.launch)/g,
              ) ?? [],
            ),
          ],
        }),
      )
    }
    // 子进程错误可能包含 secret 文件正文、连接串或验证链接，只报告固定步骤名。
    throw new Error(`Selfhost features command failed during ${stage}: ${command}`)
  }
  return result.stdout
}
function assert(condition, reason) {
  if (!condition) throw new Error(reason)
}
function evidence(event, details = {}) {
  const entry = { event, ...details }
  events.push(entry)
  console.info(JSON.stringify({ sha, ...entry }))
}
const composeArgs = ['compose', '--env-file', '/dev/null', '-f', composeFile, '-f', override]
const compose = (...args) => run('docker', [...composeArgs, ...args], { timeout: 210_000 })
function secret(name, value = randomBytes(32).toString('hex')) {
  // 父目录0700；文件挂载允许镜像内各非 root UID 读取，文件从不进入 build context。
  writeFileSync(join(env.SECRETS_DIR, name), value, { mode: 0o644 })
  return value
}
function certificate(name, san) {
  const directory = join(temporary, 'certs', name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'extensions'),
    `subjectAltName=DNS:${san}\nextendedKeyUsage=serverAuth\n`,
  )
  run('openssl', [
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    join(directory, 'server.key'),
    '-out',
    join(directory, 'server.csr'),
    '-subj',
    `/CN=${san}`,
  ])
  run('openssl', [
    'x509',
    '-req',
    '-in',
    join(directory, 'server.csr'),
    '-CA',
    env.CA_FILE,
    '-CAkey',
    join(temporary, 'certs/ca.key'),
    '-CAcreateserial',
    '-out',
    join(directory, 'server.crt'),
    '-days',
    '2',
    '-extfile',
    join(directory, 'extensions'),
  ])
  chmodSync(join(directory, 'server.key'), 0o644)
}
function probe(service, path) {
  const port = service === 'web' ? 3000 : 3001
  return JSON.parse(
    compose(
      'exec',
      '-T',
      service,
      'node',
      '-e',
      `fetch('http://127.0.0.1:${port}${path}',{signal:AbortSignal.timeout(5000)}).then(async r=>console.log(JSON.stringify({status:r.status,cache:r.headers.get('cache-control'),body:await r.json()}))).catch(()=>process.exit(1))`,
    ),
  )
}
try {
  sha = run('git', ['rev-parse', 'HEAD']).trim()
  assert(/^[a-f0-9]{40}$/.test(sha), 'Source revision must be a complete SHA')
  await createProject(
    {
      name: 'feature-probe',
      domain,
      target: 'selfhost',
      output: source,
      locale: 'zh',
      'image-namespace': 'ghcr.io/configure-owner/feature-probe',
      'billing-enabled': 'false',
      'credits-enabled': 'false',
      marketing: 'false',
      i18n: 'false',
      ai: '',
      billing: '',
      features: '',
      'media-providers': '',
      oauth: '',
      turnstile: 'false',
      'multi-tenant': 'true',
    },
    root,
  )
  const templatePath = join(source, 'template.config.ts')
  const template = readFileSync(templatePath, 'utf8')
  for (const feature of ['billing', 'credits', 'marketing', 'i18n'])
    assert(
      new RegExp(`${feature}:\\s*\\{\\s*enabled: false`).test(template),
      `${feature} was not disabled`,
    )
  assert(/defaultLocale: 'zh'/.test(template), 'Generated default locale differs')
  const generatedCompose = readFileSync(composeFile, 'utf8')
  assert(
    !/GOOGLE_CLIENT|GITHUB_CLIENT|TURNSTILE/.test(generatedCompose),
    'Disabled auth secrets still required',
  )
  // 与现有浏览器验收保持一致，只在生成副本开启邮箱验证，不修改源模板。
  assert(
    template.includes('requireEmailVerification: false'),
    'Verification fixture template changed',
  )
  writeFileSync(
    templatePath,
    template.replace('requireEmailVerification: false', 'requireEmailVerification: true'),
  )
  evidence('features.generated', {
    locale: 'zh',
    multiTenant: true,
    billing: false,
    credits: false,
    marketing: false,
    i18n: false,
    ai: false,
  })
  if (!prepareOnly) {
    stage = 'build'
    // 匿名 Docker 配置避免读取宿主 registry 登录态；保留已安装的 CLI 插件路径。
    const dockerHost = run('docker', [
      'context',
      'inspect',
      '--format',
      '{{.Endpoints.docker.Host}}',
    ]).trim()
    env.DOCKER_HOST ||= dockerHost
    env.DOCKER_CONFIG = join(temporary, 'docker')
    mkdirSync(env.DOCKER_CONFIG)
    writeFileSync(
      join(env.DOCKER_CONFIG, 'config.json'),
      JSON.stringify({
        cliPluginsExtraDirs: [
          // biome-ignore lint/suspicious/noUndeclaredEnvVars: 独立非缓存验收脚本，只读取插件目录。
          join(process.env.DOCKER_CONFIG ?? join(env.HOME, '.docker'), 'cli-plugins'),
        ],
      }),
    )
    Object.assign(env, {
      APP_VERSION: sha,
      IMAGE_NAMESPACE: namespace,
      COMPOSE_PROJECT_NAME: project,
      COMPOSE_PROFILES: 'caddy',
      APP_DOMAIN: domain,
      APP_URL: `https://${domain}`,
      CADDY_TLS_MODE: 'supplied',
      POSTGRES_DB: 'selfhost_features',
      CACHE_NAMESPACE: project,
      JOB_EXECUTOR_ID: `${project}-jobs`,
      EMAIL_TRANSPORT: 'log',
      SECRETS_DIR: join(temporary, 'secrets'),
      PG_TLS_DIR: join(temporary, 'certs/postgres'),
      CA_FILE: join(temporary, 'certs/ca.crt'),
      CADDY_CERT_DIR: join(temporary, 'certs/caddy'),
    })
    for (const name of ['web', 'jobs', 'migrate', 'postgres', 'valkey', 'caddy'])
      env[`${name.toUpperCase()}_IMAGE`] = `${namespace}/${name}:${sha}`
    console.info(JSON.stringify({ event: 'features.build.started', sha }))
    const buildDeadline = Date.now() + 900_000
    for (const name of ['web', 'jobs', 'migrate', 'postgres', 'valkey', 'caddy']) {
      const app = ['web', 'jobs', 'migrate'].includes(name)
      const remaining = buildDeadline - Date.now()
      assert(remaining > 0, 'Image build exceeded the fifteen-minute budget')
      run(
        'docker',
        [
          'build',
          '-f',
          app ? 'deploy/selfhost/app.Dockerfile' : `deploy/selfhost/${name}.Dockerfile`,
          ...(app ? ['--target', name] : []),
          '--build-arg',
          `APP_VERSION=${sha}`,
          '--label',
          `org.opencontainers.image.revision=${sha}`,
          '-t',
          env[`${name.toUpperCase()}_IMAGE`],
          source,
        ],
        { cwd: source, timeout: remaining },
      )
      const [image] = JSON.parse(
        run('docker', ['image', 'inspect', env[`${name.toUpperCase()}_IMAGE`]], {
          timeout: Math.max(1, Math.min(60_000, buildDeadline - Date.now())),
        }),
      )
      assert(
        image.Config.Labels?.['org.opencontainers.image.revision'] === sha,
        `${name}: image SHA mismatch`,
      )
    }
    evidence('features.images.built')
    stage = 'configure'
    mkdirSync(env.SECRETS_DIR)
    mkdirSync(join(temporary, 'certs'))
    run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(temporary, 'certs/ca.key'),
      '-out',
      env.CA_FILE,
      '-days',
      '2',
      '-subj',
      '/CN=selfhost-features-CA',
    ])
    certificate('postgres', 'postgres')
    certificate('caddy', domain)
    const appPassword = secret('app_db_password')
    const migratorPassword = secret('migrator_db_password')
    const cachePassword = secret('valkey_password')
    for (const name of ['postgres_password', 'readonly_db_password', 'auth_secret', 'resend_key'])
      secret(name)
    secret(
      'app_database_url',
      `postgres://app:${appPassword}@postgres:5432/${env.POSTGRES_DB}?sslmode=verify-full`,
    )
    secret(
      'migrator_database_url',
      `postgres://migrator:${migratorPassword}@postgres:5432/${env.POSTGRES_DB}?sslmode=verify-full`,
    )
    secret('valkey_url', `redis://default:${cachePassword}@valkey:6379`)
    writeFileSync(
      override,
      `services:
  web:
    volumes: ['${join(root, 'scripts/selfhost-features-routes.mjs')}:/features-routes.mjs:ro']
  jobs:
    command: [node, --import, /fixture/preload.mjs, server/index.mjs]
    environment:
      EMAIL_TRANSPORT: resend
      RESEND_API_KEY_FILE: /run/secrets/resend_key
      EMAIL_FROM: 'Fixture <fixture@example.com>'
    secrets: [resend_key]
    volumes: ['${fixture}:/fixture:ro']
    depends_on:
      capture: {condition: service_healthy}
  capture:
    image: '${env.WEB_IMAGE}'
    user: '1000:1000'
    command: [node, /fixture/capture.mjs]
    volumes: ['${fixture}:/fixture:ro']
    networks: [data]
    mem_limit: 64m
    cpus: 0.1
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    healthcheck:
      test: [CMD, node, -e, "fetch('http://127.0.0.1:8025/health').then(r=>process.exit(r.ok?0:1))"]
      interval: 2s
      retries: 20
networks:
  data: {internal: true}
secrets:
  resend_key: {file: '${env.SECRETS_DIR}/resend_key'}
`,
    )
    const config = JSON.parse(compose('config', '--format', 'json'))
    for (const [name, service] of Object.entries(config.services)) {
      assert(
        !service.build && Number(service.user.split(':')[0]) > 0,
        `${name}: image/non-root boundary failed`,
      )
      assert(name === 'caddy' || !service.ports?.length, `${name}: data port exposed`)
    }
    for (const kind of ['ps', 'volume']) {
      const args = kind === 'ps' ? ['ps', '-a'] : ['volume', 'ls']
      assert(
        !run('docker', [
          ...args,
          '--filter',
          `label=com.docker.compose.project=${project}`,
          '--format',
          kind === 'ps' ? '{{.ID}}' : '{{.Name}}',
        ]).trim(),
        'Acceptance project or volumes already exist',
      )
    }
    stage = 'start'
    started = true
    compose('up', '-d', '--wait', '--wait-timeout', '180')
    stage = 'readiness'
    const deadline = Date.now() + 360_000
    let ready
    while (Date.now() < deadline) {
      const response = probe('web', '/api/health')
      assert(
        response.body.version === sha && response.cache === 'no-store',
        'Health SHA/cache mismatch',
      )
      if (response.status === 200) {
        ready = response.body
        break
      }
      assert(response.status === 503, 'Unexpected readiness status')
      await delay(5000)
    }
    assert(
      ready && ['db', 'cache', 'queue', 'scheduler'].every((key) => ready[key]?.status === 'up'),
      'Real heartbeat readiness timed out',
    )
    assert(
      Number.isFinite(Date.parse(ready.scheduler.lastCronAt)),
      'Missing successful scheduler heartbeat',
    )
    const jobs = probe('jobs', '/internal/ready')
    assert(jobs.status === 200 && jobs.body.version === sha, 'Jobs readiness/SHA mismatch')
    evidence('features.ready', {
      version: sha,
      jobsVersion: sha,
      lastCronAt: ready.scheduler.lastCronAt,
    })
    stage = 'routes'
    compose('exec', '-T', 'web', 'node', '/features-routes.mjs')
    run('curl', [
      '--fail',
      '--silent',
      '--show-error',
      '--cacert',
      env.CA_FILE,
      '--resolve',
      `${domain}:443:127.0.0.1`,
      `${env.APP_URL}/api/health`,
    ])
    evidence('features.routes', {
      nodeSSR: true,
      staticAssets: true,
      locale: 'zh',
      disabledRoutes404: true,
      tls: true,
    })
    stage = 'browser'
    Object.assign(env, {
      SELFHOST_COMPOSE_FILE: [composeFile, override].join(delimiter),
      SELFHOST_BASE_URL: env.APP_URL,
      SELFHOST_LOCALE: 'zh',
      SELFHOST_MARKETING: 'false',
      SELFHOST_I18N: 'false',
    })
    // 完整复用既有邮件/登录/空间浏览器流程，不另造认证或数据库写入通道。
    run(
      'pnpm',
      [
        '--filter',
        '@product-res/web',
        'exec',
        'playwright',
        'test',
        '-c',
        'playwright.selfhost.config.ts',
      ],
      { timeout: 240_000 },
    )
    evidence('features.auth-workspace', {
      verifiedEmail: true,
      passwordLogin: true,
      personalWorkspace: true,
      teamSwitching: true,
    })
  }
} catch (error) {
  failure = error instanceof Error ? error.message : 'Selfhost feature acceptance failed'
} finally {
  stage = 'cleanup'
  try {
    if (started) compose('down', '-v', '--remove-orphans')
  } catch {
    failure ??= 'Selfhost features cleanup failed'
  }
  rmSync(temporary, { recursive: true, force: true })
  if (!prepareOnly) {
    mkdirSync(output, { recursive: true })
    writeFileSync(
      join(output, 'report.json'),
      `${JSON.stringify({ sha, passed: !failure, events }, null, 2)}\n`,
    )
  }
}
if (failure) {
  console.error(failure)
  process.exitCode = 1
} else evidence(prepareOnly ? 'features.prepare.passed' : 'features.acceptance.passed')
