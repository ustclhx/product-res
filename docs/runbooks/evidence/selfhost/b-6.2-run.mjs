import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// 从仓库根运行；秘密仅驻留父/子进程环境，不写 env 文件或命令参数。
const root = process.cwd()
const require = createRequire(resolve(root, 'packages/platform/package.json'))
const { Pool } = require('pg')
const contention = process.argv.includes('--contention')
const out = resolve(root, 'test-results/b-accept-queue', contention ? 'contention' : '.')
mkdirSync(out, { recursive: true })
const name = `b-accept-queue-${Date.now()}`
const volume = `${name}-pg`
const secret = () => randomBytes(24).toString('hex')
const adminPassword = secret()
const passwords = { app: secret(), migrator: secret(), readonly: secret() }
const commands = []
function run(command, args, options = {}) {
  commands.push([command, ...args])
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 900_000,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  })
  if (result.status !== 0) {
    let output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    for (const value of [
      adminPassword,
      ...Object.values(passwords),
      ...Object.entries(options.env ?? {})
        .filter(([key]) => key.endsWith('URL'))
        .map(([, value]) => value),
    ])
      if (value) output = output.replaceAll(value, '[REDACTED]')
    appendFileSync(resolve(out, 'setup-errors.log'), output)
    throw Object.assign(new Error(`Command failed: ${command} ${args.join(' ')}`), {
      code: result.status,
    })
  }
  return result.stdout.trim()
}
const manifest = {
  startedAt: new Date().toISOString(),
  sha: run('git', ['rev-parse', 'HEAD']),
  node: process.version,
  dbos: JSON.parse(
    readFileSync(resolve(root, 'packages/platform/node_modules/@dbos-inc/dbos-sdk/package.json')),
  ).version,
  container: name,
  volume,
  command: contention
    ? 'node --experimental-strip-types docs/runbooks/evidence/selfhost/b-6.2-contention.mjs'
    : 'pnpm --filter @product-res/platform test:job-engine',
  runner: 'Docker PostgreSQL + real host Node jobs fixture processes',
}
const logPath = resolve(out, 'suite.log')
const snapshotPath = resolve(out, 'metadata.jsonl')
const ipcPath = resolve(out, 'worker-events.jsonl')
for (const path of [logPath, snapshotPath, ipcPath]) writeFileSync(path, '')
let admin
let readonly
let observing = true
let observation
let created = false
const queries = {
  attempts: `SELECT run_id,message_id,key,queue,executor_id,batch_id,batch_size,attempt,started_at,finished_at FROM public.test_job_engine_attempt ORDER BY started_at`,
  effects: `SELECT run_id,key FROM public.test_job_engine_effect ORDER BY run_id,key`,
  messages: `SELECT id,queue,request_id,created_at,available_at,state,attempts,batch_id,finished_at FROM job_engine.message ORDER BY created_at,id`,
  batches: `SELECT id,queue,state,size,executor_id,created_at,finished_at FROM job_engine.batch ORDER BY created_at,id`,
  starts: `SELECT queue,message_id,batch_id,attempt,started_at FROM job_engine.start ORDER BY started_at`,
  deadLetters: `SELECT message_id,queue,attempts,code,retryable,created_at FROM job_engine.dead_letter ORDER BY created_at`,
  native: `SELECT workflow_uuid,status,name,executor_id,application_version,created_at,updated_at,recovery_attempts,queue_name FROM dbos.workflow_status ORDER BY created_at`,
}
try {
  run('docker', ['volume', 'create', volume])
  run(
    'docker',
    [
      'run',
      '-d',
      '--name',
      name,
      '-e',
      'POSTGRES_PASSWORD',
      '-p',
      '127.0.0.1::5432',
      '-v',
      `${volume}:/var/lib/postgresql/data`,
      'postgres:17',
    ],
    { env: { ...process.env, POSTGRES_PASSWORD: adminPassword } },
  )
  created = true
  const port = Number(
    run('docker', [
      'inspect',
      '--format',
      '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}',
      name,
    ]),
  )
  const url = (user, password, database) =>
    `postgres://${user}:${password}@127.0.0.1:${port}/${database}`
  admin = new Pool({ connectionString: url('postgres', adminPassword, 'postgres'), max: 1 })
  let ready = false
  for (let i = 0; i < 120; i++) {
    try {
      await admin.query('SELECT 1')
      ready = true
      break
    } catch {
      await delay(500)
    }
  }
  if (!ready) throw new Error('Postgres startup timeout')
  for (const [role, password] of Object.entries(passwords)) {
    const { rows } = await admin.query(
      "SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) AS sql",
      [role, password],
    )
    await admin.query(rows[0].sql)
  }
  await admin.query('CREATE DATABASE product_res_b_accept_queue OWNER migrator')
  await admin.end()
  admin = new Pool({
    connectionString: url('postgres', adminPassword, 'product_res_b_accept_queue'),
    max: 1,
  })
  await admin.query(readFileSync(resolve(root, 'infra/local/initdb/02-db-grants.sql'), 'utf8'))
  manifest.postgres = (await admin.query('SHOW server_version')).rows[0].server_version
  const env = {
    ...process.env,
    MIGRATION_DATABASE_URL: url('migrator', passwords.migrator, 'product_res_b_accept_queue'),
    TEST_JOB_DATABASE_URL: url('app', passwords.app, 'product_res_b_accept_queue'),
    TEST_JOB_MIGRATOR_URL: url('migrator', passwords.migrator, 'product_res_b_accept_queue'),
    TEST_JOB_READONLY_DATABASE_URL: url(
      'readonly',
      passwords.readonly,
      'product_res_b_accept_queue',
    ),
    DBOS_READONLY_ROLE: 'readonly',
    B_ACCEPT_EVIDENCE_IPC: ipcPath,
  }
  // 只同步独占测试库，不生成或提交迁移。
  const pushConfig = resolve(out, 'drizzle-push.mjs')
  writeFileSync(
    pushConfig,
    `export default { dialect: 'postgresql', schema: ${JSON.stringify(resolve(root, 'packages/db/src/schema/index.ts'))}, schemaFilter: ['public', 'job_engine'], dbCredentials: { url: process.env.MIGRATION_DATABASE_URL } }`,
  )
  run(
    'pnpm',
    [
      '--filter',
      '@product-res/db',
      'exec',
      'drizzle-kit',
      'push',
      '--config',
      pushConfig,
      '--force',
    ],
    { env },
  )
  manifest.schemaTables = (
    await admin.query(
      `SELECT table_schema,table_name FROM information_schema.tables WHERE table_schema='job_engine' ORDER BY table_name`,
    )
  ).rows
  writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2))
  run('pnpm', ['--filter', '@product-res/platform', 'dbos:migrate'], { env })
  readonly = new Pool({ connectionString: env.TEST_JOB_READONLY_DATABASE_URL, max: 1 })
  const seen = new Map()
  observation = (async () => {
    while (observing) {
      for (const [table, query] of Object.entries(queries)) {
        try {
          const { rows } = await readonly.query(query)
          const value = JSON.stringify(rows)
          if (seen.get(table) !== value) {
            seen.set(table, value)
            appendFileSync(
              snapshotPath,
              `${JSON.stringify({ observedAt: new Date().toISOString(), table, rows })}\n`,
            )
          }
        } catch (error) {
          // 正式测试beforeAll创建夹具表，准备前允许表不存在；不输出驱动原文。
          if (error.code !== '42P01')
            throw Object.assign(new Error('Metadata observer failed'), { code: error.code })
        }
      }
      await delay(100)
    }
  })()
  manifest.testStartedAt = new Date().toISOString()
  writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2))
  const child = spawn(
    contention ? process.execPath : 'pnpm',
    contention
      ? [
          '--experimental-strip-types',
          resolve(root, 'docs/runbooks/evidence/selfhost/b-6.2-contention.mjs'),
        ]
      : ['--filter', '@product-res/platform', 'test:job-engine'],
    {
      cwd: root,
      env: {
        ...env,
        NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --import=${resolve(root, 'docs/runbooks/evidence/selfhost/b-6.2-observe-workers.mjs')}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => appendFileSync(logPath, chunk))
  manifest.testPid = child.pid
  manifest.exitCode = await new Promise((done) => child.on('exit', done))
  manifest.testEndedAt = new Date().toISOString()
  await delay(500)
  if (manifest.exitCode !== 0) throw new Error('Formal suite failed')
} catch (error) {
  manifest.failure = { message: error.message, code: error.code }
  process.exitCode = 1
} finally {
  observing = false
  await observation?.catch((error) => {
    manifest.observerFailure = { message: error.message, code: error.code }
    process.exitCode = 1
  })
  await readonly?.end()
  await admin?.end()
  if (created) run('docker', ['rm', '-f', name])
  run('docker', ['volume', 'rm', volume])
  manifest.endedAt = new Date().toISOString()
  manifest.cleaned = true
  writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.log(JSON.stringify(manifest, null, 2))
}
