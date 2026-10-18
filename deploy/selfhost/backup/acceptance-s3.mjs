import { readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { createRequire } from 'node:module'

// 仅隔离测试使用：复用迁移镜像锁定的 SDK，不把真实凭据传进 argv 或日志。
const require = createRequire(new URL('../../../packages/storage/package.json', import.meta.url))
const sdk = require('@aws-sdk/client-s3')
const [operation, key, destination] = process.argv.slice(2)
// 此脚本由Docker夹具直接执行，不属于Turbo缓存任务。
// biome-ignore lint/suspicious/noUndeclaredEnvVars: 仅隔离夹具接线
const fixtureHost = process.env.FIXTURE_S3_HOST || 'object-storage'
let client
function assertMetadataChange(before, after) {
  if (before === after) throw new Error('Metadata timestamps absent')
}
try {
  if (operation === 'proxy') {
    https
      .createServer(
        {
          key: await readFile('/fixture/server.key'),
          cert: await readFile('/fixture/server.crt'),
        },
        (request, response) => {
          const upstream = http.request(
            {
              host: fixtureHost,
              port: 8333,
              path: request.url,
              method: request.method,
              headers: request.headers,
            },
            (incoming) => {
              response.writeHead(incoming.statusCode, incoming.headers)
              incoming.pipe(response)
            },
          )
          upstream.on('error', () => {
            response.writeHead(503)
            response.end()
          })
          request.pipe(upstream)
        },
      )
      .listen(8443, '0.0.0.0')
  } else {
    client = new sdk.S3Client({
      endpoint: `http://${fixtureHost}:8333`,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: (await readFile('/run/secrets/s3_admin_access_key_id', 'utf8')).trim(),
        secretAccessKey: (await readFile('/run/secrets/s3_admin_secret_access_key', 'utf8')).trim(),
      },
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 3000, requestTimeout: 10000 },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    })
    const Bucket = 'backup-fixture'
    if (operation === 'init') {
      try {
        await client.send(new sdk.CreateBucketCommand({ Bucket }))
      } catch (error) {
        if (error.name !== 'BucketAlreadyOwnedByYou') throw error
      }
      console.log(JSON.stringify({ created: true }))
    } else if (operation === 'list') {
      const objects = []
      let token
      do {
        const page = await client.send(
          new sdk.ListObjectsV2Command({ Bucket, Prefix: 'cluster/', ContinuationToken: token }),
        )
        objects.push(...(page.Contents ?? []).map(({ Key, Size }) => ({ key: Key, bytes: Size })))
        token = page.NextContinuationToken
      } while (token)
      console.log(JSON.stringify(objects))
    } else if (operation === 'download') {
      const object = await client.send(new sdk.GetObjectCommand({ Bucket, Key: key }))
      await writeFile(destination, await object.Body.transformToByteArray())
      console.log(JSON.stringify({ downloaded: true }))
    } else if (operation === 'age') {
      const object = await client.send(new sdk.GetObjectCommand({ Bucket, Key: key }))
      const raw = await object.Body.transformToString()
      // system_identifier 是64位整数，不能经JS Number重新序列化而丢失身份精度。
      const aged = raw.replace(
        /("(?:start_time|finish_time)"\s*:\s*)"[^"]*"/g,
        (_match, field) => field + JSON.stringify(destination),
      )
      assertMetadataChange(raw, aged)
      await client.send(new sdk.PutObjectCommand({ Bucket, Key: key, Body: aged }))
      console.log(JSON.stringify({ aged: true }))
    } else throw new Error('Unsupported fixture operation')
  }
} catch (error) {
  const code = /^[A-Za-z]+$/.test(error.name) ? error.name : 'Error'
  console.error(`BACKUP_S3_FIXTURE_FAILED_${code}`)
  process.exitCode = 1
} finally {
  client?.destroy()
}
