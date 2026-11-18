import type { ReactNode } from 'react'

/**
 * 工具卡片的注册表（openspec add-ai-chat-components design D5）：项目在自有的 `message-parts.project.tsx`
 * 中按工具名登记显示名与详情渲染；未登记的工具只显示通用文案「工具」与状态，不显示内部名称、参数与结果。
 * 注册表只是数据，适配层（`message-parts.tsx`）在渲染时查询。
 */

/** 交给详情渲染函数的工具调用；`input` / `output` 为模型与工具的原始值，由项目决定显示哪些 */
export interface ToolCallView {
  readonly toolName: string
  readonly toolCallId: string
  readonly state: 'pending' | 'running' | 'done' | 'error'
  readonly input: unknown
  readonly output: unknown
}

export interface ToolRenderer {
  /** 显示名（按语言取文案，如 `m.reports_tool_search`） */
  readonly label: () => string
  /** 可折叠的详情；不提供时卡片只有显示名与状态 */
  readonly render?: (call: ToolCallView) => ReactNode
}

const renderers = new Map<string, ToolRenderer>()

/** 登记工具的显示名与详情；同名再次登记时覆盖 */
export function registerToolRenderer(toolName: string, renderer: ToolRenderer): void {
  renderers.set(toolName, renderer)
}

export function toolRenderer(toolName: string): ToolRenderer | undefined {
  return renderers.get(toolName)
}

/** 清空注册表（每次模块执行与测试之间从空表开始） */
export function resetToolRenderers(): void {
  renderers.clear()
}
