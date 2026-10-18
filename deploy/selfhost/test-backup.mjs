import { execFile, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const root = resolve(import.meta.dirname, '../..')
const args = process.argv.slice(2)
const releaseDrill = args.includes('--release-drill')
const full = args.includes('--full') || releaseDrill
const restoreSuite = args.includes('--restore') || releaseDrill
const devRuntime = args.includes('--dev-runtime')
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const sha = option(
  '--sha',
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
)
if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Expected full SHA')
const sourceDirty = Boolean(
  execFileSync('git', ['status', '--porcelain'], {
    cwd: root,
    encoding: 'utf8',
  }).trim(),
)
const harnessRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim()
const bundleDirectory = resolve(option('--bundle-dir', join(root, 'deploy/selfhost')))
let bundleRelease
const output = resolve(option('--output', join(tmpdir(), `selfhost-d-backup-evidence-${sha}`)))
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'selfhost-d-backup-')))
chmodSync(temporary, 0o700)
const project = `selfhost-d-drill-${randomBytes(6).toString('hex')}`
const fixture = join(temporary, 'fixture')
const secrets = join(temporary, 'secrets')
const composeFile = join(temporary, 'compose.yaml')
const env = { ...process.env, COMPOSE_PROJECT_NAME: project, COMPOSE_PROFILES: '' }
const image = (name) =>
  bundleRelease?.images[name] ||
  process.env[`${name.toUpperCase().replaceAll('-', '_')}_IMAGE`] ||
  `local/selfhost/${name}:${sha}`
const execute = promisify(execFile)
let started = false
let failure
let phase = 'configuration'
let sampling = false
let sampler
let sampleInFlight
let cleaned = false
let selectedRestore
const restoreStates = []
const events = []
const measurements = {}
const priorCpu = new Map()
const credentials = []
const assert = (condition, reason) => {
  if (!condition) throw new Error(reason)
}
function evidence(event, detail = {}) {
  const value = { event, ...detail }
  events.push(value)
  console.info(JSON.stringify(value))
}
function safe(value) {
  for (const credential of credentials)
    assert(!value.includes(credential), 'Fixture leaked a credential')
  assert(
    !/X-Amz-Signature|postgres(?:ql)?:\/\//i.test(value),
    'Fixture leaked a signed URL or connection string',
  )
  return value
}
function run(command, commandArgs, options = {}) {
  try {
    return safe(
      execFileSync(command, commandArgs, {
        cwd: root,
        env,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 16 * 1024 * 1024,
        timeout: 180_000,
        ...options,
      }),
    )
  } catch (error) {
    if (error.message === 'Fixture leaked a credential') throw error
    const fixtureCode =
      String(error.stderr ?? '').match(/BACKUP_S3_FIXTURE_FAILED_[A-Za-z]+/)?.[0] ??
      String(error.stdout ?? '').match(/REPLICA_[A-Z0-9_]+/)?.[0] ??
      ''
    const name = commandArgs.includes('/usr/local/lib/selfhost-backup/backup.py')
      ? commandArgs.at(-1)
      : commandArgs.includes('selfhost-walg')
        ? commandArgs
            .slice(
              commandArgs.indexOf('selfhost-walg') + 1,
              commandArgs.indexOf('selfhost-walg') + 3,
            )
            .join(' ')
        : ['s3tool', 'psql', 'pg_restore', 'initdb'].find((name) => commandArgs.includes(name)) ||
          commandArgs[0]
    throw new Error(`Backup acceptance command failed (${fixtureCode} ${phase}; ${name})`)
  }
}
const composeArgs = ['compose', '--env-file', '/dev/null', '-f', composeFile]
const compose = (...commandArgs) => run('docker', [...composeArgs, ...commandArgs])
async function composeAsync(...commandArgs) {
  try {
    const result = await execute('docker', [...composeArgs, ...commandArgs], {
      cwd: root,
      env,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 180_000,
    })
    return safe(result.stdout)
  } catch {
    throw new Error(`Backup acceptance asynchronous command failed (${phase})`)
  }
}
function secret(name) {
  const value = randomBytes(32).toString('hex')
  credentials.push(value)
  writeFileSync(join(secrets, name), value, { mode: 0o644 })
}
async function wait(check, timeout = 120_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(1000)
  }
  throw new Error(`Backup acceptance timed out (${phase})`)
}
const sql = (query, service = 'postgres', database = 'product_res_production') =>
  compose(
    'exec',
    '-T',
    service,
    'psql',
    '--no-psqlrc',
    '--set=ON_ERROR_STOP=1',
    '-U',
    'postgres',
    '-d',
    database,
    '-tAc',
    query,
  ).trim()
const walg = (...commandArgs) => compose('exec', '-T', 'backup', 'selfhost-walg', ...commandArgs)
const backup = (...commandArgs) =>
  compose(
    'exec',
    '-T',
    'backup',
    'python3',
    '/usr/local/lib/selfhost-backup/backup.py',
    ...commandArgs,
  )
const status = () => JSON.parse(backup('status'))
// 夹具 PG 开着 archive_mode 与 archive_timeout，autovacuum/checkpoint 会在任意时刻封口并归档
// 新 WAL 段。比较对象清单时既有对象必须原样保留（不删除、不改写），新增只允许 WAL 段；
// rewritten 列出按设计每次重写的对象（只要求仍存在）。返回新增对象供调用方精确核对。
function preservedInventory(before, after, reason, rewritten = []) {
  const current = new Map(after.map((o) => [o.key, o.bytes]))
  const prior = new Set(before.map((o) => o.key))
  assert(
    before.every((o) =>
      rewritten.includes(o.key) ? current.has(o.key) : current.get(o.key) === o.bytes,
    ),
    reason,
  )
  const added = after.filter((o) => !prior.has(o.key))
  assert(
    added.every((o) => /\/wal_005\/[0-9A-F]{24}(?:\.lz4)?$/.test(o.key)),
    reason,
  )
  return added
}
const s3 = (...commandArgs) =>
  JSON.parse(compose('run', '--rm', '--no-deps', 's3tool', ...commandArgs))
function rejectBackup(overrides, command = 'status', entrypoint) {
  const commandArgs = ['run', '--rm', '--no-deps']
  for (const [name, value] of Object.entries(overrides)) commandArgs.push('-e', `${name}=${value}`)
  if (entrypoint) commandArgs.push('--entrypoint', entrypoint)
  commandArgs.push('backup', ...(entrypoint ? ['backup-list', '--json'] : [command]))
  let rejected = false
  try {
    compose(...commandArgs)
  } catch {
    rejected = true
  }
  assert(rejected, 'Invalid configuration or failed operation returned success')
}
async function pitr(backupId, target) {
  await composeAsync('stop', 'restore')
  compose('rm', '-f', 'restore')
  run('docker', ['volume', 'rm', `${project}_restored`, `${project}_restore_socket`])
  compose(
    'run',
    '--rm',
    '--no-deps',
    '--entrypoint',
    'selfhost-walg',
    'restore',
    'backup-fetch',
    '/var/lib/postgresql/data',
    backupId,
  )
  const recoveryTarget = target.replace('T', ' ').replace(/Z$/, '+00')
  const config = `restore_command = 'selfhost-walg wal-fetch %f %p'\nrecovery_target_time = '${recoveryTarget}'\nrecovery_target_timeline = '1'\nrecovery_target_action = 'pause'\nrecovery_target_inclusive = true\n`
  run(
    'docker',
    [
      ...composeArgs,
      'run',
      '--rm',
      '--no-deps',
      '--entrypoint',
      'sh',
      'restore',
      '-c',
      'cat >> /var/lib/postgresql/data/postgresql.auto.conf; touch /var/lib/postgresql/data/recovery.signal',
    ],
    { input: config },
  )
  await composeAsync('up', '-d', 'restore')
  await wait(() => {
    try {
      return sql('select pg_is_wal_replay_paused()', 'restore') === 't'
    } catch {
      return false
    }
  })
}
async function sample() {
  measurements[phase] ??= {
    samples: 0,
    services: {},
    maxConnections: 0,
    maxWalBytes: 0,
    maxPgDataBytes: 0,
    minFreeBytes: null,
  }
  const point = measurements[phase]
  // 异步容器采样，避免宿主同步docker调用阻塞恢复子进程；只枚举本fixture与已登记恢复project。
  const projects = new Set([project])
  for (const directory of restoreStates) {
    const metadata = join(directory, 'state.json')
    if (existsSync(metadata)) projects.add(JSON.parse(readFileSync(metadata, 'utf8')).project)
  }
  const lists = await Promise.all(
    [...projects].map(async (name) => {
      const result = await execute(
        'docker',
        [
          'ps',
          '--filter',
          `label=com.docker.compose.project=${name}`,
          '--format',
          '{{.ID}} {{.Label "com.docker.compose.service"}}',
        ],
        { env, encoding: 'utf8', timeout: 10_000 },
      )
      return result.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [id, service] = line.split(' ')
          return {
            id,
            service: name === project ? service : `recovery:${name}`,
            postgres: service === 'postgres' || service === 'restore',
          }
        })
    }),
  )
  await Promise.all(
    lists.flat().map(async ({ id, service, postgres }) => {
      let result
      try {
        result = await execute(
          'docker',
          [
            'exec',
            id,
            'sh',
            '-c',
            // cat 失败（容器正在 compose stop 或已退出、cgroup 文件随之消失）必须让 exec 非零，
            // 否则末尾 awk 的 `|| true` 会把残缺输出当作成功采样，误判为 OOM 计数缺失。
            "cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.peak /sys/fs/cgroup/memory.events /sys/fs/cgroup/cpu.stat || exit 97; awk '/^VmRSS:/ {s += $2} END {print s*1024}' /proc/[0-9]*/status 2>/dev/null || true",
          ],
          { env, encoding: 'utf8', timeout: 10_000 },
        )
      } catch {
        // 一次性backup-fetch/校验容器或正在停止的服务会在采样中自然退出；不能把该竞争当作OOM或漏采成功。
        return
      }
      const raw = safe(result.stdout)
      const lines = raw.trim().split('\n')
      // compose stop 期间 exec 进程随容器被终止时，docker exec 可能返回 0 且无任何输出
      // （CI 证据：service=tls、keys 为空、lineCount=1）；没有读到任何计数即视为退出竞争，跳过本次采样。
      if (raw.trim() === '') return
      if (!/oom_kill \d+\b/.test(raw)) {
        // 读到了计数却没有 oom_kill 行：真实计数缺失，带上服务名供定位
        const error = new Error('Fixture cgroup OOM counters absent')
        error.service = service
        // 只记录读到的计数名（如 anon / oom / oom_kill）与行数，不含数值，供定位缺失原因
        error.keys = [...new Set(lines.map((line) => line.match(/^[a-z_]+/)?.[0]).filter(Boolean))]
          .slice(0, 60)
          .join(' ')
        error.lineCount = lines.length
        throw error
      }
      point.services[service] ??= {
        rssPeakBytes: 0,
        cgroupPeakBytes: 0,
        cpuUsec: 0,
        cpuPeakPercent: 0,
        samples: 0,
        maxConnections: 0,
        maxWalBytes: 0,
        maxPgDataBytes: 0,
        minFreeBytes: null,
      }
      const value = point.services[service]
      value.rssPeakBytes = Math.max(value.rssPeakBytes, Number(lines.at(-1)))
      value.cgroupPeakBytes = Math.max(value.cgroupPeakBytes, Number(lines[1]))
      value.cpuUsec = Number(raw.match(/usage_usec (\d+)/)?.[1])
      const measuredAt = Date.now()
      const prior = priorCpu.get(id)
      if (prior)
        value.cpuPeakPercent = Math.max(
          value.cpuPeakPercent,
          (value.cpuUsec - prior.usage) / ((measuredAt - prior.at) * 10),
        )
      priorCpu.set(id, { usage: value.cpuUsec, at: measuredAt })
      assert(
        /oom_kill 0\b/.test(raw),
        /oom_kill \d+\b/.test(raw)
          ? 'Fixture resource budget OOM'
          : 'Fixture cgroup OOM counters absent',
      )
      value.samples++
      if (postgres) {
        try {
          const metrics = await execute(
            'docker',
            [
              'exec',
              id,
              'psql',
              '-X',
              '-U',
              'postgres',
              '-d',
              'product_res_production',
              '-tAc',
              "select json_build_object('connections',(select count(*) from pg_stat_activity),'walBytes',(select coalesce(sum(size),0) from pg_ls_waldir()),'pgDataBytes',pg_database_size(current_database()))",
            ],
            { env, encoding: 'utf8', timeout: 10_000 },
          )
          const data = JSON.parse(metrics.stdout)
          for (const [key, source] of [
            ['maxConnections', 'connections'],
            ['maxWalBytes', 'walBytes'],
            ['maxPgDataBytes', 'pgDataBytes'],
          ]) {
            value[key] = Math.max(value[key], data[source])
            point[key] = Math.max(point[key], data[source])
          }
          const disk = await execute(
            'docker',
            [
              'exec',
              id,
              'sh',
              '-c',
              'df -Pk /var/lib/postgresql/data | tail -1; du -sk /var/lib/postgresql/data',
            ],
            { env, encoding: 'utf8', timeout: 10_000 },
          )
          const diskLines = disk.stdout.trim().split('\n')
          const free = Number(diskLines[0].trim().split(/\s+/)[3]) * 1024
          const pgDataBytes = Number(diskLines[1].trim().split(/\s+/)[0]) * 1024
          value.maxPgDataBytes = Math.max(value.maxPgDataBytes, pgDataBytes)
          point.maxPgDataBytes = Math.max(point.maxPgDataBytes, pgDataBytes)
          value.minFreeBytes = Math.min(value.minFreeBytes ?? free, free)
          point.minFreeBytes = Math.min(point.minFreeBytes ?? free, free)
        } catch {
          // base抓取与重放早期还没有可查询的数据库；容器cgroup仍已采到。
        }
      }
    }),
  )
  point.samples++
}
async function monitor() {
  while (sampling) {
    if (phase !== 'schedule_restart') {
      sampleInFlight = sample()
      await sampleInFlight
    }
    await delay(1000)
  }
}
async function restoreAcceptance(first, sourceSchemas, schemaSql, aclSql, sourceDbAcl, selected) {
  const selectedBackupId = selected?.backupId || first.base.backupId
  phase = 'restore_target'
  const target =
    selected?.target ||
    sql('select to_char(clock_timestamp() at time zone \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\')')
  if (!selected) {
    await delay(1200)
    sql("insert into public.backup_marker values ('after',99)")
  }
  backup('verify')
  const checksFile = join(temporary, 'checks.json')
  writeFileSync(
    checksFile,
    JSON.stringify({
      creditsEnabled: true,
      checks: [
        {
          name: 'markers',
          sql: "select exists(select 1 from backup_marker where id='before' and amount=17) and not exists(select 1 from backup_marker where id='after')",
        },
        {
          name: 'schemas',
          sql: `select (${schemaSql})::text = '${sourceSchemas.replaceAll("'", "''")}'`,
        },
        {
          name: 'database-acl',
          sql: `select (${aclSql})::text = '${sourceDbAcl.replaceAll("'", "''")}'`,
        },
        {
          name: 'task-state',
          sql: "select (select state='pending' from job_engine.message where queue='restore-fixture') and (select consumed_at is null from job_engine.workflow_event where workflow_id='restore-fixture') and (select state='waiting' from job_engine.workflow_wait where workflow_id='restore-fixture') and exists(select 1 from job_engine.schedule where id='restore-fixture') and (select status='pending' from dbos.backup_task where id='fixture') and exists(select 1 from dbos.workflow_status where workflow_uuid='d-drill-fixture' and status='PENDING' and name='direct-sql-restore-fixture') and exists(select 1 from dbos.operation_outputs where workflow_uuid='d-drill-fixture' and function_id=0 and function_name='prepared' and output='17')",
        },
        {
          name: 'credit-snapshot',
          sql: "select (select sum(delta) from credit_ledger)=17 and (select sum(remaining) from credit_grant where status='active')=17",
        },
      ],
    }),
    { mode: 0o600 },
  )
  function restoreArgs(destination, state, suffix, extra = []) {
    const envPath = join(temporary, `${suffix}.env`)
    writeFileSync(
      envPath,
      `BACKUP_S3_ENDPOINT=https://${destination ? 'replica-tls' : 'tls'}:8443\nBACKUP_S3_REGION=us-east-1\nBACKUP_S3_PREFIX=s3://backup-fixture/cluster\nBACKUP_S3_FORCE_PATH_STYLE=true\n`,
      { mode: 0o600 },
    )
    return [
      '--s3-env',
      envPath,
      '--access-key-file',
      join(secrets, destination ? 'replica_admin_id' : 's3_admin_access_key_id'),
      '--secret-key-file',
      join(secrets, destination ? 'replica_admin_key' : 's3_admin_secret_access_key'),
      '--ca-file',
      join(fixture, 'ca.crt'),
      '--image',
      image('postgres'),
      '--backup-id',
      selectedBackupId,
      '--target-time',
      target,
      '--project',
      `selfhost-restore-d-drill-${randomBytes(6).toString('hex')}`,
      '--state-dir',
      state,
      '--network',
      configNetwork(),
      '--checks-file',
      checksFile,
      ...extra,
    ]
  }
  function configNetwork() {
    return JSON.parse(compose('config', '--format', 'json')).networks.fixture.name
  }
  async function hostRestore(script, commandArgs) {
    let result
    try {
      result = await execute(join(bundleDirectory, script), commandArgs, {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 180_000,
        maxBuffer: 1024 * 1024,
      })
    } catch (error) {
      const code = String(error.stderr ?? '').match(/RESTORE_[A-Z_]+/)?.[0] || 'UNKNOWN'
      evidence('restore.process_failure', {
        phase,
        restoreCode: code,
        exitCode: Number.isInteger(error.code) ? error.code : null,
        signal: /^SIG[A-Z]+$/.test(error.signal ?? '') ? error.signal : null,
        killed: error.killed === true,
      })
      if (error.stdout) {
        const lines = safe(String(error.stdout)).trim().split('\n')
        try {
          const report = JSON.parse(lines.at(-1))
          evidence('restore.diagnostic', { report })
        } catch {}
      }
      throw new Error(`Restore entrance failed (${phase}; ${code})`)
    }
    // 恢复子进程与资源观察者是独立失败边界，不能把观察者错误误报为RESTORE UNKNOWN。
    if (sampleInFlight) await sampleInFlight
    try {
      return JSON.parse(safe(result.stdout).trim().split('\n').at(-1))
    } catch {
      throw new Error(`Restore report invalid (${phase})`)
    }
  }
  const primaryState = join(temporary, 'primary-restore')
  restoreStates.push(primaryState)
  phase = 'restore_primary'
  const primary = await hostRestore('restore.sh', [
    'restore',
    ...restoreArgs(false, primaryState, 'primary'),
  ])
  evidence('restore.primary', { report: primary, target, beforePresent: true, afterAbsent: true })
  const promoted = await hostRestore('restore.sh', ['promote', '--state-dir', primaryState])
  assert(promoted.status === 'promoted_isolated', 'Explicit promote did not succeed')
  evidence('restore.promote', { explicit: true, isolated: true })
  phase = 'restore_failure_boundaries'
  async function rejectedRestore(commandArgs) {
    try {
      await hostRestore('restore.sh', ['restore', ...commandArgs])
      return false
    } catch {
      return true
    }
  }
  assert(
    await rejectedRestore(restoreArgs(false, primaryState, 'unsafe-existing')),
    'Existing state path accepted',
  )
  const existingVolumeArgs = restoreArgs(
    false,
    join(temporary, 'existing-volume'),
    'existing-volume',
  )
  existingVolumeArgs[existingVolumeArgs.indexOf('--project') + 1] = primary.project
  assert(await rejectedRestore(existingVolumeArgs), 'Existing database volume accepted')
  const tooLateState = join(temporary, 'future-restore')
  restoreStates.push(tooLateState)
  const futureArgs = restoreArgs(false, tooLateState, 'future', ['--timeout', '20'])
  futureArgs[futureArgs.indexOf('--target-time') + 1] = new Date(
    Date.now() + 86400_000,
  ).toISOString()
  assert(await rejectedRestore(futureArgs), 'Out-of-range target silently restored latest')
  const gapKey = `wal_005/${selectedBackupId.slice(5)}.lz4`
  walg('st', 'get', gapKey, '/var/lib/selfhost-backup/gap.lz4', '--no-decompress')
  walg('st', 'rm', gapKey)
  const gapState = join(temporary, 'gap-restore')
  restoreStates.push(gapState)
  assert(
    await rejectedRestore(restoreArgs(false, gapState, 'gap', ['--timeout', '20'])),
    'Missing WAL returned success',
  )
  walg('st', 'put', '/var/lib/selfhost-backup/gap.lz4', gapKey, '--no-compress')
  evidence('restore.boundaries', {
    existingPathRejected: true,
    missingWalRejected: true,
    beyondUpperBoundRejected: true,
  })
  const failedDrillState = join(temporary, 'failed-drill')
  const failedChecks = join(temporary, 'failed-checks.json')
  writeFileSync(
    failedChecks,
    JSON.stringify({
      creditsEnabled: true,
      checks: [{ name: 'expected-failure', sql: 'select false' }],
    }),
    { mode: 0o600 },
  )
  restoreStates.push(failedDrillState)
  let drillRejected = false
  try {
    await hostRestore(
      'restore-drill.sh',
      restoreArgs(false, failedDrillState, 'failed-drill', ['--checks-file', failedChecks]),
    )
  } catch {
    drillRejected = true
  }
  const failedDrill = JSON.parse(readFileSync(join(failedDrillState, 'report.json'), 'utf8'))
  const failedDrillMetadata = JSON.parse(readFileSync(join(failedDrillState, 'state.json'), 'utf8'))
  assert(
    drillRejected && failedDrill.status === 'failed' && !failedDrill.cleaned,
    'Failed drill did not retain diagnosis',
  )
  run('docker', ['volume', 'inspect', failedDrillMetadata.volume])
  await hostRestore('restore.sh', ['cleanup', '--state-dir', failedDrillState])
  evidence('restore.failed_drill', {
    nonzero: true,
    diagnosisRetained: true,
    volumeRetainedUntilExplicitCleanup: true,
  })
  const replicaSync = () =>
    compose(
      'exec',
      '-T',
      '-e',
      'BACKUP_REPLICA_ENABLED=true',
      'backup',
      'python3',
      '/usr/local/lib/selfhost-backup/backup.py',
      'replica-sync',
    )
  phase = 'replica_sync'
  replicaSync()
  const replicaList = () =>
    JSON.parse(compose('run', '--rm', '--no-deps', 'replica-s3tool', 'list'))
  const copyState = status().replica
  assert(
    copyState.ok &&
      copyState.continuousUntil &&
      copyState.backupId === status().base.backupId &&
      (!releaseDrill || copyState.oldestBackupId === selectedBackupId),
    'Replica lacks verified upper bound',
  )
  const copied = replicaList()
  assert(
    copied.some((o) => o.key.includes('/logical/')),
    'Replica did not copy dump',
  )
  replicaSync()
  // 两次同步之间主库可能刚归档新 WAL：重复同步只能复制这些新段，既有对象一个都不重写。
  const repeated = replicaList()
  const primaryNow = new Map(s3('list').map((o) => [o.key, o.bytes]))
  const newlyArchived = preservedInventory(copied, repeated, 'Repeated sync changed inventory', [
    'cluster/replica/manifest.json',
  ])
  assert(
    newlyArchived.every((o) => primaryNow.get(o.key) === o.bytes) &&
      status().replica.copiedObjects === newlyArchived.length,
    'Repeated sync changed inventory',
  )
  let interrupted = false
  try {
    compose(
      'exec',
      '-T',
      '-e',
      'BACKUP_REPLICA_ENABLED=true',
      'backup',
      'timeout',
      '--signal=KILL',
      '1',
      'python3',
      '/usr/local/lib/selfhost-backup/backup.py',
      'replica-sync',
    )
  } catch {
    interrupted = true
  }
  assert(interrupted && !status().replica.ok, 'Interrupted copy reported success')
  replicaSync()
  evidence('replica.sync', {
    complete: true,
    repeated: true,
    interruptedResumed: true,
    independentCredentials: true,
    dump: true,
    continuousUntil: copyState.continuousUntil,
    lagSeconds: copyState.syncLagSeconds,
  })
  phase = 'replica_failure'
  await composeAsync('stop', 'replica-tls')
  let rejected = false
  try {
    replicaSync()
  } catch {
    rejected = true
  }
  assert(rejected && !status().replica.ok, 'Replica outage reported success')
  const priorObjects = s3('list')
  for (const operation of ['health', 'retention-apply']) {
    let refused = false
    try {
      compose(
        'exec',
        '-T',
        '-e',
        'BACKUP_REPLICA_ENABLED=true',
        'backup',
        'python3',
        '/usr/local/lib/selfhost-backup/backup.py',
        operation,
      )
    } catch {
      refused = true
    }
    assert(refused, 'Failed replica permitted healthy state or primary cleanup')
  }
  preservedInventory(priorObjects, s3('list'), 'Replica failure allowed deletion')
  sql("insert into public.backup_marker values ('primary-independent',1)")
  backup('verify')
  assert(status().verification.ok, 'Replica outage blocked primary archive')
  await composeAsync('start', 'replica-tls')
  // 只针对本夹具生成真实history，再停止此临时PG；正式恢复入口不向主归档写入。
  await pitr(selectedBackupId, target)
  sql('select pg_wal_replay_resume()', 'restore')
  sql('select pg_promote(true,30)', 'restore')
  compose(
    'exec',
    '-T',
    'restore',
    'selfhost-walg',
    'wal-push',
    '/var/lib/postgresql/data/pg_wal/00000002.history',
  )
  await composeAsync('stop', 'restore')
  replicaSync()
  assert(
    replicaList().some((o) => /00000002\.history(?:\.[^.]+)?$/.test(o.key)),
    'Replica did not copy real history',
  )
  evidence('replica.history', {
    realPromotionHistoryCopied: true,
    primaryTimeline: 1,
    promotedFixtureTimeline: 2,
    chainVerifiedBeforeHistory: status().verification.ok,
    laterPrimaryVerificationOrRetention: false,
  })
  evidence('replica.failure', { nonzero: true, primaryArchiveIndependent: true, recovered: true })
  phase = 'replica_source_delete'
  const logicalKey = s3('list').find((o) => /logical\/.*database.dump.lz4$/.test(o.key)).key
  walg('st', 'rm', logicalKey.slice('cluster/'.length))
  replicaSync()
  assert(
    replicaList().some((o) => o.key === logicalKey),
    'Source deletion propagated',
  )
  evidence('replica.source_delete', { deletionNotPropagated: true })
  const finalCopyState = status().replica
  assert(
    Date.parse(finalCopyState.continuousUntil) >= Date.parse(target),
    'Replica upper bound precedes target',
  )
  evidence('replica.final_bound', {
    ...finalCopyState,
    target,
    observedAt: new Date().toISOString(),
    observedLagSeconds: (Date.now() - Date.parse(finalCopyState.continuousUntil)) / 1000,
  })
  phase = 'restore_secondary_only'
  await composeAsync('stop', 'tls', 'object-storage', 'postgres', 'backup')
  const secondaryState = join(temporary, 'secondary-restore')
  restoreStates.push(secondaryState)
  const secondary = await hostRestore(
    'restore-drill.sh',
    restoreArgs(true, secondaryState, 'secondary'),
  )
  evidence('restore.secondary', {
    report: secondary,
    target,
    primaryStopped: true,
    independentCredentials: true,
    beforePresent: true,
    afterAbsent: true,
  })
  assert(
    primary.backupId === secondary.backupId &&
      primary.targetTime === secondary.targetTime &&
      primary.replayLsn === secondary.replayLsn &&
      primary.actualReplayTime === secondary.actualReplayTime,
    'Primary and secondary replay positions differ',
  )
  if (releaseDrill) {
    for (const report of [primary, secondary]) {
      const points = Object.values(measurements)
        .map((point) => point.services[`recovery:${report.project}`])
        .filter(Boolean)
      assert(
        points.some((point) => point.samples >= 1 && point.maxPgDataBytes > 0),
        'Recovery resource samples absent',
      )
    }
  }
  evidence('restore.same_point', {
    backupId: selectedBackupId,
    target,
    replayLsn: primary.replayLsn,
    actualReplayTime: primary.actualReplayTime,
    primaryRtoSeconds: primary.elapsedSeconds,
    secondaryRtoSeconds: secondary.elapsedSeconds,
    sameReplayPosition: true,
  })
  await composeAsync('start', 'object-storage', 'tls', 'postgres', 'backup')
}
async function cleanup() {
  sampling = false
  if (sampler) await sampler.catch(() => {})
  const errors = []
  for (const state of restoreStates) {
    try {
      const metadata = join(state, 'state.json')
      if (!existsSync(metadata)) continue
      run(join(bundleDirectory, 'restore.sh'), ['cleanup', '--state-dir', state])
    } catch {
      errors.push('restore-state')
    }
  }
  // 任一恢复实例清理失败也必须继续清理其他实例与主fixture；失败现场保留供定向重试。
  if (started) {
    try {
      compose('down', '-v', '--remove-orphans', '--timeout', '10')
    } catch {
      errors.push('fixture-compose')
    }
  }
  cleaned = errors.length === 0
  if (cleaned) rmSync(temporary, { recursive: true, force: true })
  else {
    failure ??= 'Backup acceptance cleanup failed'
    evidence('backup.cleanup_failed', { errors, retainedTemporary: temporary })
  }
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, async () => {
    failure = `Backup acceptance interrupted by ${signal}`
    await cleanup()
    process.exit(signal === 'SIGINT' ? 130 : 143)
  })

try {
  if (releaseDrill) {
    assert(!sourceDirty, 'Release drill requires a clean committed harness')
    assert(
      args.includes('--bundle-dir') && !devRuntime,
      'Release drill requires bundle and image-contained runtime',
    )
    run('python3', [
      '-B',
      join(bundleDirectory, 'release/bundle.py'),
      'verify',
      bundleDirectory,
      '--sha',
      sha,
    ])
    bundleRelease = JSON.parse(readFileSync(join(bundleDirectory, 'release.json'), 'utf8'))
    for (const name of ['postgres', 'backup', 'migrate', 'object-storage']) {
      const supplied = process.env[`${name.toUpperCase().replaceAll('-', '_')}_IMAGE`]
      assert(
        !supplied || supplied === bundleRelease.images[name],
        'External image differs from release bundle',
      )
    }
    evidence('release.provenance', {
      sourceRevision: sha,
      harnessRevision,
      sourceDirty,
      images: bundleRelease.images,
      bundleVerified: true,
      imageContainedRuntime: true,
    })
  }
  mkdirSync(secrets)
  mkdirSync(fixture)
  for (const name of [
    'postgres_password',
    'app_db_password',
    'migrator_db_password',
    'readonly_db_password',
    's3_admin_access_key_id',
    's3_admin_secret_access_key',
    's3_access_key_id',
    's3_secret_access_key',
  ])
    secret(name)
  writeFileSync(
    join(secrets, 'migrator_database_url'),
    `postgres://migrator:${readFileSync(join(secrets, 'migrator_db_password'), 'utf8')}@postgres:5432/product_res_production?sslmode=verify-full`,
    { mode: 0o644 },
  )
  run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    join(fixture, 'ca.key'),
    '-out',
    join(fixture, 'ca.crt'),
    '-days',
    '2',
    '-subj',
    '/CN=selfhost-d-backup-CA',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
    '-addext',
    'subjectKeyIdentifier=hash',
  ])
  writeFileSync(
    join(fixture, 'extensions'),
    // Python3.13启用严格X509校验，夹具CA/leaf也必须包含真实证书的必要扩展。
    'subjectAltName=DNS:tls,DNS:replica-tls,DNS:postgres\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n',
  )
  run('openssl', [
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    join(fixture, 'server.key'),
    '-out',
    join(fixture, 'server.csr'),
    '-subj',
    '/CN=tls',
  ])
  run('openssl', [
    'x509',
    '-req',
    '-in',
    join(fixture, 'server.csr'),
    '-CA',
    join(fixture, 'ca.crt'),
    '-CAkey',
    join(fixture, 'ca.key'),
    '-CAcreateserial',
    '-out',
    join(fixture, 'server.crt'),
    '-days',
    '2',
    '-extfile',
    join(fixture, 'extensions'),
  ])
  chmodSync(join(fixture, 'server.key'), 0o644)
  writeFileSync(join(fixture, 'ca-invalid.crt'), 'invalid fixture certificate\n')
  const schedulingTime = new Date(Date.now() - 60_000).toISOString().slice(11, 16)
  // 只有脚本创建的 project、卷和内网；测试不采纳外部 S3 配置、不暴露宿主端口。
  writeFileSync(
    composeFile,
    `
name: '${project}'
x-safe: &safe
  cap_drop: [ALL]
  security_opt: [no-new-privileges:true]
  networks: [fixture]
  logging: {driver: json-file, options: {max-size: 2m, max-file: '2'}}
x-backup-env: &backup-env
  PGHOST: /var/run/postgresql
  PGUSER: postgres
  POSTGRES_DB: product_res_production
  PGDATA: /var/lib/postgresql/data
  BACKUP_S3_ENDPOINT: https://tls:8443
  BACKUP_S3_REGION: us-east-1
  BACKUP_S3_PREFIX: s3://backup-fixture/cluster
  BACKUP_S3_FORCE_PATH_STYLE: 'true'
  BACKUP_S3_CA_FILE: /fixture/ca.crt
  BACKUP_S3_ACCESS_KEY_ID_FILE: /run/secrets/s3_admin_access_key_id
  BACKUP_S3_SECRET_ACCESS_KEY_FILE: /run/secrets/s3_admin_secret_access_key
services:
  postgres:
    <<: *safe
    image: '${image('postgres')}'
    user: '999:999'
    mem_limit: 1g
    cpus: 0.5
    environment:
      <<: *backup-env
      BACKUP_ENABLED: 'true'
      POSTGRES_PASSWORD_FILE: /run/secrets/postgres_password
      APP_DB_PASSWORD_FILE: /run/secrets/app_db_password
      MIGRATOR_DB_PASSWORD_FILE: /run/secrets/migrator_db_password
      READONLY_DB_PASSWORD_FILE: /run/secrets/readonly_db_password
    secrets: [postgres_password, app_db_password, migrator_db_password, readonly_db_password, s3_admin_access_key_id, s3_admin_secret_access_key]
    volumes: [pgdata:/var/lib/postgresql/data, socket:/var/run/postgresql, backup_state:/var/lib/selfhost-backup, '${fixture}:/fixture:ro', '${fixture}:/etc/postgresql/tls-src:ro']
    healthcheck: {test: [CMD, pg_isready, -U, postgres, -d, product_res_production], interval: 2s, timeout: 3s, retries: 60}
  backup:
    <<: *safe
    image: '${image('backup')}'
    user: '999:999'
    restart: unless-stopped
    mem_limit: 256m
    cpus: 0.2
    environment:
      <<: *backup-env
      BACKUP_UTC_TIME: '${schedulingTime}'
      BACKUP_RETRY_SECONDS: '3'
    # 先暂停调度，seed 后再以正式 schedule 入口重建。
    entrypoint: [python3, /usr/local/lib/selfhost-backup/backup.py]
    command: [schedule]
    secrets: [s3_admin_access_key_id, s3_admin_secret_access_key]
    volumes: [pgdata:/var/lib/postgresql/data:ro, socket:/var/run/postgresql, backup_state:/var/lib/selfhost-backup, '${fixture}:/fixture:ro'${devRuntime ? `, '${join(root, 'deploy/selfhost/backup')}:/usr/local/lib/selfhost-backup:ro'` : ''}]
  object-storage:
    <<: *safe
    image: '${image('object-storage')}'
    user: '1000:1000'
    mem_limit: 512m
    cpus: 0.3
    environment:
      S3_PUBLIC_DOMAIN: tls
      S3_BUCKET: backup-fixture
      S3_ADMIN_ACCESS_KEY_ID_FILE: /run/secrets/s3_admin_access_key_id
      S3_ADMIN_SECRET_ACCESS_KEY_FILE: /run/secrets/s3_admin_secret_access_key
      S3_ACCESS_KEY_ID_FILE: /run/secrets/s3_access_key_id
      S3_SECRET_ACCESS_KEY_FILE: /run/secrets/s3_secret_access_key
      GOMEMLIMIT: 384MiB
      GOMAXPROCS: '1'
    secrets: [s3_admin_access_key_id, s3_admin_secret_access_key, s3_access_key_id, s3_secret_access_key]
    volumes: [objects:/data, metadata:/metadata]
    tmpfs: ['/tmp:uid=1000,gid=1000,mode=0700']
    healthcheck: {test: [CMD, /usr/local/bin/object-storage-health], interval: 2s, timeout: 3s, retries: 60}
  tls:
    <<: *safe
    image: '${image('migrate')}'
    user: '1000:1000'
    mem_limit: 128m
    cpus: 0.1
    entrypoint: [node, /src/deploy/selfhost/backup/acceptance-s3.mjs]
    command: [proxy]
    volumes: ['${fixture}:/fixture:ro', '${join(root, 'deploy/selfhost/backup/acceptance-s3.mjs')}:/src/deploy/selfhost/backup/acceptance-s3.mjs:ro']
  migrate:
    <<: *safe
    image: '${image('migrate')}'
    user: '1000:1000'
    mem_limit: 512m
    cpus: 0.3
    environment:
      MIGRATION_DATABASE_URL_FILE: /run/secrets/migrator_database_url
      NODE_EXTRA_CA_CERTS: /fixture/ca.crt
      DBOS_APPLICATION_ROLE: app
      DBOS_READONLY_ROLE: readonly
    secrets: [migrator_database_url]
    volumes: ['${fixture}:/fixture:ro']
  s3tool:
    <<: *safe
    image: '${image('migrate')}'
    user: '1000:1000'
    mem_limit: 256m
    cpus: 0.2
    entrypoint: [node, /src/deploy/selfhost/backup/acceptance-s3.mjs]
    secrets: [s3_admin_access_key_id, s3_admin_secret_access_key]
    volumes: ['${join(root, 'deploy/selfhost/backup/acceptance-s3.mjs')}:/src/deploy/selfhost/backup/acceptance-s3.mjs:ro']
  restore:
    <<: *safe
    image: '${image('postgres')}'
    user: '999:999'
    mem_limit: 512m
    cpus: 0.3
    entrypoint: [postgres]
    command: [-c, "listen_addresses=", -c, ssl=off, -c, archive_mode=off, -c, hba_file=/etc/postgresql/pg_hba.conf]
    environment: *backup-env
    secrets: [s3_admin_access_key_id, s3_admin_secret_access_key]
    volumes: [restored:/var/lib/postgresql/data, restore_socket:/var/run/postgresql, backup_state:/backup-artifacts:ro, '${fixture}:/fixture:ro']
networks:
  fixture: {internal: true}
volumes:
  pgdata: {}
  socket: {}
  backup_state: {}
  objects: {}
  metadata: {}
  restored: {}
  restore_socket: {}
secrets:
  migrator_database_url: {file: '${join(secrets, 'migrator_database_url')}'}
${credentials
  .map(
    (_, i) =>
      [
        'postgres_password',
        'app_db_password',
        'migrator_db_password',
        'readonly_db_password',
        's3_admin_access_key_id',
        's3_admin_secret_access_key',
        's3_access_key_id',
        's3_secret_access_key',
      ][i],
  )
  .map((name) => `  ${name}: {file: '${join(secrets, name)}'}`)
  .join('\n')}
`,
  )
  let config = JSON.parse(compose('config', '--format', 'json'))
  if (restoreSuite) {
    // 独立实例与凭据模拟账号丢失；不复用主目标的对象卷或管理身份。
    for (const name of [
      'replica_admin_id',
      'replica_admin_key',
      'replica_app_id',
      'replica_app_key',
    ]) {
      secret(name)
      config.secrets[name] = { file: join(secrets, name) }
    }
    const copy = (name) => structuredClone(config.services[name])
    const replicaStore = copy('object-storage')
    replicaStore.environment.S3_PUBLIC_DOMAIN = 'replica-tls'
    replicaStore.secrets = [
      'replica_admin_id',
      'replica_admin_key',
      'replica_app_id',
      'replica_app_key',
    ].map((source, i) => ({
      source,
      target: [
        's3_admin_access_key_id',
        's3_admin_secret_access_key',
        's3_access_key_id',
        's3_secret_access_key',
      ][i],
    }))
    replicaStore.volumes = replicaStore.volumes.map((volume) => ({
      ...volume,
      source: `replica_${volume.source}`,
    }))
    for (const volume of replicaStore.volumes) config.volumes[volume.source] = {}
    config.services['replica-storage'] = replicaStore
    const replicaTls = copy('tls')
    replicaTls.environment = { FIXTURE_S3_HOST: 'replica-storage' }
    config.services['replica-tls'] = replicaTls
    const replicaTool = copy('s3tool')
    replicaTool.environment = { FIXTURE_S3_HOST: 'replica-storage' }
    replicaTool.secrets = replicaStore.secrets.slice(0, 2)
    config.services['replica-s3tool'] = replicaTool
    // 初始主备份不等待副本；测试显式启用复制后才声明双副本。
    config.services.backup.environment = {
      ...config.services.backup.environment,
      BACKUP_REPLICA_S3_ENDPOINT: 'https://replica-tls:8443',
      BACKUP_REPLICA_S3_REGION: 'us-east-1',
      BACKUP_REPLICA_S3_PREFIX: 's3://backup-fixture/cluster',
      BACKUP_REPLICA_S3_FORCE_PATH_STYLE: 'true',
      BACKUP_REPLICA_S3_ACCESS_KEY_ID_FILE: '/run/secrets/replica_admin_id',
      BACKUP_REPLICA_S3_SECRET_ACCESS_KEY_FILE: '/run/secrets/replica_admin_key',
      BACKUP_REPLICA_S3_CA_FILE: '/fixture/ca.crt',
    }
    config.services.backup.secrets.push(
      { source: 'replica_admin_id', target: 'replica_admin_id' },
      { source: 'replica_admin_key', target: 'replica_admin_key' },
    )
    writeFileSync(composeFile, JSON.stringify(config))
    config = JSON.parse(compose('config', '--format', 'json'))
  }
  assert(
    Object.values(config.services).every((s) => !s.ports?.length && !s.build),
    'Fixture exposes data ports or builds',
  )
  assert(config.networks.fixture.internal, 'Fixture permits external egress')
  for (const name of ['postgres', 'backup', 'object-storage', 'migrate']) {
    const [info] = JSON.parse(run('docker', ['image', 'inspect', image(name)]))
    assert(
      info.Config.User && !['0', 'root'].includes(info.Config.User.split(':')[0]),
      'Fixture image is root',
    )
    if (releaseDrill) {
      assert(
        info.Config.Labels?.['org.opencontainers.image.revision'] === sha,
        'Image OCI revision differs',
      )
      assert(
        info.RepoDigests?.includes(image(name)),
        'Image RepoDigests differs from bundle digest',
      )
    }
  }
  evidence('backup.fixture', {
    mode: releaseDrill ? 'release-drill' : restoreSuite ? 'restore' : full ? 'full' : 'smoke',
    project,
    noPublishedPorts: true,
    internalOnly: true,
  })
  phase = 'startup'
  started = true
  await composeAsync(
    'up',
    '-d',
    '--wait',
    '--wait-timeout',
    '120',
    'postgres',
    'object-storage',
    'tls',
    ...(restoreSuite ? ['replica-storage', 'replica-tls'] : []),
  )
  phase = 'bucket_initialization'
  s3('init')
  if (restoreSuite) compose('run', '--rm', '--no-deps', 'replica-s3tool', 'init')
  if (restoreSuite) {
    const connectivity = compose(
      'run',
      '--rm',
      '--no-deps',
      '--entrypoint',
      'python3',
      'backup',
      '-c',
      "import sys;sys.path.insert(0,'/usr/local/lib/selfhost-backup');from replica import S3,configuration;from walg import BackupError\ntry:\n print([len(S3(configuration(other)).list()) for other in [False,True]])\nexcept BackupError as e:\n print(str(e));sys.exit(1)",
    )
    assert(connectivity.includes('['), 'Replica endpoints not readable')
  }
  evidence('backup.bucket_ready')
  phase = 'migrations'
  const migration = compose('run', '--rm', '--no-deps', 'migrate')
  assert(
    migration.includes('selfhost.db:migrate.completed') &&
      migration.includes('selfhost.dbos:migrate.completed'),
    'Production schema migration failed',
  )
  evidence('backup.production_schemas', { businessSql: true, dbosMigrate: true })
  phase = 'seed'
  sql(`set role migrator;
    create table public.backup_marker(id text primary key, amount integer not null check(amount >= 0));
    create schema if not exists job_engine authorization migrator;
    create schema if not exists dbos authorization migrator;
    create table job_engine.backup_task(id text primary key, status text not null);
    create table dbos.backup_task(id text primary key, status text not null);
    grant usage on schema job_engine, dbos to app, readonly;
    grant select, insert, update, delete on all tables in schema job_engine, dbos to app;
    grant select on all tables in schema job_engine, dbos to readonly;
    insert into public.backup_marker values ('before', 17);
    insert into job_engine.backup_task values ('fixture', 'pending');
    insert into dbos.backup_task values ('fixture', 'pending');`)
  if (restoreSuite)
    sql(readFileSync(join(root, 'deploy/selfhost/backup/fixtures/restore-seed.sql'), 'utf8'))
  // 启动前做配置边界，防止失败测试与生产式调度互相覆盖状态。
  phase = 'configuration_boundaries'
  rejectBackup({ BACKUP_S3_ACCESS_KEY_ID_FILE: '/fixture/missing' }, 'base')
  rejectBackup({ BACKUP_S3_ACCESS_KEY_ID: 'fixture-conflict' }, 'base')
  rejectBackup({ BACKUP_S3_CA_FILE: '/fixture/ca-invalid.crt' }, 'base')
  rejectBackup({ BACKUP_S3_CA_FILE: '' }, 'base')
  compose(
    'run',
    '--rm',
    '--no-deps',
    '--entrypoint',
    'selfhost-walg',
    'backup',
    'backup-list',
    '--json',
  )
  evidence('backup.configuration', {
    fileSecretsNonRoot: true,
    missingFileRejected: true,
    fileValueConflictRejected: true,
    invalidTlsRejected: true,
    selfSignedCaVerified: true,
  })
  phase = 'scheduled_cycle'
  await composeAsync('up', '-d', 'backup')
  assert(compose('exec', '-T', 'backup', 'id', '-u').trim() === '999', 'Backup runtime UID differs')
  sampling = true
  sampler = monitor().catch((error) => {
    sampling = false
    const reason = ['Fixture resource budget OOM', 'Fixture cgroup OOM counters absent'].includes(
      error.message,
    )
      ? error.message
      : error.name === 'SyntaxError'
        ? 'Sampler metadata JSON invalid'
        : 'Sampler Docker operation failed'
    evidence('backup.sampling_failed', {
      phase,
      reason,
      // compose 服务名或 recovery:<项目名>，只含小写标识字符，不含主机或凭据信息
      service: /^[a-z0-9:_-]{1,80}$/.test(error.service ?? '') ? error.service : null,
      keys: /^[a-z_ ]{0,1000}$/.test(error.keys ?? '-') ? error.keys : null,
      lineCount: Number.isInteger(error.lineCount) ? error.lineCount : null,
      exitCode: Number.isInteger(error.code) ? error.code : null,
      code: ['ETIMEDOUT', 'ENOENT', 'EACCES', 'EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM'].includes(
        error.code,
      )
        ? error.code
        : null,
      signal: /^SIG[A-Z]+$/.test(error.signal ?? '') ? error.signal : null,
      killed: error.killed === true,
    })
    failure ??= `Backup resource sampling failed: ${reason}`
  })
  await wait(() => {
    const value = status()
    return value.base?.ok && value.dump?.ok && value.schedule?.lastSuccess
  }, 180_000)
  const runtimeUid = Number(
    compose('exec', '-T', 'backup', 'cat', '/proc/1/status').match(/^Uid:\s+(\d+)/m)?.[1],
  )
  assert(runtimeUid === 999, 'Backup PID1 UID differs')
  const schemaSql =
    "select json_agg(table_schema || '.' || table_name order by table_schema,table_name) from information_schema.tables where table_schema in ('public','job_engine','dbos','drizzle')"
  const sourceSchemas = sql(schemaSql)
  const aclSql =
    'select json_agg(json_build_array(grantor::regrole::text,grantee::regrole::text,privilege_type,is_grantable) order by grantor,grantee,privilege_type,is_grantable) from pg_database cross join lateral aclexplode(datacl) where datname=current_database()'
  const sourceDbAcl = sql(aclSql)
  const first = status()
  assert(first.healthy, 'Successful cycle reported unhealthy')
  backup('health')
  const backups = JSON.parse(walg('backup-list', '--json'))
  assert(backups.length >= 1 && first.base.backupId, 'No real base backup')
  const objects = s3('list')
  assert(
    objects.some((o) => /basebackups_005\/.*_backup_stop_sentinel\.json$/.test(o.key)),
    'S3 base sentinel absent',
  )
  sql('select pg_switch_wal()')
  await wait(() => Number(sql('select archived_count from pg_stat_archiver')) > 0)
  assert(
    s3('list').some((o) => /wal_005\/[0-9A-F]{24}/.test(o.key)),
    'No real S3 WAL',
  )
  evidence('backup.real_cycle', {
    baseCount: backups.length,
    walArchived: true,
    dumpUploaded: true,
    scheduleSlot: first.schedule.slot,
    runtimeUid,
    healthy: first.healthy,
  })
  phase = 'logical_restore'
  const manifestKey = s3('list').find((o) => /logical\/.*\/manifest\.json$/.test(o.key))?.key
  assert(manifestKey, 'Logical manifest missing')
  const logicalPrefix = manifestKey.slice('cluster/'.length).replace(/manifest\.json$/, '')
  compose(
    'exec',
    '-T',
    'backup',
    'sh',
    '-c',
    'mkdir -p /var/lib/selfhost-backup/acceptance && chmod 700 /var/lib/selfhost-backup/acceptance',
  )
  walg(
    'st',
    'get',
    `${logicalPrefix}database.dump.lz4`,
    '/var/lib/selfhost-backup/acceptance/database.dump',
  )
  walg(
    'st',
    'get',
    `${logicalPrefix}roles.sql.lz4`,
    '/var/lib/selfhost-backup/acceptance/roles.sql',
  )
  const dumpList = compose(
    'exec',
    '-T',
    'backup',
    'pg_restore',
    '--list',
    '/var/lib/selfhost-backup/acceptance/database.dump',
  )
  assert(
    ['public backup_marker', 'job_engine backup_task', 'dbos backup_task'].every((name) =>
      dumpList.includes(name),
    ),
    'Dump does not cover all schemas',
  )
  compose(
    'run',
    '--rm',
    '--no-deps',
    '--entrypoint',
    'initdb',
    'restore',
    '-D',
    '/var/lib/postgresql/data',
    '--auth-local=peer',
    '--auth-host=scram-sha-256',
  )
  await composeAsync('up', '-d', 'restore')
  await wait(() => {
    try {
      return sql('select 1', 'restore', 'postgres') === '1'
    } catch {
      return false
    }
  })
  const roles = compose(
    'exec',
    '-T',
    'backup',
    'cat',
    '/var/lib/selfhost-backup/acceptance/roles.sql',
  )
  assert(
    ['app', 'migrator', 'readonly'].every((role) => roles.includes(`CREATE ROLE ${role};`)),
    'Role restoration material absent',
  )
  run(
    'docker',
    [
      ...composeArgs,
      'exec',
      '-T',
      'restore',
      'psql',
      '-X',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'postgres',
    ],
    { input: roles },
  )
  compose(
    'exec',
    '-T',
    'restore',
    'pg_restore',
    '--create',
    '--exit-on-error',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '/backup-artifacts/acceptance/database.dump',
  )
  const checkSql = `select json_build_object('marker',(select amount from public.backup_marker where id='before'),'job',(select status from job_engine.backup_task where id='fixture'),'dbos',(select status from dbos.backup_task where id='fixture'),'appDml',has_table_privilege('app','public.backup_marker','INSERT'),'readonlySelect',has_table_privilege('readonly','public.backup_marker','SELECT'),'readonlyWrite',has_table_privilege('readonly','public.backup_marker','INSERT'),'appSuper',(select rolsuper from pg_roles where rolname='app'),'appCreate',has_schema_privilege('app','public','CREATE'),'migratorCreate',has_schema_privilege('migrator','public','CREATE'))`
  assert(
    sql(schemaSql, 'restore') === sourceSchemas,
    'Actual business/engine schema inventory differs',
  )
  assert(sql(aclSql, 'restore') === sourceDbAcl, 'Database ACL differs')
  const restored = JSON.parse(sql(checkSql, 'restore'))
  assert(
    restored.marker === 17 &&
      restored.job === 'pending' &&
      restored.dbos === 'pending' &&
      restored.appDml &&
      restored.readonlySelect &&
      !restored.readonlyWrite &&
      !restored.appSuper &&
      !restored.appCreate &&
      restored.migratorCreate,
    'Logical restore data or role permissions differ',
  )
  evidence('backup.logical_restore', {
    customFormatList: true,
    ...restored,
    roleMaterial: true,
    databaseAcl: true,
    productionSchemas: true,
  })
  phase = 'schedule_restart'
  await composeAsync('restart', 'backup')
  await delay(4000)
  const afterRestart = status()
  assert(
    afterRestart.schedule.slot === first.schedule.slot &&
      afterRestart.schedule.lastSuccess === first.schedule.lastSuccess &&
      afterRestart.base.backupId === first.base.backupId,
    'Restart duplicated successful schedule slot',
  )
  evidence('backup.schedule_restart', { successfulSlotPreserved: true, noDuplicateBase: true })
  if (restoreSuite && !releaseDrill)
    await restoreAcceptance(first, sourceSchemas, schemaSql, aclSql, sourceDbAcl)
  if (full) {
    phase = 'oldest_weekly_pitr'
    await composeAsync(
      'exec',
      '-T',
      'backup',
      'python3',
      '/usr/local/lib/selfhost-backup/backup.py',
      'base',
    )
    const weeklyId = status().base.backupId
    const beforeTarget = sql(
      'select to_char(clock_timestamp() at time zone \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\')',
    )
    await delay(1500)
    sql("insert into public.backup_marker values ('after', 99)")
    sql('select pg_switch_wal()')
    await wait(
      () =>
        !Number(
          sql(
            "select count(*) from pg_ls_dir('pg_wal/archive_status') as name where name like '%.ready'",
          ),
        ),
    )
    await composeAsync(
      'exec',
      '-T',
      'backup',
      'python3',
      '/usr/local/lib/selfhost-backup/backup.py',
      'base',
    )
    const laterIds = [status().base.backupId]
    if (releaseDrill) {
      for (let index = 0; index < 2; index++) {
        await composeAsync(
          'exec',
          '-T',
          'backup',
          'python3',
          '/usr/local/lib/selfhost-backup/backup.py',
          'base',
        )
        laterIds.push(status().base.backupId)
      }
      assert(
        new Set([first.base.backupId, weeklyId, ...laterIds]).size === 5,
        'Expected five distinct real full backups',
      )
    }
    const metadataDates = () =>
      JSON.parse(walg('backup-list', '--detail', '--json')).map((item) => ({
        backupId: item.backup_name,
        startTime: item.start_time,
        finishTime: item.finish_time,
      }))
    const originalDates = metadataDates()
    const all = JSON.parse(walg('backup-list', '--json'))
    const oldest = all.find((b) => (b.backup_name ?? b.BackupName) === weeklyId)
    assert(oldest, 'Oldest base missing before retention')
    const oldestKey = s3('list').find((o) => o.key.endsWith(`/${weeklyId}/metadata.json`))?.key
    assert(oldestKey, 'Oldest base sentinel missing')
    const weeklyDate = new Date(Date.now() - 21 * 86400_000)
    weeklyDate.setUTCDate(weeklyDate.getUTCDate() - ((weeklyDate.getUTCDay() + 6) % 7))
    weeklyDate.setUTCHours(2, 0, 0, 0)
    const obsoleteKey = s3('list').find((o) =>
      o.key.endsWith(`/${first.base.backupId}/metadata.json`),
    )?.key
    s3('age', obsoleteKey, new Date(Date.now() - 40 * 86400_000).toISOString())
    s3('age', oldestKey, weeklyDate.toISOString())
    if (releaseDrill) {
      for (const [index, backupId] of laterIds.slice(0, 2).entries()) {
        const date = new Date(weeklyDate.getTime() + (index + 1) * 7 * 86400_000)
        const key = s3('list').find((item) => item.key.endsWith(`/${backupId}/metadata.json`))?.key
        assert(key, 'Weekly metadata absent')
        s3('age', key, date.toISOString())
      }
    }
    const simulatedDates = metadataDates()
    backup('verify')
    // 删除缺段只能在本fixture发生；恢复原始压缩对象后才继续真实清理。
    const gapKey = s3('list').find((o) => o.key.endsWith(`/wal_005/${weeklyId.slice(5)}.lz4`))?.key
    assert(gapKey, 'Weekly WAL absent before gap injection')
    const relativeGap = gapKey.slice('cluster/'.length)
    walg('st', 'get', relativeGap, '/var/lib/selfhost-backup/acceptance/gap.lz4', '--no-decompress')
    walg('st', 'rm', relativeGap)
    const beforeGapApply = s3('list')
    let gapRejected = false
    try {
      backup('retention-apply')
    } catch {
      gapRejected = true
    }
    assert(
      gapRejected &&
        preservedInventory(beforeGapApply, s3('list'), 'Gap permitted destructive cleanup'),
      'Gap permitted destructive cleanup',
    )
    walg('st', 'put', '/var/lib/selfhost-backup/acceptance/gap.lz4', relativeGap, '--no-compress')
    evidence('backup.gap_protection', { missingWalRejected: true, noDelete: true })
    const beforeCleanup = s3('list')
    const plan = JSON.parse(backup('retention-plan'))
    assert(plan.oldest === weeklyId && plan.weekly.includes(weeklyId), 'Weekly selection differs')
    if (releaseDrill)
      assert(
        plan.weekly.length === 4 && plan.missingWeeklyAnchors.length === 0,
        'Four weekly anchors absent',
      )
    evidence('backup.retention_plan', {
      plan,
      originalDates,
      simulatedDates,
      metadataOnlyAged: true,
      actualBackupCount: all.length,
      weeklyDate: weeklyDate.toISOString(),
      simulatedWeeklyOffsetDays: 21,
    })
    preservedInventory(beforeCleanup, s3('list'), 'Dry-run mutated S3')
    backup('retention-apply')
    assert(
      !JSON.parse(walg('backup-list', '--json')).some((b) => b.backup_name === first.base.backupId),
      'Obsolete base was not deleted',
    )
    assert(
      s3('list').some((o) => o.key.includes(`wal_005/${weeklyId.slice(5)}`)),
      'Weekly starting WAL deleted',
    )
    assert(
      JSON.parse(walg('backup-list', '--json')).some(
        (b) => (b.backup_name ?? b.BackupName) === weeklyId,
      ),
      'Weekly anchor deleted by real retention',
    )
    selectedRestore = { backupId: weeklyId, target: beforeTarget }
    const restoreStart = Date.now()
    await pitr(weeklyId, beforeTarget)
    assert(
      sql("select string_agg(id,',' order by id) from public.backup_marker", 'restore') ===
        'before',
      'PITR before/after marker incorrect',
    )
    assert(JSON.parse(sql(checkSql, 'restore')).marker === 17, 'PITR roles/tasks missing')
    // 正式演练后续还要再次验证主timeline=1的连续链；提前上传promote的timeline=2
    // history会按正式工具契约拒绝该证明。history专项延后到主验证全部完成后的副本阶段。
    if (!releaseDrill) {
      sql('select pg_wal_replay_resume()', 'restore')
      sql('select pg_promote(true, 30)', 'restore')
      compose(
        'exec',
        '-T',
        'restore',
        'sh',
        '-c',
        'selfhost-walg wal-push /var/lib/postgresql/data/pg_wal/00000002.history',
      )
      assert(
        s3('list').some((o) => /wal_005\/00000002\.history/.test(o.key)),
        'Real timeline history missing',
      )
    }
    evidence('backup.oldest_weekly_pitr', {
      backupId: weeklyId,
      retentionDateSimulated: true,
      retainedAgeDays: (Date.now() - weeklyDate.getTime()) / 86400_000,
      realTarget: beforeTarget,
      beforePresent: true,
      afterAbsent: true,
      historyArchived: !releaseDrill,
      historyDeferredToReplicaPhase: releaseDrill,
      elapsedMs: Date.now() - restoreStart,
    })
    // 不再写业务数据：按工具公布的采样上界恢复，验证空闲库也能命中target_time。
    const idleBound = status().verification.continuousUntil
    await pitr(weeklyId, idleBound)
    assert(
      sql("select string_agg(id,',' order by id) from public.backup_marker", 'restore') ===
        'after,before',
      'Idle verified upper bound was not reached',
    )
    evidence('backup.idle_upper_bound', {
      target: idleBound,
      reached: true,
      businessWritesAfterVerify: false,
    })
    phase = 'disk_failure'
    rejectBackup({ BACKUP_MIN_FREE_BYTES: '9223372036854775807' }, 'dump')
    let current = status()
    assert(
      current.dump.failures > first.dump.failures && !current.dump.ok,
      'Disk failure absent from status',
    )
    const pendingTemp = compose(
      'exec',
      '-T',
      'backup',
      'sh',
      '-c',
      'find /var/lib/selfhost-backup/tmp -type f | wc -l',
    ).trim()
    assert(pendingTemp === '0', 'Failed dump retained temporary files')
    evidence('backup.disk_failure', { nonzero: true, statusFailed: true, temporaryFiles: 0 })
    phase = 'archive_upload_failure'
    const failuresBefore = Number(sql('select failed_count from pg_stat_archiver'))
    await composeAsync('stop', 'tls')
    sql("insert into public.backup_marker values ('archive_failure', 1)")
    sql('select pg_switch_wal()')
    await wait(() => Number(sql('select failed_count from pg_stat_archiver')) > failuresBefore)
    assert(
      Number(
        sql(
          "select count(*) from pg_ls_dir('pg_wal/archive_status') as name where name like '%.ready'",
        ),
      ) > 0,
      'Unarchived WAL removed after failure',
    )
    const beforeFailedBase = s3('list')
    rejectBackup({}, 'base')
    rejectBackup({}, 'dump')
    let cleanupRejected = false
    try {
      backup('retention-apply')
    } catch {
      cleanupRejected = true
    }
    assert(
      cleanupRejected && JSON.stringify(beforeFailedBase) === JSON.stringify(s3('list')),
      'Failed new base allowed delete',
    )
    current = status()
    assert(
      !current.dump.ok &&
        current.dump.failures > first.dump.failures &&
        current.pgStatArchiver.failed_count > failuresBefore,
      'Upload/archive failure missing from status',
    )
    evidence('backup.archive_upload_failure', {
      nonzero: true,
      unarchivedWalRetained: true,
      archiverFailuresIncreased: true,
      dumpStatusFailed: true,
      newBaseFailed: !current.base.ok,
      failedCycleNoDelete: true,
    })
    await composeAsync('start', 'tls')
    // PostgreSQL 自然重试；不伪写成功状态或移除 .ready 文件。
    await wait(
      () =>
        !Number(
          sql(
            "select count(*) from pg_ls_dir('pg_wal/archive_status') as name where name like '%.ready'",
          ),
        ),
      90_000,
    )
    await composeAsync(
      'exec',
      '-T',
      'backup',
      'python3',
      '/usr/local/lib/selfhost-backup/backup.py',
      'dump',
    )
    assert(status().dump.ok, 'Dump did not recover after endpoint restored')
    evidence('backup.failure_recovery', { archiveRetried: true, dumpRecovered: true })
  }
  if (releaseDrill) {
    phase = 'base_failure_recovery'
    await composeAsync(
      'exec',
      '-T',
      'backup',
      'python3',
      '/usr/local/lib/selfhost-backup/backup.py',
      'base',
    )
    backup('verify')
    assert(status().base.ok, 'Base did not recover before release drill')
    await restoreAcceptance(first, sourceSchemas, schemaSql, aclSql, sourceDbAcl, selectedRestore)
  }
  sampling = false
  await sampler
  assert(!failure, failure)
  const final = status()
  assert(final.disk.freeBytes > 0 && final.disk.walBytes > 0, 'Status disk/WAL evidence absent')
  for (const point of Object.values(measurements)) {
    assert(point.maxConnections <= 10, 'Backup connection budget exceeded')
    for (const [name, resource] of Object.entries(point.services)) {
      assert(
        resource.cgroupPeakBytes <=
          (name.startsWith('recovery:') ? 512 * 1024 * 1024 : config.services[name].mem_limit),
        'Backup memory budget exceeded',
      )
    }
  }
  if (releaseDrill) {
    for (const service of [
      'postgres',
      'backup',
      'object-storage',
      'tls',
      'replica-storage',
      'replica-tls',
    ]) {
      const points = Object.values(measurements)
        .map((point) => point.services[service])
        .filter(Boolean)
      assert(
        points.some(
          (point) =>
            point.samples >= 1 &&
            Number.isFinite(point.cgroupPeakBytes) &&
            point.cgroupPeakBytes > 0 &&
            Number.isFinite(point.rssPeakBytes) &&
            point.rssPeakBytes > 0 &&
            (service !== 'postgres' || point.maxPgDataBytes > 0),
        ),
        'Required service resource samples absent',
      )
    }
  }
  evidence('backup.resources', {
    budgets: {
      recoveryEachMiB: 512,
      backupMiB: 256,
      backupCpu: 0.2,
      maxConnections: 10,
    },
    interpretation: 'Per-service sampled maxima; these are not a simultaneous whole-host peak',
    measurements,
    disk: final.disk,
  })
  phase = 'redaction'
  safe(
    compose(
      'logs',
      '--no-log-prefix',
      'postgres',
      'backup',
      'object-storage',
      'tls',
      ...(restoreSuite ? ['replica-storage', 'replica-tls'] : []),
    ),
  )
  evidence('backup.passed', {
    full,
    restoreSuite,
    releaseDrill,
    fixtureData: 'direct SQL into production schemas; no jobs executed',
  })
} catch (error) {
  failure ??= error instanceof Error ? error.message : 'Backup acceptance failed'
  if (started) {
    try {
      evidence('backup.failure_status', { status: status() })
    } catch {}
  }
  evidence('backup.failed', { phase, reason: failure })
} finally {
  await cleanup()
  mkdirSync(output, { recursive: true })
  writeFileSync(
    join(output, 'backup-smoke.json'),
    `${JSON.stringify({ sha, sourceRevision: sha, harnessRevision, sourceDirty, full, restoreSuite, releaseDrill, passed: !failure, cleaned, events, measurements }, null, 2)}\n`,
  )
}
if (failure) {
  console.error(failure)
  process.exitCode = 1
}
