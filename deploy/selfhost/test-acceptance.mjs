import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// 只在隔离目录/镜像变体中改模板；默认生产配置与 sender 均不增加测试入口。
const root = resolve(import.meta.dirname, '../..')
const temporary = mkdtempSync(join(tmpdir(), 'selfhost-final-compose-'))
chmodSync(temporary, 0o700)
const project = 'selfhost-final-compose'
const version = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const context = join(temporary, 'source')
const fixture = join(root, 'apps/web/e2e/selfhost')
const composeFile = join(root, 'deploy/selfhost/compose.yaml')
const override = join(temporary, 'override.yaml')
const env = {
  ...process.env,
  APP_VERSION: version,
  COMPOSE_PROJECT_NAME: project,
  COMPOSE_PROFILES: 'caddy',
  APP_DOMAIN: 'selfhost-final.local',
  APP_URL: 'https://selfhost-final.local',
  CADDY_TLS_MODE: 'supplied',
  POSTGRES_DB: 'product_res_wt_selfhost_final_compose',
  CACHE_NAMESPACE: project,
  EMAIL_TRANSPORT: 'log',
  GOOGLE_CLIENT_ID: 'unused-fixture',
  GITHUB_CLIENT_ID: 'unused-fixture',
  TURNSTILE_SITE_KEY: 'unused-fixture',
  LOG_MAX_SIZE: '20k',
  LOG_MAX_FILE: '3',
  SECRETS_DIR: join(temporary, 'secrets'),
  PG_TLS_DIR: join(temporary, 'certs/postgres'),
  CA_FILE: join(temporary, 'certs/ca.crt'),
  CADDY_CERT_DIR: join(temporary, 'certs/caddy'),
}
for (const service of ['web', 'jobs', 'migrate', 'postgres', 'valkey', 'caddy'])
  env[`${service.toUpperCase()}_IMAGE`] = `selfhost-final/${service}:${version}`
function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, env, stdio: 'inherit', ...options })
}
const capture = (command, args) =>
  run(command, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
const compose = (...args) => run('docker', ['compose', '-f', composeFile, '-f', override, ...args])
const composeOutput = (...args) =>
  capture('docker', ['compose', '-f', composeFile, '-f', override, ...args])
const fail = (condition, reason) => {
  if (!condition) throw new Error(reason)
}
const evidence = (event, details = {}) =>
  console.info(JSON.stringify({ event, version, ...details }))
function secret(name, value = randomBytes(32).toString('hex')) {
  writeFileSync(join(env.SECRETS_DIR, name), value, { mode: 0o644 })
  return value
}
function certificate(name, san) {
  const directory = join(temporary, 'certs', name)
  mkdirSync(directory, { recursive: true })
  const extension = join(directory, 'extensions')
  writeFileSync(extension, `subjectAltName=DNS:${san}\nextendedKeyUsage=serverAuth\n`)
  run(
    'openssl',
    [
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
    ],
    { stdio: 'ignore' },
  )
  run(
    'openssl',
    [
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
      extension,
    ],
    { stdio: 'ignore' },
  )
  chmodSync(join(directory, 'server.key'), 0o644)
}
async function health(expected, component) {
  const result = JSON.parse(
    composeOutput(
      'exec',
      '-T',
      'web',
      'node',
      '-e',
      `fetch('http://127.0.0.1:3000/api/health').then(async r=>console.log(JSON.stringify({code:r.status,cache:r.headers.get('cache-control'),body:await r.json()})))`,
    ),
  )
  const statuses = ['db', 'cache', 'queue', 'scheduler']
    .map((name) => `${name}=${result.body[name]?.status}`)
    .join(', ')
  fail(
    result.code === expected,
    `health status: expected ${expected}, got ${result.code}; ${statuses}`,
  )
  fail(
    result.cache === 'no-store' && result.body.version === version,
    'health version/cache mismatch',
  )
  fail(
    !/postgres:|redis:|password|secret|private-host/.test(JSON.stringify(result)),
    'health leaked dependency details',
  )
  if (component) fail(result.body[component].status === 'down', `health ${component} not down`)
  return result
}
async function waitForRecovery() {
  let lastFailure
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      return await health(200)
    } catch (error) {
      // 消费者启动是异步的；只等待未就绪状态，版本/泄密等断言仍立即失败。
      if (!(error instanceof Error) || !error.message.startsWith('health status:')) throw error
      lastFailure = error
      await delay(1000)
    }
  }
  throw lastFailure
}
function userCount() {
  // app 查询使用与应用相同的 TLS 校验；密码只在容器内读 file secret。
  return Number(
    composeOutput(
      'exec',
      '-T',
      'postgres',
      'sh',
      '-c',
      `export PGPASSWORD="$(cat /run/secrets/app_db_password)" PGSSLMODE=verify-full PGSSLROOTCERT=/run/certs/ca.crt; exec psql -h postgres -U app -d "$POSTGRES_DB" -tAc "select count(*) from \\"user\\" where email like 'selfhost-final-%'"`,
    ).trim(),
  )
}
// 只输出非敏感进程身份；不把 owner token、邮件正文或密码写入日志。
function ownerIdentity(service) {
  return JSON.parse(
    composeOutput(
      'exec',
      '-T',
      service,
      'node',
      '-e',
      "const fs=require('node:fs');const crypto=require('node:crypto');const dir=process.env.JOB_OWNERSHIP_DIRECTORY;const stat=fs.statSync(dir);if(stat.uid!==1000||(stat.mode&511)!==448)throw Error('owner directory permissions');const key=crypto.createHash('sha256').update('product-res-job-engine:'+process.env.JOB_EXECUTOR_ID).digest('hex');const {host,pid,pidNamespace,bootId,startTime}=JSON.parse(fs.readFileSync(dir+'/'+key+'.json','utf8'));if(!bootId||!startTime)process.exit(1);console.log(JSON.stringify({host,pid,pidNamespace,bootId,startTime,retained:fs.readdirSync(dir).filter(n=>n.startsWith(key+'.')).length}))",
    ),
  )
}
async function verifyReplica(stopped, active) {
  compose('stop', stopped)
  const email = composeOutput(
    'exec',
    '-T',
    'web',
    'node',
    '-e',
    "const crypto=require('node:crypto');const email='selfhost-final-replica-'+crypto.randomUUID()+'@example.com';fetch('http://127.0.0.1:3000/api/auth/sign-up/email',{method:'POST',headers:{'content-type':'application/json',origin:process.env.APP_URL},body:JSON.stringify({email,name:'Replica probe',password:crypto.randomBytes(24).toString('hex')})}).then(r=>{if(!r.ok)throw Error('replica signup status '+r.status);console.log(email)})",
  ).trim()
  let delivered = false
  for (let attempt = 0; attempt < 30; attempt++) {
    const count = composeOutput(
      'exec',
      '-T',
      'capture',
      'node',
      '-e',
      "fetch('http://127.0.0.1:8025/emails?to='+encodeURIComponent(process.argv[1])).then(r=>r.json()).then(r=>console.log(r.length))",
      email,
    ).trim()
    if (count === '1') {
      delivered = true
      break
    }
    await delay(1000)
  }
  fail(delivered, `remaining replica ${active} did not deliver verification email`)
  compose('start', stopped)
  compose('up', '-d', '--wait', '--wait-timeout', '180')
  evidence('selfhost.acceptance.replica', { active, restarted: stopped, delivered: true })
}
let stackStarted = false
let acceptanceFailure
try {
  // 公共基础镜像使用匿名拉取；不读取宿主 Docker Hub 凭据或阻塞在桌面凭据 helper。
  const dockerHost = capture('docker', [
    'context',
    'inspect',
    '--format',
    '{{.Endpoints.docker.Host}}',
  ]).trim()
  const originalDockerConfig = env.DOCKER_CONFIG ?? join(env.HOME, '.docker')
  env.DOCKER_HOST = dockerHost
  env.DOCKER_CONFIG = join(temporary, 'docker')
  mkdirSync(env.DOCKER_CONFIG)
  writeFileSync(
    join(env.DOCKER_CONFIG, 'config.json'),
    JSON.stringify({
      cliPluginsExtraDirs: [join(originalDockerConfig, 'cli-plugins')],
    }),
  )
  env.DOCKER_BUILDKIT = '1'
  mkdirSync(env.SECRETS_DIR)
  mkdirSync(join(temporary, 'certs'))
  run(
    'openssl',
    [
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
      '/CN=selfhost-final-CA',
    ],
    { stdio: 'ignore' },
  )
  certificate('postgres', 'postgres')
  certificate('caddy', 'selfhost-final.local')
  const appPassword = secret('app_db_password')
  const migratorPassword = secret('migrator_db_password')
  secret('postgres_password')
  secret('readonly_db_password')
  const cachePassword = secret('valkey_password')
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
    'resend_key',
  ])
    secret(name)
  // git 文件清单避免 node_modules、dotenv、构建目录或其他 worktree 的凭据进入 context。
  const files = capture('git', ['ls-files', '-z']).split('\0').filter(Boolean)
  for (const file of files) {
    mkdirSync(dirname(join(context, file)), { recursive: true })
    cpSync(join(root, file), join(context, file))
  }
  const templatePath = join(context, 'template.config.ts')
  const template = readFileSync(templatePath, 'utf8')
    .replace('multiTenant: false', 'multiTenant: true')
    .replace('requireEmailVerification: false', 'requireEmailVerification: true')
    .replace("oauth: ['google', 'github']", 'oauth: []')
    .replace('turnstile: true', 'turnstile: false')
  writeFileSync(templatePath, template)
  evidence('selfhost.acceptance.template', {
    multiTenant: true,
    requireEmailVerification: true,
    turnstile: false,
  })
  for (const target of ['web', 'jobs', 'migrate'])
    run('docker', [
      'build',
      '-f',
      join(context, 'deploy/selfhost/app.Dockerfile'),
      '--target',
      target,
      '--build-arg',
      `APP_VERSION=${version}`,
      '-t',
      env[`${target.toUpperCase()}_IMAGE`],
      context,
    ])
  for (const service of ['postgres', 'valkey', 'caddy'])
    run('docker', [
      'build',
      '-f',
      join(context, `deploy/selfhost/${service}.Dockerfile`),
      '-t',
      env[`${service.toUpperCase()}_IMAGE`],
      context,
    ])
  writeFileSync(
    override,
    `services:
  postgres:
    volumes: ['${env.CA_FILE}:/run/certs/ca.crt:ro']
  jobs: &fixture-jobs
    hostname: selfhost-final-jobs-1
    mem_limit: 384m
    cpus: 0.15
    command: [node, --import, /fixture/preload.mjs, server/index.mjs]
    environment:
      EMAIL_TRANSPORT: resend
      RESEND_API_KEY_FILE: /run/secrets/resend_key
      EMAIL_FROM: 'Fixture <fixture@example.com>'
      JOB_EXECUTOR_ID: selfhost-final-jobs-1
    secrets: [resend_key]
    volumes: ['${fixture}:/fixture:ro']
    depends_on:
      capture: {condition: service_healthy}
  jobs-2:
    extends: {file: '${composeFile}', service: jobs}
    <<: *fixture-jobs
    hostname: selfhost-final-jobs-2
    environment:
      EMAIL_TRANSPORT: resend
      RESEND_API_KEY_FILE: /run/secrets/resend_key
      EMAIL_FROM: 'Fixture <fixture@example.com>'
      JOB_EXECUTOR_ID: selfhost-final-jobs-2
      JOB_OWNERSHIP_DIRECTORY: /app/.data/job-owners
  capture:
    image: node:22-bookworm-slim
    user: '1000:1000'
    command: [node, /fixture/capture.mjs]
    volumes: ['${fixture}:/fixture:ro']
    networks: [data]
    restart: unless-stopped
    mem_limit: 64m
    cpus: 0.1
    healthcheck:
      test: [CMD, node, -e, "fetch('http://127.0.0.1:8025/health').then(r=>process.exit(r.ok?0:1))"]
      interval: 2s
      retries: 20
    logging:
      driver: json-file
      options: {max-size: 20k, max-file: '3'}
    stop_grace_period: 45s
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
networks:
  data: {internal: true}
secrets:
  resend_key: {file: '${env.SECRETS_DIR}/resend_key'}
`,
  )
  const config = JSON.parse(composeOutput('config', '--format', 'json'))
  for (const [name, service] of Object.entries(config.services)) {
    fail(!service.build && service.user && !service.user.startsWith('0'), `${name}: image/non-root`)
    fail(
      service.healthcheck &&
        service.mem_limit &&
        service.cpus &&
        service.logging.options['max-file'] === '3',
      `${name}: missing boundary`,
    )
    fail(name === 'caddy' || !service.ports?.length, `${name}: externally exposed`)
  }
  fail(
    config.services.caddy.ports
      .map((p) => String(p.published))
      .sort()
      .join(',') === '443,80',
    'proxy port mismatch',
  )
  fail(
    config.services.web.depends_on.migrate.condition === 'service_completed_successfully' &&
      config.services.jobs.depends_on.migrate.condition === 'service_completed_successfully' &&
      config.services['jobs-2'].depends_on.migrate.condition === 'service_completed_successfully',
    'migration gate mismatch',
  )
  const ownerVolumes = ['jobs', 'jobs-2'].map((service) =>
    config.services[service].volumes.find((volume) => volume.target === '/app/.data/job-owners'),
  )
  fail(
    ownerVolumes.every((volume) => volume?.type === 'volume') &&
      ownerVolumes[0].source === ownerVolumes[1].source,
    'replicas do not share persistent owner volume',
  )
  evidence('selfhost.acceptance.config', {
    nonRoot: true,
    ports: [80, 443],
    logRotation: '20k x 3',
  })
  fail(
    !capture('docker', [
      'ps',
      '-a',
      '--filter',
      `label=com.docker.compose.project=${project}`,
      '--format',
      '{{.ID}}',
    ]).trim(),
    'acceptance project already exists',
  )
  fail(
    !capture('docker', [
      'volume',
      'ls',
      '--filter',
      `label=com.docker.compose.project=${project}`,
      '--format',
      '{{.Name}}',
    ]).trim(),
    'acceptance volumes not fresh',
  )
  stackStarted = true
  compose('up', '-d', '--wait', '--wait-timeout', '180')
  const migration = JSON.parse(
    composeOutput('ps', '-a', '--format', 'json')
      .split('\n')
      .find((line) => JSON.parse(line).Service === 'migrate'),
  )
  fail(migration.ExitCode === 0, 'migrate did not complete')
  const migrationLogs = composeOutput('logs', '--no-log-prefix', 'migrate')
  fail(
    migrationLogs.indexOf('selfhost.db:migrate.completed') <
      migrationLogs.indexOf('selfhost.dbos:migrate.completed'),
    'migration order mismatch',
  )
  for (const service of ['postgres', 'valkey', 'web', 'jobs', 'jobs-2', 'caddy', 'capture'])
    fail(
      Number(composeOutput('exec', '-T', service, 'id', '-u').trim()) > 0,
      `${service}: root process`,
    )
  // 必须等真实五分钟 heartbeat，不能通过写 setting 假造成功。
  let ready
  for (let attempt = 0; attempt < 65; attempt++) {
    const probe = JSON.parse(
      composeOutput(
        'exec',
        '-T',
        'web',
        'node',
        '-e',
        "fetch('http://127.0.0.1:3000/api/health').then(async r=>console.log(JSON.stringify({code:r.status,body:await r.json()})))",
      ),
    )
    if (probe.code === 200) {
      ready = await health(200)
      break
    }
    await delay(5000)
  }
  fail(ready, 'real cron heartbeat did not become ready')
  evidence('selfhost.acceptance.ready', ready)
  run(
    'curl',
    [
      '--fail',
      '--silent',
      '--show-error',
      '--cacert',
      env.CA_FILE,
      '--resolve',
      'selfhost-final.local:443:127.0.0.1',
      'https://selfhost-final.local/api/health',
    ],
    { stdio: 'ignore' },
  )
  evidence('selfhost.acceptance.tls', { verified: true })
  const permissions = composeOutput(
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'postgres',
    '-d',
    env.POSTGRES_DB,
    '-tAc',
    "select has_schema_privilege('app','public','CREATE'), has_database_privilege('app',current_database(),'CREATE'), has_table_privilege('app','audit_log','UPDATE'), has_table_privilege('readonly','user','INSERT')",
  )
  fail(permissions.trim() === 'f|f|f|f', 'database role permissions widened')
  evidence('selfhost.acceptance.permissions', {
    appDDL: false,
    auditUpdate: false,
    readonlyWrite: false,
  })
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
    {
      env: {
        ...env,
        SELFHOST_COMPOSE_FILE: `${composeFile}:${override}`,
        SELFHOST_BASE_URL: env.APP_URL,
      },
    },
  )
  const ownersBefore = [ownerIdentity('jobs'), ownerIdentity('jobs-2')]
  fail(ownersBefore[0].host !== ownersBefore[1].host, 'replicas share hostname')
  compose('stop', 'jobs', 'jobs-2')
  await health(503, 'queue')
  compose('start', 'jobs', 'jobs-2')
  await waitForRecovery()
  await verifyReplica('jobs', 'jobs-2')
  await verifyReplica('jobs-2', 'jobs')
  compose('stop', 'valkey')
  await health(503, 'cache')
  compose('start', 'valkey')
  // 缓存驱动不自动重放故障期操作；重启依赖进程后恢复真实连接。
  compose('restart', 'web', 'jobs', 'jobs-2')
  compose('up', '-d', '--wait', '--wait-timeout', '180')
  await waitForRecovery()
  evidence('selfhost.acceptance.failures', { stoppedJobs: 503, stoppedCache: 503 })
  const usersBefore = userCount()
  fail(usersBefore > 0, 'application users not persisted')
  compose(
    'exec',
    '-T',
    'valkey',
    'sh',
    '-c',
    'export REDISCLI_AUTH="$(cat /run/secrets/valkey_password)"; valkey-cli SET selfhost-final-persistence present >/dev/null',
  )
  compose('down')
  compose('up', '-d', '--wait', '--wait-timeout', '180')
  fail(userCount() === usersBefore, 'Postgres user data lost')
  fail(
    composeOutput(
      'exec',
      '-T',
      'valkey',
      'sh',
      '-c',
      'export REDISCLI_AUTH="$(cat /run/secrets/valkey_password)"; valkey-cli GET selfhost-final-persistence',
    ).trim() === 'present',
    'Valkey data lost',
  )
  await waitForRecovery()
  for (const [index, service] of ['jobs', 'jobs-2'].entries()) {
    const current = ownerIdentity(service)
    const old = ownersBefore[index]
    fail(current.host === old.host && current.pid === old.pid, 'stable replica identity changed')
    fail(current.pidNamespace !== old.pidNamespace, 'container namespace did not change')
    fail(current.retained > old.retained, 'prior incarnation records were not preserved')
  }
  evidence('selfhost.acceptance.persistence', { postgres: true, valkey: true, ownership: true })
  // 写入应用主进程 stdout，实际跨越 Docker json-file 大小阈值；helper只读本任务日志目录。
  compose(
    'exec',
    '-T',
    'web',
    'node',
    '-e',
    "const fs=require('node:fs');for(let i=0;i<800;i++)fs.writeFileSync('/proc/1/fd/1',JSON.stringify({event:'selfhost.acceptance.rotation',requestId:'selfhost-final-rotation',index:i,padding:'x'.repeat(200)})+'\\n')",
  )
  await delay(1000)
  const webId = composeOutput('ps', '-q', 'web').trim()
  const logPath = capture('docker', ['inspect', '--format', '{{.LogPath}}', webId]).trim()
  const rotated = capture('docker', [
    'run',
    '--rm',
    '--name',
    'selfhost-final-log-inspect',
    '-v',
    `${dirname(logPath)}:/logs:ro`,
    'busybox:latest',
    'sh',
    '-c',
    'ls /logs/*json.log*',
  ])
    .trim()
    .split('\n')
  fail(
    rotated.length === 3 && rotated.some((path) => path.endsWith('.2')),
    'actual Docker log rotation missing',
  )
  const logs = composeOutput('logs', '--no-log-prefix', 'web')
  fail(logs.includes('selfhost-final-rotation'), 'rotated logs lost requestId')
  for (const name of [
    'app_database_url',
    'migrator_database_url',
    'valkey_url',
    'auth_secret',
    'resend_key',
  ])
    fail(!logs.includes(readFileSync(join(env.SECRETS_DIR, name), 'utf8')), 'logs leaked secret')
  evidence('selfhost.acceptance.rotation', {
    retainedFiles: rotated.length,
    requestId: true,
    secrets: false,
  })
  evidence('selfhost.acceptance.passed')
} catch (error) {
  acceptanceFailure = error
} finally {
  let cleanupCompleted = false
  try {
    if (stackStarted) compose('down', '-v', '--remove-orphans')
    cleanupCompleted = true
  } catch (cleanupFailure) {
    // 不掩盖原始验收失败；即使 Docker 失联，也必须删除本任务临时密钥。
    acceptanceFailure = acceptanceFailure
      ? new AggregateError([acceptanceFailure, cleanupFailure], 'Acceptance and cleanup failed')
      : cleanupFailure
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
  evidence(cleanupCompleted ? 'selfhost.acceptance.cleaned' : 'selfhost.acceptance.cleanup_failed')
}
if (acceptanceFailure) throw acceptanceFailure
