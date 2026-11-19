import { AppError } from '@product-res/shared'
import { log } from '@product-res/shared/log'
import { getWebRuntime } from '../../server/runtime.ts'
import { isAdminNotFound, requireAdmin } from '../admin/guard.ts'
import { isUiPreviewEnabled } from '../ui-preview/gate.ts'
import { invalidateShareCard } from './invalidate.server.ts'
import { defaultShareCardLayout, sampleShareCardLayout } from './layout.tsx'
import { registerPreviewShareCards } from './meta.server.ts'
import { defaultShareTokenPattern } from './registry.ts'
import { renderShareCard } from './render.server.ts'
import { SHARE_CARD_BUSY } from './renderer.ts'
import {
  addSampleShare,
  SAMPLE_SHARE_PREVIEWS,
  SAMPLE_SHARE_WORKSPACE_ID,
  type SampleSharePreview,
} from './sample.ts'
import { resolveRequestShareCardSite } from './site.ts'
import { resolveShareCardTheme } from './theme.ts'
import { createShareToken } from './token.ts'

const plain = (status: number, text: string, headers: Record<string, string> = {}) =>
  new Response(`${text}\n`, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  })

/**
 * /dev/ui 分享卡片预览图（tasks 6.1）：用示例固定数据与真实渲染器输出 PNG，不读写存储与缓存。
 * 与 /dev/ui 同一开关（`UI_PREVIEW=true`），生产 404。
 */
export async function handleShareCardPreviewRequest(request: Request): Promise<Response> {
  const runtime = getWebRuntime()
  if (!isUiPreviewEnabled(runtime.config)) return plain(404, 'Not Found')
  const url = new URL(request.url)
  const variant = url.searchParams.get('variant') ?? ''
  const mode = url.searchParams.get('mode') === 'dark' ? 'dark' : 'light'
  if (!Object.hasOwn(SAMPLE_SHARE_PREVIEWS, variant)) return plain(404, 'Not Found')
  // staging 也开放预览：每张都会渲染，与卡片缓存未命中共用 shareCard 限流配额。
  const limited = await runtime.rateLimiter.limit(
    'shareCard',
    `share:ip:${runtime.requestMeta.clientIp ?? 'unknown'}`,
  )
  if (!limited.success) return plain(429, 'Too Many Requests', { 'retry-after': '60' })
  const data = SAMPLE_SHARE_PREVIEWS[variant as SampleSharePreview]
  // 与卡片路由相同按请求 host 与 `l` 参数解析站点，多站点项目可在各自域名、各语言下预览。
  const { site, themeOverride } = resolveRequestShareCardSite(
    request.url,
    runtime.config.APP_URL,
    undefined,
    url.searchParams.get('l'),
  )
  try {
    const body = await renderShareCard(
      {
        render: (value, theme, site) =>
          variant === 'default'
            ? defaultShareCardLayout(value.title, theme, site)
            : sampleShareCardLayout(value, theme, site),
      },
      data,
      resolveShareCardTheme(mode, themeOverride),
      site,
    )
    return new Response(new Uint8Array(body), {
      headers: {
        'content-type': 'image/png',
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex',
        'x-content-type-options': 'nosniff',
      },
    })
  } catch (error) {
    if (error instanceof AppError && error.code === SHARE_CARD_BUSY)
      return plain(503, 'Busy', { 'retry-after': '1' })
    log.error('share-cards.preview-failed', { error })
    return plain(500, 'Error')
  }
}

/**
 * e2e 与 staging 验收夹具（tasks 6.2、8.2）：`create` 在 KV 中登记一条新的示例分享（TTL 1 天，固定数据，
 * 不接受任意文本）并返回令牌与分享页地址；`invalidate` 对 sample 类型的令牌调用模板失效函数（与项目撤销分享
 * 时相同）。只在 `UI_PREVIEW=true` 的环境开放，并要求平台管理员会话；其余情况一律 404。
 */
const sampleFixtureVariants = ['en', 'zh', 'long'] as const

export async function handleSampleShareFixture(request: Request): Promise<Response> {
  const runtime = getWebRuntime()
  if (!isUiPreviewEnabled(runtime.config)) return plain(404, 'Not Found')
  try {
    await requireAdmin({ auth: runtime.auth, db: runtime.db, headers: request.headers })
  } catch (error) {
    if (isAdminNotFound(error)) return plain(404, 'Not Found')
    throw error
  }
  registerPreviewShareCards(runtime.config)
  const input = (await request.json().catch(() => null)) as {
    action?: string
    token?: string
    variant?: string
  } | null
  if (input?.action === 'create') {
    // 只能选固定变体（staging 验收需要中文卡片），不接受任意文本。
    const variant = sampleFixtureVariants.find((name) => name === input.variant) ?? 'en'
    const token = await addSampleShare(
      runtime.cache,
      createShareToken(),
      SAMPLE_SHARE_PREVIEWS[variant],
    )
    return Response.json({ token, page: `/s/sample/${token}` })
  }
  // 只接受 sample 的令牌格式，项目类型的分享不能经此失效。
  if (
    input?.action === 'invalidate' &&
    typeof input.token === 'string' &&
    defaultShareTokenPattern.test(input.token)
  ) {
    await invalidateShareCard({
      type: 'sample',
      token: input.token,
      workspaceId: SAMPLE_SHARE_WORKSPACE_ID,
    })
    return Response.json({ invalidated: true })
  }
  return plain(400, 'Bad Request')
}
