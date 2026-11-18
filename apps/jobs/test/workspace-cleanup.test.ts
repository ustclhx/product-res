import { createScheduledController } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it, vi } from 'vitest'
import { WORKSPACE_CLEANUP_CRON } from '../src/cron/workspace-cleanup.ts'
import worker from '../src/index.ts'

it('routes the daily cleanup cron to the retention job', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    await worker.scheduled(createScheduledController({ cron: WORKSPACE_CLEANUP_CRON }), env)
    expect(log.mock.calls.flat().join(' ')).toContain('cron.workspace-cleanup')
    expect(log.mock.calls.flat().join(' ')).toContain('cron.deleted-user-ai-cleanup')
  } finally {
    log.mockRestore()
  }
})
