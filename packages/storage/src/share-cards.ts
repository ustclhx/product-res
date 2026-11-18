import type { KeyValueStore } from '@product-res/platform'
import { AppError } from '@product-res/shared'
import { log } from '@product-res/shared/log'

export interface ShareCardObject {
  readonly body: Uint8Array
  readonly metadata: Readonly<Record<string, string>>
}

/** 分享卡片只需要按键读写、按前缀分页与删除，不向业务层暴露目标 SDK。 */
export interface ShareCardObjects {
  list(input: { prefix: string; cursor?: string; limit?: number }): Promise<{
    keys: readonly string[]
    cursor?: string
  }>
  get(key: string): Promise<ShareCardObject | null>
  put(
    key: string,
    body: Uint8Array,
    options?: { contentType?: string; metadata?: Record<string, string> },
  ): Promise<void>
  delete(key: string): Promise<void>
}
export interface ShareCardIdentity {
  readonly type: string
  readonly token: string
  readonly workspaceId: string
}
export const SHARE_CARD_REVOCATION_TTL = 86_400
const segment = (value: string) => {
  // 类型可声明自己的令牌格式；这里只保护对象路径边界，不强制默认 base64url 字符集。
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 对象键的信任边界需要拒绝控制字符。
  if (!value || value === '.' || value === '..' || /[/\\\u0000-\u001f\u007f]/.test(value))
    throw new AppError('INVALID_SHARE_CARD_KEY', 'Invalid share card key')
  return value
}
export const shareCardImagePrefix = (type: string, token: string) =>
  `share-cards/img/${segment(type)}/${segment(token)}/`
export const shareCardWorkspacePrefix = (workspaceId: string) =>
  `share-cards/ws/${segment(workspaceId)}/`
export const shareCardWorkspaceKey = ({ type, token, workspaceId }: ShareCardIdentity) =>
  `${shareCardWorkspacePrefix(workspaceId)}${segment(type)}/${segment(token)}`
/** 图片键的最后一段是卡片地址的 `v`（版式版本与摘要前 8 位），编码后作为文件名。 */
export const shareCardImageKey = (type: string, token: string, variant: string) =>
  `${shareCardImagePrefix(type, token)}${segment(encodeURIComponent(variant))}.png`
/**
 * R2 撤销墓碑：对象存储读写强一致，渲染后的撤销复查读它而不是 KV（KV 读取默认缓存 60 秒）。
 * 墓碑永不删除：令牌不复用，残留的空对象成本可以忽略，删除反而会重新打开与渲染并发的窗口。
 */
export const shareCardTombstoneKey = (type: string, token: string) =>
  `share-cards/revoked/${segment(type)}/${segment(token)}`
export const shareCardRevokedKey = (type: string, token: string) =>
  `share-revoked:${segment(type)}:${segment(token)}`

export function createShareCardInvalidator(
  objects: ShareCardObjects,
  kv: Pick<KeyValueStore, 'put'>,
) {
  async function invalidateShareCard(input: ShareCardIdentity) {
    const prefix = shareCardImagePrefix(input.type, input.token)
    const index = shareCardWorkspaceKey(input)
    // 先阻止缓存读取；删除失败时保留索引，让空间清理可以重试。
    await kv.put(shareCardRevokedKey(input.type, input.token), '1', {
      expirationTtl: SHARE_CARD_REVOCATION_TTL,
    })
    // 强一致的墓碑先于删除写入：与之并发的渲染在写入前后复查它，不会留下孤儿卡片。
    await objects.put(shareCardTombstoneKey(input.type, input.token), new Uint8Array())
    let cursor: string | undefined
    do {
      const page = await objects.list({ prefix, ...(cursor ? { cursor } : {}) })
      for (const key of page.keys) await objects.delete(key)
      cursor = page.cursor
    } while (cursor)
    await objects.delete(index)
  }
  async function cleanupWorkspaceShareCards(
    workspaceId: string,
    { maxIndexes = Number.POSITIVE_INFINITY }: { maxIndexes?: number } = {},
  ) {
    const prefix = shareCardWorkspacePrefix(workspaceId)
    let cursor: string | undefined
    let invalidated = 0
    let processed = 0
    do {
      const page = await objects.list({
        prefix,
        ...(cursor ? { cursor } : {}),
        ...(Number.isFinite(maxIndexes) ? { limit: maxIndexes - processed } : {}),
      })
      for (const key of page.keys) {
        const [type = '', token = '', extra] = key.slice(prefix.length).split('/')
        if (processed >= maxIndexes) return { invalidated, complete: false }
        processed++
        let valid =
          key.startsWith(prefix) &&
          /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(type) &&
          !!token &&
          extra === undefined
        if (valid) {
          try {
            segment(type)
            segment(token)
          } catch {
            valid = false
          }
        }
        if (!valid) {
          log.warn('share-cards.invalid-workspace-index', { workspaceId })
          await objects.delete(key)
          continue
        }
        await invalidateShareCard({ type, token, workspaceId })
        invalidated++
      }
      cursor = page.cursor
      if (processed >= maxIndexes && cursor) return { invalidated, complete: false }
    } while (cursor)
    return { invalidated, complete: true }
  }
  return { invalidateShareCard, cleanupWorkspaceShareCards }
}

/** 元数据键使用小写短横线：S3 兼容存储会把用户元数据键转为小写。 */
const EXPIRES_AT = 'expires-at'
const WORKSPACE_ID = 'workspace-id'
const NEVER = 'never'

export interface ShareCardImageRef {
  readonly type: string
  readonly token: string
  readonly variant: string
}

export type ShareCardImageRead =
  | { readonly status: 'hit'; readonly body: Uint8Array; readonly expiresAt: Date | null }
  | { readonly status: 'miss' | 'expired' }

/**
 * 卡片图片的持久存储（design 第 3 条）：图片元数据记录到期时间与所属空间，命中时据此判断到期，
 * 不调用项目解析；已到期的图片当场删除。写入时同时写空间索引，供删空间时按前缀清理。
 */
export function createShareCardImageStore(objects: ShareCardObjects) {
  async function read(ref: ShareCardImageRef, now = new Date()): Promise<ShareCardImageRead> {
    const key = shareCardImageKey(ref.type, ref.token, ref.variant)
    const object = await objects.get(key)
    if (!object) return { status: 'miss' }
    const raw = object.metadata[EXPIRES_AT]
    const expiresAt = raw === NEVER ? null : new Date(raw ?? '')
    // 元数据缺失或无法解析时按已到期处理，不能意外变为永久有效。
    if (expiresAt !== null && !(expiresAt.getTime() > now.getTime())) {
      await objects.delete(key)
      return { status: 'expired' }
    }
    return { status: 'hit', body: object.body, expiresAt }
  }
  async function write(
    ref: ShareCardImageRef & { readonly workspaceId: string },
    body: Uint8Array,
    expiresAt: Date | null,
  ) {
    const index = shareCardWorkspaceKey(ref)
    // 先写索引：图片写入后进程中断时，空间清理仍能找到这张卡片。
    await objects.put(index, new Uint8Array())
    await objects.put(shareCardImageKey(ref.type, ref.token, ref.variant), body, {
      contentType: 'image/png',
      metadata: {
        [EXPIRES_AT]: expiresAt === null ? NEVER : expiresAt.toISOString(),
        [WORKSPACE_ID]: ref.workspaceId,
      },
    })
  }
  /** 是否已有撤销墓碑（强一致）；渲染后写入前后各查一次。 */
  async function isRevoked(type: string, token: string) {
    return (await objects.get(shareCardTombstoneKey(type, token))) !== null
  }
  /** 写入后发现已撤销时撤回本次写入的图片与索引。 */
  async function discard(ref: ShareCardImageRef & { readonly workspaceId: string }) {
    await objects.delete(shareCardImageKey(ref.type, ref.token, ref.variant))
    await objects.delete(shareCardWorkspaceKey(ref))
  }
  return { read, write, discard, isRevoked }
}
