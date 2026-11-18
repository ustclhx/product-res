import { readFileSync } from 'node:fs'
// 复用门禁脚本的 JSONC 解析（容忍注释与尾逗号）
import { parseJsonc } from '../../../scripts/production/check-wrangler-envs.mjs'
import templateConfig from '../../../template.config.ts'

/**
 * Workers AI 用例的前提（harden-derived-project-checks D1）：项目选择了 workers-ai 媒体服务商，
 * 且 web 的 wrangler.jsonc 声明了 `ai` 绑定（运行时才能调用）。任一缺失时返回跳过原因，否则返回 null。
 */
export function workersAiSkipReason(): string | null {
  if (!templateConfig.ai.mediaProviders.includes('workers-ai'))
    return 'ai.mediaProviders 未包含 workers-ai'
  const wrangler = (parseJsonc as (text: string) => { ai?: { binding?: string } })(
    readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
  )
  if (!wrangler.ai?.binding) return 'apps/web/wrangler.jsonc 没有 ai 绑定'
  return null
}
