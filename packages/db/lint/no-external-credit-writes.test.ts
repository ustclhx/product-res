import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const checker = resolve(import.meta.dirname, '../../../scripts/check-credit-writes.mjs')
const fixtures = resolve(import.meta.dirname, 'fixtures')
const temporary: string[] = []

function prepare(targets: Array<[string, string]>) {
  const root = mkdtempSync(join(tmpdir(), 'credit-writes-'))
  temporary.push(root)
  execFileSync('git', ['init', '--quiet', root])
  for (const [fixture, path] of targets) {
    const target = join(root, path)
    mkdirSync(resolve(target, '..'), { recursive: true })
    cpSync(join(fixtures, fixture), target)
  }
  return root
}

function check(targets: Array<[string, string]>) {
  return spawnSync(process.execPath, [checker, prepare(targets)], { encoding: 'utf8' })
}

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('production credit write ownership', () => {
  it('rejects Drizzle/scoped/alias/namespace/raw SQL writes in both apps and other packages', () => {
    const app = 'apps/web/src/features/billing/server.ts'
    const pkg = 'packages/billing/src/grants.ts'
    const result = check([
      ['credit-writes.ts', app],
      ['credit-writes.ts', pkg],
    ])
    expect(result.status).toBe(1)
    const expected = readFileSync(join(fixtures, 'credit-writes.ts'), 'utf8')
      .split('\n')
      .flatMap((line, index) => (line.includes('// expect-credit-write') ? [index + 1] : []))
    for (const path of [app, pkg]) {
      const lines = result.stderr
        .split('\n')
        .filter((line) => line.startsWith(`${path}:`))
        .map((line) => Number(line.split(':')[1]))
      // TRUNCATE has two independently protected targets on the same line.
      expect([...new Set(lines)]).toEqual(expected)
    }
  })

  it('permits the same writes only in credits production, tests, fixtures and schema migrations', () => {
    const result = check([
      ['credit-writes.ts', 'packages/credits/src/index.ts'],
      ['credit-writes.ts', 'apps/jobs/src/grants.test.ts'],
      ['credit-writes.ts', 'packages/db/lint/fixtures/grants.ts'],
      ['credit-writes.ts', 'packages/db/src/schema/credits.ts'],
      ['credit-writes.ts', 'packages/db/migrations/seed.sql'],
    ])
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it('permits credit reads and non-credit writes in app and package production', () => {
    const result = check([
      ['credit-reads.ts', 'apps/jobs/src/cron/credits.ts'],
      ['credit-reads.ts', 'packages/billing/src/credits.ts'],
    ])
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it('exits cleanly when independent credit checks run concurrently', async () => {
    const root = prepare([
      ['credit-reads.ts', 'apps/jobs/src/cron/credits.ts'],
      ['credit-reads.ts', 'packages/billing/src/credits.ts'],
    ])
    // 同时关闭多个真实 API 子进程，覆盖短生命周期下的取消竞态。
    const results = await Promise.all(
      Array.from(
        { length: 8 },
        () =>
          new Promise<{ status: number | null; stderr: string }>((done, reject) => {
            const child = spawn(process.execPath, [checker, root])
            child.stdout.resume()
            let stderr = ''
            child.stderr.setEncoding('utf8').on('data', (chunk) => {
              stderr += chunk
            })
            child.on('error', reject)
            child.on('close', (status) => done({ status, stderr }))
          }),
      ),
    )
    for (const result of results) {
      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
    }
  })
})
