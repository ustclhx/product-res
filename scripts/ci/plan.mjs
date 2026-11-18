#!/usr/bin/env node
// CI 计划：决定 .github/workflows/ci.yml 本次运行 full / docs / reuse 中的哪一种。
// - docs：变更全部是不进入构建与包测试的文档，只跑 lint 类检查（仍会读取 docs 与技能文件）。
// - reuse：main 上的 push 提交与其 PR 已成功全量测试过的合并树完全相同，跳过重复测试。
// 任何不确定（缺数据、API 失败、事件不认识、树不一致）都回退 full；脚本自身从不因此失败。
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const WORKFLOW_FILE = 'ci.yml'
export const TESTED_JOB_PREFIX = 'tested-tree '
const FULL_SHA = /^[0-9a-f]{40}$/

// 只有这些路径算文档。apps/、packages/、scripts/、deploy/ 下的 .md/.mdx 可能是内容集合、
// 测试夹具或打包输入，一律按代码处理。
const DOCS_PATTERNS = [/^docs\//, /^openspec\//, /^[^/]+\.md$/, /^\.(?:agents|claude|omp)\/.+\.md$/]

export function isDocsPath(path) {
  return DOCS_PATTERNS.some((re) => re.test(path))
}

/** 空变更也按 full：说明不了本次提交被测过 */
export function classify(paths) {
  return paths.length > 0 && paths.every(isDocsPath) ? 'docs' : 'full'
}

/**
 * 找到合并出 sha 的 PR，并确认该 PR 最近一次 CI 已在完全相同的树上全量通过。
 * @param {{ repo: string, sha: string, tree: string, api: {
 *   pullsForCommit: (sha: string) => Promise<any[]>,
 *   ciRuns: (headSha: string) => Promise<any[]>,
 *   runJobs: (runId: number) => Promise<any[]>,
 * }, pr?: any }} input
 * @returns {Promise<{ reuse: boolean, reason: string, run?: string }>}
 */
export async function findReuse({ repo, sha, tree, api, pr }) {
  if (!FULL_SHA.test(tree ?? '')) return { reuse: false, reason: '树哈希无效' }
  if (!pr) {
    if (!FULL_SHA.test(sha ?? '')) return { reuse: false, reason: '提交 SHA 无效' }
    const merged = (await api.pullsForCommit(sha)).filter(
      (p) =>
        p.merged_at &&
        p.merge_commit_sha === sha &&
        p.base?.ref === 'main' &&
        p.head?.repo?.full_name === repo,
    )
    if (merged.length !== 1)
      return { reuse: false, reason: `找到 ${merged.length} 个由此提交合并的本仓库 PR` }
    pr = merged[0]
  }
  const head = pr.head?.sha
  if (!FULL_SHA.test(head ?? '')) return { reuse: false, reason: `PR #${pr.number} 缺少 head SHA` }
  const runs = (await api.ciRuns(head))
    .filter(
      (run) =>
        run.head_sha === head &&
        run.event === 'pull_request' &&
        run.head_branch === pr.head.ref &&
        run.head_repository?.full_name === repo,
    )
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)
  const latest = runs[0]
  if (!latest) return { reuse: false, reason: `PR #${pr.number} 的 head ${head} 没有 CI 运行` }
  // 只看最近一次：较新的运行未完成或失败时，不回头采信更早的成功结果
  if (latest.status !== 'completed' || latest.conclusion !== 'success')
    return {
      reuse: false,
      reason: `PR #${pr.number} 最近一次 CI 为 ${latest.status}/${latest.conclusion}`,
      run: latest.html_url,
    }
  const jobs = await api.runJobs(latest.id)
  const tested = jobs.filter((job) => job.name?.startsWith(TESTED_JOB_PREFIX))
  if (tested.length !== 1 || tested[0].conclusion !== 'success')
    return {
      reuse: false,
      reason: `PR #${pr.number} 的 CI 没有成功的全量测试记录（${tested.map((j) => `${j.name}=${j.conclusion}`).join(', ') || '无'}）`,
      run: latest.html_url,
    }
  const testedTree = tested[0].name.slice(TESTED_JOB_PREFIX.length).trim()
  if (testedTree !== tree)
    return {
      reuse: false,
      reason: `树不一致：PR 测试 ${testedTree}，本次 ${tree}`,
      run: latest.html_url,
    }
  return {
    reuse: true,
    reason: `PR #${pr.number} 的 CI 已在同一棵树 ${tree} 上全量通过`,
    run: latest.html_url,
  }
}

/**
 * @param {{
 *   event: string, ref: string, sha: string, repo: string,
 *   prHead?: string, before?: string,
 *   git: { parents: (rev: string) => string[], tree: (rev: string) => string,
 *          changed: (from: string, to: string) => string[], isAncestor: (a: string, b: string) => boolean,
 *          exists: (rev: string) => boolean },
 *   api: Parameters<typeof findReuse>[0]['api'],
 * }} input
 * @returns {Promise<{ mode: 'full' | 'docs' | 'reuse', tree: string, reason: string, run?: string }>}
 */
export async function plan({ event, ref, sha, repo, prHead, before, git, api }) {
  let tree = ''
  try {
    tree = git.tree(sha)
    let base
    if (event === 'pull_request') {
      // actions/checkout 检出 refs/pull/N/merge：第一父提交是当时的 base，第二父是 PR head
      const parents = git.parents(sha)
      if (parents.length !== 2 || parents[1] !== prHead)
        return { mode: 'full', tree, reason: '检出提交不是该 PR head 的合并提交' }
      base = parents[0]
    } else if (event === 'push') {
      if (!FULL_SHA.test(before ?? '') || /^0+$/.test(before))
        return { mode: 'full', tree, reason: '新分支或缺少 before' }
      if (!git.exists(before) || !git.isAncestor(before, sha))
        return { mode: 'full', tree, reason: 'before 不可达或非祖先（强推）' }
      base = before
    } else {
      return { mode: 'full', tree, reason: `${event} 事件总是全量运行` }
    }
    const paths = git.changed(base, sha)
    if (classify(paths) === 'docs')
      return { mode: 'docs', tree, reason: `${paths.length} 个变更文件都是文档` }
    if (event !== 'push' || ref !== 'refs/heads/main')
      return { mode: 'full', tree, reason: `${paths.length} 个变更文件包含代码或配置` }
    const reuse = await findReuse({ repo, sha, tree, api })
    return { mode: reuse.reuse ? 'reuse' : 'full', tree, reason: reuse.reason, run: reuse.run }
  } catch (error) {
    return { mode: 'full', tree, reason: `计划失败，回退全量：${error?.message ?? error}` }
  }
}

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20 }).trim()

export const localGit = {
  parents: (rev) => sh('git', ['rev-list', '--parents', '-n', '1', rev]).split(/\s+/).slice(1),
  tree: (rev) => sh('git', ['rev-parse', `${rev}^{tree}`]),
  // 禁用重命名识别：移入 docs/ 的代码文件也会以删除旧路径的形式出现
  changed: (from, to) =>
    sh('git', ['diff', '--no-renames', '--name-only', '-z', from, to]).split('\0').filter(Boolean),
  isAncestor: (a, b) => {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', a, b])
      return true
    } catch {
      return false
    }
  },
  exists: (rev) => {
    try {
      execFileSync('git', ['cat-file', '-e', `${rev}^{commit}`], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  },
}

export function ghApi(repo) {
  const get = (path) =>
    JSON.parse(sh('gh', ['api', '-H', 'Accept: application/vnd.github+json', path]))
  return {
    pullsForCommit: async (sha) => get(`repos/${repo}/commits/${sha}/pulls?per_page=100`),
    ciRuns: async (head) =>
      get(
        `repos/${repo}/actions/workflows/${WORKFLOW_FILE}/runs?event=pull_request&head_sha=${head}&per_page=100`,
      ).workflow_runs,
    runJobs: async (id) =>
      get(`repos/${repo}/actions/runs/${id}/jobs?filter=latest&per_page=100`).jobs,
    pull: async (number) => get(`repos/${repo}/pulls/${number}`),
  }
}

function report(env, line) {
  console.log(line)
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`)
}

async function main(argv, env) {
  const repo = env.GITHUB_REPOSITORY
  const api = ghApi(repo)
  const flag = (name) => {
    const i = argv.indexOf(name)
    return i === -1 ? undefined : argv[i + 1]
  }
  // 演练：只计算复用判断并打印，不影响本次运行模式。--probe-sha 走完整的「提交 → PR」查找；
  // --probe-pr 跳过查找，配合 --tree 验证尚未合并的 PR（树可用 git merge-tree --write-tree 预先算出）。
  const probeSha = flag('--probe-sha') ?? env.CI_PLAN_PROBE_SHA
  const probePr = flag('--probe-pr')
  if (probeSha || probePr) {
    let result
    try {
      const sha = probeSha ? sh('git', ['rev-parse', `${probeSha}^{commit}`]) : undefined
      const tree = flag('--tree') ?? localGit.tree(sha)
      const pr = probePr ? await api.pull(Number(probePr)) : undefined
      result = await findReuse({ repo, sha, tree, api, pr })
    } catch (error) {
      result = { reuse: false, reason: `演练失败：${error?.message ?? error}` }
    }
    report(
      env,
      `复用演练（${probeSha ?? `PR #${probePr}`}）：${result.reuse ? '会复用' : '不复用'}。${result.reason}${result.run ? `（${result.run}）` : ''}`,
    )
    if (!env.GITHUB_OUTPUT) return
  }
  const result = await plan({
    event: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
    sha: env.GITHUB_SHA,
    repo,
    prHead: env.PR_HEAD_SHA,
    before: env.PUSH_BEFORE,
    git: localGit,
    api,
  })
  report(env, `CI 计划：${result.mode}。${result.reason}${result.run ? `（${result.run}）` : ''}`)
  if (env.GITHUB_OUTPUT)
    appendFileSync(env.GITHUB_OUTPUT, `mode=${result.mode}\ntree=${result.tree}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main(process.argv.slice(2), process.env)
}
