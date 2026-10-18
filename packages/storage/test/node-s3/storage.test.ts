import { GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createNodeStorage } from '../../src/node/index.ts'
import { type S3Fixture, startS3Fixture } from './fixture.ts'

let fixture: S3Fixture
const workspace = '019a03ac-9283-73a8-bca7-4dfbf04e6680'
const key = (name: string) => `ws/${workspace}/${name}`

beforeAll(async () => {
  fixture = await startS3Fixture()
})
afterAll(async () => {
  await fixture?.close()
})

describe.each([true, false])('real S3 forcePathStyle=%s', (forcePathStyle) => {
  it('preserves PUT→HEAD→attachment GET→idempotent DELETE and private buckets', async () => {
    const config = forcePathStyle ? fixture.config : fixture.virtualConfig
    const storage = createNodeStorage(config)
    const objectKey = key(`roundtrip-${forcePathStyle}.png`)
    const upload = await storage.presignUpload(objectKey, 'image/png')
    const url = new URL(upload.uploadUrl)
    const endpoint = new URL(config.endpoint)
    expect(url.host).toBe(forcePathStyle ? endpoint.host : `${config.bucket}.${endpoint.host}`)
    expect(url.pathname).toBe(forcePathStyle ? `/${config.bucket}/${objectKey}` : `/${objectKey}`)
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host;if-none-match')
    expect(upload.headers).toEqual({ 'Content-Type': 'image/png', 'If-None-Match': '*' })
    expect(upload.expiresIn).toBe(600)
    expect(url.searchParams.has('x-amz-checksum-crc32')).toBe(false)
    const changedMime = new URL((await storage.presignUpload(objectKey, 'image/jpeg')).uploadUrl)
    expect(changedMime.searchParams.get('X-Amz-Signature')).not.toBe(
      url.searchParams.get('X-Amz-Signature'),
    )
    expect(await storage.head(objectKey)).toBeNull()
    const put = await fixture.request(upload.uploadUrl, {
      method: 'PUT',
      headers: { ...upload.headers },
      body: 'original',
    })
    expect(put.status).toBe(200)
    expect(await storage.head(objectKey)).toEqual({ size: 8, mime: 'image/png' })
    const inline = new URL(await storage.presignDownload(objectKey))
    expect(inline.searchParams.get('X-Amz-Expires')).toBe('300')
    expect(inline.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
    expect(inline.searchParams.has('response-content-disposition')).toBe(false)
    const attachment = new URL(await storage.presignDownload(objectKey, true))
    expect(attachment.searchParams.get('response-content-disposition')).toBe('attachment')
    expect(attachment.searchParams.get('X-Amz-Signature')).not.toBe(
      inline.searchParams.get('X-Amz-Signature'),
    )
    const get = await fixture.request(attachment.href)
    expect(get.status).toBe(200)
    expect(get.headers.get('content-disposition')).toBe('attachment')
    expect(await get.text()).toBe('original')
    const anonymous = new URL(inline)
    anonymous.search = ''
    expect((await fixture.request(anonymous.href)).status).toBe(403)
    await storage.delete(objectKey)
    await storage.delete(objectKey)
    expect(await storage.head(objectKey)).toBeNull()
  })

  it('rejects replay and concurrent conditional PUT without changing original bytes', async () => {
    const storage = createNodeStorage(forcePathStyle ? fixture.config : fixture.virtualConfig)
    const objectKey = key(`concurrent-${forcePathStyle}.png`)
    const upload = await storage.presignUpload(objectKey, 'image/png')
    const responses = await Promise.all(
      ['first', 'second'].map((body) =>
        fixture.request(upload.uploadUrl, {
          method: 'PUT',
          headers: { ...upload.headers },
          body,
        }),
      ),
    )
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1)
    expect(responses.filter((response) => [409, 412].includes(response.status))).toHaveLength(1)
    const winner = responses[0]?.status === 200 ? 'first' : 'second'
    expect(
      (
        await fixture.request(upload.uploadUrl, {
          method: 'PUT',
          headers: { ...upload.headers },
          body: 'replacement',
        })
      ).status,
    ).toBe(412)
    expect(await (await fixture.request(await storage.presignDownload(objectKey))).text()).toBe(
      winner,
    )
  })
})

it('propagates denied HEAD as a safe error rather than missing', async () => {
  const storage = createNodeStorage(fixture.deniedConfig)
  const error = await storage.head(key('denied.png')).catch((error: unknown) => error)
  expect(error).toMatchObject({ code: 'STORAGE_HEAD_FAILED' })
  expect(JSON.stringify(error)).not.toContain(fixture.deniedConfig.secretAccessKey)
  expect(JSON.stringify(error)).not.toContain(fixture.deniedConfig.accessKeyId)
  expect(error).not.toHaveProperty('cause')
})

it('rejects expired signatures, tampered signatures and mismatched signed MIME', async () => {
  const storage = createNodeStorage(fixture.config)
  const objectKey = key('signature.png')
  const upload = await storage.presignUpload(objectKey, 'image/png')
  const tampered = new URL(upload.uploadUrl)
  tampered.searchParams.set('X-Amz-Signature', '0'.repeat(64))
  expect(
    (
      await fixture.request(tampered.href, {
        method: 'PUT',
        headers: { ...upload.headers },
        body: 'bad',
      })
    ).status,
  ).toBe(403)
  expect(
    (
      await fixture.request(upload.uploadUrl, {
        method: 'PUT',
        headers: { ...upload.headers, 'Content-Type': 'image/jpeg' },
        body: 'bad',
      })
    ).status,
  ).toBe(403)
  // 直接生成过去的有效签名，避免等待真实十分钟或篡改日期后仅验证签名不匹配。
  const expired = await getSignedUrl(
    fixture.client,
    new GetObjectCommand({
      Bucket: fixture.config.bucket,
      Key: objectKey,
    }),
    { expiresIn: 300, signingDate: new Date(Date.now() - 3600_000) },
  )
  expect((await fixture.request(expired)).status).toBe(403)
  expect(await storage.head(objectKey)).toBeNull()
})

it('allows deterministic media keys and rejects traversal segments for every operation', async () => {
  const storage = createNodeStorage(fixture.config)
  await expect(
    storage.presignUpload(`ws/${workspace}/ai/${workspace}/0`, 'image/png'),
  ).resolves.toMatchObject({ expiresIn: 600 })
  for (const invalid of [key('../../escape'), key('../escape'), `ws/${workspace}/./escape`]) {
    await expect(storage.presignUpload(invalid, 'image/png')).rejects.toMatchObject({
      code: 'INVALID_FILE_KEY',
    })
    await expect(storage.presignDownload(invalid)).rejects.toMatchObject({
      code: 'INVALID_FILE_KEY',
    })
    await expect(storage.head(invalid)).rejects.toMatchObject({ code: 'INVALID_FILE_KEY' })
    await expect(storage.delete(invalid)).rejects.toMatchObject({ code: 'INVALID_FILE_KEY' })
  }
})
