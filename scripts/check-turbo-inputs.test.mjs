import assert from 'node:assert/strict'
import test from 'node:test'
import { findCacheHazards, globToRegExp, parseJsonc, readRepo } from './check-turbo-inputs.mjs'

const rootTurbo = {
  tasks: {
    build: { dependsOn: ['^build'] },
    typecheck: { dependsOn: ['^typecheck'] },
    test: { dependsOn: ['^typecheck', '^test'] },
  },
}
const pkg = (dir, name, deps = [], turbo, scripts = ['typecheck', 'test', 'build']) => ({
  dir,
  name,
  deps,
  scripts,
  turbo,
})

function repo(sources, { packages, root = rootTurbo, rootDeps = [] } = {}) {
  const extra = ['template.config.ts', 'scripts/tool.mjs', 'apps/web/src/server.ts']
  return {
    files: [...new Set([...Object.keys(sources), ...extra])],
    read: (file) => sources[file] ?? '',
    rootDeps,
    rootTurbo: root,
    packages: packages ?? [
      pkg('packages/a', '@x/a'),
      pkg('packages/b', '@x/b', ['@x/a']),
      pkg('apps/web', '@x/web', ['@x/b']),
    ],
  }
}

test('本包与依赖闭包内的引用不报', () => {
  const r = repo({
    'packages/b/src/x.ts': "import '../../a/src/y.ts'\nimport './local.ts'",
    'packages/a/src/y.ts': '',
    'apps/web/src/z.ts': "import '../../../packages/a/src/y.ts'",
  })
  assert.deepEqual(findCacheHazards(r), [])
})

test('引用依赖闭包外的已跟踪文件时按任务报出', () => {
  const r = repo({ 'packages/a/src/x.ts': "import cfg from '../../../template.config.ts'" })
  const found = findCacheHazards(r)
  assert.equal(found.length, 3)
  assert.match(found[0], /@x\/a#build.*template\.config\.ts/)
})

test('测试文件的引用不要求 build 覆盖', () => {
  const r = repo({ 'packages/a/test/x.test.ts': "import '../../../apps/web/src/server.ts'" })
  assert.deepEqual(
    findCacheHazards(r).map((v) => v.split(':')[0]),
    ['@x/a#typecheck', '@x/a#test'],
  )
})

test('globalDependencies、$TURBO_ROOT$ inputs、cache:false 与 pkg#task 依赖都算覆盖', () => {
  const sources = {
    'packages/a/src/x.ts': "import '../../../template.config.ts'",
    'packages/b/test/x.test.ts': "import '../../../apps/web/src/server.ts'",
  }
  const packages = [
    pkg('packages/a', '@x/a'),
    pkg('packages/b', '@x/b', [], {
      tasks: {
        typecheck: { inputs: ['$TURBO_DEFAULT$', '$TURBO_ROOT$/apps/web/src/**'] },
        test: { cache: false },
      },
    }),
    pkg('apps/web', '@x/web'),
  ]
  const root = { ...rootTurbo, globalDependencies: ['template.config.ts'] }
  assert.deepEqual(findCacheHazards(repo(sources, { packages, root })), [])
  const viaTask = [
    pkg('packages/a', '@x/a', [], undefined, ['test']),
    pkg('packages/b', '@x/b', [], { tasks: { test: { dependsOn: ['@x/web#test'] } } }, ['test']),
    pkg('apps/web', '@x/web'),
  ]
  assert.deepEqual(
    findCacheHazards(
      repo(
        { 'packages/b/test/x.test.ts': "import '../../../apps/web/src/server.ts'" },
        {
          packages: viaTask,
        },
      ),
    ),
    [],
  )
})

test('根包的依赖闭包属于全局 hash', () => {
  const r = repo(
    { 'apps/web/src/x.ts': "import '../../../packages/a/src/y.ts'", 'packages/a/src/y.ts': '' },
    { packages: [pkg('packages/a', '@x/a'), pkg('apps/web', '@x/web')], rootDeps: ['@x/a'] },
  )
  assert.deepEqual(findCacheHazards(r), [])
})

test('未跟踪目标、祖先目录与仓库外路径不报', () => {
  const r = repo({
    'packages/a/src/x.ts': [
      "readFileSync('../../../.env.worktree')",
      "resolve(import.meta.dirname, '../../..')",
      "join(dir, '../')",
      "import '../../../../outside.ts'",
    ].join('\n'),
  })
  assert.deepEqual(findCacheHazards(r), [])
})

test('目录引用要求目录内每个已跟踪文件都被覆盖', () => {
  const sources = { 'packages/a/src/x.ts': "spawn('../../../scripts')" }
  assert.equal(findCacheHazards(repo(sources)).length, 3)
  const packages = [
    pkg('packages/a', '@x/a', [], {
      tasks: Object.fromEntries(
        ['build', 'typecheck', 'test'].map((t) => [t, { inputs: ['$TURBO_ROOT$/scripts/**'] }]),
      ),
    }),
  ]
  assert.deepEqual(findCacheHazards(repo(sources, { packages })), [])
})

test('glob 与 jsonc 解析', () => {
  assert.ok(globToRegExp('apps/web/**').test('apps/web/src/a.ts'))
  assert.ok(globToRegExp('scripts/local-payment-env.*').test('scripts/local-payment-env.d.mts'))
  assert.ok(!globToRegExp('scripts/*.mjs').test('scripts/a/b.mjs'))
  assert.deepEqual(parseJsonc('{\n  // 注释\n  "a": ["//x", 1,],\n}'), { a: ['//x', 1] })
})

test('当前仓库的 Turbo 缓存输入完整', () => {
  assert.deepEqual(findCacheHazards(readRepo()), [])
})
