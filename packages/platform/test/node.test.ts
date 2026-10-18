import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { requireCapability } from '../src/index.ts'
import { unavailableTaskCapabilities } from '../src/node/index.ts'

describe('Node task capabilities before B', () => {
  it('reports unavailable and rejects use before any task side effect', async () => {
    const tasks = unavailableTaskCapabilities()
    expect(await tasks.health.queue()).toEqual({ status: 'unavailable' })
    expect(await tasks.health.scheduler()).toEqual({ status: 'unavailable', lastCronAt: null })
    for (const capability of [
      tasks.queue,
      tasks.transactionalEnqueue,
      tasks.workflow,
      tasks.scheduler,
    ]) {
      expect(() => requireCapability<unknown>(capability, 'tasks')).toThrow(
        expect.objectContaining({ code: 'CAPABILITY_UNAVAILABLE', status: 503 }),
      )
    }
  })

  it('loads both exports in a real Node process without Cloudflare modules or bindings', () => {
    const dir = fileURLToPath(new URL('..', import.meta.url))
    const output = execFileSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        "await import('@product-res/platform'); const { unavailableTaskCapabilities } = await import('@product-res/platform/node'); console.log((await unavailableTaskCapabilities().health.queue()).status)",
      ],
      { cwd: dir, encoding: 'utf8' },
    )
    expect(output.trim()).toBe('unavailable')
  })
})
