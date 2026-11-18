import { templateConfig } from '../../server/template-config.ts'

/**
 * 营销站在客户端也要用到的模板配置（站点名称与功能开关）。只取公开字段，
 * 模板配置本身不含密钥（docs/02-project-structure.md §3）。
 */
export const site = {
  name: templateConfig.app.name,
  blog: templateConfig.features.blog,
  docs: templateConfig.features.docs,
  guides: templateConfig.features.guides,
  /** 营销区块（openspec add-ui-design-system 8.5）：背书数值、产品矩阵与悬浮 AI 入口均由模板配置驱动 */
  marketing: {
    stats: templateConfig.marketing.stats,
    steps: templateConfig.marketing.steps,
    products: templateConfig.marketing.products,
    // 悬浮入口指向 AI 功能，项目关闭文本 AI 时一并隐藏，避免指向不存在的功能
    aiEntry:
      templateConfig.marketing.enabled &&
      templateConfig.marketing.aiEntry.enabled &&
      templateConfig.ai.text.enabled
        ? templateConfig.marketing.aiEntry.href
        : null,
  },
} as const
