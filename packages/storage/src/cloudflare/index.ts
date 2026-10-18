import type { Storage } from '../storage.ts'
import { presignDownload, presignUpload, type StorageEnv } from './presign.ts'

export { createCloudflareMediaCopier } from './media.ts'
export * from './presign.ts'

/** 保留 binding receiver，仅将对象元数据转换为业务需要的字段。 */
export function createCloudflareStorage(env: StorageEnv): Storage {
  return {
    async head(key) {
      const object = await env.FILES.head(key)
      return object ? { size: object.size, mime: object.httpMetadata?.contentType ?? null } : null
    },
    delete: (key) => env.FILES.delete(key),
    presignUpload: (key, mime) => presignUpload(env, key, mime),
    presignDownload: (key, attachment) => presignDownload(env, key, attachment),
  }
}
