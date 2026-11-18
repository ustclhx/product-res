// 阅读器预览的状态取值。路由的 validateSearch 不会被拆进懒加载分包，这里保持为不依赖阅读器的叶子模块，
// 避免把 react-markdown 等带进首页的静态依赖（tasks 8.4 评审 B1，构建检查见 scripts/check-home-bundle.mjs）。
export const READER_STATUSES = ['ready', 'empty', 'loading', 'error'] as const

export type ReaderPreviewStatus = (typeof READER_STATUSES)[number]
