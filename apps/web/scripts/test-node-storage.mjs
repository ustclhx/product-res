import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const web = fileURLToPath(new URL('../', import.meta.url))
const directory = mkdtempSync(join(tmpdir(), 'selfhost-c-wire-storage-'))
const prefix = `selfhost-c-wire-storage-${process.pid}-${randomBytes(4).toString('hex')}`
const containers = []
let child
let cleaned = false
const secret = () => randomBytes(32).toString('hex')
const passwords = { postgres: secret(), app: secret(), migrator: secret(), readonly: secret() }
const accessKey = secret()
const secretKey = secret()
const valkeyPassword = secret()

function command(args, input) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    input,
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  // Docker、SQL 及驱动错误可能包含凭据，只输出固定步骤。
  if (result.status !== 0) throw new Error(`Storage fixture Docker ${args[0]} failed`)
  return result.stdout.trim()
}
function cleanup() {
  if (cleaned) return
  cleaned = true
  for (const name of containers.reverse())
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 30_000 })
  rmSync(directory, { recursive: true, force: true })
}
process.on('exit', cleanup)
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child?.kill(signal)
    cleanup()
    process.exit(signal === 'SIGINT' ? 130 : 143)
  })
}
async function wait(check) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Storage fixture readiness failed')
}
function start(kind, image, port, args) {
  const name = `${prefix}-${kind}`
  command(['image', 'inspect', image])
  command(['create', '--pull=never', '--name', name, '-p', `127.0.0.1::${port}`, ...args, image])
  containers.push(name)
  command(['start', name])
  return { name, endpoint: command(['port', name, `${port}/tcp`]) }
}
async function run(args, env) {
  return new Promise((resolve, reject) => {
    child = spawn('pnpm', args, { cwd: web, env, stdio: 'inherit' })
    child.on('error', () => reject(new Error('Storage fixture test command failed')))
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

try {
  writeFileSync(
    join(directory, 'pg.env'),
    `POSTGRES_PASSWORD=${passwords.postgres}\nPOSTGRES_DB=product_res_wt_selfhost_c_wire_storage\n`,
    { mode: 0o600 },
  )
  const pg = start('pg', 'postgres:17', 5432, ['--env-file', join(directory, 'pg.env')])
  await wait(
    () =>
      spawnSync('docker', ['exec', pg.name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], {
        stdio: 'ignore',
      }).status === 0,
  )
  const roles = Object.entries(passwords)
    .filter(([role]) => role !== 'postgres')
    .map(([role, password]) => `CREATE ROLE ${role} LOGIN PASSWORD '${password}';`)
    .join('\n')
  command(
    [
      'exec',
      '-i',
      pg.name,
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'product_res_wt_selfhost_c_wire_storage',
    ],
    `${roles}\n${readFileSync(join(root, 'infra/local/initdb/02-db-grants.sql'), 'utf8')}`,
  )
  writeFileSync(
    join(directory, 'valkey.conf'),
    `bind 0.0.0.0\nrequirepass ${valkeyPassword}\nsave ""\nappendonly no\n`,
    { mode: 0o644 },
  )
  // 配置只存在临时目录；值不进入容器命令行或诊断输出。
  const cacheName = `${prefix}-valkey`
  command(['image', 'inspect', 'valkey/valkey:8.1.6-alpine'])
  command([
    'create',
    '--pull=never',
    '--name',
    cacheName,
    '-p',
    '127.0.0.1::6379',
    '-v',
    `${directory}/valkey.conf:/fixture/valkey.conf:ro`,
    'valkey/valkey:8.1.6-alpine',
    'valkey-server',
    '/fixture/valkey.conf',
  ])
  containers.push(cacheName)
  command(['start', cacheName])
  const cacheEndpoint = command(['port', cacheName, '6379/tcp'])
  writeFileSync(
    join(directory, 's3.json'),
    JSON.stringify({
      identities: [
        {
          name: 'fixture',
          credentials: [{ accessKey, secretKey }],
          actions: ['Admin', 'Read', 'Write', 'List'],
        },
      ],
    }),
    { mode: 0o600 },
  )
  const s3Name = `${prefix}-s3`
  command(['image', 'inspect', 'chrislusf/seaweedfs:4.48'])
  command([
    'create',
    '--pull=never',
    '--name',
    s3Name,
    '-p',
    '127.0.0.1::8333',
    '-v',
    `${directory}/s3.json:/fixture/s3.json:ro`,
    'chrislusf/seaweedfs:4.48',
    'mini',
    '-dir=/data',
    '-bucket=fixture-files',
    '-s3.config=/fixture/s3.json',
    '-admin.ui=false',
    '-master.telemetry=false',
    '-volume.max=1',
    '-webdav=false',
  ])
  containers.push(s3Name)
  command(['start', s3Name])
  const endpoint = `http://${command(['port', s3Name, '8333/tcp'])}`
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_STORAGE_DATABASE_URL: `postgres://app:${passwords.app}@${pg.endpoint}/product_res_wt_selfhost_c_wire_storage`,
    MIGRATION_DATABASE_URL: `postgres://migrator:${passwords.migrator}@${pg.endpoint}/product_res_wt_selfhost_c_wire_storage`,
    TEST_VALKEY_URL: `redis://:${valkeyPassword}@${cacheEndpoint}`,
    S3_ENDPOINT: endpoint,
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'fixture-files',
    S3_ACCESS_KEY_ID: accessKey,
    S3_SECRET_ACCESS_KEY: secretKey,
  }
  // build:node 由主验收调用，避免本脚本静默复用旧产物或重复修改构建输出。
  const code = await run(
    ['exec', 'vitest', 'run', '--config', 'vitest.storage.node.config.ts'],
    env,
  )
  process.exitCode = code
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  cleanup()
}
