import {
  compareVersions,
  listReleases,
  parseUpgradeDoc,
  releasesBetween,
} from '../template-release.mjs'
import { gitRaw } from './git.mjs'

const ancestor = (cwd, a, b) => gitRaw(cwd, ['merge-base', '--is-ancestor', a, b]).status === 0

/** Discover deployment boundaries, then read notes from the effective target tree. */
export function planUpgrades({ cwd, base, target, params, repository, confirmed = [] }) {
  const releases = listReleases(cwd)
  const interval = releasesBetween(base, target, cwd)
  let warnings = []
  const readDocuments = (ref, versions) =>
    versions.map((release) => {
      const path = `docs/upgrades/${release.version}.md`
      const result = gitRaw(cwd, ['show', `${ref}:${path}`])
      const link = repository
        ? `${repository.replace(/\.git$/, '').replace(/\/$/, '')}/blob/${ref}/${path}`
        : path
      if (result.status !== 0) {
        warnings.push(`缺少升级说明：${path}`)
        return { ...release, path, link, summary: '缺少升级说明', actions: [], migrations: [] }
      }
      const parsed = parseUpgradeDoc(result.stdout)
      if (parsed.errors.length) warnings.push(`${path} 格式问题：${parsed.errors.join('；')}`)
      return {
        ...release,
        path,
        link,
        summary: parsed.sections.概要 ?? '',
        previous: parsed.frontmatter.previous,
        requiresDeployed: parsed.frontmatter.requiresDeployed,
        actions: parsed.actions.filter((action) =>
          Object.entries(action.conditions).every(([key, expected]) => {
            const actual = params[key]
            return Array.isArray(actual) ? actual.includes(expected) : String(actual) === expected
          }),
        ),
        migrations: parsed.migrations.map((migration) => migration.tag),
      }
    })
  const documents = readDocuments(target, interval)
  let actual = target
  let boundary = null
  for (const document of documents) {
    const required = document.requiresDeployed
    if (!required || confirmed.includes(required)) continue
    const release = releases.find((item) => item.version === required)
    if (!release) throw new Error(`${document.path}: requiresDeployed ${required} 不是发布版本`)
    // 基准已越过边界时不倒退；恰好处于边界仍需明确声明线上已部署。
    if (release.commit !== base && ancestor(cwd, release.commit, base)) continue
    if (
      compareVersions(required, document.version) >= 0 ||
      !ancestor(cwd, release.commit, document.commit)
    ) {
      throw new Error(`${document.path}: requiresDeployed ${required} 必须早于当前版本`)
    }
    if (!ancestor(cwd, base, release.commit)) continue
    if (!boundary || ancestor(cwd, release.commit, actual)) {
      actual = release.commit
      boundary = { version: required, requiredBy: document.version }
    }
  }
  let included = documents
  if (actual !== target) {
    // 截断后只采纳实际目标的说明，避免把之后版本的动作或迁移清单提前带入。
    warnings = []
    included = readDocuments(
      actual,
      interval.filter((release) => ancestor(cwd, release.commit, actual)),
    )
  }
  const first = included[0]
  if (first) {
    const previous = first.previous
    const tag =
      typeof previous === 'string' && previous
        ? `refs/tags/${previous.startsWith('v') ? previous : `template-v${previous}`}`
        : null
    const resolved = tag
      ? gitRaw(cwd, ['rev-parse', '--verify', '--quiet', `${tag}^{commit}`])
      : null
    const commit = resolved?.status === 0 ? resolved.stdout.trim() : null
    if (commit !== base) {
      const reason = commit
        ? ''
        : tag
          ? `（无法将 previous ${previous} 解析为提交：${tag} 不存在或未指向提交）`
          : '（升级说明缺少有效的 previous，无法确定起点提交）'
      warnings.push(`${first.path} 中部分动作可能已随基准完成，需要逐项核对${reason}`)
    }
  }
  return { target: actual, documents: included, warnings, boundary }
}

/** Compare original template tags, including migrations explicitly skipped by the user. */
export function reconcileMigrations(upgrades, plan) {
  const actual = [...plan.port.map((item) => item.tag), ...plan.skipped]
  const documented = [...new Set(upgrades.documents.flatMap((document) => document.migrations))]
  const missing = actual.filter((tag) => !documented.includes(tag))
  const extra = documented.filter((tag) => !actual.includes(tag))
  return {
    actual,
    documented,
    warnings: [
      ...(missing.length
        ? [`迁移清单不一致：实际计划有、升级说明未列出：${missing.join(', ')}`]
        : []),
      ...(extra.length ? [`迁移清单不一致：升级说明有、实际计划未包含：${extra.join(', ')}`] : []),
    ],
  }
}
