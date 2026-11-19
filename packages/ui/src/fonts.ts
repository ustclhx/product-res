// Inter 可变字体（opsz 轴）的拉丁子集地址：根布局用它输出 <link rel="preload">，
// 让首屏英文正文尽早换成 Inter，减少 font-display: swap 带来的版面跳动。
// 用 Vite 的 `?url` 导入，因此单独经 `@product-res/ui/fonts` 导出、只由根布局引用，主入口保持普通 ESM，
// Node 端直接打包公开模块（public-smoke）时不需要资源 loader。
// 其他子集（拉丁扩展、西里尔等）只按 unicode-range 按需下载，不预加载。
// 项目换了正文字体时，在 apps/web/src/features/theme/fonts.project.ts 替换或清空这份列表。
import interLatinOpsz from '@fontsource-variable/inter/files/inter-latin-opsz-normal.woff2?url'

/** 根布局逐项输出 `<link rel="preload" as="font" crossorigin>` */
export interface FontPreload {
  readonly href: string
  readonly type: 'font/woff2' | 'font/woff' | 'font/ttf' | 'font/otf'
}

export const fontPreloads: readonly FontPreload[] = [{ href: interLatinOpsz, type: 'font/woff2' }]
