import type { MediaResult } from '@product-res/ai'
import {
  defineTemplateConfig,
  MEDIA_MAX_FILE_BYTES,
  MEDIA_OUTPUT_MIME_TYPES,
} from '@product-res/config'
import type { AiTask, Database } from '@product-res/db'
import type { WorkflowStep } from '@product-res/platform'
import { getLogContext, withLogContext } from '@product-res/shared/log'
import { beforeEach, expect, it, vi } from 'vitest'
import {
  createNodeMediaHandler,
  createNodeMediaRunnerDeps,
  type NodeMediaWorkflowOptions,
} from '../src/node/media.ts'

const mocks = vi.hoisted(() => ({
  storage: { delete: vi.fn(), head: vi.fn(), presignUpload: vi.fn(), presignDownload: vi.fn() },
  copier: vi.fn(),
  createStorage: vi.fn(),
  createCopier: vi.fn(),
  provider: vi.fn(),
  download: vi.fn(),
  entitlements: vi.fn(),
  persist: vi.fn(),
  runner: vi.fn(),
}))
vi.mock('@product-res/ai', async (original) => ({
  ...(await original<typeof import('@product-res/ai')>()),
  createTaskMediaProvider: mocks.provider,
}))
vi.mock('@product-res/storage/node', () => ({
  createNodeStorage: mocks.createStorage,
  createNodeMediaCopier: mocks.createCopier,
}))
vi.mock('@product-res/storage', () => ({
  getFileDownload: mocks.download,
  persistMediaOutputs: mocks.persist,
}))
vi.mock('@product-res/entitlements', () => ({ getEntitlements: mocks.entitlements }))
vi.mock('../src/workflows/media-runner.ts', () => ({ runMediaTask: mocks.runner }))

const db = {} as Database
const task = {
  id: 'task-media',
  workspaceId: 'workspace-media',
  kind: 'image',
  provider: 'fal',
  input: {
    params: { prompt: 'fixture', image_url: 'file-owned' },
    providerModelId: 'fal-fixture',
    unitsLimit: 1,
    fileParams: ['image_url'],
    storageBytes: 3 * 1024 ** 3,
  },
} as unknown as AiTask
const template = defineTemplateConfig({
  app: { name: 'fixture', url: 'https://example.test', supportEmail: 'support@example.test' },
  ai: { mediaProviders: ['fal'] },
  billing: { pastDueGraceDays: 4 },
})
const options: NodeMediaWorkflowOptions = {
  storage: {
    endpoint: 'https://s3.example.test',
    region: 'auto',
    bucket: 'media',
    forcePathStyle: true,
    accessKeyId: 'fixture',
    secretAccessKey: 'fixture',
  },
  providerEnv: { FAL_KEY: 'fixture' },
  callbackOrigin: 'https://example.test',
  callbackSecret: 'fixture',
  template,
}
const result: MediaResult = { outputs: [{ url: 'https://fal.media/output', mime: 'image/png' }] }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.createStorage.mockReturnValue(mocks.storage)
  mocks.createCopier.mockReturnValue(mocks.copier)
  mocks.download.mockResolvedValue('https://s3.example.test/signed')
  mocks.entitlements.mockResolvedValue({ features: { storageGb: 2 } })
  mocks.persist.mockResolvedValue([])
})

it('resolves tenant file parameters without mutating the task snapshot and keeps provider allowlist', async () => {
  const deps = createNodeMediaRunnerDeps(db, options)
  expect(await deps.params(task)).toEqual({
    prompt: 'fixture',
    image_url: 'https://s3.example.test/signed',
  })
  expect(task.input.params).toEqual({ prompt: 'fixture', image_url: 'file-owned' })
  expect(mocks.download).toHaveBeenCalledExactlyOnceWith(db, mocks.storage, {
    workspaceId: task.workspaceId,
    fileId: 'file-owned',
  })
  deps.provider(task)
  expect(mocks.provider).toHaveBeenCalledExactlyOnceWith(options.providerEnv, task, ['fal'])
  expect(deps).not.toHaveProperty('faultEnv')
})

it('uses Node storage with the smaller snapshot/current quota and existing media security limits', async () => {
  const deps = createNodeMediaRunnerDeps(db, options)
  await deps.persist(task, result)
  expect(mocks.createStorage).toHaveBeenCalledExactlyOnceWith(options.storage)
  expect(mocks.createCopier).toHaveBeenCalledExactlyOnceWith(options.storage)
  expect(mocks.entitlements).toHaveBeenCalledWith(db, task.workspaceId, { pastDueGraceDays: 4 })
  expect(mocks.persist).toHaveBeenCalledWith({
    db,
    storage: mocks.storage,
    copyOutput: mocks.copier,
    task,
    result,
    limits: {
      maxFileBytes: MEDIA_MAX_FILE_BYTES,
      allowedHosts: ['fal.media', 'v3.fal.media', 'v3b.fal.media'],
      allowedMimeTypes: MEDIA_OUTPUT_MIME_TYPES.image,
      storageBytes: 2 * 1024 ** 3,
    },
  })
  mocks.entitlements.mockResolvedValueOnce({ features: { storageGb: 5 } })
  await deps.persist(task, result)
  expect(mocks.persist.mock.lastCall?.[0].limits.storageBytes).toBe(task.input.storageBytes)
})

it('isolates task/request identity while observing runner failures', async () => {
  const scope = vi.fn()
  const observer = {
    tagContext: vi.fn(),
    captureException: vi.fn(),
    run<T>(handle: () => T): T {
      scope()
      return handle()
    },
  }
  const handler = createNodeMediaHandler(db, { ...options, observer })
  const step = {} as WorkflowStep
  const error = new Error('fixture failure')
  mocks.runner.mockImplementationOnce(async (taskId, receivedStep, deps) => {
    expect(getLogContext()).toMatchObject({ taskId: 'task-media', requestId: 'media-request' })
    expect(taskId).toBe('task-media')
    expect(receivedStep).toBe(step)
    expect(deps.db).toBe(db)
    expect(deps.observer).toBe(observer)
    throw error
  })
  await withLogContext({ requestId: 'parent-request' }, async () => {
    await expect(handler({ taskId: 'task-media', requestId: 'media-request' }, step)).rejects.toBe(
      error,
    )
    expect(getLogContext()).toMatchObject({ requestId: 'parent-request' })
    expect(getLogContext()).not.toHaveProperty('taskId')
  })
  expect(scope).toHaveBeenCalledOnce()
  expect(observer.tagContext).toHaveBeenCalledOnce()
  expect(observer.captureException).toHaveBeenCalledExactlyOnceWith(error)
})
