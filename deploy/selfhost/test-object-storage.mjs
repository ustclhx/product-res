import { execFile, execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const root = resolve(import.meta.dirname, '../..')
const requireWeb = createRequire(join(root, 'apps/web/package.json'))
const { chromium } = requireWeb('@playwright/test')
const { build } = createRequire(join(root, 'apps/jobs/package.json'))('esbuild')
const execute = promisify(execFile)
const temporary = mkdtempSync(join(tmpdir(), 'selfhost-c-profile-'))
chmodSync(temporary, 0o700)
const project = `selfhost-c-profile-${process.pid}`
const version = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const composeFiles = [
  join(root, 'deploy/selfhost/compose.yaml'),
  join(root, 'deploy/selfhost/compose.object-storage.yaml'),
  join(temporary, 'acceptance.yaml'),
]
const fixture = join(temporary, 'fixture')
const env = {
  ...process.env,
  COMPOSE_PROJECT_NAME: project,
  COMPOSE_PROFILES: 'object-storage',
  APP_DOMAIN: 'app.selfhost-c-profile.test',
  APP_URL: 'https://app.selfhost-c-profile.test',
  S3_PUBLIC_DOMAIN: 'storage.selfhost-c-profile.test',
  S3_BUCKET: 'profile-files',
  S3_REGION: 'us-east-1',
  CADDY_TLS_MODE: 'supplied',
  POSTGRES_DB: 'product_res_wt_selfhost_c_profile',
  CACHE_NAMESPACE: project,
  JOB_EXECUTOR_ID: 'selfhost-c-profile-jobs',
  GOOGLE_CLIENT_ID: 'unused-fixture',
  GITHUB_CLIENT_ID: 'unused-fixture',
  TURNSTILE_SITE_KEY: 'unused-fixture',
  EMAIL_TRANSPORT: 'log',
  SECRETS_DIR: join(temporary, 'secrets'),
  PG_TLS_DIR: join(temporary, 'certs/postgres'),
  CA_FILE: join(fixture, 'ca.crt'),
  CADDY_CERT_DIR: join(temporary, 'certs/caddy'),
  OBJECT_STORAGE_IMAGE: 'selfhost-c-profile/object-storage:4.48',
}
for (const service of ['web', 'jobs', 'migrate', 'postgres', 'valkey', 'caddy'])
  env[`${service.toUpperCase()}_IMAGE`] = `selfhost-c-profile/${service}:${version}`
const browserName = `${project}-browser`
const browserImage = 'selfhost-c-profile/browser:1.63.0'
const composeArgs = ['compose', ...composeFiles.flatMap((file) => ['-f', file])]
let stackStarted = false
let browserStarted = false
let browser
let page
let failure
let sampling = false
let phase = 'startup'
let sampler
let cleanupStarted = false
const measurements = {}
const networkErrors = []
const prior = new Map()
let serviceIds = []
const evidence = (event, detail = {}) => console.info(JSON.stringify({ event, version, ...detail }))
const assert = (condition, reason) => {
  if (!condition) throw new Error(reason)
}
function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      ...options,
    })
  } catch {
    // 失败时不透传 SDK、SQL、浏览器/认证响应或命令参数中的签名。
    throw new Error(`Acceptance command failed: ${command} ${args[0]}`)
  }
}
const compose = (...args) => run('docker', [...composeArgs, ...args])
async function composeAsync(...args) {
  try {
    return (
      await execute('docker', [...composeArgs, ...args], { cwd: root, env, maxBuffer: 1024 * 1024 })
    ).stdout
  } catch (error) {
    if (args[0] !== 'exec')
      console.error(error.stderr?.slice(-2000) ?? 'Compose failed without diagnostics')
    throw new Error('Acceptance asynchronous Compose command failed')
  }
}
function secret(name, value = randomBytes(32).toString('hex')) {
  writeFileSync(join(env.SECRETS_DIR, name), value, { mode: 0o644 })
  return value
}
function certificate(name, domains) {
  const dir = join(temporary, 'certs', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'extensions'),
    `subjectAltName=${domains.map((d) => `DNS:${d}`).join(',')}\nextendedKeyUsage=serverAuth\n`,
  )
  run('openssl', [
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    join(dir, 'server.key'),
    '-out',
    join(dir, 'server.csr'),
    '-subj',
    `/CN=${domains[0]}`,
  ])
  run('openssl', [
    'x509',
    '-req',
    '-in',
    join(dir, 'server.csr'),
    '-CA',
    env.CA_FILE,
    '-CAkey',
    join(temporary, 'certs/ca.key'),
    '-CAcreateserial',
    '-out',
    join(dir, 'server.crt'),
    '-days',
    '2',
    '-extfile',
    join(dir, 'extensions'),
  ])
  chmodSync(join(dir, 'server.key'), 0o644)
}
const sql = (query) =>
  compose(
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'postgres',
    '-d',
    env.POSTGRES_DB,
    '-tAc',
    query,
  ).trim()
const helper = (...args) =>
  JSON.parse(compose('exec', '-T', 'jobs', 'node', '/fixture/storage.cjs', ...args))
async function wait(check, timeout = 120_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(1000)
  }
  throw new Error('Acceptance readiness timeout')
}
function engine(path) {
  return new Promise((resolveResult, reject) => {
    const request = http.get(
      { socketPath: env.DOCKER_HOST.replace(/^unix:\/\//, ''), path },
      (response) => {
        let body = ''
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () => {
          if (response.statusCode === 404 && path.includes('/stats?')) return resolveResult(null)
          if (response.statusCode !== 200) return reject(new Error('Docker stats HTTP failed'))
          try {
            resolveResult(JSON.parse(body))
          } catch {
            reject(new Error('Docker stats response failed'))
          }
        })
      },
    )
    request.on('error', () => reject(new Error('Docker stats connection failed')))
    request.setTimeout(5000, () => request.destroy())
  })
}
async function refreshIds() {
  serviceIds = await engine(
    `/containers/json?filters=${encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${project}`] }))}`,
  )
}
async function waitForHealthy() {
  const required = ['postgres', 'valkey', 'web', 'jobs', 'caddy', 'object-storage']
  await wait(async () => {
    await refreshIds()
    const healthy = new Set(
      serviceIds
        .filter(({ Status }) => Status.endsWith('(healthy)'))
        .map(({ Labels }) => Labels['com.docker.compose.service']),
    )
    return required.every((name) => healthy.has(name))
  })
}
async function sample() {
  const results = await Promise.all(
    serviceIds.map(async ({ Id, Labels }) => {
      const stats = await engine(`/containers/${Id}/stats?stream=false&one-shot=true`)
      if (!stats?.memory_stats?.usage || !stats.cpu_stats?.cpu_usage) return
      const memory = stats.memory_stats
      const name = Labels['com.docker.compose.service']
      const usage = stats.cpu_stats.cpu_usage.total_usage
      const time = Date.parse(stats.read)
      const previous = prior.get(Id)
      const cores =
        previous && time > previous.time
          ? Math.max(0, (usage - previous.usage) / ((time - previous.time) * 1e6))
          : 0
      prior.set(Id, { usage, time })
      return {
        name,
        usage: memory.usage,
        rss: memory.stats?.anon ?? memory.stats?.rss ?? 0,
        working:
          memory.usage - (memory.stats?.inactive_file ?? memory.stats?.total_inactive_file ?? 0),
        cores,
      }
    }),
  )
  const valid = results.filter(Boolean)
  if (!valid.length) return
  measurements[phase] ??= {
    samples: 0,
    peakMiB: 0,
    workingMiB: 0,
    rssMiB: 0,
    peakCores: 0,
    cpuCoreSum: 0,
    services: {},
  }
  const current = measurements[phase]
  current.samples++
  const mib = (key) => valid.reduce((sum, s) => sum + s[key], 0) / 1024 ** 2
  current.peakMiB = Math.max(current.peakMiB, mib('usage'))
  current.workingMiB = Math.max(current.workingMiB, mib('working'))
  current.rssMiB = Math.max(current.rssMiB, mib('rss'))
  const cores = valid.reduce((sum, s) => sum + s.cores, 0)
  current.peakCores = Math.max(current.peakCores, cores)
  current.cpuCoreSum += cores
  for (const entry of valid) {
    current.services[entry.name] ??= {
      peakMiB: 0,
      rssMiB: 0,
      workingMiB: 0,
      peakCores: 0,
    }
    const maximum = current.services[entry.name]
    maximum.peakMiB = Math.max(maximum.peakMiB, entry.usage / 1024 ** 2)
    maximum.rssMiB = Math.max(maximum.rssMiB, entry.rss / 1024 ** 2)
    maximum.workingMiB = Math.max(maximum.workingMiB, entry.working / 1024 ** 2)
    maximum.peakCores = Math.max(maximum.peakCores, entry.cores)
  }
}
async function checkpoint(label) {
  const services = ['postgres', 'valkey', 'web', 'jobs', 'caddy', 'object-storage']
  for (const name of services) {
    const id = compose('ps', '-q', name).trim()
    const state = JSON.parse(run('docker', ['inspect', '--format', '{{json .State}}', id]))
    assert(!state.OOMKilled && state.Running, `${name} not running or OOM killed`)
    assert(
      run('docker', ['inspect', '--format', '{{.RestartCount}}', id]).trim() === '0',
      `${name} restarted unexpectedly`,
    )
    const metrics = compose(
      'exec',
      '-T',
      name,
      'sh',
      '-c',
      'cat /sys/fs/cgroup/memory.peak /sys/fs/cgroup/memory.events /sys/fs/cgroup/cpu.max',
    )
    assert(/oom_kill 0/.test(metrics), `${name} cgroup OOM event`)
    evidence('profile.cgroup', { label, service: name, metrics: metrics.trim() })
  }
  evidence('profile.connections', {
    label,
    postgres: Number(sql('select count(*) from pg_stat_activity')),
  })
}
async function monitor() {
  while (sampling) {
    await refreshIds()
    await sample()
    await delay(500)
  }
}
async function cleanup() {
  if (cleanupStarted) return
  cleanupStarted = true
  sampling = false
  if (sampler) await sampler.catch(() => {})
  await browser?.close().catch(() => {})
  let cleaned = true
  if (browserStarted) {
    try {
      run('docker', ['rm', '-f', browserName])
    } catch {
      cleaned = false
      failure ??= 'Browser cleanup failed'
    }
  }
  if (stackStarted) {
    try {
      compose('down', '-v', '--remove-orphans')
    } catch {
      cleaned = false
      failure ??= 'Profile cleanup failed'
    }
  }
  rmSync(temporary, { recursive: true, force: true })
  evidence(cleaned ? 'profile.cleaned' : 'profile.cleanup_failed')
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    failure = `Profile interrupted by ${signal}`
    await cleanup()
    process.exit(signal === 'SIGINT' ? 130 : 143)
  })
}
async function browserUpload(size, complete = true) {
  return page.evaluate(
    async ({ workspaceId, size, complete }) => {
      const declared = await fetch('/api/files/uploads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, mime: 'image/png', size }),
      })
      if (!declared.ok) throw new Error('Upload declaration failed')
      const value = await declared.json()
      const bytes = new Uint8Array(size).fill(42)
      const put = await fetch(value.uploadUrl, {
        method: 'PUT',
        headers: value.headers,
        body: bytes,
      })
      if (!put.ok) throw new Error('Conditional upload failed')
      if (complete) {
        const confirmed = await fetch(`/api/files/${value.fileId}/complete`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId }),
        })
        if (!confirmed.ok) throw new Error('Upload confirmation failed')
      }
      return value
    },
    { workspaceId: env.WORKSPACE_ID, size, complete },
  )
}

try {
  env.DOCKER_HOST = run('docker', [
    'context',
    'inspect',
    '--format',
    '{{.Endpoints.docker.Host}}',
  ]).trim()
  const originalDockerConfig = env.DOCKER_CONFIG ?? join(env.HOME, '.docker')
  env.DOCKER_CONFIG = join(temporary, 'docker')
  mkdirSync(env.DOCKER_CONFIG)
  writeFileSync(
    join(env.DOCKER_CONFIG, 'config.json'),
    JSON.stringify({ cliPluginsExtraDirs: [join(originalDockerConfig, 'cli-plugins')] }),
  )
  mkdirSync(env.SECRETS_DIR)
  mkdirSync(fixture)
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
    '/CN=selfhost-c-profile-CA',
  ])
  certificate('postgres', ['postgres'])
  const deniedDomain = 'denied.selfhost-c-profile.test'
  certificate('caddy', [env.APP_DOMAIN, env.S3_PUBLIC_DOMAIN, deniedDomain])
  const appPassword = secret('app_db_password')
  const migratorPassword = secret('migrator_db_password')
  const cachePassword = secret('valkey_password')
  secret('postgres_password')
  secret('readonly_db_password')
  secret(
    'app_database_url',
    `postgres://app:${appPassword}@postgres:5432/${env.POSTGRES_DB}?sslmode=verify-full`,
  )
  secret(
    'migrator_database_url',
    `postgres://migrator:${migratorPassword}@postgres:5432/${env.POSTGRES_DB}?sslmode=verify-full`,
  )
  secret('valkey_url', `redis://default:${cachePassword}@valkey:6379`)
  for (const name of [
    'auth_secret',
    'google_client_secret',
    'github_client_secret',
    'turnstile_secret',
    's3_admin_access_key_id',
    's3_admin_secret_access_key',
    's3_access_key_id',
    's3_secret_access_key',
  ])
    secret(name)
  await build({
    entryPoints: [join(root, 'deploy/selfhost/acceptance-storage.ts')],
    outfile: join(fixture, 'storage.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    nodePaths: [join(root, 'packages/storage/node_modules')],
    logLevel: 'silent',
  })
  if (!process.argv.includes('--reuse-images')) {
    const context = join(temporary, 'source')
    for (const file of run('git', ['ls-files', '-z']).split('\0').filter(Boolean)) {
      mkdirSync(dirname(join(context, file)), { recursive: true })
      cpSync(join(root, file), join(context, file))
    }
    // A context 早于 C 的 maps 接线；仅临时验收副本补该构建输入，D 正式接线另交协调者。
    const dockerignore = join(context, 'deploy/selfhost/app.Dockerfile.dockerignore')
    writeFileSync(
      dockerignore,
      `${readFileSync(dockerignore, 'utf8')}\n!scripts/\n!scripts/sentry-node-maps.mjs\n`,
    )
    const template = join(context, 'template.config.ts')
    writeFileSync(
      template,
      readFileSync(template, 'utf8')
        .replace("oauth: ['google', 'github']", 'oauth: []')
        .replace('turnstile: true', 'turnstile: false'),
    )
    run('bash', [join(context, 'deploy/selfhost/build.sh')], {
      env: { ...env, APP_VERSION: version, IMAGE_NAMESPACE: 'selfhost-c-profile' },
      stdio: 'inherit',
    })
  }
  for (const service of ['web', 'jobs', 'migrate'])
    assert(
      run('docker', [
        'inspect',
        '--format',
        '{{index .Config.Labels "org.opencontainers.image.revision"}}',
        env[`${service.toUpperCase()}_IMAGE`],
      ]).trim() === version,
      'Acceptance image SHA differs',
    )
  run(
    'docker',
    [
      'build',
      '-f',
      join(root, 'deploy/selfhost/object-storage.Dockerfile'),
      '-t',
      env.OBJECT_STORAGE_IMAGE,
      root,
    ],
    { stdio: 'inherit' },
  )
  run(
    'docker',
    [
      'build',
      '-f',
      join(root, 'deploy/selfhost/acceptance-browser.Dockerfile'),
      '-t',
      browserImage,
      root,
    ],
    { stdio: 'inherit' },
  )
  const caddy = join(fixture, 'Caddyfile')
  writeFileSync(
    caddy,
    `${readFileSync(join(root, 'deploy/selfhost/Caddyfile.object-storage'), 'utf8')}\n${deniedDomain} {\n import /etc/caddy/tls-supplied.caddy\n respond "denied origin fixture"\n}\n`,
  )
  writeFileSync(
    composeFiles[2],
    `services:\n  jobs:\n    volumes: ['${fixture}:/fixture:ro']\n  caddy:\n    volumes: ['${caddy}:/etc/caddy/Caddyfile:ro']\n    networks:\n      ingress:\n        aliases: ['${deniedDomain}']\n`,
  )
  const externalEnvironment = {
    ...env,
    COMPOSE_PROFILES: '',
    SECRETS_DIR: join(temporary, 'not-created'),
  }
  for (const key of Object.keys(externalEnvironment)) {
    if (key.startsWith('S3_') || key === 'OBJECT_STORAGE_IMAGE') delete externalEnvironment[key]
  }
  const baseConfig = JSON.parse(
    run('docker', ['compose', '-f', composeFiles[0], 'config', '--format', 'json'], {
      env: externalEnvironment,
    }),
  )
  assert(
    !baseConfig.services['object-storage'] &&
      !Object.keys(baseConfig.secrets).some((s) => s.startsWith('s3_')),
    'Default Compose requires profile storage secrets',
  )
  const config = JSON.parse(compose('config', '--format', 'json'))
  const constant = ['postgres', 'valkey', 'web', 'jobs', 'caddy', 'object-storage']
  const limitsMiB = constant.reduce(
    (sum, name) => sum + config.services[name].mem_limit / 1024 ** 2,
    0,
  )
  const cpus = constant.reduce((sum, name) => sum + Number(config.services[name].cpus), 0)
  assert(limitsMiB <= 3328 && cpus <= 2.00001, 'Whole stack budget exceeds profile baseline')
  for (const [name, service] of Object.entries(config.services)) {
    assert(
      service.user && !service.user.startsWith('0') && !service.build,
      `Service ${name} non-root/image boundary failed`,
    )
    assert(name === 'caddy' || !service.ports?.length, `Service ${name} publishes internal ports`)
  }
  assert(
    config.services.caddy.ports
      .map((p) => p.published)
      .sort()
      .join(',') === '443,80',
    'Proxy public ports differ',
  )
  assert(
    !config.services.caddy.networks.data && !config.services['object-storage'].networks.data,
    'Storage proxy joined PG data network',
  )
  evidence('profile.config', {
    defaultStorage: false,
    limitsMiB,
    cpus,
    hostHeadroomMiB: 4096 - limitsMiB,
  })
  stackStarted = true
  sampling = true
  sampler = monitor().catch((error) => {
    sampling = false
    failure = error.message
  })
  await composeAsync('up', '-d', 'object-storage-init')
  await wait(async () => {
    const id = compose('ps', '-a', '-q', 'object-storage-init').trim()
    if (!id) return false
    const { State } = await engine(`/containers/${id}/json`)
    if (State.Status !== 'exited') return false
    assert(State.ExitCode === 0, 'Storage initialization failed')
    return true
  })
  await composeAsync('run', '--rm', '--no-deps', 'object-storage-init')
  await composeAsync('up', '-d', '--wait', '--wait-timeout', '180')
  evidence('profile.started')
  for (const name of constant)
    assert(
      Number(compose('exec', '-T', name, 'id', '-u').trim()) > 0,
      `Service ${name} runtime UID is root`,
    )
  helper('permissions')
  evidence('profile.permissions', {
    uidNonzero: true,
    appAdmin: false,
    initializationIdempotent: true,
  })
  run('docker', [
    'run',
    '-d',
    '--rm',
    '--init',
    '--name',
    browserName,
    '--network',
    `${project}_ingress`,
    '-p',
    '127.0.0.1::3000',
    '-v',
    `${fixture}:/fixture:ro`,
    '--shm-size=512m',
    browserImage,
  ])
  browserStarted = true
  const browserPort = run('docker', ['port', browserName, '3000/tcp']).trim().split(':').at(-1)
  await wait(async () => {
    try {
      browser = await chromium.connect(`ws://127.0.0.1:${browserPort}/`, { timeout: 1500 })
      return true
    } catch {
      return false
    }
  })
  const context = await browser.newContext({ ignoreHTTPSErrors: false })
  page = await context.newPage()
  await page.goto(env.APP_URL)
  const session = await page.evaluate(
    async (identity) => {
      const response = await fetch('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(identity),
      })
      if (!response.ok) throw new Error('Real auth signup failed')
      const signed = await response.json()
      const sessionResponse = await fetch('/api/auth/get-session?disableCookieCache=true')
      const session = await sessionResponse.json()
      if (!session?.user || session.user.id !== signed.user.id)
        throw new Error('Real session missing')
      return session
    },
    {
      email: `${randomUUID()}@profile.example.com`,
      password: randomBytes(24).toString('hex'),
      name: 'C profile acceptance',
    },
  )
  env.WORKSPACE_ID = session.user.id
  const cdp = await context.newCDPSession(page)
  await cdp.send('Network.enable')
  const methods = new Map()
  let successfulPreflights = 0
  let proxyErrors = 0
  cdp.on('Network.loadingFailed', ({ errorText, corsErrorStatus }) => {
    networkErrors.push({ errorText, corsError: corsErrorStatus?.corsError ?? null })
  })
  cdp.on('Network.responseReceivedExtraInfo', ({ statusCode }) => {
    if (statusCode === 503) proxyErrors++
  })
  cdp.on('Network.requestWillBeSent', ({ requestId, request }) => {
    methods.set(requestId, request.method)
  })
  cdp.on('Network.responseReceived', ({ requestId, response }) => {
    if (methods.get(requestId) === 'OPTIONS' && response.status < 300) successfulPreflights++
  })
  phase = 'idle'
  await delay(30_000)
  phase = 'browser_protocol'
  const object = await browserUpload(3)
  const key = new URL(object.uploadUrl).pathname.split('/').slice(2).join('/')
  assert(
    object.expiresIn === 600 && object.headers['If-None-Match'] === '*',
    'Conditional signature contract differs',
  )
  const signedHead = helper('head', key).url
  const checks = await page.evaluate(
    async ({ object, signedHead, workspaceId }) => {
      const duplicate = await fetch(object.uploadUrl, {
        method: 'PUT',
        headers: object.headers,
        body: new Uint8Array([1, 2, 3]),
      })
      const head = await fetch(signedHead, { method: 'HEAD' })
      const download = await fetch(
        `/api/files/${object.fileId}?workspaceId=${workspaceId}&download=1`,
      )
      const data = new Uint8Array(await download.arrayBuffer())
      const anonymous = await fetch(object.uploadUrl.split('?')[0])
      return {
        duplicate: duplicate.status,
        head: head.status,
        etag: Boolean(head.headers.get('etag')),
        size: Number(head.headers.get('content-length')),
        download: download.status,
        attachment: download.headers.get('content-disposition'),
        unchanged: data.length === 3 && data.every((b) => b === 42),
        anonymous: anonymous.status,
      }
    },
    { object, signedHead, workspaceId: env.WORKSPACE_ID },
  )
  assert(
    checks.duplicate === 412 &&
      checks.head === 200 &&
      checks.etag &&
      checks.size === 3 &&
      checks.download === 200 &&
      checks.attachment === 'attachment' &&
      checks.unchanged &&
      checks.anonymous === 403,
    'Browser S3 protocol assertion failed',
  )
  assert(successfulPreflights > 0, 'No actual browser OPTIONS observed')
  const deniedPage = await context.newPage()
  await deniedPage.goto(`https://${deniedDomain}`)
  const denied = await deniedPage.evaluate(
    async ({ url, headers }) => {
      try {
        await fetch(url, { method: 'PUT', headers, body: new Uint8Array([1, 2, 3]) })
        return false
      } catch {
        return true
      }
    },
    { url: object.uploadUrl, headers: object.headers },
  )
  assert(denied, 'Unapproved browser origin was not rejected')
  await deniedPage.close()
  evidence('profile.browser', {
    ...checks,
    successfulPreflights,
    deniedOrigin: denied,
    tlsValidation: true,
  })
  phase = 'concurrent_uploads'
  for (let round = 0; round < 3; round++)
    await Promise.all(Array.from({ length: 4 }, () => browserUpload(16 * 1024 ** 2)))
  evidence('profile.uploads', { concurrent: 4, rounds: 3, bytesPerUpload: 16 * 1024 ** 2 })
  phase = 'unknown_length_copy'
  const copied = await composeAsync(
    'exec',
    '-T',
    'jobs',
    'node',
    '/fixture/storage.cjs',
    'copy',
    '2',
  )
  evidence('profile.copy', JSON.parse(copied))
  phase = 'maintenance'
  const pending = []
  for (let i = 0; i < 8; i++) pending.push(await browserUpload(1024 ** 2, false))
  const ids = pending.map(({ fileId }) => `'${fileId}'`).join(',')
  sql(`update file set created_at = now() - interval '2 hours' where id in (${ids})`)
  const nextCron = Math.ceil(Date.now() / 600_000) * 600_000
  evidence('profile.maintenance_wait', {
    pending: pending.length,
    nextCron: new Date(nextCron).toISOString(),
  })
  await wait(() => sql(`select count(*) from file where id in (${ids})`) === '0', 660_000)
  const logs = compose('logs', '--no-log-prefix', 'jobs')
  assert(logs.includes('cron.files-cleanup'), 'Natural ten-minute cleanup did not run')
  for (const item of pending) {
    const url = helper('head', new URL(item.uploadUrl).pathname.split('/').slice(2).join('/')).url
    assert(
      (await page.evaluate(
        async (target) => (await fetch(target, { method: 'HEAD' })).status,
        url,
      )) === 404,
      'Maintenance object retained',
    )
  }
  evidence('profile.maintenance', { removed: pending.length, naturalCron: true })
  const readiness = await page.evaluate(async () => {
    const response = await fetch('/api/health')
    return { status: response.status, body: await response.json() }
  })
  assert(
    readiness.status === 200 &&
      readiness.body.version === version &&
      ['db', 'cache', 'queue', 'scheduler'].every((key) => readiness.body[key]?.status === 'up'),
    'Full stack readiness failed',
  )
  evidence('profile.readiness', {
    status: readiness.status,
    lastCronAt: readiness.body.scheduler.lastCronAt,
  })
  await checkpoint('before_proxy_failure')
  const failureHead = helper('head', key).url
  await composeAsync('stop', 'object-storage')
  const errorsBefore = proxyErrors
  await page.evaluate(async (target) => {
    // 代理故障不保证 CORS 响应；这里只验证服务器状态由容器内同证书客户端完成。
    try {
      await fetch(target, { method: 'HEAD' })
    } catch {}
    return true
  }, failureHead)
  await delay(250)
  assert(
    proxyErrors > errorsBefore &&
      !compose('logs', '--no-log-prefix', 'caddy').includes('X-Amz-Signature'),
    'Proxy failure logged signed query',
  )
  await composeAsync('start', 'object-storage')
  await waitForHealthy()
  evidence('profile.proxy_failure', { signedQueryLogged: false })
  phase = 'restart'
  await checkpoint('before_restart')
  await composeAsync('restart', 'object-storage', 'web', 'jobs')
  await waitForHealthy()
  await delay(10_000)
  await page.reload()
  assert(
    (await page.evaluate(
      async ({ id, workspaceId }) =>
        (
          await fetch(`/api/files/${id}?workspaceId=${workspaceId}`)
        ).status,
      { id: object.fileId, workspaceId: env.WORKSPACE_ID },
    )) === 200,
    'Object/session lost on restart',
  )
  await checkpoint('before_recreate')
  await composeAsync('down')
  await composeAsync('up', '-d', '--wait', '--wait-timeout', '180')
  await delay(10_000)
  await page.reload()
  assert(
    (await page.evaluate(
      async ({ id, workspaceId }) =>
        (
          await fetch(`/api/files/${id}?workspaceId=${workspaceId}`)
        ).status,
      { id: object.fileId, workspaceId: env.WORKSPACE_ID },
    )) === 200,
    'Object data lost on recreation',
  )
  evidence('profile.persistence', { restart: true, recreate: true })
  sampling = false
  await sampler
  await checkpoint('after_recreate')
  for (const name of [
    'idle',
    'concurrent_uploads',
    'unknown_length_copy',
    'maintenance',
    'restart',
  ]) {
    const result = measurements[name]
    assert(
      result?.samples > 0 && constant.every((service) => result.services[service]),
      `Incomplete resource samples for ${name}`,
    )
  }
  for (const value of Object.values(measurements)) {
    value.averageCores = value.cpuCoreSum / value.samples
    delete value.cpuCoreSum
  }
  evidence('profile.resources', { budgetMiB: 4096, limitsMiB, measurements })
  for (const service of ['object-storage', 'web', 'jobs', 'caddy']) {
    const log = compose('logs', '--no-log-prefix', service)
    for (const name of [
      's3_access_key_id',
      's3_secret_access_key',
      's3_admin_access_key_id',
      's3_admin_secret_access_key',
    ])
      assert(
        !log.includes(readFileSync(join(env.SECRETS_DIR, name), 'utf8')),
        'Storage log contains credentials',
      )
    assert(!log.includes('X-Amz-Signature'), 'Storage log contains signed query')
  }
  assert(!failure, failure)
  evidence('profile.passed')
} catch (error) {
  failure = error instanceof Error ? error.message : 'Unknown profile acceptance failure'
  evidence('profile.failed', { phase, networkErrors })
} finally {
  await cleanup()
}
if (failure) {
  console.error(failure)
  process.exitCode = 1
}
