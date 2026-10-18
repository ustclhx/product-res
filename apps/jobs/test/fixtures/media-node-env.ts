import { createNodeStorage } from '@product-res/storage/node'
import { afterAll } from 'vitest'
import { startMediaS3Fixture } from './media-s3.ts'

// 同一组业务用例只替换目标夹具；字节写入真实本地 S3，不加载 Workers runtime。
const fixture = await startMediaS3Fixture()
export const mediaStorageConfig = fixture.config
const storage = createNodeStorage(fixture.config)
export const env = {
  HYPERDRIVE: process.env.TEST_JOB_DATABASE_URL as string,
  HYPERDRIVE_MIGRATOR: process.env.MIGRATION_DATABASE_URL as string,
  FILES: {
    async delete(key: string) {
      await storage.delete(key)
    },
    async head(key: string) {
      const object = await storage.head(key)
      return object ? { size: object.size, httpMetadata: { contentType: object.mime } } : null
    },
    async get(key: string) {
      const object = await storage.head(key)
      return object ? { size: object.size } : null
    },
  },
}
afterAll(() => fixture.close())
