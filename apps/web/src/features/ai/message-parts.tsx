import {
  ChatMarkdown,
  type ChatMarkdownLabels,
  ChatMessage,
  ThinkingIndicator,
  ThinkingStep,
  ThinkingSteps,
  ThinkingStepsContent,
  ThinkingStepsHeader,
  ToolCall,
  type ToolCallLabels,
  type ToolCallState,
} from '@product-res/ui/chat'
import { getToolName, isToolUIPart } from 'ai'
import type { ReactNode } from 'react'
import { m } from '../../paraglide/messages.js'
import { templateConfig } from '../../server/template-config.ts'
import {
  type ChatMessageStatus,
  type ChatUIMessage,
  messageReasoning,
  messageRetrying,
  messageText,
} from './conversation.ts'
import { registerProjectToolRenderers } from './message-parts.project.tsx'
import { resetToolRenderers, type ToolCallView, toolRenderer } from './tool-renderers.ts'

/**
 * AI SDK `UIMessage` → `@product-res/ui/chat` 组件的适配层（openspec add-ai-chat-components design D5）：
 * - `text` → ChatMarkdown（相邻的正文段合并为一段，被工具调用隔开的各自渲染）；
 * - `reasoning` → ThinkingSteps（`templateConfig.ai.text.reasoning.display` 关闭时跳过；重试后只显示本次尝试的推理）；
 * - `tool-<name>` / `dynamic-tool` → ToolCall，显示名与详情查注册表（`message-parts.project.tsx`）；
 *   未登记的工具只显示「工具」与状态，不显示内部名称；
 * - 其他 part（`step-start`、`source-*`、`file`、`data-*` 等）忽略；
 * - 等待首个可见输出时显示 ThinkingIndicator，自动重试期间为 retrying 状态。
 * `packages/ui` 的对话组件不认识 AI SDK，换 SDK 版本只改本文件。
 */

// 每次模块执行（含热更新）都从空注册表开始，再登记项目的工具
resetToolRenderers()
registerProjectToolRenderers()

export { registerToolRenderer, type ToolCallView, type ToolRenderer } from './tool-renderers.ts'

export function chatMarkdownLabels(): ChatMarkdownLabels {
  return {
    copy: m.chat_ui_code_copy(),
    copied: m.chat_ui_code_copied(),
    copyFailed: m.chat_ui_code_copy_failed(),
    codeBlock: m.chat_ui_code_block(),
    table: m.chat_ui_table(),
    image: m.chat_ui_image(),
    // ChatMarkdown 把模板中的 `{alt}` 换成替代文字
    imageAlt: m.chat_ui_image_alt({ alt: '{alt}' }),
    footnotes: m.chat_ui_footnotes(),
    footnoteBack: m.chat_ui_footnote_back(),
  }
}

const toolLabels = (): ToolCallLabels => ({
  pending: m.chat_ui_tool_pending(),
  running: m.chat_ui_tool_running(),
  done: m.chat_ui_tool_done(),
  error: m.chat_ui_tool_error(),
})

type ToolPartState =
  | 'input-streaming'
  | 'input-available'
  | 'approval-requested'
  | 'approval-responded'
  | 'output-available'
  | 'output-error'
  | 'output-denied'

/** AI SDK 的工具状态 → 卡片四态（design D2） */
export function toolCallState(state: ToolPartState): ToolCallState {
  switch (state) {
    case 'input-streaming':
    case 'approval-requested':
      return 'pending'
    case 'input-available':
    case 'approval-responded':
      return 'running'
    case 'output-available':
      return 'done'
    default:
      return 'error'
  }
}

type Part = ChatUIMessage['parts'][number]

/** 正文段与工具调用按出现顺序排列；相邻正文段合并（重试后的续写与首段连续） */
type Block = { kind: 'text'; key: string; text: string } | { kind: 'tool'; key: string; part: Part }

function contentBlocks(message: ChatUIMessage): Block[] {
  const blocks: Block[] = []
  message.parts.forEach((part, index) => {
    if (part.type === 'text') {
      const last = blocks.at(-1)
      if (last?.kind === 'text') last.text += part.text
      else blocks.push({ kind: 'text', key: `t${index}`, text: part.text })
    } else if (isToolUIPart(part)) {
      blocks.push({ kind: 'tool', key: `x${index}`, part })
    }
  })
  return blocks.filter((block) => block.kind !== 'text' || block.text)
}

function ToolPart({ part, live }: { part: Part; live: boolean }) {
  if (!isToolUIPart(part)) return null
  const toolName = getToolName(part)
  // 回复已不在生成中（停止、失败、刷新后）而工具仍停在准备 / 执行：不会再有结果，按出错显示
  const raw = toolCallState(part.state)
  const state = !live && (raw === 'pending' || raw === 'running') ? 'error' : raw
  const renderer = toolRenderer(toolName)
  const call: ToolCallView = {
    toolName,
    toolCallId: part.toolCallId,
    state,
    input: part.input,
    output: part.state === 'output-available' ? part.output : undefined,
  }
  const details = renderer?.render?.(call)
  return (
    <ToolCall
      name={renderer ? renderer.label() : m.chat_ui_tool()}
      state={state}
      labels={toolLabels()}
      data-tool-registered={renderer ? '' : undefined}
    >
      {details ?? undefined}
    </ToolCall>
  )
}

function Reasoning({ text, busy }: { text: string; busy: boolean }) {
  return (
    <ThinkingSteps>
      <ThinkingStepsHeader busy={busy}>
        {busy ? m.chat_ui_reasoning_busy() : m.chat_ui_reasoning()}
      </ThinkingStepsHeader>
      <ThinkingStepsContent>
        <ThinkingStep>{text}</ThinkingStep>
      </ThinkingStepsContent>
    </ThinkingSteps>
  )
}

export interface ChatMessageViewProps {
  readonly message: ChatUIMessage
  /** 正在生成的最后一条助手消息 */
  readonly live: boolean
  /** 保存的状态或停止接口返回的状态（覆盖流中的状态） */
  readonly status: ChatMessageStatus | undefined
  /** 正文下方的操作区（复制回复、评分） */
  readonly actions?: ReactNode
  /** 是否播放入场动效；首屏的历史消息不播放 */
  readonly entrance?: boolean
}

type StatusProps =
  | { status?: 'streaming' }
  | {
      status: 'aborted' | 'failed' | 'incomplete' | 'retrying'
      statusLabel: string
      statusDetail?: string
    }

function statusProps(
  live: boolean,
  retrying: boolean,
  status: ChatMessageStatus | undefined,
): StatusProps {
  if (live)
    return retrying
      ? { status: 'retrying', statusLabel: m.chat_ui_status_retrying() }
      : { status: 'streaming' }
  if (status === 'aborted') return { status: 'aborted', statusLabel: m.chat_ui_status_stopped() }
  if (status === 'failed')
    return {
      status: 'failed',
      statusLabel: m.chat_ui_status_failed(),
      statusDetail: m.chat_ui_status_failed_detail(),
    }
  // 刷新后发现仍为 streaming（生成中断开）：未完成
  if (status === 'streaming')
    return {
      status: 'incomplete',
      statusLabel: m.chat_ui_status_incomplete(),
      statusDetail: m.chat_ui_status_incomplete_detail(),
    }
  return {}
}

/** 一条消息：用户消息为纯文本气泡，助手消息按 part 组合（推理在头像旁，工具卡片与正文依次竖排） */
export function ChatMessageView({
  message,
  live,
  status,
  actions,
  entrance = true,
}: ChatMessageViewProps) {
  if (message.role === 'user')
    return (
      <ChatMessage from="user" entrance={entrance}>
        {messageText(message)}
      </ChatMessage>
    )
  const retrying = live && messageRetrying(message)
  const reasoning = templateConfig.ai.text.reasoning.display ? messageReasoning(message) : ''
  const blocks = contentBlocks(message)
  const hasText = blocks.some((block) => block.kind === 'text')
  // 等待首个可见输出：推理区块自己显示「思考中」，重试时显示重试徽标，都不再叠加指示
  const waiting = live && !retrying && !hasText && !reasoning
  return (
    <ChatMessage
      from="assistant"
      entrance={entrance}
      leading={reasoning ? <Reasoning text={reasoning} busy={live && !hasText} /> : undefined}
      actions={actions}
      {...statusProps(live, retrying, status)}
    >
      {blocks.length || waiting ? (
        <>
          {blocks.map((block) =>
            block.kind === 'text' ? (
              <ChatMarkdown
                key={block.key}
                id={`${message.id}-${block.key}`}
                markdown={block.text}
                labels={chatMarkdownLabels()}
                streaming={live && block === blocks.at(-1)}
              />
            ) : (
              <ToolPart key={block.key} part={block.part} live={live} />
            ),
          )}
          {waiting ? <ThinkingIndicator label={m.chat_ui_status_thinking()} /> : null}
        </>
      ) : null}
    </ChatMessage>
  )
}
