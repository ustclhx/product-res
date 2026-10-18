import { templateConfig } from '../../server/template-config.ts'

/**
 * 营销站在客户端也要用到的模板配置（站点名称与功能开关）。只取公开字段，
 * 模板配置本身不含密钥（docs/02-project-structure.md §3）。
 */
export const site = {
  name: templateConfig.app.name,
  blog: templateConfig.features.blog,
  docs: templateConfig.features.docs,
} as const
