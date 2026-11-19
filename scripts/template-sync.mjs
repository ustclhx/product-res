#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { postprocessProject } from './create-project.mjs'
import { readBaseRecord, serializeBaseRecord } from './template-base.mjs'
import { listReleases } from './template-release.mjs'
import { cloneTemplate, generateAt, resolveCommit } from './template-sync/generate.mjs'
import { git, gitRaw } from './template-sync/git.mjs'
import { inferCommand } from './template-sync/infer.mjs'
import {
  applyTemplateChanges,
  commitCopies,
  fetchCopies,
  retainedDeletions,
  setupDiff,
  shortSha,
  syncBranchName,
  templateChanges,
} from './template-sync/merge.mjs'
import {
  drizzleGenerate,
  finalizeSnapshot,
  isEmptyDatabase,
  migrateIncrementally,
  migrationsPath,
  migrationsWithout,
  planMigrations,
  portMigrations,
} from './template-sync/migrations.mjs'
import { diffLockPackages, renderReport } from './template-sync/report.mjs'
import { planUpgrades, reconcileMigrations } from './template-sync/upgrades.mjs'

/**
 * @callback Runner
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd: string}} options
 * @returns {{status: number | null, output: string}}
 */

/** @type {Runner} */
export function defaultRunner(command, args, { cwd }) {
  // 与生成器自检一致：CI 模式只跑单元测试，清除数据库连接，避免对使用者的本地库执行集成测试。
  const env = { ...process.env, CI: 'true', TURBO_ENV_MODE: 'loose', TURBO_TELEMETRY_DISABLED: '1' }
  for (const key of Object.keys(env)) {
    if (/DATABASE_URL|HYPERDRIVE_LOCAL_CONNECTION_STRING/.test(key)) delete env[key]
  }
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  })
  if (result.error) return { status: null, output: result.error.message }
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` }
}

const lastLine = (text) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? ''

/** Preflight failure: nothing in the project was changed. */
export class PreflightError extends Error {}

/**
 * @typedef {object} SyncOptions
 * @property {string} project Derived project root (Git top level).
 * @property {string} [to] Target ref; defaults to the highest annotated template-v release, or HEAD without releases.
 * @property {string} [template] Template URL or path; defaults to the baseline repository.
 * @property {string} [report] Report path; defaults to `<git-dir>/template-sync/<short>.md`.
 * @property {string[]} [confirmDeployed] Versions explicitly confirmed as deployed.
 * @property {string[]} [skipMigrations] Template migration tags to mark handled without porting.
 * @property {string} [verifyDb] Empty, isolated Postgres URL for the migration path check.
 * @property {string[]} [trailers] 追加到同步提交上的 Git 提交尾注（如项目约定的 `Co-Authored-By: …`）
 * @property {boolean} [skipVerify] Tool tests only: skip verification commands; merge and ports still
 *   happen, the baseline is never updated and the status is `unverified`.
 * @property {Runner} [runner] Command runner for pnpm steps (tests inject a stub).
 * @property {(message: string) => void} [log]
 */

/** `--trailer <尾注>` 参数；尾注须为 `键: 值` 形式 */
export function trailerArgs(trailers = []) {
  for (const trailer of trailers)
    if (!/^[A-Za-z][\w-]*:\s*\S/.test(trailer))
      throw new PreflightError(`--trailer 须为「键: 值」形式：${trailer}`)
  return trailers.flatMap((trailer) => ['--trailer', trailer])
}

/**
 * Sync a derived project to a template commit on branch `template-sync/<short>`.
 * Preflight failures throw PreflightError before any branch or file change.
 * @param {SyncOptions} options
 * @returns {Promise<{status: 'up-to-date' | 'conflicts' | 'failed' | 'unverified' | 'synced', branch?: string, reportPath?: string, report?: import('./template-sync/report.mjs').SyncReport}>}
 */
export async function runSync(options) {
  const log = options.log ?? ((message) => console.error(message))
  const runner = options.runner ?? defaultRunner
  const project = resolve(options.project)
  const top = gitRaw(project, ['rev-parse', '--show-toplevel'])
  if (top.status !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(project)) {
    throw new PreflightError('--project 必须是衍生项目的 Git 仓库根目录')
  }
  let record
  try {
    record = await readBaseRecord(project)
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new PreflightError(
        '项目缺少 .template-base.json；请先运行 template-sync infer-base 推断模板基准',
      )
    }
    throw new PreflightError(
      `基准记录无效：${error.message}；可运行 template-sync infer-base 重新推断`,
    )
  }
  trailerArgs(options.trailers)
  if (!record.clean || !record.commit) {
    throw new PreflightError(
      '基准记录 clean=false：项目生成自有未提交改动的模板，无法确定基准；请运行 template-sync infer-base',
    )
  }
  if (git(project, ['status', '--porcelain', '--untracked-files=all'])) {
    throw new PreflightError('项目工作区有未提交的改动或未跟踪文件，请先提交或清理后再同步')
  }

  const source = options.template ?? record.repository
  const work = await mkdtemp(join(tmpdir(), 'template-sync-'))
  let clone
  try {
    clone = await cloneTemplate(source, log).catch((error) => {
      throw new PreflightError(error.message)
    })
    const base = resolveCommit(clone, record.commit)
    if (base !== record.commit) throw new PreflightError(`模板中不存在基准提交 ${record.commit}`)
    const releases = listReleases(clone.dir)
    const fallback = !options.to && !releases.length
    const ref = options.to ?? releases.at(-1)?.tag ?? 'HEAD'
    const requested = resolveCommit(clone, ref)
    let target = requested
    if (!target) throw new PreflightError(`模板中不存在目标 ${ref}`)
    const upgrades = planUpgrades({
      cwd: clone.dir,
      base,
      target,
      params: record.params,
      repository: record.repository,
      confirmed: options.confirmDeployed ?? [],
    })
    target = upgrades.target
    const notes = [
      ...(fallback ? ['没有 template-v* 发布版本，默认目标回退到 HEAD（目标未发布）'] : []),
      ...(upgrades.boundary
        ? [
            `先部署 ${upgrades.boundary.version}，再用 --confirm-deployed ${upgrades.boundary.version} 继续同步到 ${ref}（${upgrades.boundary.requiredBy} 要求）`,
          ]
        : []),
      ...(options.skipVerify ? ['--skip-verify 仅供同步工具自身测试使用，不更新基准记录'] : []),
    ]
    for (const note of notes) log(note)
    if (base === target) {
      if (!upgrades.boundary) {
        log(`已是最新：项目基准已是 ${shortSha(target)}，没有可采纳的模板更新`)
        return { status: 'up-to-date' }
      }
      log(`基准已在部署边界 ${upgrades.boundary.version}，等待确认已部署后继续`)
      const report = {
        template: source,
        base: { commit: base, version: record.version },
        target: {
          ref: `template-v${upgrades.boundary.version}`,
          commit: target,
          version: releases.findLast((release) => release.commit === target)?.version ?? null,
        },
        branch: git(project, ['branch', '--show-current']),
        resumed: false,
        applied: [],
        conflicts: [],
        setupDiff: '',
        ported: [],
        skippedMigrations: [],
        lockChanges: [],
        checks: [],
        baseUpdated: false,
        notes,
        upgrades,
        migrationComparison: { actual: [], documented: [], warnings: [] },
      }
      const reportPath = resolve(
        options.report ??
          join(
            git(project, ['rev-parse', '--absolute-git-dir']),
            'template-sync',
            `${shortSha(target)}.md`,
          ),
      )
      await mkdir(dirname(reportPath), { recursive: true })
      await writeFile(reportPath, renderReport(report))
      log(`同步报告：${reportPath}`)
      return { status: 'up-to-date', report, reportPath }
    }
    const branch = syncBranchName(target)
    const current = gitRaw(project, ['symbolic-ref', '--quiet', '--short', 'HEAD']).stdout.trim()
    const resumed = current === branch
    if (
      !resumed &&
      gitRaw(project, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0
    ) {
      throw new PreflightError(`同步分支 ${branch} 已存在；切换到该分支继续，或删除后重新同步`)
    }

    log(`生成基准 ${shortSha(base)} 与目标 ${shortSha(target)} 的副本`)
    const baseCopy = join(work, 'base')
    const targetCopy = join(work, 'target')
    let copies
    let plan
    try {
      await generateAt(clone, base, record.params, baseCopy)
      await generateAt(clone, target, record.params, targetCopy)
      copies = await commitCopies(baseCopy, targetCopy, (dir) =>
        postprocessProject(dir, { reference: targetCopy }),
      )
      plan = await planMigrations({
        baseCopy,
        targetCopy,
        recorded: record.migrations,
        skip: options.skipMigrations ?? [],
      })
    } catch (error) {
      await copies?.cleanup()
      throw new PreflightError(error.message)
    }
    try {
      fetchCopies(project, copies.repo)
    } finally {
      await copies.cleanup()
    }
    const changes = templateChanges(project)

    /** @type {import('./template-sync/report.mjs').SyncReport} */
    const report = {
      template: source,
      base: { commit: base, version: record.version },
      target: {
        ref: target === requested ? ref : `template-v${upgrades.boundary.version}`,
        defaulted: !options.to && target === requested,
        commit: target,
        version: releases.findLast((release) => release.commit === target)?.version ?? null,
      },
      branch,
      resumed,
      applied: [],
      conflicts: [],
      setupDiff: setupDiff(project),
      retained: [],
      ported: [],
      skippedMigrations: plan.skipped,
      commentOnlyMigrations: plan.commentOnly,
      lockChanges: [],
      checks: [],
      baseUpdated: false,
      notes,
      upgrades,
      migrationComparison: reconcileMigrations(upgrades, plan),
    }
    const finish = async (status) => {
      const reportPath = resolve(
        options.report ??
          join(
            git(project, ['rev-parse', '--absolute-git-dir']),
            'template-sync',
            `${shortSha(target)}.md`,
          ),
      )
      await mkdir(dirname(reportPath), { recursive: true })
      await writeFile(reportPath, renderReport(report))
      log(`同步报告：${reportPath}`)
      return { status, branch, reportPath, report }
    }

    report.retained = retainedDeletions(project, changes)
    if (!resumed) {
      git(project, ['switch', '--quiet', '--create', branch])
      Object.assign(report, applyTemplateChanges(project, changes))
      if (report.conflicts.length) {
        report.checks.push({
          name: '依赖安装与验证',
          command: '-',
          status: 'skip',
          detail: '存在冲突',
        })
        return finish('conflicts')
      }
    }

    let failed = false
    const step = (name, command, args, { run = true, failureHint } = {}) => {
      const label = [command, ...args].join(' ')
      if (options.skipVerify || failed || !run) {
        const detail = failed ? '前序步骤失败' : !run ? '没有 package.json 变化' : undefined
        report.checks.push({ name, command: label, status: 'skip', detail })
        return
      }
      log(`运行 ${label}`)
      const result = runner(command, args, { cwd: project })
      const ok = result.status === 0
      report.checks.push({
        name,
        command: label,
        status: ok ? 'pass' : 'fail',
        detail: ok ? undefined : [lastLine(result.output), failureHint].filter(Boolean).join('。'),
      })
      if (!ok) {
        failed = true
        if (failureHint) log(failureHint)
      }
    }
    const attempt = async (name, command, action) => {
      if (options.skipVerify || failed) {
        report.checks.push({
          name,
          command,
          status: 'skip',
          detail: failed ? '前序步骤失败' : undefined,
        })
        return
      }
      try {
        const detail = await action()
        report.checks.push({ name, command, status: 'pass', detail })
      } catch (error) {
        failed = true
        report.checks.push({ name, command, status: 'fail', detail: error.message })
      }
    }

    const lockPath = join(project, 'pnpm-lock.yaml')
    const lockBefore = existsSync(lockPath) ? await readFile(lockPath, 'utf8') : ''
    const manifests = changes.some(
      (change) =>
        basename(change.path) === 'package.json' ||
        (change.from && basename(change.from) === 'package.json'),
    )
    step('依赖重新解析', 'pnpm', ['install', '--no-frozen-lockfile'], { run: manifests })
    step('锁文件一致性', 'pnpm', ['install', '--frozen-lockfile'], { run: manifests })
    const lockAfter = existsSync(lockPath) ? await readFile(lockPath, 'utf8') : ''
    report.lockChanges = diffLockPackages(lockBefore, lockAfter)

    const migrationsDir = join(project, migrationsPath)
    report.ported = await portMigrations(project, plan.port, targetCopy)
    const drizzleCommand = 'drizzle-kit generate'
    if (report.ported.length) {
      await attempt('合并后 schema 的 snapshot', drizzleCommand, async () => {
        const written = await finalizeSnapshot(
          project,
          report.ported,
          await drizzleGenerate(project, migrationsDir, runner),
        )
        // 项目的 biome check 覆盖迁移 meta：中间 snapshot 由移植复制写出，最后一个由 drizzle-kit 生成，
        // 都要按项目格式化规则整理，只格式化最后一个会让衍生项目 pnpm check 失败。
        const format = runner(
          'pnpm',
          ['exec', 'biome', 'format', '--write', `${migrationsPath}/meta`],
          {
            cwd: project,
          },
        )
        if (format.status !== 0) throw new Error(`biome format 失败：${lastLine(format.output)}`)
        return written.length ? undefined : '模板迁移未改变 schema，沿用上一个 snapshot'
      })
    }
    git(project, ['add', '--all'])
    if (gitRaw(project, ['diff', '--cached', '--quiet']).status !== 0) {
      git(project, [
        'commit',
        '--quiet',
        '--no-verify',
        ...trailerArgs(options.trailers),
        '-m',
        `chore(template-sync): 采纳模板 ${shortSha(base)}..${shortSha(target)}`,
      ])
    }

    await attempt('drizzle-kit generate 无变化', drizzleCommand, async () => {
      if (await drizzleGenerate(project, migrationsDir, runner)) {
        throw new Error('合并后的 schema 与迁移不一致，drizzle-kit 会生成新迁移')
      }
    })
    if (options.verifyDb) {
      await attempt('迁移：空库执行项目迁移后增量执行移植迁移', 'drizzle migrate', async () => {
        if (!(await isEmptyDatabase(project, options.verifyDb))) {
          throw new Error('--verify-db 必须指向空的隔离数据库')
        }
        const before = join(work, 'migrations-before')
        await migrationsWithout(
          migrationsDir,
          report.ported.map((item) => item.tag),
          before,
        )
        const { executed } = await migrateIncrementally({
          project,
          url: options.verifyDb,
          before,
          after: migrationsDir,
        })
        const expected = report.ported.map((item) => item.when)
        if (executed.join(',') !== expected.join(',')) {
          throw new Error(
            `增量迁移执行了 ${executed.length} 个，应为 ${expected.length} 个移植迁移`,
          )
        }
        return `增量执行 ${executed.length} 个移植迁移`
      })
    } else {
      report.checks.push({
        name: '迁移数据库验证',
        command: 'drizzle migrate',
        status: 'skip',
        detail: '未提供 --verify-db 隔离空库',
      })
    }
    step('锁文件去重检查', 'pnpm', ['dedupe', '--check'], {
      failureHint: '请运行 pnpm dedupe，提交 pnpm-lock.yaml 的变更后重跑同步。',
    })
    step('类型检查', 'pnpm', ['typecheck'])
    step('单元测试', 'pnpm', ['test'])
    step('生产构建', 'pnpm', ['build'])

    if (failed) return finish('failed')
    // 跳过验证不等于验证通过，基准只在验证全部通过后才更新。
    if (options.skipVerify) {
      report.notes.push('验证已跳过，基准未更新')
      return finish('unverified')
    }
    const migrations = [...record.migrations]
    for (const tag of [...report.ported.map((item) => item.source), ...plan.skipped]) {
      if (!migrations.includes(tag)) migrations.push(tag)
    }
    await writeFile(
      join(project, '.template-base.json'),
      serializeBaseRecord({
        ...record,
        commit: target,
        version: report.target.version,
        migrations,
      }),
    )
    git(project, ['add', '.template-base.json'])
    git(project, [
      'commit',
      '--quiet',
      '--no-verify',
      ...trailerArgs(options.trailers),
      '-m',
      `chore(template-sync): 更新模板基准到 ${shortSha(target)}`,
    ])
    report.baseUpdated = true
    return finish('synced')
  } finally {
    await clone?.cleanup()
    await rm(work, { recursive: true, force: true })
  }
}

const usage = `用法：node scripts/template-sync.mjs <命令> [参数]

命令：
  sync --project <路径> [--to <ref>] [--template <URL|路径>] [--report <文件>]
       [--confirm-deployed <已部署版本>]... [--skip-migration <模板迁移 tag>]... [--verify-db <空库 URL>] [--skip-verify]
       [--trailer "<键>: <值>"]...（追加到同步提交，如 Co-Authored-By）
  infer-base --project <路径> [--template <URL|路径>] [--since <YYYY-MM-DD>] [--until <YYYY-MM-DD>]
             [--generation-commit <完整 SHA>] [--param key=value]... [--threshold <行数，默认 50>]
             [--write <候选完整 SHA> [--force]]
             --generation-commit 从 HEAD 或其祖先还原参数并确定默认时间窗，默认取最早的根提交。
             --param domain=acme.example 与 create-project --domain 一样会补 https://，完整值填不带末尾斜线的 HTTPS origin。
             --threshold 只比较文本差异行数，二进制差异需人工核对。
             --force 允许写入超过阈值的指定候选，并显示警告。
`

async function syncCommand(args) {
  const { values } = parseArgs({
    args,
    options: {
      project: { type: 'string' },
      to: { type: 'string' },
      template: { type: 'string' },
      report: { type: 'string' },
      'confirm-deployed': { type: 'string', multiple: true },
      'skip-migration': { type: 'string', multiple: true },
      'verify-db': { type: 'string' },
      'skip-verify': { type: 'boolean' },
      trailer: { type: 'string', multiple: true },
    },
  })
  if (!values.project) throw new Error(`缺少 --project\n${usage}`)
  const result = await runSync({
    project: values.project,
    to: values.to,
    template: values.template,
    report: values.report,
    confirmDeployed: values['confirm-deployed'] ?? [],
    skipMigrations: values['skip-migration'] ?? [],
    verifyDb: values['verify-db'],
    skipVerify: values['skip-verify'],
    trailers: values.trailer ?? [],
  })
  if (result.status === 'conflicts')
    console.error(
      `存在 ${result.report.conflicts.length} 个冲突，已留在分支 ${result.branch} 的工作区`,
    )
  if (result.status === 'failed')
    console.error(`验证失败，基准记录未更新；分支 ${result.branch} 保留供排查`)
  if (result.status === 'unverified')
    console.error(`验证已跳过，基准记录未更新；分支 ${result.branch} 保留`)
  if (result.status === 'synced') console.error(`同步完成：分支 ${result.branch}，未推送或合并`)
  return ['conflicts', 'failed', 'unverified'].includes(result.status) ? 1 : 0
}

/** CLI subcommands share the same template checkout. */
export const commands = { sync: syncCommand, 'infer-base': inferCommand }

/**
 * CLI entry: dispatch the first positional argument to a subcommand.
 * @param {string[]} argv Arguments after the script path.
 * @returns {Promise<number>} Exit code.
 */
export async function main(argv) {
  const [name, ...rest] = argv
  if (!name || name === '--help' || name === '-h') {
    console.log(usage)
    return name ? 0 : 1
  }
  const command = commands[name]
  if (!command) throw new Error(`未知命令 ${name}\n${usage}`)
  return command(rest)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(`同步失败：${error.message}`)
      process.exitCode = error instanceof PreflightError ? 2 : 1
    },
  )
}
