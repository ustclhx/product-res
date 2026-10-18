import type { Database } from '@product-res/db'
import {
  cleanupFiles,
  completeUpload,
  declareUpload,
  getFileDownload,
  getSharedFileDownload,
  type MediaOutputCopier,
  persistMediaOutputs,
  type Storage,
} from '@product-res/storage'

/** 无 Workers 声明的 C 接入夹具；只验证签名，不替代真实 S3 验收。 */
export function useStorage(db: Database, storage: Storage, copyOutput: MediaOutputCopier) {
  const workspaceId = 'workspace'
  const fileId = 'file'
  const userId = 'user'
  return [
    declareUpload(db, storage, { workspaceId, userId, mime: 'image/png', size: 1 }),
    completeUpload(db, storage, { workspaceId, fileId }),
    getFileDownload(db, storage, { workspaceId, fileId }),
    getSharedFileDownload(db, storage, 'token'),
    cleanupFiles(db, storage),
    persistMediaOutputs({
      db,
      storage,
      copyOutput,
      task: { id: 'task', workspaceId, userId },
      result: { outputs: [] },
      limits: { maxFileBytes: 1, storageBytes: 1, allowedHosts: [], allowedMimeTypes: [] },
    }),
  ]
}
