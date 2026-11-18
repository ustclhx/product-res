import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { AppError } from '@product-res/shared'
import type { ShareCardObjects } from '../share-cards.ts'
import { createS3Client, isMissing, type S3StorageConfig, storageError } from './client.ts'

export function createNodeShareCardObjects(config: S3StorageConfig): ShareCardObjects {
  async function operation<T>(
    key: string,
    run: (client: ReturnType<typeof createS3Client>) => Promise<T>,
  ) {
    // S3 使用字面对象键；列出的坏索引也必须能删除，不按文件系统路径拒绝点段。
    if (!key.startsWith('share-cards/'))
      throw new AppError('INVALID_SHARE_CARD_KEY', 'Invalid share card key')
    const client = createS3Client(config)
    try {
      return await run(client)
    } catch {
      throw storageError('SHARE_CARD_STORAGE_FAILED')
    } finally {
      client.destroy()
    }
  }
  return {
    list: (input) =>
      operation(input.prefix, async (client) => {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: config.bucket,
            Prefix: input.prefix,
            ...(input.cursor ? { ContinuationToken: input.cursor } : {}),
            ...(input.limit ? { MaxKeys: input.limit } : {}),
          }),
        )
        return {
          keys: (page.Contents ?? []).flatMap((object) => (object.Key ? [object.Key] : [])),
          ...(page.IsTruncated && page.NextContinuationToken
            ? { cursor: page.NextContinuationToken }
            : {}),
        }
      }),
    get: (key) =>
      operation(key, async (client) => {
        try {
          const object = await client.send(
            new GetObjectCommand({ Bucket: config.bucket, Key: key }),
          )
          return {
            body: (await object.Body?.transformToByteArray()) ?? new Uint8Array(),
            metadata: object.Metadata ?? {},
          }
        } catch (error) {
          if (isMissing(error)) return null
          throw error
        }
      }),
    put: (key, body, options = {}) =>
      operation(key, async (client) => {
        await client.send(
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: key,
            Body: body,
            ...(options.contentType ? { ContentType: options.contentType } : {}),
            ...(options.metadata ? { Metadata: options.metadata } : {}),
          }),
        )
      }),
    delete: (key) =>
      operation(key, async (client) => {
        await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
      }),
  }
}
