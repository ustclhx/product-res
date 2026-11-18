import type { ComponentType } from 'react'
import type { ChatSession } from './chat-session.ts'
import type { PickerModel } from './model-picker.ts'

// 项目自有：模板只创建本文件，之后不再修改（template-release 检查），template-sync 不会在这里冲突。

/** 输入区右下角预计消耗的参数：当前模型、输入框估算的 token 数与会话（对话 ID、回复状态、空间 slug 等） */
export interface ComposerEstimateProps {
  readonly model: PickerModel | undefined
  readonly inputTokens: number
  readonly session: ChatSession
}

/**
 * 替换输入区右下角的预计消耗（#373）。保持 undefined 时使用模板的 CreditEstimateText（按模型定价的最坏情况估算）。
 * 需要「每条预计 · 余额」等读取会话的文案时，导出一个组件，例如：
 *
 *   export const ProjectComposerEstimate: ComponentType<ComposerEstimateProps> | undefined = ({
 *     model, inputTokens, session,
 *   }) => <SessionChatCost model={model} inputTokens={inputTokens} session={session} />
 *
 * 组件可以使用 hooks；返回 null 时右下角不显示。外观只用 @saas/ui 组件与 token（docs/design-system.md）。
 */
export const ProjectComposerEstimate: ComponentType<ComposerEstimateProps> | undefined = undefined
