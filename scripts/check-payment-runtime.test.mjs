import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { checkPaymentRuntime } from './check-payment-runtime.mjs'

test('rejects old factory references including imports, aliases and namespace access', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'payment-boundary-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const examples = [
    'createTestPaymentRuntime(env)',
    "import { createTestPaymentRuntime as runtime } from '@product-res/billing'; runtime(env)",
    'billing.createTestPaymentRuntime(env)',
    "billing['createTestPaymentRuntime'](env)",
  ]
  for (const [index, source] of examples.entries()) {
    const path = `apps/web/src/entry-${index}.ts`
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), source)
    const errors = await checkPaymentRuntime(root, [path])
    assert.equal(errors.length, 1)
    assert.equal(errors[0].path, path)
  }
})

test('allows the environment factory and ignores comments and test fixtures', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'payment-boundary-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const paths = ['apps/jobs/src/billing.ts', 'packages/billing/src/runtime.test.ts']
  for (const path of paths) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(
      join(root, path),
      path.endsWith('.test.ts')
        ? 'createTestPaymentRuntime(env)'
        : '// createTestPaymentRuntime is obsolete\ncreatePaymentRuntime(env)',
    )
  }
  assert.deepEqual(await checkPaymentRuntime(root, paths), [])
})
