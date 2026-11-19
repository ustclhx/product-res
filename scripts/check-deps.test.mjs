import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { checkWorkspace, importsOf } from './check-deps.mjs'

const { uiOnlyDependencies, forbiddenDependencies } = JSON.parse(
  readFileSync(new URL('./check-deps.rules.json', import.meta.url), 'utf8'),
)
const emptyRules = () => ({
  compositionEntries: [],
  targetFixtures: {},
  uiOnlyDependencies,
  forbiddenDependencies,
})

function workspace(t, files, rules = emptyRules()) {
  const root = mkdtempSync(join(tmpdir(), 'check-deps-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [file, text] of Object.entries({
    'packages/ui/package.json': manifest('@product-res/ui'),
    ...files,
  })) {
    const path = join(root, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, typeof text === 'string' ? text : JSON.stringify(text))
  }
  return () => checkWorkspace(root, rules).violations
}

const manifest = (name, dependencies = {}) => ({ name, dependencies })

const uiDependencies = [
  'radix-ui',
  '@base-ui/react',
  'motion',
  'framer-motion',
  'lucide-react',
  'class-variance-authority',
]

test('renamed scope uses the UI manifest despite earlier unrelated packages', (t) => {
  const check = workspace(t, {
    'packages/aaa/package.json': manifest('@unrelated/aaa'),
    'packages/ui/package.json': manifest('@renamed/ui', { react: '*', 'radix-ui': '*' }),
    'packages/ui/src/project/card.tsx': "import 'react'; import 'motion/react'",
    'apps/web/package.json': manifest('@renamed/web', { '@renamed/ui': '*' }),
    'apps/web/src/page.tsx': "import '@renamed/ui/project'",
    'packages/email/package.json': manifest('@renamed/email', { react: '*' }),
    'packages/email/src/index.tsx': "import '@react-email/render'",
    'packages/platform/package.json': manifest('@renamed/platform', {
      '@renamed/db': '*',
      '@renamed/auth': '*',
    }),
    'packages/shared/package.json': manifest('@renamed/shared', { '@renamed/db': '*' }),
    'packages/config/package.json': manifest('@renamed/config'),
    'packages/config/src/index.ts': "import '@renamed/platform'",
    'apps/web/src/adapter.ts': "import '@renamed/platform/node'",
  })
  const violations = check()
  assert.equal(violations.length, 4)
  for (const text of [
    '@renamed/shared → @renamed/db（packages/shared/package.json dependencies）',
    '@renamed/platform → @renamed/auth（packages/platform/package.json dependencies）',
    '@renamed/config → @renamed/platform（packages/config/src/index.ts:1）',
    'apps/web/src/adapter.ts:1 → @renamed/platform/node',
  ]) {
    assert.ok(
      violations.some((message) => message.includes(text)),
      text,
    )
  }
})

test('renamed UI dependency violations name the canonical UI package in manifests and project source', (t) => {
  const check = workspace(t, {
    'packages/aaa/package.json': manifest('@unrelated/aaa'),
    'packages/ui/package.json': manifest('@renamed/ui'),
    'packages/ui/src/project/card.tsx': "import '@radix-ui/react-dialog'",
    'apps/web/package.json': manifest('@renamed/web', { 'radix-ui': '*' }),
    'apps/web/src/page.tsx': "import 'motion/react'",
  })
  const violations = check()
  assert.equal(violations.length, 3)
  assert.ok(violations.some((message) => message.includes('packages/ui/src/project/card.tsx:1')))
  for (const path of ['apps/web/package.json dependencies', 'apps/web/src/page.tsx:1']) {
    assert.ok(
      violations.some(
        (message) =>
          message.includes(path) && message.includes('UI 底层依赖仅允许 @renamed/ui 使用'),
      ),
    )
  }
})

test('scope discovery fails when the canonical UI manifest is missing or unscoped', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'check-deps-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.throws(() => checkWorkspace(root, emptyRules()), /packages\/ui\/package\.json/)
  const check = workspace(t, {
    'packages/ui/package.json': manifest('ui'),
    'packages/aaa/package.json': manifest('@unrelated/aaa'),
  })
  assert.throws(check, /name 必须为 @scope\/ui，无法确定内部包 scope/)
})

test('UI dependencies are restricted in every manifest dependency field for apps and other packages', (t) => {
  const fields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
  const dependencies = Object.fromEntries(uiDependencies.map((dep) => [dep, '*']))
  const allFields = Object.fromEntries(fields.map((field) => [field, dependencies]))
  const check = workspace(t, {
    'apps/web/package.json': { name: '@product-res/web', ...allFields },
    'packages/billing/package.json': { name: '@product-res/billing', ...allFields },
    'packages/ui/package.json': { name: '@product-res/ui', ...allFields },
  })
  const violations = check()
  assert.equal(violations.length, uiDependencies.length * fields.length * 2)
  for (const path of ['apps/web', 'packages/billing']) {
    for (const field of fields) {
      for (const dep of uiDependencies) {
        assert.ok(
          violations.some((message) =>
            message.includes(`→ ${dep}（${path}/package.json ${field}）`),
          ),
        )
      }
    }
  }
})

const uiImports = [
  "// import 'motion'",
  'const example = "require(\'radix-ui\')"',
  "import type { Dialog } from 'radix-ui'",
  "import 'radix-ui'",
  "export { motion } from 'motion/react'",
  "export * from '@base-ui/react/dialog'",
  "import /* comment */ ('framer-motion', { with: { type: 'json' } })",
  'import(`lucide-react`)',
  "require /* comment */ ('class-variance-authority')",
  "import radix = require('radix-ui')",
  "type Icon = import('lucide-react').Icon",
  "import('motion/' + 'react')",
  "import('radix\\x2dui')",
].join('\n')

test('apps and other packages reject UI imports across AST forms and outside src', (t) => {
  const check = workspace(t, {
    'apps/web/package.json': manifest('@product-res/web'),
    'apps/web/src/routes/page.tsx': uiImports,
    'apps/web/test/component.test.tsx': "import 'motion/react'",
    'packages/billing/package.json': manifest('@product-res/billing'),
    'packages/billing/probe/component.ts': "import '@base-ui/react/dialog'",
  })
  const violations = check()
  assert.equal(violations.length, 13)
  for (let line = 3; line <= 13; line++) {
    assert.ok(
      violations.some((message) => message.includes(`apps/web/src/routes/page.tsx:${line}`)),
    )
  }
  assert.ok(violations.some((message) => message.includes('apps/web/test/component.test.tsx:1')))
  assert.ok(violations.some((message) => message.includes('packages/billing/probe/component.ts:1')))
})

test('UI package including project components may import primitives; similar package names remain allowed', (t) => {
  const check = workspace(t, {
    'packages/ui/package.json': manifest('@product-res/ui'),
    'packages/ui/src/components/control.tsx': uiImports,
    'packages/ui/src/project/index.ts': uiImports,
    'apps/web/package.json': manifest('@product-res/web', {
      'motion-utils': '*',
      'radix-ui-extra': '*',
      '@base-ui-extra/react': '*',
      '@product-res/ui': '*',
    }),
    'apps/web/src/index.ts':
      "import '@product-res/ui'; import { Plus } from '@product-res/ui/icons'; import 'motion-utils'; import 'radix-ui-extra'",
  })
  assert.deepEqual(check(), [])
})

test('split Radix dependencies and subpath imports are forbidden even in UI', (t) => {
  const files = {}
  for (const [path, name] of [
    ['.', 'product-res'],
    ['apps/web', '@product-res/web'],
    ['packages/ui', '@product-res/ui'],
    ['packages/billing', '@product-res/billing'],
  ]) {
    files[`${path}/package.json`] = manifest(name, { '@radix-ui/react-dialog': '*' })
    files[`${path}/src/index.ts`] = "import '@radix-ui/react-dialog/internal'"
  }
  const violations = workspace(t, files)()
  // 根源码不在 workspace 扫描范围，但根 manifest 仍应失败。
  assert.equal(violations.length, 7)
  assert.ok(violations.every((message) => message.includes('禁止拆分 Radix 子包')))
})

test('existing React rules still exempt apps and package test fixtures', (t) => {
  const check = workspace(t, {
    'apps/web/package.json': manifest('@product-res/web', { react: '*', '@product-res/ui': '*' }),
    'apps/web/src/index.tsx': "import 'react'; import '@product-res/ui'",
    'packages/billing/package.json': manifest('@product-res/billing'),
    'packages/billing/test/component.test.tsx': "import 'react'; import '@product-res/ui'",
    'packages/billing/src/index.ts': "import 'react'",
    'packages/email/package.json': manifest('@product-res/email', {
      react: '*',
      '@react-email/render': '*',
    }),
    'packages/email/src/index.tsx': "import 'react'; import '@react-email/render'",
  })
  const violations = check()
  assert.equal(violations.length, 1)
  assert.match(violations[0], /packages\/billing\/src\/index.ts:1/)
})

test('AST covers import/export/require/type and dynamic syntax without matching comments or strings', () => {
  const source = [
    "// import 'cloudflare:fake'",
    'const example = "require(\'cloudflare:fake\')"',
    "import type { Env } from 'cloudflare:workers'",
    "import 'cloudflare:workers'",
    "export { env } from 'cloudflare:workers'",
    "export * from 'cloudflare:workers'",
    "import /* comment */ ( /* comment */ 'cloudflare:workers', { with: { type: 'json' } })",
    'import(`cloudflare:workers`)',
    "require /* comment */ ('cloudflare:workers')",
    "import workers = require('cloudflare:workers')",
    "type Step = import('cloudflare:workers').WorkflowStep",
    "import('cloudflare:' + 'workers')",
    "import('cloudflare\\x3aworkers')",
  ].join('\n')
  const imports = importsOf(source)
  assert.equal(imports.length, 11)
  assert.ok(imports.every(({ specifier }) => specifier === 'cloudflare:workers'))
  assert.equal(imports[0].line, 3)
})

test('apps routes/features and packages reject Cloudflare imports, even outside src', (t) => {
  const check = workspace(t, {
    'apps/web/package.json': manifest('@product-res/web'),
    'apps/web/src/routes/api.ts': "export * from 'cloudflare:workers'",
    'apps/web/src/features/auth.ts': "import /* comment */ ('cloudflare:workflows')",
    'apps/web/test/unregistered.test.ts': "import 'cloudflare:test'",
    'packages/auth/package.json': manifest('@product-res/auth'),
    'packages/auth/src/auth.ts': "require('cloudflare:workers')",
    'packages/auth/probe/new.ts': "import 'cloudflare:workers'",
  })
  const violations = check()
  assert.equal(violations.length, 5)
  for (const file of [
    'routes/api.ts',
    'features/auth.ts',
    'unregistered.test.ts',
    'src/auth.ts',
    'probe/new.ts',
  ]) {
    assert.ok(violations.some((message) => message.includes(`${file}:1`)))
  }
})

test('only platform Cloudflare adapters, exact composition entries and exact target fixtures are exempt', (t) => {
  const rules = emptyRules()
  rules.compositionEntries = ['apps/web/src/server.ts']
  rules.targetFixtures = {
    'packages/platform/test/cloudflare.test.ts': ['cloudflare:test', 'cloudflare:workers'],
  }
  const check = workspace(
    t,
    {
      'apps/web/package.json': manifest('@product-res/web'),
      'apps/web/src/server.ts': "import 'cloudflare:workers'",
      'packages/platform/package.json': manifest('@product-res/platform'),
      'packages/platform/src/cloudflare/index.ts':
        "import 'cloudflare:workers'; import 'cloudflare:workflows'",
      'packages/platform/test/cloudflare.test.ts':
        "import 'cloudflare:test'; import type { WorkflowStep } from 'cloudflare:workers'",
      'packages/platform/src/node/index.ts': "import 'cloudflare:workers'",
      'packages/platform/src/index.ts': "export * from 'cloudflare:workers'",
      'packages/platform/src/cloudflare/test.ts': "import 'cloudflare:test'",
      'apps/web/src/server.node.ts': "import 'cloudflare:workers'",
      'apps/web/src/server-helper.ts': "import 'cloudflare:workers'",
    },
    rules,
  )
  assert.equal(check().length, 5)
})

test('former transition entries cannot exempt business imports', (t) => {
  const file = 'apps/web/src/routes/old.ts'
  const rules = { ...emptyRules(), transition: { [file]: { 'cloudflare:workers': 1 } } }
  const check = workspace(
    t,
    {
      'apps/web/package.json': manifest('@product-res/web'),
      [file]: "import 'cloudflare:workers'",
    },
    rules,
  )
  assert.equal(check().length, 1)
  assert.match(check()[0], /仅允许平台 Cloudflare 适配器/)
})

test('platform depends only on shared/config/db; config/db cannot reverse that direction; business packages may depend on each other', (t) => {
  const check = workspace(t, {
    'packages/platform/package.json': manifest('@product-res/platform', {
      '@product-res/shared': '*',
      '@product-res/config': '*',
      '@product-res/db': '*',
    }),
    'packages/platform/src/index.ts': "import '@product-res/auth'",
    'packages/config/package.json': manifest('@product-res/config', {
      '@product-res/platform': '*',
    }),
    'packages/db/package.json': manifest('@product-res/db'),
    'packages/db/src/client.ts': "import '@product-res/platform'",
    'packages/ai/package.json': manifest('@product-res/ai', {
      '@product-res/credits': '*',
      '@product-res/platform': '*',
    }),
    'packages/credits/package.json': manifest('@product-res/credits', {
      '@product-res/billing': '*',
    }),
  })
  assert.equal(check().length, 3)
})

test('target adapters are restricted for named and relative imports, with exact target entries and fixtures allowed', (t) => {
  const rules = emptyRules()
  rules.compositionEntries = ['apps/web/src/server.ts']
  rules.targetFixtures = { 'apps/web/test/cloudflare.test.ts': ['cloudflare:workers'] }
  rules.targetAdapterFixtures = {
    'packages/platform/test/cloudflare.test.ts': ['cloudflare'],
    'packages/platform/test/node.test.ts': ['node'],
  }
  const check = workspace(
    t,
    {
      'apps/web/package.json': manifest('@product-res/web'),
      'apps/web/src/server.ts': "import '@product-res/platform/cloudflare'",
      'apps/web/src/routes/neutral.ts': "import '@product-res/platform'",
      'apps/web/src/routes/adapter.ts':
        "import '@product-res/platform/cloudflare'; import '@product-res/platform/node'; import '../../../../packages/platform/src/cloudflare/index.ts'",
      'apps/web/test/cloudflare.test.ts': "import '@product-res/platform/cloudflare'",
      'apps/web/test/unknown.test.ts': "import '@product-res/platform/cloudflare'",
      'apps/web/src/server.node.ts': "import '@product-res/platform/node'",
      'packages/platform/package.json': manifest('@product-res/platform'),
      'packages/platform/src/cloudflare/index.ts': "export * from './runtime'",
      'packages/platform/src/cloudflare/runtime.ts': "import '@product-res/platform/cloudflare'",
      'packages/platform/src/node/index.ts': "import '@product-res/platform/node'",
      'packages/platform/src/index.ts':
        "export * from './cloudflare/index'; export * from './node/index'",
      'packages/platform/test/cloudflare.test.ts': "import '../src/cloudflare/index'",
      'packages/platform/test/node.test.ts': "import '../src/node/index'",
    },
    rules,
  )
  const violations = check()
  assert.equal(violations.length, 7)
  assert.ok(violations.every((message) => message.includes('业务仅可依赖 platform 中立入口')))
})

test('relative cross-package imports enforce foundation layers and packages cannot reference apps', (t) => {
  const check = workspace(t, {
    'apps/web/package.json': manifest('@product-res/web'),
    'apps/web/src/index.ts': '',
    'packages/platform/package.json': manifest('@product-res/platform'),
    'packages/platform/src/index.ts': "import '../../db/src/client'",
    'packages/config/package.json': manifest('@product-res/config'),
    'packages/config/src/index.ts': "import '../../platform/src/index.ts'",
    'packages/db/package.json': manifest('@product-res/db'),
    'packages/db/src/client.ts':
      "import '../../platform/src/index.ts'; import '../../config/src/index'",
    'packages/ai/package.json': manifest('@product-res/ai'),
    'packages/ai/src/index.ts':
      "import '../../platform/src/index.ts'; import '../../../apps/web/src/index'",
  })
  const violations = check()
  assert.equal(violations.length, 3)
  assert.ok(
    violations.some((message) => message.includes('@product-res/config → @product-res/platform')),
  )
  assert.ok(
    violations.some((message) => message.includes('@product-res/db → @product-res/platform')),
  )
  assert.ok(violations.some((message) => message.includes('packages 不得引用 apps')))
})

test('evals is only allowed as a root dependency, never in app or package manifests and sources', (t) => {
  const check = workspace(t, {
    'package.json': { name: 'root', devDependencies: { '@product-res/evals': 'workspace:*' } },
    'packages/evals/package.json': manifest('@product-res/evals', { '@product-res/ai': '*' }),
    'packages/evals/src/cli.ts': "import '@product-res/ai'; import './run.ts'",
    'packages/ai/package.json': manifest('@product-res/ai'),
    'apps/web/package.json': {
      name: '@product-res/web',
      devDependencies: { '@product-res/evals': 'workspace:*' },
    },
    'apps/jobs/package.json': manifest('@product-res/jobs'),
    'apps/jobs/src/index.ts': "import { defineSuite } from '@product-res/evals'",
    'packages/ai/test/helper.ts': "import '../../evals/src/suite.ts'",
  })
  const violations = check()
  assert.equal(violations.length, 3, violations.join('\n'))
  for (const text of [
    '@product-res/web → @product-res/evals（apps/web/package.json devDependencies）',
    '@product-res/jobs → @product-res/evals（apps/jobs/src/index.ts:1）',
    '@product-res/ai → @product-res/evals（packages/ai/test/helper.ts:1）',
  ])
    assert.ok(
      violations.some((message) => message.includes(text)),
      text,
    )
})
