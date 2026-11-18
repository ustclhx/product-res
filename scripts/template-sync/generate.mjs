import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { paramsToArgs } from '../template-base.mjs'
import { listReleases } from '../template-release.mjs'
import { git, gitEnv, gitRaw } from './git.mjs'

/**
 * @typedef {object} TemplateClone
 * @property {string} dir Clone directory (no checkout; blobs fetched on demand).
 * @property {string} source The URL or local path that was cloned.
 * @property {() => Promise<void>} cleanup Remove the clone and its temporary parent.
 */

/**
 * Clone the template without a checkout into a fresh directory under os.tmpdir().
 * Local paths use --no-local so the clone never hard-links the source object store.
 * @param {string} source Repository URL or local path.
 * @returns {Promise<TemplateClone>}
 */
export async function cloneTemplate(source) {
  if (!source) throw new Error('缺少模板来源：基准记录没有 repository，请用 --template 指定')
  const parent = await mkdtemp(join(tmpdir(), 'template-sync-clone-'))
  const cleanup = () => rm(parent, { recursive: true, force: true })
  const local = !/^[a-z][a-z0-9+.-]*:\/\//i.test(source) && !/^[^/@:]+@[^:]+:/.test(source)
  const from = local ? resolve(source) : source
  const dir = join(parent, 'template')
  const result = gitRaw(parent, [
    'clone',
    '--quiet',
    '--filter=blob:none',
    '--no-checkout',
    ...(local ? ['--no-local'] : []),
    from,
    dir,
  ])
  if (result.status !== 0) {
    await cleanup()
    throw new Error(`无法克隆模板 ${source}：${result.stderr.trim()}`)
  }
  return { dir, source, cleanup }
}

/**
 * Resolve a ref (branch, remote branch, tag or SHA) in a clone to a full commit SHA.
 * `HEAD` is the template's default branch in a fresh clone.
 * @param {TemplateClone} clone
 * @param {string} ref
 * @returns {string | null} 40-character SHA, or null when the commit does not exist.
 */
export function resolveCommit(clone, ref) {
  for (const candidate of [ref, `origin/${ref}`, `refs/tags/${ref}`]) {
    const result = gitRaw(clone.dir, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`])
    if (result.status === 0) return result.stdout.trim()
  }
  return null
}

/**
 * Highest annotated `template-v<SemVer>` release pointing exactly at a commit.
 * @param {TemplateClone} clone
 * @param {string} commit Full SHA.
 * @returns {string | null} Version without the `template-v` prefix.
 */
export function releaseVersion(clone, commit) {
  return listReleases(clone.dir).findLast((release) => release.commit === commit)?.version ?? null
}

/**
 * Generate a project copy from a clean archive of `rev`, using that commit's own generator.
 * Throws with the commit and the rejected parameter when the generator refuses the params.
 * @param {TemplateClone} clone
 * @param {string} rev Commit SHA.
 * @param {Record<string, string | boolean | string[]>} params Normalized baseline params.
 * @param {string} outDir Absolute output directory; must not exist yet.
 * @returns {Promise<void>}
 */
export async function generateAt(clone, rev, params, outDir) {
  if (!isAbsolute(outDir)) throw new Error('outDir 必须是绝对路径')
  // 生成器以 argv[1] 与 import.meta.url 比对判断是否直接运行，路径须先解析掉 /var 一类符号链接。
  const work = await realpath(await mkdtemp(join(tmpdir(), 'template-sync-tree-')))
  try {
    const tree = join(work, 'tree')
    await mkdir(tree)
    const archive = join(work, 'tree.tar')
    git(clone.dir, ['archive', '--format=tar', '-o', archive, rev])
    const untar = spawnSync('tar', ['-xf', archive, '-C', tree], { encoding: 'utf8' })
    if (untar.status !== 0) throw new Error(`解包模板提交 ${rev} 失败：${untar.stderr}`)
    const generator = join(tree, 'scripts/create-project.mjs')
    if (!existsSync(generator)) throw new Error(`模板提交 ${rev} 中没有 scripts/create-project.mjs`)
    const args = paramsToArgs(params)
    const result = spawnSync(
      process.execPath,
      [generator, ...args, '--output', outDir, '--skip-check'],
      { cwd: tree, encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
    )
    if (result.error) throw result.error
    if (result.status !== 0) {
      const message = `${result.stderr}\n${result.stdout}`.trim()
      const unknown = message.match(/Unknown option '--([\w-]+)'/)
      const named =
        unknown?.[1] ??
        args.find((arg, index) => index % 2 === 0 && message.includes(arg))?.slice(2)
      throw new Error(
        `模板提交 ${rev} 的生成器拒绝参数${named ? ` --${named}` : ''}：${message.split('\n')[0]}`,
      )
    }
    if (!existsSync(outDir)) throw new Error(`模板提交 ${rev} 的生成器没有产生输出目录`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
