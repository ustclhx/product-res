import type { ShareCardTheme } from './types.ts'

// 项目自有：品牌覆盖与 styles/brand.css 保持对应，模板之后不再修改。
// 填写颜色字面量时，在 scripts/check-ui.allow.local.json 按文件登记 exceptions，
// 原因：分享卡片在服务端渲染，无法读取 CSS 变量。
export const projectShareCardTheme: Partial<ShareCardTheme> = {}
