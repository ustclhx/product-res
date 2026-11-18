import type { ShareLookup } from './lookup.ts'
import type { ShareCardMeta } from './meta.ts'

/** 页面只拿到展示所需的可序列化字段，不下发 resolve 的原始数据与空间 ID。 */
export type SharePageView =
  | {
      readonly status: 'ok'
      readonly title: string
      readonly description: string
      readonly label: string | null
      /** UTC 日期 YYYY-MM-DD，服务端与客户端渲染一致，避免水合差异。 */
      readonly sharedOn: string
      readonly expiresOn: string | null
      readonly card: Pick<ShareCardMeta, 'image' | 'width' | 'height' | 'alt'>
      readonly meta: ShareCardMeta['meta']
    }
  | { readonly status: 'not-found' | 'expired' | 'rate-limited' }

const utcDate = (date: Date) => date.toISOString().slice(0, 10)

export function sharePageView(
  result: Extract<ShareLookup, { status: 'ok' }>,
  meta: ShareCardMeta,
): SharePageView {
  const page = result.card.page(result.resolution.data)
  return {
    status: 'ok',
    title: page.title,
    description: page.description,
    label: page.label ?? null,
    sharedOn: utcDate(result.resolution.sharedAt),
    expiresOn: result.expiresAt ? utcDate(result.expiresAt) : null,
    card: { image: meta.image, width: meta.width, height: meta.height, alt: meta.alt },
    meta: meta.meta,
  }
}
