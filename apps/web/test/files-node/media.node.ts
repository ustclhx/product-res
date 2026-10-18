import { createDb } from '@product-res/db'
import { readLocalEnv } from '@product-res/db/worktree-env'
import { expect, it, vi } from 'vitest'
import { getFileMediaHttpDeps } from '../../src/features/files/runtime.ts'
import { type WebRuntime, withWebRuntime } from '../../src/server/runtime.ts'

it('Node 缺少文件能力，即使 Workflow 可用也在任务与预扣前返回 503', async () => {
  const url = readLocalEnv('CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE')
  if (!url) throw new Error('Files Node test requires an isolated worktree database')
  const db = createDb(url)
  const create = vi.fn()
  const runtime = {
    files: { available: false },
    ai: { available: true, value: { workflow: { available: true, value: { create } } } },
    get db() {
      throw new Error('Business database must not be accessed')
    },
    get auth() {
      throw new Error('Auth must not be accessed')
    },
  } as unknown as WebRuntime
  const counts = () => db.$client`
    select (select count(*) from ai_task) as tasks,
           (select count(*) from credit_hold) as holds`
  try {
    const before = await counts()
    withWebRuntime(runtime, () => {
      expect(getFileMediaHttpDeps).toThrow(
        expect.objectContaining({ code: 'CAPABILITY_UNAVAILABLE', status: 503 }),
      )
    })
    expect(create).not.toHaveBeenCalled()
    expect(await counts()).toEqual(before)
  } finally {
    await db.$client.end()
  }
})
