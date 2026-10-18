import { spawn, spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = dirname(fileURLToPath(import.meta.url))
const root = resolve(directory, '..')
const prefix = `selfhost-c-wire-jobs-${process.pid}-${Date.now()}`
const created = []
let child
let cleaned = false
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000, ...options })
  if (result.status !== 0) throw new Error(`${command} fixture operation failed`)
  return result.stdout.trim()
}
function cleanup() {
  if (cleaned) return
  cleaned = true
  for (const name of created)
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 30_000 })
}
process.on('exit', cleanup)
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    child?.kill(signal)
    cleanup()
    process.exit(signal === 'SIGINT' ? 130 : 143)
  })
function container(suffix, image, ports, args, mounts = []) {
  const name = `${prefix}-${suffix}`
  run('docker', [
    'create',
    '--rm',
    '--pull=never',
    '--name',
    name,
    ...ports.flatMap((port) => ['-p', `127.0.0.1::${port}`]),
    ...mounts.flatMap((mount) => ['--mount', mount]),
    ...(suffix === 'pg' ? ['-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=jobs'] : []),
    image,
    ...args,
  ])
  created.push(name)
  run('docker', ['start', name])
  const bindings = JSON.parse(
    run('docker', ['inspect', '--format', '{{json .NetworkSettings.Ports}}', name]),
  )
  return {
    name,
    ports: Object.fromEntries(ports.map((port) => [port, bindings[`${port}/tcp`][0].HostPort])),
  }
}
async function until(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if (await check()) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Isolated jobs fixture readiness timeout')
}
try {
  // trust 仅用于独占、loopback 的临时 PG；应用角色仍无 schema/DBOS DDL 权限。
  const pg = container('pg', 'postgres:17', [5432], [])
  const valkey = container(
    'valkey',
    'valkey/valkey:8.1.6-alpine',
    [6379],
    ['valkey-server', '--save', '', '--appendonly', 'no'],
  )
  const smtp = container(
    'smtp',
    'node:22.23.3-bookworm-slim',
    [2525, 8080],
    ['node', '/fixture/fixtures-smtp.mjs'],
    [`type=bind,src=${directory},dst=/fixture,readonly`],
  )
  await until(
    () =>
      spawnSync('docker', ['exec', pg.name, 'pg_isready', '-U', 'postgres', '-d', 'jobs'], {
        stdio: 'ignore',
      }).status === 0,
  )
  await until(
    () =>
      spawnSync('docker', ['exec', valkey.name, 'valkey-cli', 'ping'], { stdio: 'ignore' })
        .status === 0,
  )
  const control = `http://127.0.0.1:${smtp.ports[8080]}`
  await until(async () => (await fetch(control)).ok)
  run('docker', ['exec', '-i', pg.name, 'psql', '-U', 'postgres', '-d', 'jobs'], {
    input: 'CREATE ROLE app LOGIN; CREATE ROLE migrator LOGIN SUPERUSER;',
  })
  const files =
    process.argv.length > 2
      ? process.argv.slice(2)
      : [
          'test/node-production.integration.test.ts',
          'test/node-observer-shutdown.integration.test.ts',
          'test/node-smtp.integration.test.ts',
          'test/node-wire.integration.test.ts',
        ]
  for (const [index, file] of files.entries()) {
    // B wire 用例会核验全库消息数；每个文件独立数据库，避免持久状态跨文件污染。
    // 每个文件同时隔离 SMTP 接收状态，生产 shutdown 的失败不污染后续计数断言。
    const reset = await fetch(`${control}/reset`, { method: 'POST' })
    if (!reset.ok) throw new Error('SMTP fixture reset failed')
    const database = `jobs_${index}`
    run('docker', ['exec', '-i', pg.name, 'psql', '-U', 'postgres', '-d', 'jobs'], {
      input: `CREATE DATABASE ${database} OWNER migrator;`,
    })
    const migrator = `postgres://migrator@127.0.0.1:${pg.ports[5432]}/${database}`
    const application = `postgres://app@127.0.0.1:${pg.ports[5432]}/${database}`
    const environment = {
      ...process.env,
      MIGRATION_DATABASE_URL: migrator,
      TEST_JOB_DATABASE_URL: application,
      TEST_DATABASE_URL: application,
      CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: application,
      TEST_JOB_MIGRATOR_URL: migrator,
      TEST_VALKEY_URL: `redis://127.0.0.1:${valkey.ports[6379]}`,
      JOBS_SMTP_PORT: smtp.ports[2525],
      JOBS_SMTP_CONTROL: control,
    }
    // 先运行一次既有迁移入口，再授予 public DML；globalSetup仍校验迁移幂等。
    run('pnpm', ['--filter', '@product-res/db', 'db:migrate'], {
      cwd: resolve(root, '../..'),
      env: environment,
      stdio: 'pipe',
    })
    run('docker', ['exec', '-i', pg.name, 'psql', '-U', 'postgres', '-d', database], {
      input:
        'GRANT USAGE ON SCHEMA public TO app; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app;',
    })
    const exit = await new Promise((resolve, reject) => {
      child = spawn(
        'pnpm',
        ['exec', 'vitest', 'run', '--config', 'vitest.node-integration.config.ts', file],
        {
          cwd: root,
          env: environment,
          stdio: 'inherit',
        },
      )
      child.on('error', reject)
      child.on('exit', (code) => resolve(code ?? 1))
    })
    if (exit !== 0) {
      process.exitCode = exit
      break
    }
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  cleanup()
}
