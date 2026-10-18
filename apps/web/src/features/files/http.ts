import type { AuthContextSource } from '@product-res/auth'
import type { Database } from '@product-res/db'
import type { Capability } from '@product-res/platform'
import { AppError, toErrorResponse } from '@product-res/shared'
import { log } from '@product-res/shared/log'
import {
  completeUpload,
  declareUpload,
  getFileDownload,
  getSharedFileDownload,
  type Storage,
} from '@product-res/storage'
import { templateConfig } from '../../server/template-config.ts'
import {
  fileInput,
  fileNotFound,
  fileWorkspaceInput,
  requireFileWorkspace,
  requireFileWrite,
  uploadInput,
} from './access.ts'
import { requireFileStorage } from './runtime.ts'

export interface FileHttpDeps {
  readonly db: Database
  readonly auth: AuthContextSource
  readonly files?: Capability<Storage>
}

async function fileResponse(action: () => Promise<Response>): Promise<Response> {
  try {
    const response = await action()
    response.headers.set('cache-control', 'no-store')
    return response
  } catch (error) {
    if (!(error instanceof AppError)) log.error('storage.request.failed', { error })
    const { status, body } = toErrorResponse(error)
    return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
  }
}

const invalidRequest = () => new AppError('INVALID_REQUEST', 'Invalid file request')
const redirectDownload = (url: string) =>
  new Response(null, { status: 302, headers: { location: url } })

export function handleFileUpload(request: Request, deps: FileHttpDeps): Promise<Response> {
  return fileResponse(async () => {
    const storage = requireFileStorage(deps)
    const parsed = uploadInput.safeParse(await request.json().catch(() => undefined))
    if (!parsed.success) throw invalidRequest()
    const input = parsed.data
    const context = await requireFileWorkspace({ ...deps, headers: request.headers, ...input })
    requireFileWrite(context)
    const result = await declareUpload(
      deps.db,
      storage,
      { ...input, userId: context.user.id },
      { pastDueGraceDays: templateConfig.billing.pastDueGraceDays },
    )
    return Response.json(result)
  })
}

export function handleFileComplete(
  request: Request,
  fileId: string,
  deps: FileHttpDeps,
): Promise<Response> {
  return fileResponse(async () => {
    const storage = requireFileStorage(deps)
    const body = await request.json().catch(() => undefined)
    const workspace = fileWorkspaceInput.safeParse(body)
    if (!workspace.success) throw invalidRequest()
    const parsed = fileInput.safeParse({ ...workspace.data, fileId })
    if (!parsed.success) throw invalidRequest()
    const input = parsed.data
    const context = await requireFileWorkspace({ ...deps, headers: request.headers, ...input })
    requireFileWrite(context)
    return Response.json(
      await completeUpload(deps.db, storage, input, {
        pastDueGraceDays: templateConfig.billing.pastDueGraceDays,
      }),
    )
  })
}

export function handleFileDownload(
  request: Request,
  fileId: string,
  deps: FileHttpDeps,
): Promise<Response> {
  return fileResponse(async () => {
    const storage = requireFileStorage(deps)
    const parsed = fileInput.safeParse({
      fileId,
      workspaceId: new URL(request.url).searchParams.get('workspaceId'),
    })
    if (!parsed.success) throw fileNotFound()
    const input = parsed.data
    await requireFileWorkspace({ ...deps, headers: request.headers, ...input })
    return redirectDownload(
      await getFileDownload(deps.db, storage, {
        ...input,
        ...(new URL(request.url).searchParams.get('download') === '1' ? { download: true } : {}),
      }),
    )
  })
}

export function handleSharedFileDownload(
  token: string,
  deps: Pick<FileHttpDeps, 'db' | 'files'>,
): Promise<Response> {
  return fileResponse(async () => {
    const storage = requireFileStorage(deps)
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw fileNotFound()
    return redirectDownload(await getSharedFileDownload(deps.db, storage, token))
  })
}
