// 项目自有：模板只创建本文件，之后不再修改（template-sync 不会覆盖这里的改动）。
//
// 根布局对返回的每一项输出字体 preload。预加载会在首帧前占用带宽：只预加载首屏正文确实使用的字体文件。
// - 默认原样返回模板的 Inter 拉丁子集；
// - 项目在 brand.css 用 --font-sans 换掉了 Inter 时，返回 [] 关闭；
// - 预加载自己的字体：`import url from './my-font.woff2?url'` 后返回 [{ href: url, type: 'font/woff2' }]；
// - 追加：return [...defaults, { href: url, type: 'font/woff2' }]
import type { FontPreload } from '@saas/ui/fonts'

export function projectFontPreloads(defaults: readonly FontPreload[]): readonly FontPreload[] {
  return defaults
}
