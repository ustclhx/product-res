import { AppError } from '@product-res/shared'
import { log } from '@product-res/shared/log'
import type { MediaCopyLimits, MediaCopyOutput, MediaOutputCopier } from '../media.ts'
import { allowedUrl, checkSize } from '../media-validation.ts'

const PART_BYTES = 5 * 1024 * 1024
type MediaBucket = Pick<R2Bucket, 'put' | 'createMultipartUpload'>
type FixedStreamFactory = (length: number) => Pick<FixedLengthStream, 'readable' | 'writable'>

async function copyOutput(
  bucket: MediaBucket,
  key: string,
  output: MediaCopyOutput,
  limits: MediaCopyLimits,
  fetcher: typeof fetch,
  makeFixedStream: FixedStreamFactory,
) {
  if (!limits.allowedMimeTypes.includes(output.mime))
    throw new AppError('FILE_TYPE_NOT_ALLOWED', 'Media type is not allowed')
  let response: Response
  if ('url' in output) {
    // workerd 不支持 redirect: 'error'；manual 下 3xx 由下方 !response.ok 拒绝。
    response = await fetcher(allowedUrl(output.url, limits.allowedHosts).toString(), {
      redirect: 'manual',
    })
  } else {
    const body = output.body
    if (body instanceof Uint8Array) {
      checkSize(body.byteLength, limits.maxFileBytes)
      await bucket.put(key, body, { httpMetadata: { contentType: output.mime } })
      return { mime: output.mime, size: body.byteLength }
    }
    response = new Response(body, { headers: { 'Content-Type': output.mime } })
  }
  try {
    if (!response.ok || response.redirected || !response.body)
      throw new AppError('MEDIA_DOWNLOAD_FAILED', 'Media download failed')
    const mime = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase()
    if (!mime || mime !== output.mime || !limits.allowedMimeTypes.includes(mime))
      throw new AppError('FILE_TYPE_NOT_ALLOWED', 'Media type is not allowed')
    const length = response.headers.get('Content-Length')
    if (length !== null) {
      if (!/^\d+$/.test(length)) throw new AppError('MEDIA_INVALID_LENGTH', 'Invalid media length')
      const size = Number(length)
      checkSize(size, limits.maxFileBytes)
      const fixed = makeFixedStream(size)
      // 两端同时驱动以保持背压；长度不一致由 FixedLengthStream 拒绝。
      const controller = new AbortController()
      const copying = response.body.pipeTo(fixed.writable, { signal: controller.signal })
      const storing = bucket
        .put(key, fixed.readable, { httpMetadata: { contentType: mime } })
        .catch((error: unknown) => {
          controller.abort(error)
          throw error
        })
      const results = await Promise.allSettled([copying, storing])
      for (const result of results) if (result.status === 'rejected') throw result.reason
      return { mime, size }
    }
    const upload = await bucket.createMultipartUpload(key, { httpMetadata: { contentType: mime } })
    const reader = response.body.getReader()
    const parts: R2UploadedPart[] = []
    let size = 0
    let buffer = new Uint8Array(PART_BYTES)
    let buffered = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > limits.maxFileBytes)
          throw new AppError('FILE_TOO_LARGE', 'Media exceeds the file size limit')
        let offset = 0
        while (offset < value.byteLength) {
          const count = Math.min(PART_BYTES - buffered, value.byteLength - offset)
          buffer.set(value.subarray(offset, offset + count), buffered)
          buffered += count
          offset += count
          if (buffered === PART_BYTES) {
            parts.push(await upload.uploadPart(parts.length + 1, buffer))
            buffer = new Uint8Array(PART_BYTES)
            buffered = 0
          }
        }
      }
      checkSize(size, limits.maxFileBytes)
      // R2 只允许最后一片小于 5 MiB。
      if (buffered)
        parts.push(await upload.uploadPart(parts.length + 1, buffer.subarray(0, buffered)))
      await upload.complete(parts)
      return { mime, size }
    } catch (error) {
      const cleanup = await Promise.allSettled([reader.cancel(error), upload.abort()])
      if (cleanup[1]?.status === 'rejected')
        log.warn('storage.media.multipart_abort_failed', { key })
      throw error
    } finally {
      reader.releaseLock()
    }
  } catch (error) {
    if (response.body && !response.body.locked) await response.body.cancel(error)
    throw error
  }
}

/** 每个事件显式装配 R2；流与平台类型不进入业务入口。 */
export function createCloudflareMediaCopier(
  bucket: MediaBucket,
  {
    fetch: fetcher = globalThis.fetch,
    fixedLengthStream = (size) => new FixedLengthStream(size),
  }: {
    readonly fetch?: typeof fetch
    readonly fixedLengthStream?: FixedStreamFactory
  } = {},
): MediaOutputCopier {
  return (key, output, limits) =>
    copyOutput(bucket, key, output, limits, fetcher, fixedLengthStream)
}
