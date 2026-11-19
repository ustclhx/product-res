import type { ShareCardObjects } from '../share-cards.ts'

export function createCloudflareShareCardObjects(bucket: R2Bucket): ShareCardObjects {
  return {
    async list(input) {
      const page = await bucket.list(input)
      return {
        keys: page.objects.map((object) => object.key),
        ...(page.truncated ? { cursor: page.cursor } : {}),
      }
    },
    async get(key) {
      const object = await bucket.get(key)
      if (!object) return null
      return {
        body: new Uint8Array(await object.arrayBuffer()),
        metadata: object.customMetadata ?? {},
      }
    },
    async put(key, body, options = {}) {
      await bucket.put(key, body, {
        ...(options.contentType ? { httpMetadata: { contentType: options.contentType } } : {}),
        ...(options.metadata ? { customMetadata: options.metadata } : {}),
      })
    },
    delete: (key) => bucket.delete(key),
  }
}
