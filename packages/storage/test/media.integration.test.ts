import { env } from 'cloudflare:workers'
import { aiTask, createDb, file, organization, scoped, user } from '@product-res/db'
import { newId } from '@product-res/shared'
import { eq, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCloudflareMediaCopier } from '../src/cloudflare/index.ts'
import { cleanupFiles, getStorageUsage, persistMediaOutputs } from '../src/index.ts'

const db = createDb(env.HYPERDRIVE)
let ws: string
let userId: string
let taskId: string
const limits = {
  maxFileBytes: 20 * 1024 * 1024,
  storageBytes: 100 * 1024 * 1024,
  allowedMimeTypes: ['image/png'],
  allowedHosts: ['media.example.test', '*.cdn.example.test'],
}
const output = {
  url: 'https://media.example.test/output.png',
  mime: 'image/png',
  width: 10,
  height: 20,
}
beforeEach(async () => {
  ws = newId()
  userId = newId()
  taskId = newId()
  await db.insert(user).values({ id: userId, name: 'Media', email: `${userId}@example.test` })
  await db.insert(organization).values({ id: ws, name: 'Media', slug: ws })
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
    deadlineAt: new Date(Date.now() + 3600000),
  })
})
afterEach(async () => {
  await env.FILES.delete([key(0), key(1)])
  await db.delete(file).where(eq(file.workspaceId, ws))
  await db.delete(aiTask).where(eq(aiTask.workspaceId, ws))
  await db.delete(organization).where(eq(organization.id, ws))
  await db.delete(user).where(eq(user.id, userId))
})
afterAll(() => db.$client.end())
function key(index: number) {
  return `ws/${ws}/ai/${taskId}/${index}`
}
function copy(
  options: Partial<Omit<Parameters<typeof persistMediaOutputs>[0], 'storage' | 'copyOutput'>> & {
    bucket?: Pick<R2Bucket, 'put' | 'createMultipartUpload' | 'delete'>
    fetch?: typeof fetch
  } = {},
) {
  const {
    bucket = env.FILES,
    fetch: fetcher = vi.fn(
      async () =>
        new Response('png', { headers: { 'Content-Type': 'image/png', 'Content-Length': '3' } }),
    ),
    ...input
  } = options
  return persistMediaOutputs({
    db,
    storage: bucket,
    copyOutput: createCloudflareMediaCopier(bucket, { fetch: fetcher }),
    task: { id: taskId, workspaceId: ws, userId },
    result: { outputs: [output] },
    limits,
    ...input,
  })
}

describe('safe media persistence', () => {
  it('reclaims a persisted output soft-deleted by cancellation in an active workspace', async () => {
    await copy()
    await scoped(db, ws).updateById(aiTask, taskId, { status: 'canceled' })
    await scoped(db, ws).update(file, { deletedAt: new Date() }, eq(file.sourceTaskId, taskId))
    expect(await getStorageUsage(db, ws)).toBe(0)
    expect(await env.FILES.head(key(0))).not.toBeNull()
    await cleanupFiles(db, env.FILES)
    expect(await scoped(db, ws).count(file)).toBe(0)
    expect(await env.FILES.head(key(0))).toBeNull()
  })
  it('rejects external and deceptive addresses without downloading or creating files', async () => {
    const fetcher = vi.fn<typeof fetch>()
    for (const url of [
      'https://evil.test/a',
      'https://media.example.test.evil.test/a',
      'http://media.example.test/a',
      'https://media.example.test:444/a',
      'https://x@media.example.test/a',
      'https://evilcdn.example.test/a',
    ]) {
      await expect(
        copy({ fetch: fetcher, result: { outputs: [{ ...output, url }] } }),
      ).rejects.toMatchObject({ code: 'MEDIA_URL_NOT_ALLOWED' })
    }
    expect(fetcher).not.toHaveBeenCalled()
    expect(await scoped(db, ws).count(file)).toBe(0)
  })

  it('streams fixed-length media with redirects disabled and replays at a full quota without duplicates', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response('png', { headers: { 'Content-Type': 'image/png', 'Content-Length': '3' } }),
    )
    const first = await copy({ fetch: fetcher, limits: { ...limits, storageBytes: 3 } })
    expect(fetcher).toHaveBeenCalledWith(output.url, { redirect: 'manual' })
    expect(first).toEqual([
      expect.objectContaining({ mime: 'image/png', size: 3, width: 10, height: 20 }),
    ])
    expect(await copy({ fetch: fetcher, limits: { ...limits, storageBytes: 3 } })).toEqual(first)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(await scoped(db, ws).count(file)).toBe(1)
    expect(await getStorageUsage(db, ws)).toBe(3)
    expect((await env.FILES.get(key(0)))?.size).toBe(3)
  })

  it('rejects MIME, length, and quota limits without leaving ready files', async () => {
    for (const [headers, code] of [
      [{ 'Content-Type': 'text/html', 'Content-Length': '3' }, 'FILE_TYPE_NOT_ALLOWED'],
      [
        { 'Content-Type': 'image/png', 'Content-Length': `${limits.maxFileBytes + 1}` },
        'FILE_TOO_LARGE',
      ],
    ] as const) {
      await expect(
        copy({ fetch: vi.fn(async () => new Response('png', { headers })) }),
      ).rejects.toMatchObject({ code })
    }
    await expect(copy({ limits: { ...limits, storageBytes: 2 } })).rejects.toMatchObject({
      code: 'UPGRADE_REQUIRED',
    })
    expect(await scoped(db, ws).count(file, eq(file.status, 'ready'))).toBe(0)
    expect(await env.FILES.head(key(0))).toBeNull()
  })

  it('enforces type, byte size and quota limits on synchronous outputs', async () => {
    for (const [body, mime, expected] of [
      [new Uint8Array(3), 'text/html', 'FILE_TYPE_NOT_ALLOWED'],
      [new Uint8Array(limits.maxFileBytes + 1), 'image/png', 'FILE_TOO_LARGE'],
      [new Uint8Array(3), 'image/png', 'UPGRADE_REQUIRED'],
    ] as const) {
      await expect(
        copy({
          result: { outputs: [{ body, mime }] },
          limits: { ...limits, storageBytes: 2 },
        }),
      ).rejects.toMatchObject({ code: expected })
    }
    expect(await scoped(db, ws).count(file, eq(file.status, 'ready'))).toBe(0)
    expect(await env.FILES.head(key(0))).toBeNull()
  })

  it('releases unused synchronous streams on replay and rejection', async () => {
    await copy()
    for (const scenario of ['replay', 'type', 'terminal'] as const) {
      if (scenario === 'terminal')
        await scoped(db, ws).updateById(aiTask, taskId, { status: 'canceled' })
      const cancel = vi.fn()
      const body = new ReadableStream<Uint8Array>({ cancel })
      const saving = copy({
        result: { outputs: [{ body, mime: scenario === 'type' ? 'text/html' : 'image/png' }] },
      })
      if (scenario === 'replay') await saving
      else
        await expect(saving).rejects.toMatchObject({
          code: scenario === 'type' ? 'FILE_TYPE_NOT_ALLOWED' : 'MEDIA_TASK_TERMINAL',
        })
      expect(cancel).toHaveBeenCalledOnce()
    }
  })

  it('rejects redirects and mismatched Content-Length without making files ready', async () => {
    await expect(
      copy({
        fetch: vi.fn(
          async () =>
            new Response(null, { status: 302, headers: { Location: 'https://evil.test/a' } }),
        ),
      }),
    ).rejects.toMatchObject({ code: 'MEDIA_DOWNLOAD_FAILED' })
    await expect(
      copy({
        fetch: vi.fn(
          async () =>
            new Response('oversized', {
              headers: { 'Content-Type': 'image/png', 'Content-Length': '3' },
            }),
        ),
      }),
    ).rejects.toThrow()
    expect(await scoped(db, ws).count(file, eq(file.status, 'ready'))).toBe(0)
    expect(await env.FILES.head(key(0))).toBeNull()
  })

  it.each(['url', 'binary'])(
    'uses 5 MiB multipart parts for unknown-length %s outputs',
    async (source) => {
      const size = 5 * 1024 * 1024 + 7
      const parts: number[] = []
      const realMultipart = env.FILES.createMultipartUpload.bind(env.FILES)
      const bucket = {
        put: env.FILES.put.bind(env.FILES),
        delete: env.FILES.delete.bind(env.FILES),
        createMultipartUpload: vi.fn(async (objectKey: string, options?: R2MultipartOptions) => {
          const upload = await realMultipart(objectKey, options)
          return {
            key: upload.key,
            uploadId: upload.uploadId,
            abort: upload.abort.bind(upload),
            complete: upload.complete.bind(upload),
            uploadPart: async (
              number: number,
              bytes: ArrayBuffer | ArrayBufferView | string | ReadableStream,
            ) => {
              if (!(bytes instanceof Uint8Array)) throw new Error('Expected buffered part')
              parts.push(bytes.byteLength)
              return upload.uploadPart(number, bytes)
            },
          }
        }),
      }
      const fetcher = vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(size))
                controller.close()
              },
            }),
            { headers: { 'Content-Type': 'image/png' } },
          ),
      )
      const result =
        source === 'url'
          ? { outputs: [output] }
          : {
              outputs: [
                {
                  body: new ReadableStream<Uint8Array>({
                    start(controller) {
                      controller.enqueue(new Uint8Array(size))
                      controller.close()
                    },
                  }),
                  mime: 'image/png',
                },
              ],
            }
      expect(await copy({ bucket, fetch: fetcher, result })).toEqual([
        expect.objectContaining({ size }),
      ])
      expect(parts).toEqual([5 * 1024 * 1024, 7])
    },
  )

  it.each(['url', 'binary'])(
    'aborts oversized multipart %s outputs immediately',
    async (source) => {
      const abort = vi.fn(async () => {})
      const uploadPart = vi.fn(async (partNumber: number) => ({ partNumber, etag: 'part' }))
      const complete = vi.fn()
      const bucket = {
        put: env.FILES.put.bind(env.FILES),
        delete: env.FILES.delete.bind(env.FILES),
        createMultipartUpload: vi.fn(async () => ({
          key: key(0),
          uploadId: 'fixture',
          uploadPart,
          complete,
          abort,
        })),
      }
      const fetcher = vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(5 * 1024 * 1024))
                controller.enqueue(new Uint8Array(2))
                controller.close()
              },
            }),
            { headers: { 'Content-Type': 'image/png' } },
          ),
      )
      await expect(
        copy({
          bucket,
          fetch: fetcher,
          ...(source === 'binary'
            ? {
                result: {
                  outputs: [
                    {
                      body: new ReadableStream<Uint8Array>({
                        start(controller) {
                          controller.enqueue(new Uint8Array(5 * 1024 * 1024))
                          controller.enqueue(new Uint8Array(2))
                          controller.close()
                        },
                      }),
                      mime: 'image/png',
                    },
                  ],
                },
              }
            : {}),
          limits: { ...limits, maxFileBytes: 5 * 1024 * 1024 + 1 },
        }),
      ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
      expect(uploadPart).toHaveBeenCalledTimes(1)
      expect(abort).toHaveBeenCalledOnce()
      expect(complete).not.toHaveBeenCalled()
      expect(await scoped(db, ws).count(file, eq(file.status, 'ready'))).toBe(0)
    },
  )

  it('rejects cancellation and preserves pending cleanup anchors after a later output fails', async () => {
    await scoped(db, ws).updateById(aiTask, taskId, { status: 'canceled' })
    const fetcher = vi.fn<typeof fetch>()
    await expect(copy({ fetch: fetcher })).rejects.toMatchObject({ code: 'MEDIA_TASK_TERMINAL' })
    expect(fetcher).not.toHaveBeenCalled()
    await scoped(db, ws).updateById(aiTask, taskId, { status: 'running' })
    const failingFetch = vi
      .fn(
        async () =>
          new Response('png', {
            headers: { 'Content-Type': 'image/png', 'Content-Length': '3' },
          }),
      )
      .mockImplementationOnce(
        async () =>
          new Response('png', {
            headers: { 'Content-Type': 'image/png', 'Content-Length': '3' },
          }),
      )
      .mockImplementationOnce(
        async () =>
          new Response('html', {
            headers: { 'Content-Type': 'text/html', 'Content-Length': '4' },
          }),
      )
    await expect(
      copy({ fetch: failingFetch, result: { outputs: [output, output] } }),
    ).rejects.toMatchObject({ code: 'FILE_TYPE_NOT_ALLOWED' })
    const rows = await scoped(db, ws).select(file)
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.status === 'pending' && row.deletedAt !== null)).toBe(true)
    expect(await getStorageUsage(db, ws)).toBe(0)
    expect(await env.FILES.head(key(0))).toBeNull()
    expect(await env.FILES.head(key(1))).toBeNull()
    // 可重试下载失败复用已有 pending 主键，恢复墓碑而非创建重复记录。
    const retried = await copy({ result: { outputs: [output, output] } })
    expect(retried.map((row) => row.id).sort()).toEqual(rows.map((row) => row.id).sort())
    expect(await getStorageUsage(db, ws)).toBe(6)
  })

  it('allows cancellation to acquire the space lock during download and rejects final confirmation', async () => {
    const fetcher = vi.fn(async () => {
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ws:${ws}`}, 0))`)
        await scoped(tx, ws).updateById(aiTask, taskId, { status: 'canceled' })
      })
      return new Response('png', {
        headers: { 'Content-Type': 'image/png', 'Content-Length': '3' },
      })
    })
    await expect(copy({ fetch: fetcher })).rejects.toMatchObject({ code: 'MEDIA_TASK_TERMINAL' })
    const rows = await scoped(db, ws).select(file)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'pending', deletedAt: expect.any(Date) })
    expect(await getStorageUsage(db, ws)).toBe(0)
    expect(await env.FILES.head(key(0))).toBeNull()
  })
})
