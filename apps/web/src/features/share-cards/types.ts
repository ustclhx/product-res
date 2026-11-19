import type { Database } from '@product-res/db'
import type { ShareCardTheme } from '@product-res/ui/share-card-theme'
import type { JSX } from 'react'
import type { ShareCardSite } from './site.ts'

export type { ShareCardTheme } from '@product-res/ui/share-card-theme'

/** 项目登记的回退字体（`share-cards.fonts.ts`），排在 Inter 与 Noto Sans SC 之后。 */
export interface ProjectShareCardFont {
  /** 字体族名，satori 按它匹配。 */
  readonly name: string
  /** `apps/web/public/fonts/share-card/` 下的文件名（otf / ttf / woff），不含路径分隔符。 */
  readonly file: string
  /** Unicode 文字名（如 'Hangul'），文本含这些文字时才读取本字体。 */
  readonly scripts: readonly string[]
  /** 默认 400。 */
  readonly weight?: 400 | 600
}

export interface ShareCardContext {
  readonly db: Database
}

export interface ShareResolution<T> {
  readonly workspaceId: string
  readonly sharedAt: Date
  /** 省略时按类型有效天数计算；null 表示永不过期。 */
  readonly expiresAt?: Date | null
  readonly data: T
}

export interface ShareCardDefinition<T> {
  readonly type: string
  readonly version: number
  readonly tokenPattern?: RegExp
  readonly ttlDays?: number | null
  readonly sharePage?: false
  resolve(token: string, ctx: ShareCardContext): Promise<ShareResolution<T> | null>
  digest(data: T): string
  /** `site` 为当前站点（品牌、域名）；单站点项目可忽略，多站点项目传给 shareCardLayout 的 brand 与 host。 */
  render(data: T, theme: ShareCardTheme, site: ShareCardSite): JSX.Element
  alt(data: T): string
  /** 通用分享页与元数据使用；label 是分享页标题上方的类型标签，可省略。 */
  page(data: T): { title: string; description: string; label?: string }
}

export type RegisteredShareCard<T> = Omit<
  ShareCardDefinition<T>,
  'tokenPattern' | 'ttlDays' | 'sharePage'
> & {
  readonly tokenPattern: RegExp
  readonly ttlDays: number | null
  readonly sharePage: boolean
}
