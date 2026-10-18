import {
  completeUpload,
  createFileShare,
  declareUpload,
  getStorageUsage,
  revokeFileShare,
} from '@product-res/storage'
import { createServerFn } from '@tanstack/react-start'
import { templateConfig } from '../../server/template-config.ts'
import { fileInput, fileWorkspaceInput, requireFileWrite, uploadInput } from './access.ts'
import { withFileWorkspace } from './middleware.ts'

export const declareFileUpload = createServerFn({ method: 'POST' })
  .middleware([withFileWorkspace])
  .inputValidator(uploadInput)
  .handler(({ context, data }) => {
    requireFileWrite(context)
    return declareUpload(
      context.db,
      context.storage,
      { ...data, workspaceId: context.workspace.id, userId: context.user.id },
      { pastDueGraceDays: templateConfig.billing.pastDueGraceDays },
    )
  })

export const completeFileUpload = createServerFn({ method: 'POST' })
  .middleware([withFileWorkspace])
  .inputValidator(fileInput)
  .handler(({ context, data }) => {
    requireFileWrite(context)
    return completeUpload(
      context.db,
      context.storage,
      { workspaceId: context.workspace.id, fileId: data.fileId },
      { pastDueGraceDays: templateConfig.billing.pastDueGraceDays },
    )
  })

export const getFileStorageUsage = createServerFn({ method: 'GET' })
  .middleware([withFileWorkspace])
  .inputValidator(fileWorkspaceInput)
  .handler(({ context }) => getStorageUsage(context.db, context.workspace.id))

export const createFileShareToken = createServerFn({ method: 'POST' })
  .middleware([withFileWorkspace])
  .inputValidator(fileInput)
  .handler(async ({ context, data }) => {
    requireFileWrite(context)
    const token = await createFileShare(context.db, {
      workspaceId: context.workspace.id,
      userId: context.user.id,
      fileId: data.fileId,
    })
    return { token, path: `/api/files/shared/${encodeURIComponent(token)}` }
  })

export const revokeFileShareToken = createServerFn({ method: 'POST' })
  .middleware([withFileWorkspace])
  .inputValidator(fileInput)
  .handler(async ({ context, data }) => {
    requireFileWrite(context)
    await revokeFileShare(context.db, {
      workspaceId: context.workspace.id,
      userId: context.user.id,
      fileId: data.fileId,
    })
    return { revoked: true }
  })
