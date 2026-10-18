import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import type { NodeStorageConfig } from '@product-res/config/node'

const execute = promisify(execFile)
// SDK 已属于 storage；测试借用其依赖，不为夹具扩大 jobs 的生产依赖。
const { S3Client, CreateBucketCommand } = createRequire(
  new URL('../../../../packages/storage/package.json', import.meta.url),
)('@aws-sdk/client-s3')

async function docker(args: string[]) {
  try {
    return (await execute('docker', args, { timeout: 60_000 })).stdout.trim()
  } catch {
    throw new Error('Node media S3 fixture Docker command failed')
  }
}

export async function startMediaS3Fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'b-media-s3-'))
  const name = `b-media-s3-${randomUUID()}`
  const accessKeyId = randomUUID().replaceAll('-', '')
  const secretAccessKey = `${randomUUID()}${randomUUID()}`.replaceAll('-', '')
  let started = false
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try {
      if (started) await docker(['rm', '-f', name])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
  try {
    await writeFile(
      join(directory, 's3.json'),
      JSON.stringify({
        identities: [
          {
            name: 'media-fixture',
            credentials: [{ accessKey: accessKeyId, secretKey: secretAccessKey }],
            actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'],
          },
        ],
      }),
      { mode: 0o600 },
    )
    await docker([
      '--config',
      directory,
      'run',
      '--pull=never',
      '-d',
      '--name',
      name,
      '-p',
      '127.0.0.1::8333',
      '-v',
      `${directory}:/fixture:ro`,
      'chrislusf/seaweedfs:4.48',
      'mini',
      '-dir=/data',
      '-s3',
      '-s3.config=/fixture/s3.json',
      '-admin.ui=false',
      '-master.telemetry=false',
      '-volume.max=1',
      '-webdav=false',
    ])
    started = true
    const endpoint = `http://${await docker(['port', name, '8333/tcp'])}`
    const config: NodeStorageConfig = {
      endpoint,
      bucket: 'media-fixture',
      region: 'us-east-1',
      forcePathStyle: true,
      accessKeyId,
      secretAccessKey,
    }
    const client = new S3Client({
      endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    })
    try {
      const deadline = Date.now() + 30_000
      for (;;) {
        try {
          await client.send(new CreateBucketCommand({ Bucket: config.bucket }))
          break
        } catch {
          if (Date.now() >= deadline) throw new Error('Node media S3 fixture readiness failed')
          await delay(100)
        }
      }
    } finally {
      client.destroy()
    }
    return { config, close }
  } catch (error) {
    await close()
    throw error
  }
}
