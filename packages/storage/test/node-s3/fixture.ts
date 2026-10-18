import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3'
import type { S3StorageConfig } from '../../src/node/index.ts'

const exec = promisify(execFile)
const hostname = 'storage.fixture.test'

// Docker/SDK 原始错误可能含随机凭据；fixture 只报告固定步骤名。
async function command(file: string, args: string[]) {
  try {
    return (await exec(file, args, { timeout: 120_000 })).stdout.trim()
  } catch {
    throw new Error(`S3 fixture ${file} command failed`)
  }
}

export async function startS3Fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'selfhost-c-storage-s3-'))
  const name = `selfhost-c-storage-s3-${randomBytes(5).toString('hex')}`
  const credentials = () => ({
    accessKeyId: randomBytes(12).toString('hex'),
    secretAccessKey: randomBytes(24).toString('hex'),
  })
  const admin = credentials()
  const denied = credentials()
  const bucket = 'fixture-files'
  let proxy: https.Server | undefined
  let client: S3Client | undefined
  const originalConnection = https.Agent.prototype.createConnection
  let patched = false
  const close = async () => {
    client?.destroy()
    if (patched) https.Agent.prototype.createConnection = originalConnection
    if (proxy) {
      proxy.closeAllConnections()
      await new Promise<void>((resolve) => proxy?.close(() => resolve()))
    }
    try {
      await command('docker', ['rm', '-f', name])
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
            name: 'fixture-admin',
            credentials: [{ accessKey: admin.accessKeyId, secretKey: admin.secretAccessKey }],
            actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'],
          },
          {
            name: 'fixture-denied',
            credentials: [{ accessKey: denied.accessKeyId, secretKey: denied.secretAccessKey }],
            actions: [`Write:${bucket}`],
          },
        ],
      }),
      { mode: 0o600 },
    )
    await command('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-keyout',
      join(directory, 'key.pem'),
      '-out',
      join(directory, 'cert.pem'),
      '-subj',
      `/CN=${hostname}`,
      '-addext',
      `subjectAltName=DNS:${hostname},DNS:*.${hostname}`,
    ])
    await command('docker', [
      '--config',
      directory,
      'run',
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
      `-s3.domainName=${hostname}`,
      '-admin.ui=false',
      '-master.telemetry=false',
      '-volume.max=1',
      '-webdav=false',
    ])
    const mapped = await command('docker', ['port', name, '8333/tcp'])
    const endpoint = `http://${mapped}`
    const config: S3StorageConfig = {
      endpoint,
      bucket,
      region: 'us-east-1',
      forcePathStyle: true,
      ...admin,
    }
    client = new S3Client({
      endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: admin,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    })
    const deadline = Date.now() + 60_000
    let ready = false
    while (Date.now() < deadline) {
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }))
        ready = true
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
    if (!ready) throw new Error('S3 fixture readiness failed')
    const ca = await readFile(join(directory, 'cert.pem'))
    const key = await readFile(join(directory, 'key.pem'))
    proxy = https.createServer({ cert: ca, key }, (incoming, outgoing) => {
      // 保留被签名的 Host/path/query；只改变实际 TCP 目标。
      const upstream = http.request(
        `${endpoint}${incoming.url}`,
        {
          method: incoming.method,
          headers: incoming.headers,
        },
        (response) => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers)
          response.pipe(outgoing)
        },
      )
      upstream.on('error', () => {
        outgoing.destroy()
      })
      incoming.pipe(upstream)
    })
    await new Promise<void>((resolve) => proxy?.listen(0, '127.0.0.1', resolve))
    const address = proxy.address()
    if (!address || typeof address === 'string') throw new Error('S3 fixture TLS listener failed')
    const virtualConfig: S3StorageConfig = {
      ...config,
      endpoint: `https://${hostname}:${address.port}`,
      forcePathStyle: false,
    }
    // 仅本 worker 的 fixture 域名信任临时 CA/DNS；没有关闭 TLS 验证。
    https.Agent.prototype.createConnection = function (options, callback) {
      const servername = options.servername
      if (servername === hostname || servername?.endsWith(`.${hostname}`)) {
        return originalConnection.call(
          this,
          {
            ...options,
            ca,
            lookup: (_host, _options, done) => done(null, [{ address: '127.0.0.1', family: 4 }]),
          },
          callback,
        )
      }
      return originalConnection.call(this, options, callback)
    }
    patched = true
    const request = (
      url: string,
      init: {
        method?: string
        headers?: Record<string, string>
        body?: string | Uint8Array
      } = {},
    ) =>
      new Promise<Response>((resolve, reject) => {
        const target = new URL(url)
        const transport = target.protocol === 'https:' ? https : http
        const req = transport.request(
          target,
          {
            method: init.method ?? 'GET',
            headers: init.headers,
          },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (chunk: Buffer) => chunks.push(chunk))
            res.on('end', () => {
              const headers = new Headers()
              for (const [name, value] of Object.entries(res.headers)) {
                if (value !== undefined)
                  headers.set(name, Array.isArray(value) ? value.join(', ') : value)
              }
              resolve(
                new Response(
                  res.statusCode === 204 || init.method === 'HEAD' ? null : Buffer.concat(chunks),
                  {
                    status: res.statusCode ?? 502,
                    headers,
                  },
                ),
              )
            })
          },
        )
        req.on('error', () => reject(new Error('S3 fixture request failed')))
        req.end(init.body)
      })
    return { config, virtualConfig, deniedConfig: { ...config, ...denied }, client, request, close }
  } catch (error) {
    await close()
    throw error
  }
}

export type S3Fixture = Awaited<ReturnType<typeof startS3Fixture>>
