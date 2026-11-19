import { requireCapability } from '@product-res/platform'
import { getWebRuntime } from '../../server/runtime.ts'
import type { ShareCardRenderer } from './renderer.ts'
import { defaultShareCardSite, type ShareCardSite } from './site.ts'
import { resolveShareCardTheme } from './theme.ts'
import type { RegisteredShareCard, ShareCardTheme } from './types.ts'

/** 经 WebRuntime 注入的渲染器；目标实现由各自入口动态 import()，首次调用时才实例化 WASM 与字体。 */
export function loadShareCardRenderer(): Promise<ShareCardRenderer> {
  const runtime = getWebRuntime()
  const load = requireCapability(
    runtime.shareCardRenderer ?? { available: false },
    'shareCardRenderer',
  )
  return load()
}

/**
 * 用注册类型的版式渲染 1200×630 PNG。并发超限抛出 status 503 的 AppError（SHARE_CARD_BUSY），
 * 调用方映射为 503 + Retry-After。
 */
export async function renderShareCard<T>(
  card: Pick<RegisteredShareCard<T>, 'render'>,
  data: T,
  theme: ShareCardTheme = resolveShareCardTheme('light'),
  site: ShareCardSite = defaultShareCardSite(),
): Promise<Uint8Array> {
  const renderer = await loadShareCardRenderer()
  return renderer.render(card.render(data, theme, site))
}
