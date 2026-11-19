import assert from 'node:assert/strict'
import test from 'node:test'
import { classify, findReuse, isDocsPath, plan, TESTED_JOB_PREFIX } from './plan.mjs'

const REPO = 'acme/saas'
const sha = (c) => c.repeat(40)
const MERGE = sha('a')
const HEAD = sha('b')
const BASE = sha('c')
const TREE = sha('d')

test('文档路径只认 docs/、openspec/、根 .md 与代理技能 .md', () => {
  for (const path of [
    'docs/README.md',
    'docs/runbooks/x.json',
    'openspec/changes/x/tasks.md',
    'AGENTS.md',
    'README.md',
    '.agents/skills/new-page/SKILL.md',
    '.claude/commands/opsx/apply.md',
  ])
    assert.ok(isDocsPath(path), path)
  for (const path of [
    'apps/web/content/blog/en/hello.mdx',
    'apps/web/content/docs/en/configuration.md',
    'packages/ai/src/media/fixtures/README.md',
    'scripts/probes/latency/README.md',
    'deploy/selfhost/README.md',
    '.github/workflows/ci.yml',
    '.agents/skills/x/run.sh',
    'docs.md/evil.ts',
    'package.json',
  ])
    assert.ok(!isDocsPath(path), path)
})

test('classify：全部是文档才算 docs，空变更按 full', () => {
  assert.equal(classify(['docs/a.md', 'openspec/b.md']), 'docs')
  assert.equal(classify(['docs/a.md', 'apps/web/src/x.ts']), 'full')
  assert.equal(classify([]), 'full')
})

function fakeApi({ pulls = [], runs = [], jobs = {}, fail } = {}) {
  const calls = []
  const wrap = (name, value) => async (arg) => {
    calls.push(`${name}:${arg}`)
    if (fail === name) throw new Error(`${name} 500`)
    return typeof value === 'function' ? value(arg) : value
  }
  return {
    calls,
    pullsForCommit: wrap('pulls', pulls),
    ciRuns: wrap('runs', runs),
    runJobs: wrap('jobs', (id) => jobs[id] ?? []),
  }
}

const mergedPr = (over = {}) => ({
  number: 7,
  merged_at: '2026-11-18T00:00:00Z',
  merge_commit_sha: MERGE,
  base: { ref: 'main' },
  head: { sha: HEAD, ref: 'feat', repo: { full_name: REPO } },
  ...over,
})
const prRun = (over = {}) => ({
  id: 1,
  head_sha: HEAD,
  event: 'pull_request',
  head_branch: 'feat',
  head_repository: { full_name: REPO },
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-11-17T00:00:00Z',
  html_url: 'https://example/run/1',
  ...over,
})
const testedJob = (tree = TREE, conclusion = 'success') => ({
  name: `${TESTED_JOB_PREFIX}${tree}`,
  conclusion,
})
const reuseInput = (api) => ({ repo: REPO, sha: MERGE, tree: TREE, api })

test('findReuse：PR 最近一次 CI 在同一棵树上全量通过时复用', async () => {
  const api = fakeApi({
    pulls: [mergedPr()],
    runs: [prRun()],
    jobs: { 1: [{ name: 'lint', conclusion: 'success' }, testedJob()] },
  })
  const result = await findReuse(reuseInput(api))
  assert.equal(result.reuse, true, result.reason)
  assert.deepEqual(api.calls, [`pulls:${MERGE}`, `runs:${HEAD}`, 'jobs:1'])
})

test('findReuse：任何不一致都不复用', async (t) => {
  const cases = {
    树不同: { pulls: [mergedPr()], runs: [prRun()], jobs: { 1: [testedJob(sha('e'))] } },
    全量记录失败: {
      pulls: [mergedPr()],
      runs: [prRun()],
      jobs: { 1: [testedJob(TREE, 'failure')] },
    },
    文档模式跳过了全量: {
      pulls: [mergedPr()],
      runs: [prRun()],
      jobs: { 1: [{ name: `${TESTED_JOB_PREFIX}`, conclusion: 'skipped' }] },
    },
    没有全量记录: { pulls: [mergedPr()], runs: [prRun()], jobs: { 1: [] } },
    重复的全量记录: {
      pulls: [mergedPr()],
      runs: [prRun()],
      jobs: { 1: [testedJob(), testedJob()] },
    },
    运行失败: {
      pulls: [mergedPr()],
      runs: [prRun({ conclusion: 'failure' })],
      jobs: { 1: [testedJob()] },
    },
    较新的运行未成功: {
      pulls: [mergedPr()],
      runs: [
        prRun(),
        prRun({ id: 2, created_at: '2026-11-17T01:00:00Z', conclusion: 'cancelled' }),
      ],
      jobs: { 1: [testedJob()] },
    },
    较新的运行进行中: {
      pulls: [mergedPr()],
      runs: [prRun(), prRun({ id: 2, created_at: '2026-11-17T01:00:00Z', status: 'in_progress' })],
      jobs: { 1: [testedJob()] },
    },
    没有运行: { pulls: [mergedPr()], runs: [], jobs: {} },
    运行来自其他分支: {
      pulls: [mergedPr()],
      runs: [prRun({ head_branch: 'other' })],
      jobs: { 1: [testedJob()] },
    },
    运行来自分叉仓库: {
      pulls: [mergedPr()],
      runs: [prRun({ head_repository: { full_name: 'evil/saas' } })],
      jobs: { 1: [testedJob()] },
    },
    运行事件不是PR: {
      pulls: [mergedPr()],
      runs: [prRun({ event: 'push' })],
      jobs: { 1: [testedJob()] },
    },
    PR来自分叉: {
      pulls: [mergedPr({ head: { sha: HEAD, ref: 'feat', repo: { full_name: 'evil/saas' } } })],
      runs: [prRun()],
      jobs: { 1: [testedJob()] },
    },
    PR未合并: {
      pulls: [mergedPr({ merged_at: null })],
      runs: [prRun()],
      jobs: { 1: [testedJob()] },
    },
    合并提交不是本次: {
      pulls: [mergedPr({ merge_commit_sha: sha('f') })],
      runs: [prRun()],
      jobs: { 1: [testedJob()] },
    },
    PR目标不是main: {
      pulls: [mergedPr({ base: { ref: 'release' } })],
      runs: [prRun()],
      jobs: { 1: [testedJob()] },
    },
    多个PR: {
      pulls: [mergedPr(), mergedPr({ number: 8 })],
      runs: [prRun()],
      jobs: { 1: [testedJob()] },
    },
    没有PR: { pulls: [], runs: [prRun()], jobs: { 1: [testedJob()] } },
  }
  for (const [name, data] of Object.entries(cases))
    await t.test(name, async () => {
      const result = await findReuse(reuseInput(fakeApi(data)))
      assert.equal(result.reuse, false)
      assert.ok(result.reason)
    })
  await t.test('树哈希为空', async () => {
    const api = fakeApi({ pulls: [mergedPr()], runs: [prRun()], jobs: { 1: [testedJob('')] } })
    assert.equal((await findReuse({ ...reuseInput(api), tree: '' })).reuse, false)
  })
})

test('findReuse：重跑后的运行只按最新一次 attempt 的结论', async () => {
  // runJobs 使用 filter=latest；最新 attempt 成功即视为成功（与合并门槛一致）
  const api = fakeApi({
    pulls: [mergedPr()],
    runs: [prRun({ run_attempt: 2 })],
    jobs: { 1: [testedJob()] },
  })
  assert.equal((await findReuse(reuseInput(api))).reuse, true)
})

function fakeGit({ parents = {}, trees = {}, changed = [], ancestor = true, exists = true } = {}) {
  return {
    parents: (rev) => parents[rev] ?? [],
    tree: (rev) => trees[rev] ?? TREE,
    changed: () => changed,
    isAncestor: () => ancestor,
    exists: () => exists,
  }
}
const okApi = () => fakeApi({ pulls: [mergedPr()], runs: [prRun()], jobs: { 1: [testedJob()] } })
const pushInput = (git, api = okApi(), over = {}) => ({
  event: 'push',
  ref: 'refs/heads/main',
  sha: MERGE,
  repo: REPO,
  before: BASE,
  git,
  api,
  ...over,
})

test('plan：PR 只改文档时走 docs，并记录合并树', async () => {
  const git = fakeGit({ parents: { [MERGE]: [BASE, HEAD] }, changed: ['docs/a.md'] })
  const result = await plan({
    event: 'pull_request',
    ref: 'refs/pull/7/merge',
    sha: MERGE,
    prHead: HEAD,
    repo: REPO,
    git,
    api: fakeApi(),
  })
  assert.deepEqual([result.mode, result.tree], ['docs', TREE])
})

test('plan：PR 含代码走 full，且不查询复用', async () => {
  const api = fakeApi()
  const git = fakeGit({ parents: { [MERGE]: [BASE, HEAD] }, changed: ['apps/web/src/a.ts'] })
  const result = await plan({
    event: 'pull_request',
    ref: 'refs/pull/7/merge',
    sha: MERGE,
    prHead: HEAD,
    repo: REPO,
    git,
    api,
  })
  assert.equal(result.mode, 'full')
  assert.deepEqual(api.calls, [])
})

test('plan：PR 检出不是 head 的合并提交时走 full', async () => {
  const git = fakeGit({ parents: { [MERGE]: [BASE] }, changed: ['docs/a.md'] })
  const result = await plan({
    event: 'pull_request',
    ref: 'refs/pull/7/merge',
    sha: MERGE,
    prHead: HEAD,
    repo: REPO,
    git,
    api: fakeApi(),
  })
  assert.equal(result.mode, 'full')
})

test('plan：main push 与已测合并树一致时 reuse，不一致时 full', async () => {
  const git = fakeGit({ changed: ['apps/web/src/a.ts'] })
  assert.equal((await plan(pushInput(git))).mode, 'reuse')
  const moved = fakeGit({ changed: ['apps/web/src/a.ts'], trees: { [MERGE]: sha('e') } })
  assert.equal((await plan(pushInput(moved))).mode, 'full')
})

test('plan：main push 只改文档时 docs，不查询复用', async () => {
  const api = okApi()
  const result = await plan(pushInput(fakeGit({ changed: ['docs/a.md'] }), api))
  assert.equal(result.mode, 'docs')
  assert.deepEqual(api.calls, [])
})

test('plan：项目追加文档目录，按字面目录前缀匹配', async () => {
  const input = (changed) =>
    pushInput({ ...fakeGit({ changed }), readDocsPathsConfig: () => '["doc/"]' }, fakeApi(), {
      ref: 'refs/heads/feat',
    })

  assert.equal((await plan(input(['doc/handbook/readme.txt', 'docs/readme.md']))).mode, 'docs')
  for (const path of [
    'doc',
    'doc-assets/readme.txt',
    ' doc/readme.txt',
    '.github/ci-docs-paths.json',
  ])
    assert.equal((await plan(input([path]))).mode, 'full', path)
})

test('plan：忽略受保护的目录并给出警告，其余目录仍生效', async () => {
  const protectedDirs = ['apps/web/', 'packages/', 'scripts/ci/', 'deploy/', '.github/']
  const readDocsPathsConfig = () => JSON.stringify([...protectedDirs, 'doc/'])
  const input = (path) =>
    pushInput({ ...fakeGit({ changed: [path] }), readDocsPathsConfig }, fakeApi(), {
      ref: 'refs/heads/feat',
    })
  const warnings = []
  const docs = await plan({
    ...input('doc/readme.txt'),
    onWarning: (warning) => warnings.push(warning),
  })
  assert.equal(docs.mode, 'docs')
  assert.equal(warnings.length, protectedDirs.length)
  for (const [i, dir] of protectedDirs.entries()) {
    assert.ok(warnings[i].includes(dir))
    assert.equal((await plan(input(`${dir}readme.md`))).mode, 'full', dir)
  }
})

test('plan：配置无效或无法读取时全量运行，main 不查询复用', async () => {
  const api = okApi()
  const readError = () => {
    throw new Error('无法读取 .github/ci-docs-paths.json（EACCES）')
  }
  const invalidConfigs = [
    '{',
    '{}',
    '[1]',
    ...['/', 'doc', '/doc/', './doc/', 'a/../doc/', 'doc//', 'doc/*/', 'C:\\doc\\'].map((dir) =>
      JSON.stringify([dir]),
    ),
  ]
  const git = fakeGit({ changed: ['docs/readme.md'] })
  const readers = [...invalidConfigs.map((contents) => () => contents), readError]
  for (const readDocsPathsConfig of readers) {
    const result = await plan(pushInput({ ...git, readDocsPathsConfig }, api))
    assert.equal(result.mode, 'full', result.reason)
    assert.match(result.reason, /\.github\/ci-docs-paths\.json/)
  }
  assert.deepEqual(api.calls, [])
})

test('plan：非 main 的 push 不复用', async () => {
  const result = await plan(
    pushInput(fakeGit({ changed: ['apps/web/src/a.ts'] }), okApi(), { ref: 'refs/heads/feat' }),
  )
  assert.equal(result.mode, 'full')
})

test('plan：无法确定 diff 或出错时回退 full', async (t) => {
  const code = ['apps/web/src/a.ts']
  const docs = ['docs/a.md']
  const cases = {
    新分支: pushInput(fakeGit({ changed: docs }), okApi(), { before: sha('0') }),
    缺少before: pushInput(fakeGit({ changed: docs }), okApi(), { before: undefined }),
    强推: pushInput(fakeGit({ changed: docs, ancestor: false })),
    before不存在: pushInput(fakeGit({ changed: docs, exists: false })),
    // 空变更不算文档；没有可复用的证据时全量
    空变更: pushInput(fakeGit({ changed: [] }), fakeApi()),
    手动触发: pushInput(fakeGit({ changed: docs }), okApi(), { event: 'workflow_dispatch' }),
    API失败: pushInput(fakeGit({ changed: code }), fakeApi({ fail: 'runs', pulls: [mergedPr()] })),
    git失败: pushInput({
      ...fakeGit({ changed: code }),
      changed: () => {
        throw new Error('bad object')
      },
    }),
  }
  for (const [name, input] of Object.entries(cases))
    await t.test(name, async () => {
      const result = await plan(input)
      assert.equal(result.mode, 'full', result.reason)
    })
  await t.test('取树失败时 tree 为空', async () => {
    const result = await plan(
      pushInput({
        ...fakeGit(),
        tree: () => {
          throw new Error('no tree')
        },
      }),
    )
    assert.deepEqual([result.mode, result.tree], ['full', ''])
  })
})
