import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

/** Migrations folder relative to a project or generated copy. */
export const migrationsPath = 'packages/db/migrations'

/**
 * Read a Drizzle journal (meta/_journal.json) from a migrations folder.
 * @param {string} dir Migrations folder.
 * @returns {Promise<{version: string, dialect: string, entries: {idx: number, version: string, when: number, tag: string, breakpoints: boolean}[]}>}
 */
export async function readJournal(dir) {
  return JSON.parse(await readFile(join(dir, 'meta/_journal.json'), 'utf8'))
}

/**
 * Work out which template migrations to port between two generated copies.
 * A migration present in the baseline copy but changed or removed in the target stops the sync;
 * changes limited to whole-line SQL comments are reported in `commentOnly` instead.
 * @param {{baseCopy: string, targetCopy: string, recorded: string[], skip?: string[]}} input
 *   Generated copy roots, baseline `migrations`, and template tags the user chose to skip.
 * @returns {Promise<{port: {tag: string, entry: object}[], skipped: string[], commentOnly: string[]}>}
 *   `port` keeps template order; `tag` is the original template tag.
 */
// 只去掉整行注释与行尾空白：模板给已发布迁移补 `-- rollback-safe:` 等说明不改变语义，
// 行内注释和字符串保持原样，避免把真实语句差异误判为注释。
const withoutLineComments = (sql) =>
  sql
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line && !/^\s*--(?!>)/.test(line))
    .join('\n')

export async function planMigrations({ baseCopy, targetCopy, recorded, skip = [] }) {
  const baseDir = join(baseCopy, migrationsPath)
  const targetDir = join(targetCopy, migrationsPath)
  const base = await readJournal(baseDir)
  const target = await readJournal(targetDir)
  const targetTags = new Set(target.entries.map((entry) => entry.tag))
  const commentOnly = []
  for (const { tag } of base.entries) {
    if (!targetTags.has(tag)) throw new Error(`模板删除了已发布迁移 ${tag}，同步停止`)
    const [before, after] = await Promise.all([
      readFile(join(baseDir, `${tag}.sql`)),
      readFile(join(targetDir, `${tag}.sql`)),
    ])
    if (before.equals(after)) continue
    if (
      withoutLineComments(before.toString('utf8')) !== withoutLineComments(after.toString('utf8'))
    )
      throw new Error(`模板修改了已发布迁移 ${tag}，同步停止`)
    commentOnly.push(tag)
  }
  const baseTags = new Set(base.entries.map((entry) => entry.tag))
  const pending = target.entries.filter(
    (entry) => !baseTags.has(entry.tag) && !recorded.includes(entry.tag),
  )
  const pendingTags = new Set(pending.map((entry) => entry.tag))
  const unknown = skip.filter((tag) => !pendingTags.has(tag))
  if (unknown.length) {
    throw new Error(
      `--skip-migration 不在待移植列表中：${unknown.join(', ')}（待移植：${[...pendingTags].join(', ') || '无'}）`,
    )
  }
  return {
    port: pending
      .filter((entry) => !skip.includes(entry.tag))
      .map((entry) => ({ tag: entry.tag, entry })),
    skipped: pending.filter((entry) => skip.includes(entry.tag)).map((entry) => entry.tag),
    commentOnly,
  }
}

const lastLine = (text) =>
  text
    .split('\n')
    .filter((line) => line.trim())
    .at(-1) ?? ''
const snapshotFile = (tag) => `meta/${tag.split('_')[0]}_snapshot.json`
const json = (value) => `${JSON.stringify(value, null, 2)}\n`

/**
 * Append template migrations to the project's sequence: `<next idx>_tpl_<name>.sql`,
 * journal `when` strictly after every existing entry, snapshots chained from the last one.
 * @param {string} project Project root.
 * @param {{tag: string, entry: object}[]} port From planMigrations().
 * @param {string} targetCopy Generated target copy root (source of renamed SQL).
 * An identical `*_tpl_<name>` migration already in the journal is reused (`reused: true`).
 * @returns {Promise<{source: string, tag: string, idx: number, when: number, reused?: boolean}[]>}
 */
export async function portMigrations(project, port, targetCopy) {
  if (!port.length) return []
  const dir = join(project, migrationsPath)
  const journal = await readJournal(dir)
  const last = journal.entries.at(-1)
  let idx = Math.max(-1, ...journal.entries.map((entry) => entry.idx)) + 1
  let when = Math.max(0, ...journal.entries.map((entry) => entry.when)) + 1
  let previous = last ? JSON.parse(await readFile(join(dir, snapshotFile(last.tag)), 'utf8')) : null
  if (!previous) throw new Error('项目迁移目录没有可沿用的 snapshot')
  const ported = []
  for (const { tag, entry } of port) {
    const name = tag.replace(/^\d+_/, '')
    const content = await readFile(join(targetCopy, migrationsPath, `${tag}.sql`))
    // 同一同步分支上重跑（如验证失败后修复）时，已移植的迁移直接沿用，避免重复追加。
    const existing = journal.entries.find((item) => item.tag.endsWith(`_tpl_${name}`))
    if (existing && content.equals(await readFile(join(dir, `${existing.tag}.sql`)))) {
      ported.push({
        source: tag,
        tag: existing.tag,
        idx: existing.idx,
        when: existing.when,
        reused: true,
      })
      continue
    }
    const newTag = `${String(idx).padStart(4, '0')}_tpl_${name}`
    await writeFile(join(dir, `${newTag}.sql`), content)
    // 中间迁移的 snapshot 只承担 id 链；最终结构由 finalizeSnapshot 写入最后一个。
    previous = { ...previous, id: randomUUID(), prevId: previous.id }
    await writeFile(join(dir, snapshotFile(newTag)), json(previous))
    journal.entries.push({
      idx,
      version: entry.version,
      when,
      tag: newTag,
      breakpoints: entry.breakpoints,
    })
    ported.push({ source: tag, tag: newTag, idx, when })
    idx += 1
    when += 1
  }
  await writeFile(join(dir, 'meta/_journal.json'), json(journal))
  return ported
}

/**
 * Run drizzle-kit generate against a temporary copy of a migrations folder, using the project's
 * schema and drizzle-kit. Nothing in the project is written.
 * @param {string} project Project root.
 * @param {string} source Migrations folder to copy.
 * @param {(command: string, args: string[], options: {cwd: string}) => {status: number | null, output: string}} run
 * @returns {Promise<object | null>} The newly generated snapshot, or null for "no schema changes".
 */
export async function drizzleGenerate(project, source, run) {
  const work = await mkdtemp(join(tmpdir(), 'template-sync-drizzle-'))
  try {
    const out = join(work, 'migrations')
    await cp(source, out, { recursive: true })
    const dbDir = join(project, 'packages/db')
    const before = new Set(await readdir(join(out, 'meta')))
    const config = join(work, 'drizzle.config.ts')
    // drizzle-kit 把 out 拼成 ./<out>，只能用相对于 db 包目录的路径。
    await writeFile(
      config,
      `import base from ${JSON.stringify(join(dbDir, 'drizzle.config.ts'))}\nexport default { ...base, out: ${JSON.stringify(relative(dbDir, out))} }\n`,
    )
    const result = run(
      'pnpm',
      ['--filter', './packages/db', 'exec', 'drizzle-kit', 'generate', '--config', config],
      {
        cwd: project,
      },
    )
    if (result.status !== 0)
      throw new Error(`drizzle-kit generate 失败：${result.output.trim().split('\n').at(-1)}`)
    const created = (await readdir(join(out, 'meta'))).filter(
      (name) => name.endsWith('_snapshot.json') && !before.has(name),
    )
    if (!created.length) {
      // drizzle-kit 0.31 在 schema 加载失败时也以 0 退出，只有明确的「无变化」才算通过。
      if (!result.output.includes('No schema changes')) {
        const error = result.output.split('\n').find((line) => /error/i.test(line))
        throw new Error(`drizzle-kit generate 未完成：${(error ?? lastLine(result.output)).trim()}`)
      }
      return null
    }
    return JSON.parse(await readFile(join(out, 'meta', created.sort().at(-1)), 'utf8'))
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/**
 * Replace the last ported snapshot with the structure drizzle-kit computes for the merged schema,
 * keeping its place in the id chain. A null snapshot (no schema change) keeps the chained copy.
 * @param {string} project Project root.
 * @param {{tag: string}[]} ported From portMigrations().
 * @param {object | null} snapshot From drizzleGenerate().
 * @returns {Promise<string[]>} Snapshot paths written, relative to the project.
 */
export async function finalizeSnapshot(project, ported, snapshot) {
  if (!ported.length || !snapshot) return []
  // 只有移植迁移仍位于序列末尾时，生成的结构才属于它；否则交给末尾迁移自己的 snapshot。
  const journal = await readJournal(join(project, migrationsPath))
  if (journal.entries.at(-1)?.tag !== ported.at(-1).tag) return []
  const path = join(migrationsPath, snapshotFile(ported.at(-1).tag))
  const current = JSON.parse(await readFile(join(project, path), 'utf8'))
  await writeFile(
    join(project, path),
    json({ ...snapshot, id: current.id, prevId: current.prevId }),
  )
  return [path]
}

function loadMigrator(project) {
  const require = createRequire(join(project, 'packages/db/package.json'))
  return {
    postgres: require('postgres'),
    drizzle: require('drizzle-orm/postgres-js').drizzle,
    migrate: require('drizzle-orm/postgres-js/migrator').migrate,
  }
}

/**
 * True when the database has no user tables and no migrations schema yet.
 * @param {string} project Project root (resolves the project's postgres driver).
 * @param {string} url Postgres URL.
 * @param {string} [migrationsSchema]
 */
export async function isEmptyDatabase(project, url, migrationsSchema = 'drizzle') {
  const { postgres } = loadMigrator(project)
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    const [{ n }] =
      await sql`select count(*)::int as n from information_schema.tables where table_schema not in ('pg_catalog', 'information_schema')`
    const [{ s }] =
      await sql`select count(*)::int as s from information_schema.schemata where schema_name = ${migrationsSchema}`
    return n === 0 && s === 0
  } finally {
    await sql.end()
  }
}

/**
 * Migrate a database with `before` (the project's own sequence), then with `after` (including
 * ported migrations), and return what the second run recorded. Uses the project's drizzle-orm.
 * @param {{project: string, url: string, before: string, after: string, migrationsSchema?: string}} input
 * @returns {Promise<{beforeCount: number, executed: number[]}>} `executed` lists created_at values added by `after`.
 */
export async function migrateIncrementally({
  project,
  url,
  before,
  after,
  migrationsSchema = 'drizzle',
}) {
  const { postgres, drizzle, migrate } = loadMigrator(project)
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  const rows = () =>
    sql.unsafe(
      `select created_at from "${migrationsSchema.replaceAll('"', '""')}".__drizzle_migrations order by id`,
    )
  try {
    if (existsSync(join(before, 'meta/_journal.json'))) {
      await migrate(drizzle(sql), { migrationsFolder: before, migrationsSchema })
    }
    const beforeCount = (await rows()).length
    await migrate(drizzle(sql), { migrationsFolder: after, migrationsSchema })
    const executed = (await rows()).slice(beforeCount).map((row) => Number(row.created_at))
    return { beforeCount, executed }
  } finally {
    await sql.end()
  }
}

/**
 * Copy a migrations folder whose journal omits the given tags: the project's sequence as it
 * stood before this sync's ports, for the incremental migration check.
 * @param {string} source Migrations folder.
 * @param {string[]} tags Journal tags to drop.
 * @param {string} out Destination folder (must not exist).
 */
export async function migrationsWithout(source, tags, out) {
  await cp(source, out, { recursive: true })
  const journal = await readJournal(out)
  journal.entries = journal.entries.filter((entry) => !tags.includes(entry.tag))
  await writeFile(join(out, 'meta/_journal.json'), json(journal))
}
