import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

// 复用迁移镜像中已锁定的 storage SDK，不引入第二套依赖或签名实现。
const require = createRequire(new URL('../../packages/storage/package.json', import.meta.url))
const env = process.env

async function secret(name) {
  const path = env[`${name}_FILE`]
  if (!path) throw new Error(name)
  const value = (await readFile(path, 'utf8')).replace(/\n$/, '')
  if (!value || /[\r\n\0]/.test(value)) throw new Error(name)
  return value
}

let client
try {
  const { S3Client, HeadBucketCommand, CreateBucketCommand, PutBucketCorsCommand } =
    require('@aws-sdk/client-s3')
  const bucket = env.S3_BUCKET
  const appUrl = new URL(env.APP_URL)
  if (!bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error('S3_BUCKET')
  }
  if (appUrl.protocol !== 'https:' || appUrl.username || appUrl.password) {
    throw new Error('APP_URL')
  }
  client = new S3Client({
    endpoint: 'http://object-storage:8333',
    region: env.S3_REGION || 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: await secret('S3_ADMIN_ACCESS_KEY_ID'),
      secretAccessKey: await secret('S3_ADMIN_SECRET_ACCESS_KEY'),
    },
    maxAttempts: 3,
    requestHandler: { connectionTimeout: 10_000, requestTimeout: 30_000 },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }))
  } catch (error) {
    if (error.$metadata?.httpStatusCode !== 404) throw error
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }))
    } catch (error) {
      if (error.name !== 'BucketAlreadyOwnedByYou') throw error
    }
  }
  await client.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: [appUrl.origin],
            AllowedMethods: ['PUT', 'GET', 'HEAD'],
            AllowedHeaders: ['Content-Type', 'If-None-Match'],
            ExposeHeaders: ['ETag', 'Content-Length', 'Content-Type', 'Content-Disposition'],
            MaxAgeSeconds: 600,
          },
        ],
      },
    }),
  )
  console.log('object-storage bucket and CORS initialized')
} catch {
  // SDK 异常可能包含签名 URL 和上游响应；只打印固定安全码。
  console.error('OBJECT_STORAGE_INIT_FAILED')
  process.exitCode = 1
} finally {
  client?.destroy()
}
