import type { Database } from '@product-res/db'
import { AppError } from '@product-res/shared'
import type { Storage } from '@product-res/storage'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  freshSession: vi.fn(),
  membership: vi.fn(),
  download: vi.fn(),
  sharedDownload: vi.fn(),
  declare: vi.fn(),
  complete: vi.fn(),
}))
vi.mock('@product-res/auth', () => ({ requireFreshSession: mocks.freshSession }))
vi.mock('@product-res/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@product-res/db')>()),
  scoped: () => ({ select: () => ({ limit: mocks.membership }) }),
}))
vi.mock('@product-res/storage', () => ({
  getFileDownload: mocks.download,
  getSharedFileDownload: mocks.sharedDownload,
  declareUpload: mocks.declare,
  completeUpload: mocks.complete,
}))

import {
  handleFileComplete,
  handleFileDownload,
  handleFileUpload,
  handleSharedFileDownload,
} from './http.ts'

const workspaceId = '019bb460-a610-7000-8000-000000000001'
const fileId = '019bb460-a610-7000-8000-000000000002'
const userId = '019bb460-a610-7000-8000-000000000003'
const findWorkspace = vi.fn()
const deps = {
  db: { query: { organization: { findFirst: findWorkspace } } } as unknown as Database,
  auth: {
    $context: Promise.resolve({ secret: 'fixture', authCookies: { sessionToken: { name: 's' } } }),
  },
  files: { available: true as const, value: {} as Storage },
}
const downloadUrl = 'https://files.example.test/signed-download'
const request = () =>
  new Request(`https://example.test/api/files/${fileId}?workspaceId=${workspaceId}`)
const post = (body: unknown) =>
  new Request('https://example.test/api/files/uploads', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.freshSession.mockResolvedValue({ user: { id: userId }, session: {} })
  findWorkspace.mockResolvedValue({ id: workspaceId, isPersonal: true, deletedAt: null })
  mocks.membership.mockResolvedValue([{ userId }])
  mocks.download.mockResolvedValue(downloadUrl)
  mocks.sharedDownload.mockResolvedValue(downloadUrl)
})

it('hides downloads from removed members without issuing a signed URL', async () => {
  mocks.membership.mockResolvedValue([])
  const response = await handleFileDownload(request(), fileId, deps)
  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found' } })
  expect(mocks.download).not.toHaveBeenCalled()
})

it('returns the same 404 for revoked sessions without reading the workspace', async () => {
  mocks.freshSession.mockRejectedValue(
    new AppError('SESSION_REQUIRED', 'Sign in required', { status: 401 }),
  )
  const response = await handleFileDownload(request(), fileId, deps)
  expect(response.status).toBe(404)
  expect(findWorkspace).not.toHaveBeenCalled()
  expect(mocks.download).not.toHaveBeenCalled()
})

it('hides files from soft deleted spaces even when membership remains', async () => {
  findWorkspace.mockResolvedValue({ id: workspaceId, isPersonal: true, deletedAt: new Date() })
  expect((await handleFileDownload(request(), fileId, deps)).status).toBe(404)
  expect(mocks.download).not.toHaveBeenCalled()
})

it('redirects current members to the signed URL without caching authorization', async () => {
  const response = await handleFileDownload(request(), fileId, deps)
  expect(response.status).toBe(302)
  expect(response.headers.get('location')).toBe(downloadUrl)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(mocks.download).toHaveBeenCalledWith(deps.db, deps.files.value, { workspaceId, fileId })
})

it('requests an attachment signature for explicit downloads after checking membership', async () => {
  const response = await handleFileDownload(
    new Request(`${request().url}&download=1`),
    fileId,
    deps,
  )
  expect(response.status).toBe(302)
  expect(mocks.download).toHaveBeenCalledWith(deps.db, deps.files.value, {
    workspaceId,
    fileId,
    download: true,
  })
})

it('reads public shares on every request and returns 404 as soon as storage reports revocation', async () => {
  const token = '019bb460-a610-7000-8000-000000000004'
  const first = await handleSharedFileDownload(token, deps)
  expect(first.status).toBe(302)
  expect(first.headers.get('cache-control')).toBe('no-store')
  mocks.sharedDownload.mockRejectedValueOnce(
    new AppError('NOT_FOUND', 'Not found', { status: 404 }),
  )
  const revoked = await handleSharedFileDownload(token, deps)
  expect(revoked.status).toBe(404)
  expect(revoked.headers.get('cache-control')).toBe('no-store')
  expect(mocks.sharedDownload).toHaveBeenCalledTimes(2)
  expect(mocks.freshSession).not.toHaveBeenCalled()
})

it('returns upload headers unchanged so clients preserve the signed conditional PUT', async () => {
  const declaration = {
    fileId,
    uploadUrl: 'https://files.example.test/upload',
    headers: { 'Content-Type': 'image/png', 'If-None-Match': '*' },
    expiresIn: 600,
  }
  mocks.declare.mockResolvedValueOnce(declaration)
  const response = await handleFileUpload(
    post({ workspaceId, mime: 'image/png', size: 1024 }),
    deps,
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(declaration)
  expect(mocks.declare.mock.calls[0]?.[2]).toEqual({
    workspaceId,
    userId,
    mime: 'image/png',
    size: 1024,
  })
})

it('preserves confirmation failures after storage rejects the real object size', async () => {
  mocks.complete.mockRejectedValueOnce(
    new AppError('UPLOAD_MISMATCH', 'Upload does not match declaration'),
  )
  const response = await handleFileComplete(post({ workspaceId }), fileId, deps)
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    error: { code: 'UPLOAD_MISMATCH', message: 'Upload does not match declaration' },
  })
})

it('refuses unavailable Node file operations before reading auth or database or writing files', async () => {
  const unavailable = {
    files: { available: false as const },
    get db(): Database {
      throw new Error('Database must not be accessed')
    },
    get auth(): never {
      throw new Error('Auth must not be accessed')
    },
  }
  const responses = await Promise.all([
    handleFileUpload(post({ workspaceId, mime: 'image/png', size: 1024 }), unavailable),
    handleFileComplete(post({ workspaceId }), fileId, unavailable),
    handleFileDownload(request(), fileId, unavailable),
    handleSharedFileDownload('019bb460-a610-7000-8000-000000000004', unavailable),
  ])
  for (const response of responses) {
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: 'CAPABILITY_UNAVAILABLE' } })
  }
  expect(mocks.freshSession).not.toHaveBeenCalled()
  expect(mocks.declare).not.toHaveBeenCalled()
  expect(mocks.complete).not.toHaveBeenCalled()
  expect(mocks.download).not.toHaveBeenCalled()
  expect(mocks.sharedDownload).not.toHaveBeenCalled()
})
