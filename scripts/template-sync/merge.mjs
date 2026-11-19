import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, gitRaw } from './git.mjs'

/** Paths the file merge never touches (design D3); each is handled by its own step. */
export const excludedPaths = [
  'packages/db/migrations',
  '.template-base.json',
  'PROJECT_SETUP.md',
  'pnpm-lock.yaml',
]
// 新版首次交付占位文件；后续同步不覆盖项目已接管的注册与品牌。
export const projectOwnedPaths = new Set([
  'apps/web/src/features/theme/html-attributes.ts',
  'apps/web/src/features/share-cards/share-cards.project.ts',
  'apps/web/src/features/share-cards/share-cards.theme.ts',
  'apps/web/src/features/share-cards/share-cards.fonts.ts',
  'apps/web/src/features/share-cards/share-cards.sites.ts',
  'apps/web/src/features/ai/message-parts.project.tsx',
  'apps/web/src/features/ai/chat-composer.project.tsx',
  'apps/web/src/features/theme/fonts.project.ts',
  'apps/web/scripts/critical-css.project.mjs',
])
export const baseRef = 'refs/template-sync/base'
export const targetRef = 'refs/template-sync/target'

// 固定身份与时间，使同一对副本得到相同的临时提交，便于复现报告。
const identity = {
  GIT_AUTHOR_NAME: 'template-sync',
  GIT_AUTHOR_EMAIL: 'template-sync@localhost',
  GIT_COMMITTER_NAME: 'template-sync',
  GIT_COMMITTER_EMAIL: 'template-sync@localhost',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
}

/**
 * Branch name used for a sync to the given target commit.
 * @param {string} targetCommit Full SHA.
 */
export function syncBranchName(targetCommit) {
  return `template-sync/${shortSha(targetCommit)}`
}

/** @param {string} sha */
export function shortSha(sha) {
  return sha.slice(0, 12)
}

/**
 * Commit two generated copies into a throwaway repository as `base` then `target`.
 * @param {string} baseDir Generated copy for the baseline commit.
 * @param {string} targetDir Generated copy for the target commit.
 * @returns {Promise<{repo: string, cleanup: () => Promise<void>}>}
 */
export async function commitCopies(baseDir, targetDir) {
  const repo = await mkdtemp(join(tmpdir(), 'template-sync-copies-'))
  const cleanup = () => rm(repo, { recursive: true, force: true })
  try {
    git(repo, ['init', '--quiet', '--bare'])
    let parent = null
    for (const [name, dir] of [
      ['base', baseDir],
      ['target', targetDir],
    ]) {
      const env = identity
      const run = (args) => git(dir, ['--git-dir', repo, '--work-tree', dir, ...args], { env })
      run(['add', '--all', '.'])
      const tree = run(['write-tree'])
      const commit = run(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', name])
      run(['update-ref', `refs/heads/${name}`, commit])
      parent = commit
    }
    return { repo, cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}

/**
 * Fetch the copy commits into the project as refs/template-sync/{base,target}.
 * @param {string} project Project root.
 * @param {string} repo Repository returned by commitCopies().
 */
export function fetchCopies(project, repo) {
  git(project, [
    'fetch',
    '--quiet',
    '--no-tags',
    repo,
    `+refs/heads/base:${baseRef}`,
    `+refs/heads/target:${targetRef}`,
  ])
}

const pathspec = ['--', '.', ...excludedPaths.map((path) => `:(exclude,top)${path}`)]

/**
 * @typedef {object} TemplateChange
 * @property {string} status Git name-status letter (A, M, D, R, C, T).
 * @property {string} path Path in the target copy (old path for deletions).
 * @property {string} [from] Previous path for renames and copies.
 */

/**
 * Template changes between the fetched copies, excluding design D3 paths.
 * @param {string} project Project root.
 * @returns {TemplateChange[]}
 */
export function templateChanges(project) {
  const fields = git(
    project,
    ['diff', '-M', '--name-status', '-z', baseRef, targetRef, ...pathspec],
    {
      trim: false,
    },
  )
    .split('\0')
    .filter((field, index, all) => field || index < all.length - 1)
  const changes = []
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++]
    if (!status) break
    if (status[0] === 'R' || status[0] === 'C') {
      changes.push({ status: status[0], from: fields[index], path: fields[index + 1] })
      index += 2
    } else {
      changes.push({ status: status[0], path: fields[index] })
      index += 1
    }
  }
  return changes.filter(
    (change) =>
      change.status === 'A' ||
      (!projectOwnedPaths.has(change.path) && !projectOwnedPaths.has(change.from)),
  )
}

/**
 * Diff of the excluded PROJECT_SETUP.md between the copies, for the report only.
 * @param {string} project Project root.
 * @returns {string} Unified diff, empty when unchanged.
 */
export function setupDiff(project) {
  return git(project, ['diff', baseRef, targetRef, '--', 'PROJECT_SETUP.md'], { trim: false })
}

function blob(project, rev, path) {
  const result = gitRaw(project, ['rev-parse', '--quiet', '--verify', `${rev}:${path}`])
  return result.status === 0 ? result.stdout.trim() : null
}

/**
 * Files the template deleted that still exist in the project. They are never removed by the sync:
 * the report lists them and the user decides. Computed from HEAD so a resumed run reports the same list.
 * @param {string} project Project root.
 * @param {TemplateChange[]} changes From templateChanges().
 * @returns {{path: string, modified: boolean}[]}
 */
export function retainedDeletions(project, changes) {
  return changes
    .filter((change) => change.status === 'D')
    .map((change) => ({ path: change.path, current: blob(project, 'HEAD', change.path) }))
    .filter((item) => item.current !== null)
    .map((item) => ({
      path: item.path,
      modified: item.current !== blob(project, baseRef, item.path),
    }))
}

/**
 * Apply each template change to the project's index and working tree with a three-way fallback.
 * Changes are applied one at a time so one refused change does not abort the rest.
 * Deletions are skipped; see retainedDeletions().
 * @param {string} project Project root (on the sync branch, clean before the call).
 * @param {TemplateChange[]} changes From templateChanges().
 * @returns {{applied: string[], conflicts: {path: string, reason: string}[]}}
 */
export function applyTemplateChanges(project, changes) {
  const applied = []
  const conflicts = []
  for (const change of changes) {
    // 删除不自动执行：模板不再交付的文件可能仍被项目使用，只在报告中提示。
    if (change.status === 'D') continue
    const source = change.from ?? change.path
    if (change.status !== 'A' && blob(project, 'HEAD', source) === null) {
      // 项目已删除该文件而模板修改了它：git apply 只会报「不在索引中」，这里明确交给使用者决定。
      conflicts.push({ path: change.path, reason: '项目已删除该文件，模板修改了它' })
      continue
    }
    const paths = change.from ? [change.from, change.path] : [change.path]
    const patch = git(
      project,
      ['diff', '-M', '--binary', '--full-index', baseRef, targetRef, '--', ...paths],
      { trim: false },
    )
    const result = gitRaw(project, ['apply', '--3way', '--index', '--whitespace=nowarn', '-'], {
      input: patch,
    })
    if (result.status === 0) {
      applied.push(change.path)
      continue
    }
    const unmerged = git(project, ['ls-files', '--unmerged', '--', ...paths])
    const reason = unmerged
      ? '三方合并冲突，已保留冲突标记'
      : `无法应用：${result.stderr.trim().split('\n').at(-1) ?? ''}`
    conflicts.push({ path: change.path, reason })
  }
  return { applied, conflicts }
}
