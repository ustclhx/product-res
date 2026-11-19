import type { ProjectShareCardFont } from './types.ts'

// 项目自有：模板只创建本文件，之后不再修改。
// 登记 Inter 与 Noto Sans SC 之外的回退字体（如谚文）。字体文件与许可证放在 apps/web/public/fonts/share-card/，
// 只在待渲染文本含 scripts 中的文字时读取；运行时卡片与构建期默认分享图共用。说明见 docs/share-cards.md 第 7 节。
export const projectShareCardFonts: readonly ProjectShareCardFont[] = [
  // { name: 'Noto Sans KR', file: 'NotoSansKR-Regular.otf', scripts: ['Hangul'] },
]
