import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import {
  CreateBucketCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createNodeMediaCopier, createNodeStorage } from '../../packages/storage/src/node/index.ts'

// 仅验收时编译、只读挂到 jobs；不进入应用镜像或注册生产媒体 workflow。
const environment = process.env
const config = {
  endpoint: environment.S3_ENDPOINT as string,
  region: environment.S3_REGION as string,
  bucket: environment.S3_BUCKET as string,
  forcePathStyle: true,
  accessKeyId: readFileSync(environment.S3_ACCESS_KEY_ID_FILE as string, 'utf8').trim(),
  secretAccessKey: readFileSync(environment.S3_SECRET_ACCESS_KEY_FILE as string, 'utf8').trim(),
}
const storage = createNodeStorage(config)
const client = new S3Client({
  ...config,
  credentials: config,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
})

async function run() {
  const [mode, argument] = process.argv.slice(2)
  if (mode === 'head') {
    console.info(
      JSON.stringify({
        url: await getSignedUrl(
          client,
          new HeadObjectCommand({ Bucket: config.bucket, Key: argument }),
          { expiresIn: 300 },
        ),
      }),
    )
  } else if (mode === 'permissions') {
    for (const command of [
      new CreateBucketCommand({ Bucket: `denied-${randomUUID()}` }),
      new PutBucketCorsCommand({
        Bucket: config.bucket,
        CORSConfiguration: { CORSRules: [] },
      }),
    ]) {
      let denied = false
      try {
        await client.send(command)
      } catch (error) {
        denied =
          (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 403
      }
      if (!denied) throw new Error('Application storage administration was not denied')
    }
    console.info(JSON.stringify({ applicationAdmin: false }))
  } else if (mode === 'copy') {
    const concurrent = Number(argument)
    const bytes = 64 * 1024 * 1024
    const copy = createNodeMediaCopier(config)
    await Promise.all(
      Array.from({ length: concurrent }, async () => {
        const key = `ws/${randomUUID()}/ai/${randomUUID()}/0`
        let sent = 0
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (sent === bytes) return controller.close()
            await delay(5)
            const chunk = new Uint8Array(Math.min(64 * 1024, bytes - sent)).fill(42)
            sent += chunk.byteLength
            controller.enqueue(chunk)
          },
        })
        const result = await copy(
          key,
          { body: stream, mime: 'image/png' },
          {
            maxFileBytes: bytes,
            storageBytes: bytes,
            allowedMimeTypes: ['image/png'],
            allowedHosts: [],
          },
        )
        if (result.size !== bytes || (await storage.head(key))?.size !== bytes)
          throw new Error('Unknown-length copy size mismatch')
        await storage.delete(key)
      }),
    )
    console.info(JSON.stringify({ unknownLength: true, concurrent, bytesPerCopy: bytes }))
  } else {
    throw new Error('Unknown storage acceptance mode')
  }
}

run()
  .catch(() => {
    // SDK 异常可能包含签名和凭据，验收失败也只输出固定摘要。
    console.error('Storage acceptance helper failed')
    process.exitCode = 1
  })
  .finally(() => client.destroy())
