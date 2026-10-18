import { Readable } from 'node:stream'
import { AbortMultipartUploadCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { AppError } from '@product-res/shared'
import type { MediaCopyLimits, MediaCopyOutput, MediaOutputCopier } from '../media.ts'
import { allowedUrl, checkSize } from '../media-validation.ts'
import { createS3Client, type S3StorageConfig, storageError, validateKey } from './client.ts'

const PART_BYTES = 5 * 1024 * 1024
const CHUNK_BYTES = 64 * 1024

async function copyOutput(
  config: S3StorageConfig,
  key: string,
  output: MediaCopyOutput,
  limits: MediaCopyLimits,
  fetcher: typeof fetch,
) {
  let body = 'body' in output && output.body instanceof ReadableStream ? output.body : undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let source: Readable | undefined
  let upload: Upload | undefined
  let uploadId: string | undefined
  let size = 0
  let sourceBroken = false
  const client = createS3Client(config)
  // 自行等待并清理 multipart，避免 Upload.abort() 的提前返回遮蔽 abort 请求失败。
  client.middlewareStack.add(
    (next, context) => async (args) => {
      const result = await next(args)
      if (context.commandName === 'CreateMultipartUploadCommand')
        uploadId = (result.output as { UploadId?: string }).UploadId
      return result
    },
    { step: 'initialize', name: 'trackMediaMultipart' },
  )
  try {
    validateKey(key)
    if (!limits.allowedMimeTypes.includes(output.mime))
      throw new AppError('FILE_TYPE_NOT_ALLOWED', 'Media type is not allowed')
    let response: Response
    if ('url' in output) {
      const url = allowedUrl(output.url, limits.allowedHosts)
      try {
        response = await fetcher(url.toString(), { redirect: 'error' })
      } catch {
        throw new AppError('MEDIA_DOWNLOAD_FAILED', 'Media download failed', { status: 502 })
      }
    } else {
      if (output.body instanceof Uint8Array) checkSize(output.body.byteLength, limits.maxFileBytes)
      const binary = output.body
      response = new Response(
        binary instanceof Uint8Array
          ? new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(binary)
                controller.close()
              },
            })
          : binary,
        { headers: { 'Content-Type': output.mime } },
      )
    }
    body = response.body ?? undefined
    if (!response.ok || response.redirected || !body)
      throw new AppError('MEDIA_DOWNLOAD_FAILED', 'Media download failed', { status: 502 })
    const mime = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase()
    if (!mime || mime !== output.mime || !limits.allowedMimeTypes.includes(mime))
      throw new AppError('FILE_TYPE_NOT_ALLOWED', 'Media type is not allowed')
    let declaredSize: number | undefined
    const length = response.headers.get('Content-Length')
    if (length !== null) {
      if (!/^\d+$/.test(length)) throw new AppError('MEDIA_INVALID_LENGTH', 'Invalid media length')
      declaredSize = Number(length)
      checkSize(declaredSize, limits.maxFileBytes)
    }
    reader = body.getReader()
    const sourceReader = reader
    async function* chunks() {
      try {
        for (;;) {
          const { done, value } = await sourceReader.read().catch(() => {
            sourceBroken = true
            throw new AppError('MEDIA_DOWNLOAD_FAILED', 'Media download failed', { status: 502 })
          })
          if (done) break
          if (!value.byteLength) continue
          size += value.byteLength
          checkSize(size, limits.maxFileBytes)
          if (declaredSize !== undefined && size > declaredSize)
            throw new AppError('MEDIA_INVALID_LENGTH', 'Invalid media length')
          // 限制 SDK chunker 每次拼接的增量；背压下只保留一个 part 与源 chunk。
          for (let offset = 0; offset < value.byteLength; offset += CHUNK_BYTES)
            yield value.subarray(offset, offset + CHUNK_BYTES)
        }
        checkSize(size, limits.maxFileBytes)
        if (declaredSize !== undefined && size !== declaredSize)
          throw new AppError('MEDIA_INVALID_LENGTH', 'Invalid media length')
      } catch (error) {
        const sourceError =
          error instanceof AppError
            ? error
            : new AppError('MEDIA_DOWNLOAD_FAILED', 'Media download failed', { status: 502 })
        throw sourceError
      }
    }
    source = Readable.from(chunks(), { objectMode: false, highWaterMark: CHUNK_BYTES })
    upload = new Upload({
      client,
      params: { Bucket: config.bucket, Key: key, ContentType: mime, Body: source },
      partSize: PART_BYTES,
      queueSize: 1,
      leavePartsOnError: true,
    })
    await upload.done()
    return { mime, size }
  } catch (error) {
    source?.destroy()
    const cleanup: Promise<unknown>[] = []
    // 已 errored 的源流无需 cancel（cancel 会再次拒绝同一断流错误）。
    if (reader && !sourceBroken) cleanup.push(reader.cancel())
    else if (body && !body.locked) cleanup.push(body.cancel())
    if (upload) {
      await upload.abort()
      if (uploadId)
        cleanup.push(
          client
            .send(
              new AbortMultipartUploadCommand({
                Bucket: config.bucket,
                Key: key,
                UploadId: uploadId,
              }),
            )
            .catch((cause: unknown) => {
              // Complete 可能已成功而响应丢失；不存在的 upload 无需再次 abort。
              if (
                typeof cause === 'object' &&
                cause !== null &&
                'name' in cause &&
                cause.name === 'NoSuchUpload'
              )
                return
              throw cause
            }),
        )
      cleanup.push(client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key })))
    }
    const results = await Promise.allSettled(cleanup)
    if (results.some((result) => result.status === 'rejected'))
      throw storageError('STORAGE_CLEANUP_FAILED')
    throw error instanceof AppError ? error : storageError('STORAGE_WRITE_FAILED')
  } finally {
    reader?.releaseLock()
    client.destroy()
  }
}

/** 转存只在当前 step 持有流；业务确认、配额与重放继续使用 persistMediaOutputs。 */
export function createNodeMediaCopier(
  config: S3StorageConfig,
  { fetch: fetcher = globalThis.fetch }: { readonly fetch?: typeof fetch } = {},
): MediaOutputCopier {
  return (key, output, limits) => copyOutput(config, key, output, limits, fetcher)
}
