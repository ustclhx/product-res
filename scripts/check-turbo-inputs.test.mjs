import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findCacheHazards,
  findEnvHazards,
  globToRegExp,
  parseJsonc,
  readRepo,
} from './check-turbo-inputs.mjs'

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

test('默认 vitest.config 读取未声明的环境变量时报出', () => {
  const config = [
    "const app = readLocalEnv('APP_DB_URL')",
    'const ci = process.env.CI',
    'process.env.DERIVED_URL = app',
    'const home = process.env.HOME',
    'if (process.env.PROBE) {} // turbo-env-ignore 手动探针',
  ].join('\n')
  const sources = {
    'packages/a/vitest.config.ts': config,
    // 其他 vitest 配置由不经 turbo 的脚本使用，不检查
    'packages/a/vitest.node.config.ts': 'process.env.NODE_ONLY_URL',
  }
  const found = findEnvHazards(repo(sources, { packages: [pkg('packages/a', '@x/a')] }))
  assert.deepEqual(
    found.map((v) => v.match(/读取 (\w+)/)[1]),
    ['APP_DB_URL', 'CI'],
  )
})

test('任务 env/passThroughEnv、$TURBO_EXTENDS$、全局与通配声明都算覆盖', () => {
  const sources = {
    'packages/a/vitest.config.ts':
      "readLocalEnv('APP_DB_URL'); process.env.CI; process.env.EVIDENCE_DIR",
    'packages/b/vitest.config.ts': 'process.env.EVIDENCE_DIR; process.env.STRIPE_KEY',
    'packages/c/vitest.config.ts': 'process.env.EVIDENCE_DIR',
  }
  const root = {
    globalPassThroughEnv: ['STRIPE_*'],
    tasks: { test: { env: ['EVIDENCE_DIR'] } },
  }
  const packages = [
    pkg('packages/a', '@x/a', [], { tasks: { test: { passThroughEnv: ['CI', 'APP_DB_URL'] } } }),
    pkg('packages/b', '@x/b'),
    pkg('packages/c', '@x/c', [], { tasks: { test: { env: ['$TURBO_EXTENDS$', 'OTHER'] } } }),
  ]
  assert.deepEqual(findEnvHazards(repo(sources, { packages, root })), [])
  // 包内 env 不带 $TURBO_EXTENDS$ 时替换根配置
  const replaced = [pkg('packages/c', '@x/c', [], { tasks: { test: { env: ['OTHER'] } } })]
  assert.equal(findEnvHazards(repo(sources, { packages: replaced, root })).length, 1)
})

test('resolveTestDatabase() 调用视为读取连接串、CI 与开发库开关', () => {
  const sources = { 'packages/a/vitest.config.ts': "const db = resolveTestDatabase('@x/a')" }
  const packages = [
    pkg('packages/a', '@x/a', [], {
      tasks: { test: { passThroughEnv: ['CI', 'MIGRATION_DATABASE_URL'] } },
    }),
  ]
  assert.deepEqual(
    findEnvHazards(repo(sources, { packages })).map((v) => v.match(/读取 (\w+)/)[1]),
    ['CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE', 'ALLOW_TEST_ON_DEV_DATABASE'],
  )
})

test('当前仓库 test 任务的环境变量声明完整', () => {
  assert.deepEqual(findEnvHazards(readRepo()), [])
})
