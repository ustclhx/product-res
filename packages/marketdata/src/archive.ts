import type { Database } from '@product-res/db'
import { rawPayload } from '@product-res/db/schema'
import { and, eq, isNull, lt } from 'drizzle-orm'

/**
 * 原始响应存档（specs/data-sync「原始响应存档与回放」）。
 * 默认存数据库内 gzip（storage='db'）；配置对象存储后可换成对象存储实现，接口不变。
 */
export interface ArchiveInput {
  readonly sourceId: string
  readonly runId?: string
  readonly importId?: string
  readonly task: Record<string, unknown>
  /** 已去掉凭据的请求摘要 */
  readonly request: { readonly method: string; readonly url: string }
  readonly status: number
  readonly body: Uint8Array | string
  readonly contentType?: string
  readonly fetchedAt: Date
}

export interface RawArchive {
  put(input: ArchiveInput): Promise<{ id: string; sha256: string }>
  /** 读取原文；已过保留期返回 null */
  get(id: string): Promise<{ body: Uint8Array; contentType: string; sourceId: string } | null>
  /** 清理过期正文，保留元数据；返回清理条数 */
  purgeExpired(now: Date): Promise<number>
}

const bytesOf = (body: Uint8Array | string) =>
  typeof body === 'string' ? new TextEncoder().encode(body) : body

async function transform(data: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const chunks: Uint8Array[] = []
  const readable = new Blob([new Uint8Array(data)]).stream().pipeThrough(stream)
  const reader = readable.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

export const gzip = (data: Uint8Array) => transform(data, new CompressionStream('gzip'))
export const gunzip = (data: Uint8Array) => transform(data, new DecompressionStream('gzip'))

export async function sha256Hex(data: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(data)))
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 数据库存档；retentionDays 默认 90 天 */
export function createDbArchive(db: Database, retentionDays = 90): RawArchive {
  return {
    async put(input) {
      const raw = bytesOf(input.body)
      const sha256 = await sha256Hex(raw)
      const [row] = await db
        .insert(rawPayload)
        .values({
          sourceId: input.sourceId,
          runId: input.runId ?? null,
          importId: input.importId ?? null,
          task: input.task,
          request: { method: input.request.method, url: input.request.url },
          status: input.status,
          bytes: raw.byteLength,
          sha256,
          contentType: input.contentType ?? 'application/json',
          storage: 'db',
          body: await gzip(raw),
          fetchedAt: input.fetchedAt,
          expiresAt: new Date(input.fetchedAt.getTime() + retentionDays * 86_400_000),
        })
        .returning({ id: rawPayload.id })
      return { id: (row as { id: string }).id, sha256 }
    },
    async get(id) {
      const [row] = await db.select().from(rawPayload).where(eq(rawPayload.id, id))
      if (!row || row.purgedAt || !row.body) return null
      return { body: await gunzip(row.body), contentType: row.contentType, sourceId: row.sourceId }
    },
    async purgeExpired(now) {
      const rows = await db
        .update(rawPayload)
        .set({ body: null, purgedAt: now })
        .where(and(lt(rawPayload.expiresAt, now), isNull(rawPayload.purgedAt)))
        .returning({ id: rawPayload.id })
      return rows.length
    },
  }
}
