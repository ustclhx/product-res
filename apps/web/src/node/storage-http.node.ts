import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { createAuth } from '@product-res/auth'
import { defineTemplateConfig } from '@product-res/config'
import { createDb, file, scoped } from '@product-res/db'
import { AppError, newId } from '@product-res/shared'
import {
  cleanupFiles,
  completeUpload,
  createFileShare,
  getStorageUsage,
  revokeFileShare,
} from '@product-res/storage'
import { createNodeStorage } from '@product-res/storage/node'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

const databaseUrl = process.env.NODE_STORAGE_DATABASE_URL
if (!databaseUrl) throw new Error('Missing isolated storage database')
const db = createDb(databaseUrl, { max: 3 })
const sql = db.$client
const storage = createNodeStorage({
  endpoint: process.env.S3_ENDPOINT as string,
  region: process.env.S3_REGION as string,
  bucket: process.env.S3_BUCKET as string,
  accessKeyId: process.env.S3_ACCESS_KEY_ID as string,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY as string,
  forcePathStyle: true,
})
const secret = Array.from(randomBytes(32), (byte) => byte.toString(16).padStart(2, '0')).join('')
const appUrl = 'https://product.ezarouter.cc'
let base: string
let child: ChildProcess | undefined
let childExit: Promise<unknown[]> | undefined
let productionEnv: NodeJS.ProcessEnv
const identities: { id: string; cookie: string; slug: string }[] = []
const headers = (cookie: string) => ({ cookie, origin: appUrl, 'content-type': 'application/json' })
const post = (path: string, body: unknown, cookie = identities[0]?.cookie ?? '') =>
  fetch(`${base}${path}`, { method: 'POST', headers: headers(cookie), body: JSON.stringify(body) })

beforeAll(async () => {
  const auth = createAuth({ APP_URL: appUrl, BETTER_AUTH_SECRET: secret }, db, {
    config: defineTemplateConfig({
      app: { name: 'Storage fixture', url: appUrl, supportEmail: 'hxl15380@gmail.com' },
      auth: { oauth: [], turnstile: false },
    }),
    sendEmail: async () => {},
  })
  for (let index = 0; index < 2; index++) {
    const signed = await auth.handler(
      new Request(`${appUrl}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { origin: appUrl, 'content-type': 'application/json' },
        body: JSON.stringify({
          email: `${newId()}@storage-fixture.example`,
          password: 'correct-horse-battery-staple',
          name: 'Storage fixture',
        }),
      }),
    )
    expect(signed.status).toBe(200)
    const id = ((await signed.json()) as { user: { id: string } }).user.id
    const [workspace] = await sql<
      { slug: string }[]
    >`select slug from organization where id = ${id}`
    if (!workspace) throw new Error('Missing storage fixture workspace')
    identities.push({
      id,
      slug: workspace.slug,
      cookie: signed.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; '),
    })
  }
  await vi.waitFor(
    async () => expect(await storage.head(`ws/${identities[0]?.id}/probe`)).toBeNull(),
    { timeout: 15_000 },
  )
  const probe = createServer().listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  base = `http://127.0.0.1:${port}`
  productionEnv = {
    PATH: process.env.PATH,
    DATABASE_URL: databaseUrl,
    VALKEY_URL: process.env.TEST_VALKEY_URL,
    BETTER_AUTH_SECRET: secret,
    APP_URL: appUrl,
    GOOGLE_CLIENT_ID: 'fixture',
    GOOGLE_CLIENT_SECRET: 'fixture',
    GITHUB_CLIENT_ID: 'fixture',
    GITHUB_CLIENT_SECRET: 'fixture',
    TURNSTILE_SITE_KEY: 'fixture',
    TURNSTILE_SECRET_KEY: 'fixture',
    S3_ENDPOINT: process.env.S3_ENDPOINT,
    S3_REGION: process.env.S3_REGION,
    S3_BUCKET: process.env.S3_BUCKET,
    S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
    CACHE_NAMESPACE: `storage-${newId()}`,
    HOST: '127.0.0.1',
    PORT: String(port),
    SHUTDOWN_TIMEOUT_MS: '5000',
  }
  child = spawn(process.execPath, ['.output/server/index.mjs'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: productionEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // 不打印 SDK/认证原始输出，防止测试失败时泄漏随机密钥或签名链接。
  child.stdout?.resume()
  child.stderr?.resume()
  childExit = once(child, 'exit')
  await vi.waitFor(
    async () => {
      if (child?.exitCode !== null) throw new Error('Storage fixture web exited before listen')
      expect(
        await fetch(`${base}/internal/live`).then(
          (res) => res.status,
          () => 0,
        ),
      ).toBe(200)
    },
    { timeout: 15_000 },
  )
})

afterAll(async () => {
  if (child?.exitCode === null) {
    child.kill('SIGTERM')
    await childExit
  }
  // 数据库与对象只属于 runner 的临时容器，runner 负责整体销毁。
  await db.close()
})

async function upload(size: number, actualSize = size) {
  const workspaceId = identities[0]?.id as string
  const response = await post('/api/files/uploads', { workspaceId, mime: 'image/png', size })
  expect(response.status).toBe(200)
  const value = (await response.json()) as {
    fileId: string
    uploadUrl: string
    headers: Record<string, string>
    expiresIn: number
  }
  expect(value.expiresIn).toBe(600)
  expect(value.headers).toMatchObject({ 'Content-Type': 'image/png', 'If-None-Match': '*' })
  const put = await fetch(value.uploadUrl, {
    method: 'PUT',
    headers: value.headers,
    body: new Uint8Array(actualSize),
  })
  expect(put.ok).toBe(true)
  return value.fileId
}
const confirm = (fileId: string) =>
  post(`/api/files/${fileId}/complete`, { workspaceId: identities[0]?.id })
const download = (
  fileId: string,
  cookie = identities[0]?.cookie,
  workspaceId = identities[0]?.id,
) =>
  fetch(`${base}/api/files/${fileId}?workspaceId=${workspaceId}&download=1`, {
    headers: { cookie: cookie ?? '' },
    redirect: 'manual',
  })

it('serves real HTTP declaration, conditional PUT, confirmation and attachment download', async () => {
  for (const path of ['/server/index.mjs.map', '/index.mjs.map'])
    expect((await fetch(`${base}${path}`)).status).toBe(404)
  const fileId = await upload(3)
  expect((await confirm(fileId)).status).toBe(200)
  const response = await download(fileId)
  expect(response.status).toBe(302)
  expect(response.headers.get('cache-control')).toBe('no-store')
  const target = response.headers.get('location')
  if (!target) throw new Error('Missing file download redirect')
  const object = await fetch(target)
  expect(object.status).toBe(200)
  expect(object.headers.get('content-disposition')).toContain('attachment')
  expect(new Uint8Array(await object.arrayBuffer())).toEqual(new Uint8Array(3))
  expect(await getStorageUsage(db, identities[0]?.id as string)).toBe(3)
  expect((await confirm(fileId)).status).toBe(200)
  expect(await getStorageUsage(db, identities[0]?.id as string)).toBe(3)
})

it('rejects actual-size mismatch and preserves a cleanup anchor when deletion fails', async () => {
  const fileId = await upload(1, 2)
  const response = await confirm(fileId)
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: { code: 'UPLOAD_MISMATCH' } })
  const workspaceId = identities[0]?.id as string
  const row = await scoped(db, workspaceId).findById(file, fileId)
  expect(row.deletedAt).not.toBeNull()
  expect(await storage.head(row.r2Key)).toBeNull()
  expect((await download(fileId)).status).toBe(404)

  const failedId = await upload(1, 2)
  const failing = {
    ...storage,
    delete: async () => {
      throw new AppError('STORAGE_DELETE_FAILED', 'Storage delete failed')
    },
  }
  await expect(
    completeUpload(db, failing, { workspaceId, fileId: failedId }),
  ).rejects.toMatchObject({ code: 'STORAGE_DELETE_FAILED' })
  const anchor = await scoped(db, workspaceId).findById(file, failedId)
  expect(anchor.status).toBe('pending')
  expect(anchor.deletedAt).not.toBeNull()
  expect(await storage.head(anchor.r2Key)).toMatchObject({ size: 2 })
  await scoped(db, workspaceId).updateById(file, failedId, {
    createdAt: new Date(Date.now() - 7_200_000),
  })
  expect(await cleanupFiles(db, failing)).toMatchObject({ failed: 1 })
  expect((await scoped(db, workspaceId).findById(file, failedId)).deletedAt).not.toBeNull()
  expect(await cleanupFiles(db, storage)).toMatchObject({ deleted: 1, failed: 0 })
  expect(await storage.head(anchor.r2Key)).toBeNull()
})

it('serializes concurrent confirmations at the remaining quota', async () => {
  const workspaceId = identities[0]?.id as string
  const quotaId = newId()
  // 大额已用量是数据库夹具；真实 S3 的两个三字节对象测试空间锁竞争。
  await scoped(db, workspaceId).insert(file, {
    id: quotaId,
    userId: workspaceId,
    purpose: 'upload',
    status: 'ready',
    r2Key: `ws/${workspaceId}/${quotaId}`,
    mime: 'image/png',
    size: 5 * 1024 ** 3 - 6,
  })
  try {
    const files = [await upload(3), await upload(3)]
    const responses = await Promise.all(files.map(confirm))
    expect(responses.map((response) => response.status).sort()).toEqual([200, 403])
    expect(await getStorageUsage(db, workspaceId)).toBe(5 * 1024 ** 3)
  } finally {
    await sql`delete from file where id = ${quotaId}`
  }
})

it('preserves the S3 HEAD failure code and 502 across the Nitro/SSR resource boundary', async () => {
  const fileId = await upload(1)
  const probe = createServer().listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  const failingBase = `http://127.0.0.1:${port}`
  const failing = spawn(process.execPath, ['.output/server/index.mjs'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: {
      ...productionEnv,
      PORT: String(port),
      S3_SECRET_ACCESS_KEY: 'invalid-fixture-signature',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  failing.stdout?.resume()
  failing.stderr?.resume()
  const exit = once(failing, 'exit')
  try {
    await vi.waitFor(async () =>
      expect(
        await fetch(`${failingBase}/internal/live`).then(
          (res) => res.status,
          () => 0,
        ),
      ).toBe(200),
    )
    const response = await fetch(`${failingBase}/api/files/${fileId}/complete`, {
      method: 'POST',
      headers: headers(identities[0]?.cookie ?? ''),
      body: JSON.stringify({ workspaceId: identities[0]?.id }),
    })
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: { code: 'STORAGE_HEAD_FAILED' } })
    expect(await scoped(db, identities[0]?.id as string).findById(file, fileId)).toMatchObject({
      status: 'pending',
      deletedAt: null,
    })
  } finally {
    if (failing.exitCode === null) {
      failing.kill('SIGTERM')
      await exit
    }
  }
})

it('checks tenant membership, session validity and share revocation before signing', async () => {
  const fileId = await upload(2)
  expect((await confirm(fileId)).status).toBe(200)
  expect((await download(fileId, identities[1]?.cookie)).status).toBe(404)
  expect((await download(fileId, identities[1]?.cookie, identities[1]?.id)).status).toBe(404)
  const input = {
    workspaceId: identities[0]?.id as string,
    userId: identities[0]?.id as string,
    fileId,
  }
  const token = await createFileShare(db, input)
  const shared = () => fetch(`${base}/api/files/shared/${token}`, { redirect: 'manual' })
  expect((await shared()).status).toBe(302)
  await revokeFileShare(db, input)
  expect((await shared()).status).toBe(404)
  const signOut = await post('/api/auth/sign-out', {})
  expect(signOut.status).toBe(200)
  expect((await download(fileId)).status).toBe(404)
})

it('keeps storage-only media unavailable without creating tasks or credit holds', async () => {
  const counts = () =>
    sql`select (select count(*) from ai_task) as tasks, (select count(*) from credit_hold) as holds`
  const before = await counts()
  const response = await post(
    '/api/ai/tasks',
    { workspaceId: identities[1]?.id, modelKey: 'fixture-unavailable', params: {} },
    identities[1]?.cookie,
  )
  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ error: { code: 'CAPABILITY_UNAVAILABLE' } })
  expect(await counts()).toEqual(before)
})
