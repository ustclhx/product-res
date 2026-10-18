import { aiTask, createDb, file, organization, scoped, user } from '@product-res/db'
import { newId } from '@product-res/shared'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { getStorageUsage, persistMediaOutputs } from '../src/index.ts'
import { createNodeMediaCopier, createNodeStorage } from '../src/node/index.ts'
import { startS3Fixture } from './node-s3/fixture.ts'

const databaseUrl = process.env.NODE_DB_TEST_URL
if (!databaseUrl) throw new Error('Node media replay requires an isolated database URL')
const db = createDb(databaseUrl, { max: 3 })
let fixture: Awaited<ReturnType<typeof startS3Fixture>>
let storage: ReturnType<typeof createNodeStorage>
let ws: string
let userId: string
let taskId: string
const limits = {
  maxFileBytes: 20 * 1024 * 1024,
  storageBytes: 3,
  allowedMimeTypes: ['image/png'],
  allowedHosts: ['media.example.test'],
}
const output = {
  url: 'https://media.example.test/output.png',
  mime: 'image/png',
  width: 10,
  height: 20,
}

beforeAll(async () => {
  fixture = await startS3Fixture()
  storage = createNodeStorage(fixture.config)
}, 120_000)
beforeEach(async () => {
  ws = newId()
  userId = newId()
  taskId = newId()
  await db.insert(user).values({ id: userId, name: 'Node media', email: `${userId}@example.test` })
  await db.insert(organization).values({ id: ws, name: 'Node media', slug: ws })
  await scoped(db, ws).insert(aiTask, {
    id: taskId,
    userId,
    kind: 'image',
    modelKey: 'fixture',
    pricing: { mode: 'per_call', credits: 1 },
    status: 'running',
    input: {},
    provider: 'fixture',
    providerRequestKey: taskId,
    deadlineAt: new Date(Date.now() + 3_600_000),
  })
})
afterEach(async () => {
  await storage.delete(key())
  await db.delete(file).where(eq(file.workspaceId, ws))
  await db.delete(aiTask).where(eq(aiTask.workspaceId, ws))
  await db.delete(organization).where(eq(organization.id, ws))
  await db.delete(user).where(eq(user.id, userId))
})
afterAll(async () => {
  await db.close()
  await fixture?.close()
})
function key() {
  return `ws/${ws}/ai/${taskId}/0`
}

it('replays a real S3 object after failed business confirmation with stable file identity and quota once', async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response('png', {
        headers: { 'Content-Type': 'image/png', 'Content-Length': '3' },
      }),
  )
  const copy = createNodeMediaCopier(fixture.config, { fetch: fetcher })
  const copiedKeys: string[] = []
  const copyOutput: typeof copy = async (objectKey, value, copyLimits) => {
    const stored = await copy(objectKey, value, copyLimits)
    copiedKeys.push(objectKey)
    expect(await storage.head(objectKey)).toEqual({ mime: 'image/png', size: 3 })
    return stored
  }
  const input = {
    db,
    storage,
    copyOutput,
    task: { id: taskId, workspaceId: ws, userId },
    result: { outputs: [output] },
    limits,
  }
  // 对象已成功，但最终配额检查失败；删除暂时不可用，保留真实对象与 pending 墓碑。
  await expect(
    persistMediaOutputs({
      ...input,
      storage: {
        delete: vi.fn(async () => {
          throw new Error('fixture delete unavailable')
        }),
      },
      limits: { ...limits, storageBytes: 2 },
    }),
  ).rejects.toMatchObject({ code: 'UPGRADE_REQUIRED' })
  const [pending] = await scoped(db, ws).select(file)
  expect(pending).toMatchObject({
    r2Key: key(),
    status: 'pending',
    deletedAt: expect.any(Date),
  })
  expect(await storage.head(key())).toEqual({ mime: 'image/png', size: 3 })
  expect(await getStorageUsage(db, ws)).toBe(0)

  const saved = await persistMediaOutputs(input)
  expect(saved).toEqual([
    expect.objectContaining({ id: pending?.id, mime: 'image/png', size: 3, width: 10, height: 20 }),
  ])
  expect(copiedKeys).toEqual([key(), key()])
  expect(await getStorageUsage(db, ws)).toBe(3)
  expect(await scoped(db, ws).count(file)).toBe(1)

  // 配额已满仍复用 ready 身份；取消未使用的新 binary 流，避免重取上游或重复计量。
  const cancel = vi.fn()
  const replay = await persistMediaOutputs({
    ...input,
    result: { outputs: [{ body: new ReadableStream<Uint8Array>({ cancel }), mime: 'image/png' }] },
  })
  expect(replay).toEqual(saved)
  expect(cancel).toHaveBeenCalledOnce()
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(await scoped(db, ws).count(file)).toBe(1)
  expect(await getStorageUsage(db, ws)).toBe(3)
  expect(await storage.head(key())).toEqual({ mime: 'image/png', size: 3 })
}, 30_000)
