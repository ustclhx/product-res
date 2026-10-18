import { createNodeMediaCopier, createNodeStorage } from '@product-res/storage/node'
import { mediaStorageConfig } from './media-node-env.ts'

// 旧用例的目标工厂名保持不变；这里只把同一安全转存契约交给 Node adapter。
export function createCloudflareStorage() {
  return createNodeStorage(mediaStorageConfig)
}
export function createCloudflareMediaCopier(_binding: unknown, options: { fetch: typeof fetch }) {
  return createNodeMediaCopier(mediaStorageConfig, options)
}
