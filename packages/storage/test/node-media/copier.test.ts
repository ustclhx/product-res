import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListMultipartUploadsCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { AppError, newId } from '@product-res/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { MediaCopyOutput } from '../../src/media.ts'
import { createNodeMediaCopier, createNodeStorage } from '../../src/node/index.ts'
import { startS3Fixture } from '../node-s3/fixture.ts'

const PART_BYTES = 5 * 1024 * 1024
const limits = {
  maxFileBytes: 20 * 1024 * 1024,
  storageBytes: 100 * 1024 * 1024,
  allowedMimeTypes: ['image/png'],
  allowedHosts: ['media.example.test', '*.cdn.example.test'],
}
const output = { url: 'https://media.example.test/output.png', mime: 'image/png' }
let fixture: Awaited<ReturnType<typeof startS3Fixture>>
let storage: ReturnType<typeof createNodeStorage>
const keys: string[] = []

beforeAll(async () => {
  fixture = await startS3Fixture()
  storage = createNodeStorage(fixture.config)
}, 120_000)
afterEach(async () => {
  vi.restoreAllMocks()
  for (const key of keys.splice(0)) await storage.delete(key)
})
afterAll(async () => fixture?.close())

function key() {
  const value = `ws/${newId()}/ai/${newId()}/0`
  keys.push(value)
  return value
}
function stream(chunks: readonly Uint8Array[], cancel = vi.fn()) {
  let index = 0
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const value = chunks[index++]
        if (value) controller.enqueue(value)
        else controller.close()
      },
      cancel,
    },
    { highWaterMark: 0 },
  )
}
function copier(response: Response) {
  const fetcher = vi.fn<typeof fetch>(async () => response)
  return { fetcher, copy: createNodeMediaCopier(fixture.config, { fetch: fetcher }) }
}
async function noResidue(objectKey: string) {
  expect(await storage.head(objectKey)).toBeNull()
  const uploads = await fixture.client.send(
    new ListMultipartUploadsCommand({ Bucket: fixture.config.bucket, Prefix: objectKey }),
  )
  expect(uploads.Uploads ?? []).toEqual([])
}

describe('Node safe media copier against real S3', () => {
  it('rejects deceptive and non-HTTPS origins before any download', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const copy = createNodeMediaCopier(fixture.config, { fetch: fetcher })
    for (const url of [
      'https://evil.test/a',
      'https://media.example.test.evil.test/a',
      'http://media.example.test/a',
      'https://media.example.test:444/a',
      'https://x@media.example.test/a',
      'https://evilcdn.example.test/a',
      'https://cdn.example.test/a',
    ]) {
      await expect(copy(key(), { ...output, url }, limits)).rejects.toMatchObject({
        code: 'MEDIA_URL_NOT_ALLOWED',
      })
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('accepts an explicitly allowed subdomain and returns actual MIME and size', async () => {
    const objectKey = key()
    const { fetcher, copy } = copier(
      new Response('png', {
        headers: { 'Content-Type': 'IMAGE/PNG; charset=binary', 'Content-Length': '3' },
      }),
    )
    const url = 'https://a.cdn.example.test/output.png'
    expect(await copy(objectKey, { ...output, url }, limits)).toEqual({
      mime: 'image/png',
      size: 3,
    })
    expect(fetcher).toHaveBeenCalledWith(url, { redirect: 'error' })
    expect(await storage.head(objectKey)).toEqual({ mime: 'image/png', size: 3 })
  })

  it('refuses redirects and releases their source body', async () => {
    const cancel = vi.fn()
    const objectKey = key()
    const { copy } = copier(
      new Response(stream([new Uint8Array(3)], cancel), {
        status: 302,
        headers: { Location: 'https://evil.test/a' },
      }),
    )
    await expect(copy(objectKey, output, limits)).rejects.toMatchObject({
      code: 'MEDIA_DOWNLOAD_FAILED',
    })
    expect(cancel).toHaveBeenCalledOnce()
    await noResidue(objectKey)
  })

  it.each([
    [{ 'Content-Type': 'text/html' }, 'FILE_TYPE_NOT_ALLOWED'],
    [{ 'Content-Type': 'image/png', 'Content-Length': 'invalid' }, 'MEDIA_INVALID_LENGTH'],
    [
      { 'Content-Type': 'image/png', 'Content-Length': `${limits.maxFileBytes + 1}` },
      'FILE_TOO_LARGE',
    ],
  ])('rejects invalid response metadata and cancels before reading', async (headers, code) => {
    const cancel = vi.fn()
    const objectKey = key()
    const { copy } = copier(new Response(stream([new Uint8Array(3)], cancel), { headers }))
    await expect(copy(objectKey, output, limits)).rejects.toMatchObject({ code })
    expect(cancel).toHaveBeenCalledOnce()
    await noResidue(objectKey)
  })

  it.each(['1', '9'])('rejects forged Content-Length %s using actual bytes', async (length) => {
    const objectKey = key()
    const { copy } = copier(
      new Response('png', {
        headers: { 'Content-Type': 'image/png', 'Content-Length': length },
      }),
    )
    await expect(copy(objectKey, output, limits)).rejects.toMatchObject({
      code: 'MEDIA_INVALID_LENGTH',
    })
    await noResidue(objectKey)
  })

  it.each(['url', 'binary'])(
    'uploads unknown-length %s in bounded, serial parts',
    async (source) => {
      const objectKey = key()
      const size = PART_BYTES * 2 + 7
      const parts: number[] = []
      let active = 0
      let maxActive = 0
      const send = S3Client.prototype.send
      vi.spyOn(S3Client.prototype, 'send').mockImplementation(function (
        this: S3Client,
        command: Parameters<typeof send>[0],
        ...args: unknown[]
      ) {
        if (!(command instanceof UploadPartCommand))
          return Reflect.apply(send, this, [command, ...args])
        const body = command.input.Body
        if (!(body instanceof Uint8Array)) throw new Error('Expected a bounded buffered part')
        parts.push(body.byteLength)
        maxActive = Math.max(maxActive, ++active)
        return Promise.resolve(Reflect.apply(send, this, [command, ...args])).finally(
          () => active--,
        )
      } as typeof send)
      const body = stream([new Uint8Array(size)])
      const { copy } = copier(new Response(body, { headers: { 'Content-Type': 'image/png' } }))
      const input: MediaCopyOutput = source === 'url' ? output : { body, mime: 'image/png' }
      expect(await copy(objectKey, input, limits)).toEqual({ mime: 'image/png', size })
      expect(parts).toEqual([PART_BYTES, PART_BYTES, 7])
      expect(maxActive).toBe(1)
      expect(await storage.head(objectKey)).toEqual({ mime: 'image/png', size })
      const stored = await fixture.client.send(
        new GetObjectCommand({ Bucket: fixture.config.bucket, Key: objectKey }),
      )
      expect((await stored.Body?.transformToByteArray())?.byteLength).toBe(size)
    },
  )

  it('supports binary Uint8Array without fetching a source', async () => {
    const objectKey = key()
    const fetcher = vi.fn<typeof fetch>()
    const copy = createNodeMediaCopier(fixture.config, { fetch: fetcher })
    const body = Uint8Array.of(1, 2, 3)
    expect(await copy(objectKey, { body, mime: 'image/png' }, limits)).toEqual({
      size: 3,
      mime: 'image/png',
    })
    expect(fetcher).not.toHaveBeenCalled()
    const stored = await fixture.client.send(
      new GetObjectCommand({ Bucket: fixture.config.bucket, Key: objectKey }),
    )
    expect(await stored.Body?.transformToByteArray()).toEqual(body)
  })

  it('rejects binary MIME and actual size before writing', async () => {
    const copy = createNodeMediaCopier(fixture.config)
    for (const [body, mime, code] of [
      [new Uint8Array(3), 'text/html', 'FILE_TYPE_NOT_ALLOWED'],
      [new Uint8Array(4), 'image/png', 'FILE_TOO_LARGE'],
      [new Uint8Array(0), 'image/png', 'FILE_TOO_LARGE'],
    ] as const) {
      const objectKey = key()
      await expect(
        copy(objectKey, { body, mime }, { ...limits, maxFileBytes: 3 }),
      ).rejects.toMatchObject({ code })
      await noResidue(objectKey)
    }
  })

  it('propagates source cancellation failure without exposing its message', async () => {
    const cancel = vi.fn(async () => {
      throw new Error('upstream credential secret must not escape')
    })
    const objectKey = key()
    const { copy } = copier(
      new Response(stream([new Uint8Array(3)], cancel), {
        headers: { 'Content-Type': 'text/html' },
      }),
    )
    await expect(copy(objectKey, output, limits)).rejects.toMatchObject({
      code: 'STORAGE_CLEANUP_FAILED',
      message: expect.not.stringContaining('secret'),
    })
    expect(cancel).toHaveBeenCalledOnce()
    await noResidue(objectKey)
  })

  it('cancels and aborts a multipart upload when S3 rejects a part', async () => {
    const objectKey = key()
    const send = S3Client.prototype.send
    let aborts = 0
    vi.spyOn(S3Client.prototype, 'send').mockImplementation(function (
      this: S3Client,
      command: Parameters<typeof send>[0],
      ...args: unknown[]
    ) {
      if (command instanceof UploadPartCommand)
        return Promise.reject(new Error('S3 credential secret must not escape'))
      if (command instanceof AbortMultipartUploadCommand) aborts++
      return Reflect.apply(send, this, [command, ...args])
    } as typeof send)
    const cancel = vi.fn()
    const { copy } = copier(
      new Response(
        stream([new Uint8Array(PART_BYTES), new Uint8Array(PART_BYTES), new Uint8Array(3)], cancel),
        { headers: { 'Content-Type': 'image/png' } },
      ),
    )
    await expect(copy(objectKey, output, limits)).rejects.toMatchObject({
      code: 'STORAGE_WRITE_FAILED',
      message: expect.not.stringContaining('secret'),
    })
    expect(cancel).toHaveBeenCalledOnce()
    expect(aborts).toBeGreaterThan(0)
    await noResidue(objectKey)
  })

  it.each(['url', 'binary'])(
    'cancels actual oversize %s and removes uploaded parts',
    async (source) => {
      const objectKey = key()
      const cancel = vi.fn()
      const body = stream(
        [new Uint8Array(PART_BYTES), new Uint8Array(PART_BYTES), new Uint8Array(2)],
        cancel,
      )
      const { copy } = copier(new Response(body, { headers: { 'Content-Type': 'image/png' } }))
      await expect(
        copy(objectKey, source === 'url' ? output : { body, mime: 'image/png' }, {
          ...limits,
          maxFileBytes: PART_BYTES * 2 + 1,
        }),
      ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
      expect(cancel).toHaveBeenCalledOnce()
      await noResidue(objectKey)
    },
  )

  it('aborts multipart when the source breaks after a part was uploaded', async () => {
    const objectKey = key()
    let reads = 0
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (++reads <= 2) controller.enqueue(new Uint8Array(PART_BYTES))
          else controller.error(new Error('upstream secret must not escape'))
        },
      },
      { highWaterMark: 0 },
    )
    const { copy } = copier(new Response(body, { headers: { 'Content-Type': 'image/png' } }))
    await expect(copy(objectKey, output, limits)).rejects.toMatchObject({
      code: 'MEDIA_DOWNLOAD_FAILED',
    })
    await noResidue(objectKey)
  })

  it('redacts binary source errors even when the producer throws an AppError', async () => {
    const objectKey = key()
    const unsafe = new AppError('PROVIDER_FAILED', 'provider credential secret', {
      cause: new Error('signed URL secret'),
    })
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(unsafe)
      },
    })
    const error = await createNodeMediaCopier(fixture.config)(
      objectKey,
      { body, mime: 'image/png' },
      limits,
    ).catch((value: unknown) => value)
    expect(error).toMatchObject({ code: 'MEDIA_DOWNLOAD_FAILED', message: 'Media download failed' })
    expect(error).not.toHaveProperty('cause')
    expect(body.locked).toBe(false)
    await noResidue(objectKey)
  })

  it.each(['abort', 'delete'])(
    'propagates %s cleanup failure as a safe retryable error',
    async (failure) => {
      const objectKey = key()
      const send = S3Client.prototype.send
      vi.spyOn(S3Client.prototype, 'send').mockImplementation(function (
        this: S3Client,
        command: Parameters<typeof send>[0],
        ...args: unknown[]
      ) {
        if (
          (failure === 'abort' && command instanceof AbortMultipartUploadCommand) ||
          (failure === 'delete' && command instanceof DeleteObjectCommand)
        )
          return Promise.reject(new Error('S3 credential secret must not escape'))
        return Reflect.apply(send, this, [command, ...args])
      } as typeof send)
      const cancel = vi.fn()
      const { copy } = copier(
        new Response(
          stream(
            [new Uint8Array(PART_BYTES), new Uint8Array(PART_BYTES), new Uint8Array(2)],
            cancel,
          ),
          {
            headers: { 'Content-Type': 'image/png' },
          },
        ),
      )
      await expect(
        copy(objectKey, output, { ...limits, maxFileBytes: PART_BYTES * 2 + 1 }),
      ).rejects.toMatchObject({
        code: 'STORAGE_CLEANUP_FAILED',
        message: expect.not.stringContaining('secret'),
      })
      expect(cancel).toHaveBeenCalledOnce()
      vi.restoreAllMocks()
      const uploads = await fixture.client.send(
        new ListMultipartUploadsCommand({ Bucket: fixture.config.bucket, Prefix: objectKey }),
      )
      // 故障注入留下的分片属于此用例，恢复真实删除能力后显式清理。
      for (const upload of uploads.Uploads ?? [])
        await fixture.client.send(
          new AbortMultipartUploadCommand({
            Bucket: fixture.config.bucket,
            Key: upload.Key,
            UploadId: upload.UploadId,
          }),
        )
      await noResidue(objectKey)
    },
  )
})
