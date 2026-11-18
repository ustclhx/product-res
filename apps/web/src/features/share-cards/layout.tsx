// 分享卡片版式（1200×630）：服务端由 satori 渲染，只用 flex 子集与主题解析值。
// 尺寸与间距照设计稿副本 docs/design-system/prototypes/share-cards/Card.dc.html。
import type { JSX } from 'react'
import { templateConfig } from '../../server/template-config.ts'
import { homePageCopy } from '../seo/home-copy.ts'
import { projectFonts } from './fonts.ts'
import type { SampleShareData } from './sample.ts'
import { defaultShareCardSite, type ShareCardBrand, type ShareCardSite } from './site.ts'
import { fallbackFontPlan, keepsWords, textWidth, truncateText } from './text.ts'
import type { ShareCardTheme } from './types.ts'

export const SHARE_CARD_WIDTH = 1200
export const SHARE_CARD_HEIGHT = 630

/**
 * 截断上限（加权字宽，em）：CJK 1、拉丁小写 0.6、大写 0.72。
 * 卡片标题 28 与设计稿的中文 28 字一致；大标题（76px）每行容量更小，取 24。
 */
export const SHARE_CARD_TEXT_LIMITS = {
  title: 28,
  heroTitle: 24,
  summary: 52,
  badge: 12,
  meta: 28,
} as const

const CONTENT_WIDTH = SHARE_CARD_WIDTH - 72 * 2
// 换行模拟的行宽留 5% 余量，抵消字宽估算与 satori 断行规则的差异
const lineWidth = (fontSize: number) => (CONTENT_WIDTH / fontSize) * 0.95
const META_SIZE = 24
// 底部行右侧：圆点 12、间距 12，与元信息之间再留 24
const HOST_CHROME = 12 + 12 + 24

/** 韩文（不含汉字与假名）按词断行；其余文本不设置，版式与之前完全相同。 */
const wordBreak = (text: string) => (keepsWords(text) ? { wordBreak: 'keep-all' as const } : {})

/**
 * 元信息的加权字宽上限：默认 28，域名很长时按底部行剩余宽度收紧，使元信息不会伸到域名下方。
 */
export function metaLimit(host: string): number {
  const available = (CONTENT_WIDTH - textWidth(host) * META_SIZE - HOST_CHROME) / META_SIZE
  return Math.max(0, Math.min(SHARE_CARD_TEXT_LIMITS.meta, Math.floor(available)))
}

export interface ShareCardLayoutContent {
  readonly title: string
  readonly summary?: string | undefined
  readonly badge?: string | undefined
  readonly meta?: string | undefined
  /** `hero`：构建期默认分享图的大标题；`card`：结果卡片。 */
  readonly size?: 'card' | 'hero'
  /** 品牌行；省略时为模板配置的应用名。多站点项目传入 render 第三个参数 `site.brand`。 */
  readonly brand?: ShareCardBrand | undefined
  /** 右下角域名；省略时为 app.url 的域名。多站点项目传入 `site.host`。 */
  readonly host?: string | undefined
}

// Inter 优先：拉丁字符使用 Inter 的真实 600 字重，CJK 只有常规体，按需回退到 Noto Sans SC，再到项目字体。
const FONT_FAMILY = ['Inter', 'Noto Sans SC', ...new Set(projectFonts.map((font) => font.name))]
  .map((name) => (name.includes(' ') ? `"${name}"` : name))
  .join(', ')

/**
 * 标题字重：含需要 Noto 回退的字符（CJK 等）时整行用 400。Noto Sans SC 只有常规体，
 * 混排时拉丁部分若用 Inter 600 会出现两种字重（使用者决定，2026-11-13）；纯拉丁标题保持 600。
 * 只需要项目字体时，每个所需字体族都登记了 600 才保持 600。
 */
export function titleWeight(title: string): 400 | 600 {
  const plan = fallbackFontPlan(title)
  if (plan.cjk) return 400
  const families = new Set(plan.project.map((font) => font.name))
  for (const name of families) {
    if (!projectFonts.some((font) => font.name === name && font.weight === 600)) return 400
  }
  return 600
}

/** 默认版式：品牌行、标题与摘要、底部元信息与站点域名。 */
export function shareCardLayout(
  content: ShareCardLayoutContent,
  theme: ShareCardTheme,
): JSX.Element {
  const hero = content.size === 'hero'
  const titleSize = hero ? 76 : 60
  const titleLeading = hero ? 92 : 74
  const title = truncateText(content.title, {
    maxWidth: hero ? SHARE_CARD_TEXT_LIMITS.heroTitle : SHARE_CARD_TEXT_LIMITS.title,
    lineWidth: lineWidth(titleSize),
    lines: 2,
  })
  const badge = content.badge && truncateText(content.badge, SHARE_CARD_TEXT_LIMITS.badge)
  const summary =
    content.summary &&
    truncateText(content.summary, {
      maxWidth: SHARE_CARD_TEXT_LIMITS.summary,
      lineWidth: lineWidth(28),
      lines: 2,
    })
  const fallback = defaultShareCardSite()
  const brand = content.brand ?? fallback.brand
  const host = content.host ?? fallback.host
  const meta = content.meta && truncateText(content.meta, metaLimit(host))
  return (
    <div
      style={{
        width: SHARE_CARD_WIDTH,
        height: SHARE_CARD_HEIGHT,
        display: 'flex',
        flexDirection: 'column',
        padding: '64px 72px',
        background: theme.background,
        color: theme.foreground,
        fontFamily: FONT_FAMILY,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 24,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: theme.radius + 4,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 28,
              fontWeight: 600,
              background: theme.primary,
              color: theme.primaryForeground,
            }}
          >
            {brand.initial ?? (Array.from(brand.name)[0] ?? '').toUpperCase()}
          </div>
          <div style={{ display: 'flex', fontSize: 30, lineHeight: '36px', fontWeight: 600 }}>
            {brand.name}
          </div>
        </div>
        {badge ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              height: 44,
              padding: '0 20px',
              borderRadius: 9999,
              fontSize: 22,
              fontWeight: 500,
              background: theme.secondary,
              color: theme.mutedForeground,
            }}
          >
            {badge}
          </div>
        ) : null}
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
          flexGrow: 1,
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            // satori 的 lineClamp 只在 block 上生效；渲染前已截断，这里兜底保证省略号可见
            display: 'block',
            lineClamp: 2,
            fontSize: titleSize,
            lineHeight: `${titleLeading}px`,
            fontWeight: titleWeight(title),
            letterSpacing: -titleSize * 0.01,
            maxHeight: titleLeading * 2,
            overflow: 'hidden',
            ...wordBreak(title),
          }}
        >
          {title}
        </div>
        {summary ? (
          <div
            style={{
              display: 'block',
              lineClamp: 2,
              fontSize: 28,
              lineHeight: '42px',
              maxHeight: 84,
              overflow: 'hidden',
              color: theme.mutedForeground,
              ...wordBreak(summary),
            }}
          >
            {summary}
          </div>
        ) : null}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingTop: 28,
          borderTop: `1px solid ${theme.border}`,
          fontSize: META_SIZE,
          lineHeight: '32px',
          color: theme.mutedForeground,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            // 占满域名左侧的剩余宽度：裁切边界是域名前的空白，而不是 satori 测得的文字宽度。
            // satori 逐字用首个含该字形的字体测宽（·、空格取 Inter），绘制时同一词段却用段首字符的字体
            // （谚文段用项目字体、汉字段用 Noto Sans SC，其 · 宽 0.56em / 1em，Inter 为 0.29em），
            // 绘制宽度大于测量宽度；盒宽等于测量宽度时 overflow: hidden 会把末字裁掉一半。
            flexGrow: 1,
            flexShrink: 1,
            minWidth: 0,
            marginRight: 24,
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
          }}
        >
          {meta ?? ''}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          <div
            style={{ width: 12, height: 12, borderRadius: 9999, background: theme.brandAccent }}
          />
          <div style={{ display: 'flex', color: theme.foreground, fontWeight: 500 }}>{host}</div>
        </div>
      </div>
    </div>
  )
}

/**
 * 构建期默认分享图：设计稿 `default` 变体，无标签与摘要。副标题为「品牌名 · 标语」，
 * 标语取站点解析的 tagline，未提供时取该语言首页的 SEO 标题（`seo/home-copy.ts`，与 `staticPage('/')` 共用，项目随产品文案修改）。
 */
export function defaultShareCardLayout(
  title: string,
  theme: ShareCardTheme,
  site: ShareCardSite = defaultShareCardSite(),
): JSX.Element {
  const tagline = site.tagline ?? homePageCopy(site.locale ?? templateConfig.i18n.defaultLocale)[0]
  return shareCardLayout(
    {
      title,
      meta: `${site.brand.name} · ${tagline}`,
      size: 'hero',
      brand: site.brand,
      host: site.host,
    },
    theme,
  )
}

/** 示例类型 `sample` 的版式：标签、标题、摘要与元信息。 */
export function sampleShareCardLayout(
  data: SampleShareData,
  theme: ShareCardTheme,
  site: ShareCardSite = defaultShareCardSite(),
): JSX.Element {
  return shareCardLayout(
    {
      title: data.title,
      summary: data.description,
      badge: data.label,
      meta: data.meta,
      brand: site.brand,
      host: site.host,
    },
    theme,
  )
}
