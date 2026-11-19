import { shareCardThemes } from '@product-res/ui/share-card-theme'
import { projectShareCardTheme } from './share-cards.theme.ts'
import type { ShareCardTheme } from './types.ts'

export type ShareCardThemeMode = 'light' | 'dark'

/** 模板基线叠加项目品牌覆盖，再叠加站点覆盖（site.ts 的 themeOverride）；项目覆盖对浅色与深色同时生效。 */
export function resolveShareCardTheme(
  mode: ShareCardThemeMode = 'light',
  siteOverride: Partial<ShareCardTheme> = {},
): ShareCardTheme {
  return { ...shareCardThemes[mode], ...projectShareCardTheme, ...siteOverride }
}
