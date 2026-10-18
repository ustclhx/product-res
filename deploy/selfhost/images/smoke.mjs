import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const root = resolve(import.meta.dirname, '../../..')
const [sha, arch, directory] = process.argv.slice(2)
if (!/^[a-f0-9]{40}$/.test(sha ?? '') || !['amd64', 'arm64'].includes(arch) || !directory)
  throw new Error('Usage: smoke.mjs <fullSha> <amd64|arm64> <output-dir>')
const output = resolve(directory)
const catalog = JSON.parse(readFileSync(join(import.meta.dirname, 'catalog.json'), 'utf8'))
const temporary = mkdtempSync(join(tmpdir(), 'selfhost-images-smoke-'))
chmodSync(temporary, 0o700)
const project = `selfhost-images-${randomBytes(6).toString('hex')}`
const subnet = `172.25.${randomBytes(1)[0]}.0/28`
const prefix = subnet.slice(0, subnet.lastIndexOf('.') + 1)
const override = join(temporary, 'smoke.yaml')
const env = {
  ...process.env,
  COMPOSE_PROJECT_NAME: project,
  COMPOSE_PROFILES: 'caddy',
  APP_DOMAIN: 'selfhost-smoke.test',
  APP_URL: 'https://selfhost-smoke.test',
  // 故意提供不同版本，证明编译时 SHA 不被运行环境覆盖。
  APP_VERSION: '0'.repeat(40) === sha ? '1'.repeat(40) : '0'.repeat(40),
  CADDY_TLS_MODE: 'supplied',
  POSTGRES_DB: 'selfhost_smoke',
  CACHE_NAMESPACE: project,
  JOB_EXECUTOR_ID: `${project}-jobs`,
  GOOGLE_CLIENT_ID: 'smoke-unused',
  GITHUB_CLIENT_ID: 'smoke-unused',
  TURNSTILE_SITE_KEY: 'smoke-unused',
  EMAIL_TRANSPORT: 'log',
  TRUSTED_PROXY_CIDRS: `${prefix}2/32`,
  SECRETS_DIR: join(temporary, 'secrets'),
  PG_TLS_DIR: join(temporary, 'certs/postgres'),
  CA_FILE: join(temporary, 'certs/ca.crt'),
  CADDY_CERT_DIR: join(temporary, 'certs/caddy'),
}
const image = (name) => `local/selfhost/${name}:${sha}`
for (const service of catalog.services)
  env[`${service.name.toUpperCase().replaceAll('-', '_')}_IMAGE`] = image(service.name)
const composeArgs = [
  'compose',
  '--env-file',
  '/dev/null',
  '-f',
  join(root, 'deploy/selfhost/compose.yaml'),
  '-f',
  override,
]
const services = []
const tooling = {}
let started = false
let failure
let nativeSmoke = false
function run(command, args, timeout = 60_000) {
  try {
    return execFileSync(command, args, {
      cwd: root,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
      timeout,
    })
  } catch {
    // Docker/驱动原始错误可能携带环境与连接配置，失败只给固定操作摘要。
    throw new Error(`Smoke command failed: ${command} ${args[0]}`)
  }
}
const compose = (...args) => run('docker', [...composeArgs, ...args], 210_000)
const assert = (condition, reason) => {
  if (!condition) throw new Error(reason)
}
function secret(name, value = randomBytes(32).toString('hex')) {
  // 父目录0700；文件挂载需允许镜像内的三个不同非 root UID 读取。
  writeFileSync(join(env.SECRETS_DIR, name), value, { mode: 0o644 })
  return value
}
function certificate(name, san) {
  const dir = join(temporary, 'certs', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'extensions'), `subjectAltName=DNS:${san}\nextendedKeyUsage=serverAuth\n`)
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
    `/CN=${san}`,
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
function probe(service, path) {
  const port = service === 'web' ? 3000 : 3001
  return JSON.parse(
    compose(
      'exec',
      '-T',
      service,
      'node',
      '-e',
      `fetch('http://127.0.0.1:${port}${path}',{signal:AbortSignal.timeout(5000)}).then(async r=>console.log(JSON.stringify({status:r.status,body:await r.json()}))).catch(()=>process.exit(1))`,
    ),
  )
}
try {
  tooling.docker = run('docker', [
    'version',
    '--format',
    'client={{.Client.Version}} server={{.Server.Version}}',
  ]).trim()
  tooling.compose = run('docker', ['compose', 'version', '--short']).trim()
  tooling.buildx = run('docker', ['buildx', 'version']).trim()
  for (const { name } of catalog.services) {
    const [config] = JSON.parse(run('docker', ['image', 'inspect', image(name)]))
    assert(config.Architecture === arch && config.Os === 'linux', `${name}: architecture mismatch`)
    assert(
      config.Config.Labels?.['org.opencontainers.image.revision'] === sha,
      `${name}: revision mismatch`,
    )
    const user = config.Config.User.split(':')[0]
    assert(user && user !== 'root' && !/^0+$/.test(user), `${name}: image configured as root`)
    const uid = Number(
      run('docker', [
        'run',
        '--rm',
        '--network',
        'none',
        '--entrypoint',
        'id',
        image(name),
        '-u',
      ]).trim(),
    )
    assert(uid > 0, `${name}: configured UID is root`)
    const binary = {
      web: 'node',
      jobs: 'node',
      migrate: 'node',
      postgres: 'postgres',
      valkey: 'valkey-server',
      caddy: 'caddy',
      'object-storage': 'weed',
      backup: 'wal-g',
    }[name]
    assert(binary, `${name}: missing binary version smoke`)
    const flag = ['caddy', 'object-storage'].includes(name) ? 'version' : '--version'
    const runtimeVersion = run('docker', [
      'run',
      '--rm',
      '--network',
      'none',
      '--entrypoint',
      binary,
      image(name),
      flag,
    ]).trim()
    assert(runtimeVersion, `${name}: missing runtime version`)
    services.push({ name, passed: false, uid, revision: sha, runtimeVersion })
  }
  const native = run('docker', ['run', '--rm', '--network', 'none', image('native-smoke')])
  assert(/native sharp module loaded, uid=[1-9][0-9]*/.test(native), 'native sharp smoke failed')
  nativeSmoke = true
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
    '/CN=selfhost-smoke-CA',
  ])
  certificate('postgres', 'postgres')
  certificate('caddy', env.APP_DOMAIN)
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
  writeFileSync(
    override,
    `services:
  web:
    environment: {APP_VERSION: '${env.APP_VERSION}'}
    networks:
      ingress: {ipv4_address: '${prefix}3'}
  jobs:
    environment: {APP_VERSION: '${env.APP_VERSION}'}
  caddy:
    ports: !reset []
    networks:
      ingress: {ipv4_address: '${prefix}2'}
  object-storage:
    image: '${image('object-storage')}'
    user: '1000:1000'
    environment:
      S3_PUBLIC_DOMAIN: storage.selfhost-smoke.test
      S3_BUCKET: smoke-files
      S3_ADMIN_ACCESS_KEY_ID_FILE: /run/secrets/s3_admin_access_key_id
      S3_ADMIN_SECRET_ACCESS_KEY_FILE: /run/secrets/s3_admin_secret_access_key
      S3_ACCESS_KEY_ID_FILE: /run/secrets/s3_access_key_id
      S3_SECRET_ACCESS_KEY_FILE: /run/secrets/s3_secret_access_key
      GOMEMLIMIT: 384MiB
      GOMAXPROCS: '1'
    secrets: [s3_admin_access_key_id, s3_admin_secret_access_key, s3_access_key_id, s3_secret_access_key]
    volumes: [object_data:/data, object_metadata:/metadata]
    tmpfs: ['/tmp:uid=1000,gid=1000,mode=0700']
    networks: [object]
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    mem_limit: 512m
    cpus: 0.3
    healthcheck:
      test: [CMD, /usr/local/bin/object-storage-health]
      interval: 2s
      timeout: 3s
      retries: 60
networks:
  data: {internal: true}
  object: {internal: true}
  ingress:
    internal: true
    ipam:
      config: !override [{subnet: '${subnet}'}]
volumes:
  object_data: {}
  object_metadata: {}
secrets:
  s3_admin_access_key_id: {file: '${env.SECRETS_DIR}/s3_admin_access_key_id'}
  s3_admin_secret_access_key: {file: '${env.SECRETS_DIR}/s3_admin_secret_access_key'}
  s3_access_key_id: {file: '${env.SECRETS_DIR}/s3_access_key_id'}
  s3_secret_access_key: {file: '${env.SECRETS_DIR}/s3_secret_access_key'}
`,
  )
  run('python3', [
    '-m',
    'unittest',
    'discover',
    '-s',
    join(root, 'deploy/selfhost/backup'),
    '-p',
    '*test*.py',
  ])
  // 备份使用自己的隔离 PG/S3 fixture，必须完成真实备份与恢复才算 runtime smoke。
  try {
    run(
      'node',
      [
        join(root, 'deploy/selfhost/test-backup.mjs'),
        '--restore',
        '--sha',
        sha,
        '--output',
        output,
      ],
      600_000,
    )
  } catch (error) {
    // 原始输出不透传；只附加验收脚本自身写入证据的固定阶段与原因，CI 才能定位失败断言。
    let failed
    let observer
    try {
      const events = JSON.parse(readFileSync(join(output, 'backup-smoke.json'), 'utf8')).events
      failed = events.find((item) => item.event === 'backup.failed')
      observer = events.find((item) => item.event === 'backup.sampling_failed')
    } catch {}
    if (!failed) throw error
    // 失败job没有发布artifact；仅透出观察者固定分类/退出元数据，不能再丢失首个错误。
    const diagnostic = observer
      ? JSON.stringify({
          phase: observer.phase,
          reason: observer.reason,
          exitCode: observer.exitCode,
          code: observer.code,
          signal: observer.signal,
          killed: observer.killed,
          service: observer.service,
          keys: observer.keys,
          lineCount: observer.lineCount,
        })
      : 'none'
    throw new Error(
      `${error.message} (phase=${failed.phase}; reason=${failed.reason}; observer=${diagnostic})`,
    )
  }
  const backupEvidence = JSON.parse(readFileSync(join(output, 'backup-smoke.json'), 'utf8'))
  assert(backupEvidence.passed && backupEvidence.cleaned, 'backup real runtime smoke failed')
  const config = JSON.parse(compose('config', '--format', 'json'))
  assert(
    Object.values(config.services).every((service) => !service.build && !service.ports?.length),
    'smoke exposes host ports or builds',
  )
  started = true
  compose('up', '-d', '--wait', '--wait-timeout', '180')
  const migrationId = compose('ps', '-a', '-q', 'migrate').trim()
  const [migration] = JSON.parse(run('docker', ['inspect', migrationId]))
  assert(migration.State.Status === 'exited' && migration.State.ExitCode === 0, 'migration failed')
  const logs = compose('logs', '--no-log-prefix', 'migrate')
  const sqlAt = logs.indexOf('selfhost.db:migrate.completed')
  const dbosAt = logs.indexOf('selfhost.dbos:migrate.completed')
  assert(sqlAt >= 0 && dbosAt > sqlAt, 'migration order failed')
  for (const service of services) {
    if (service.name === 'backup') {
      const runtimeUid = backupEvidence.events.find(
        (item) => item.event === 'backup.real_cycle',
      )?.runtimeUid
      assert(runtimeUid === service.uid, 'backup: actual PID1 UID differs')
      assert(backupEvidence.sha === sha, 'backup: source revision differs')
      service.runtimeUid = runtimeUid
      service.realBackupRestore = true
      service.passed = true
      continue
    }
    assert(config.services[service.name], `${service.name}: missing runtime smoke`)
    if (service.name !== 'migrate') {
      const status = compose('exec', '-T', service.name, 'cat', '/proc/1/status')
      const uid = Number(status.match(/^Uid:\s+(\d+)/m)?.[1])
      assert(uid > 0 && uid === service.uid, `${service.name}: PID1 UID mismatch`)
      service.runtimeUid = uid
    }
    service.passed = true
  }
  for (const name of ['web', 'jobs']) {
    const live = probe(name, '/internal/live')
    assert(live.status === 200 && live.body.version === sha, `${name}: baked version mismatch`)
  }
  let readiness
  const deadline = Date.now() + 360_000
  while (Date.now() < deadline) {
    const result = probe('web', '/api/health')
    assert(result.body.version === sha, 'readiness SHA mismatch')
    if (result.status === 200) {
      readiness = result.body
      break
    }
    assert(result.status === 503, 'unexpected readiness response')
    await delay(5000)
  }
  assert(
    readiness &&
      ['db', 'cache', 'queue', 'scheduler'].every((name) => readiness[name]?.status === 'up') &&
      readiness.scheduler.lastCronAt,
    'real runtime readiness timed out',
  )
  const jobsReady = probe('jobs', '/internal/ready')
  assert(
    jobsReady.status === 200 && jobsReady.body.version === sha,
    'jobs readiness/version failed',
  )
  // 经真实 Caddy、TLS CA 与 DNS 校验访问 app，所有网络均无外部出站。
  const tls = compose(
    'exec',
    '-T',
    'web',
    'node',
    '-e',
    "const https=require('node:https');https.get({hostname:'caddy',port:8443,path:'/api/health',servername:process.env.APP_URL.split('//')[1],headers:{host:process.env.APP_URL.split('//')[1]}},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>console.log(JSON.stringify({status:r.statusCode,body:JSON.parse(b)})))}).on('error',()=>process.exit(1))",
  )
  const tlsResult = JSON.parse(tls)
  assert(
    tlsResult.status === 200 && tlsResult.body.version === sha,
    'Caddy verified TLS smoke failed',
  )
} catch (error) {
  failure = error instanceof Error ? error.message : 'Smoke failed'
} finally {
  try {
    if (started) compose('down', '-v', '--remove-orphans')
  } catch {
    failure ??= 'Smoke cleanup failed'
  }
  rmSync(temporary, { recursive: true, force: true })
  mkdirSync(output, { recursive: true })
  writeFileSync(
    join(output, 'smoke.json'),
    `${JSON.stringify({ sha, arch, passed: !failure, nativeSmoke, tooling, services }, null, 2)}\n`,
  )
}
if (failure) {
  console.error(failure)
  process.exitCode = 1
} else console.info(JSON.stringify({ event: 'selfhost.images.smoke.passed', sha, arch }))
