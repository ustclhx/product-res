import { Button, CreditEstimate, cn, MessageFeedback } from '@product-res/ui'
import {
  ChatMarkdown,
  type ChatMarkdownLabels,
  ChatMessage,
  InputMessage,
  type InputMessageLabels,
  ThinkingIndicator,
  ThinkingStep,
  ThinkingSteps,
  ThinkingStepsContent,
  ThinkingStepsHeader,
  ToolCall,
  type ToolCallLabels,
  type ToolCallState,
} from '@product-res/ui/chat'
import { ChevronDown } from '@product-res/ui/icons'
import { type ReactNode, useEffect, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { getLocale } from '../../paraglide/runtime.js'
import { PreviewSection, Specimen } from './layout.tsx'
import {
  chatBasicSample,
  chatSafetySample,
  chatStreamSample,
  chatTableSample,
} from './sample-chat.ts'
import { feedbackLabels } from './sections-business.tsx'

// 对话组件预览（openspec add-ai-chat-components design D8，设计稿
// docs/design-system/prototypes/chat-components/States.dc.html 与 Main / Mobile 的 Markdown 样例）：
// 组件来自 @product-res/ui/chat 子路径（含 react-markdown），本节由预览页懒加载，形成独立分包。
// 示例消息都关闭入场动效（entrance={false}），与对话页首屏的历史消息一致，截图稳定。

const format = (value: number) => new Intl.NumberFormat(getLocale()).format(value)

export function chatMarkdownLabels(): ChatMarkdownLabels {
  return {
    copy: m.ui_preview_chat_copy(),
    copied: m.ui_preview_chat_copied(),
    copyFailed: m.ui_preview_chat_copy_failed(),
    codeBlock: m.ui_preview_chat_code_block(),
    table: m.ui_preview_chat_table(),
    image: m.ui_preview_chat_image(),
    imageAlt: m.ui_preview_chat_image_alt({ alt: '{alt}' }),
    footnotes: m.ui_preview_chat_footnotes(),
    footnoteBack: m.ui_preview_chat_footnote_back(),
  }
}

export function inputMessageLabels(): InputMessageLabels {
  return {
    message: m.ui_preview_chat_message(),
    send: m.ui_preview_chat_send(),
    stop: m.ui_preview_chat_stop(),
  }
}

function toolLabels(): ToolCallLabels {
  return {
    pending: m.ui_preview_chat_tool_pending(),
    running: m.ui_preview_chat_tool_running(),
    done: m.ui_preview_chat_tool_done(),
    error: m.ui_preview_chat_tool_error(),
  }
}

/** 推理按钮（放进 ChatMessage 的 leading）：已结束为「已思考 N 秒」，进行中为「思考中…」并显示三点 */
function Reasoning({
  busy = false,
  defaultOpen = false,
}: {
  busy?: boolean
  defaultOpen?: boolean
}) {
  return (
    <ThinkingSteps defaultOpen={defaultOpen}>
      <ThinkingStepsHeader busy={busy}>
        {busy ? m.ui_preview_chat_thinking_busy() : m.ui_preview_chat_thought()}
      </ThinkingStepsHeader>
      <ThinkingStepsContent>
        <ThinkingStep status={busy ? 'active' : 'complete'}>
          {m.ui_preview_chat_reasoning()}
        </ThinkingStep>
      </ThinkingStepsContent>
    </ThinkingSteps>
  )
}

/** 模型选择的示意按钮（真实页面是 ModelPicker） */
function ModelButton({ disabled }: { disabled?: boolean }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="compact"
      trailingIcon={ChevronDown}
      disabled={disabled}
    >
      {m.ui_preview_chat_model()}
    </Button>
  )
}

function InputSpecimen({
  label,
  initial = '',
  busy = false,
  disabled = false,
}: {
  label: string
  initial?: string
  busy?: boolean
  disabled?: boolean
}) {
  const [value, setValue] = useState(initial)
  const [echo, setEcho] = useState<string | null>(null)
  let trailing: ReactNode = null
  if (busy) {
    trailing = (
      <span className="text-caption text-muted-foreground">{m.ui_preview_chat_generating()}</span>
    )
  } else if (!disabled) {
    trailing = (
      <CreditEstimate hideIcon estimate={m.ui_preview_chat_estimate({ count: format(4) })} />
    )
  }
  return (
    <Specimen label={label} className="flex-col items-stretch">
      <InputMessage
        data-preview-input={busy ? 'busy' : disabled ? 'disabled' : initial ? 'multiline' : 'empty'}
        value={value}
        onValueChange={setValue}
        onSend={(text) => {
          setEcho(m.ui_preview_chat_sent({ text }))
          setValue('')
        }}
        onStop={() => setEcho(m.ui_preview_chat_stopped_echo())}
        busy={busy}
        disabled={disabled}
        placeholder={
          disabled ? m.ui_preview_chat_placeholder_readonly() : m.ui_preview_chat_placeholder()
        }
        labels={inputMessageLabels()}
        leading={<ModelButton disabled={disabled} />}
        trailing={trailing}
      />
      <p role="status" className="m-0 text-caption text-muted-foreground empty:hidden">
        {echo}
      </p>
    </Specimen>
  )
}

const TOOL_STATES: readonly ToolCallState[] = ['pending', 'running', 'done', 'error']

/** 流式模拟：定时追加字符喂给 ChatMarkdown（按顶层块增量渲染），可暂停、继续与重新播放 */
function StreamingSimulation() {
  const source = chatStreamSample(getLocale())
  const total = source.length
  const [count, setCount] = useState(0)
  const [playing, setPlaying] = useState(true)
  const done = count >= total

  useEffect(() => {
    if (!playing || done) return
    // 每 30ms 追加 4 个字符：约 130 字符 / 秒，接近真实模型的输出速度
    const timer = setInterval(() => setCount((value) => Math.min(total, value + 4)), 30)
    return () => clearInterval(timer)
  }, [playing, done, total])

  return (
    <Specimen label={m.ui_preview_chat_stream()} wide className="flex-col items-stretch">
      <div className="flex flex-wrap items-center gap-3">
        {done ? (
          <Button
            type="button"
            variant="outline"
            size="compact"
            data-stream-control="restart"
            onClick={() => {
              setCount(0)
              setPlaying(true)
            }}
          >
            {m.ui_preview_chat_stream_restart()}
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="compact"
            data-stream-control={playing ? 'pause' : 'resume'}
            onClick={() => setPlaying((value) => !value)}
          >
            {playing ? m.ui_preview_chat_stream_pause() : m.ui_preview_chat_stream_resume()}
          </Button>
        )}
        <span
          data-stream-progress={count}
          className="text-caption text-muted-foreground tabular-nums"
        >
          {m.ui_preview_chat_stream_progress({ done: format(count), total: format(total) })}
        </span>
      </div>
      <ChatMessage
        from="assistant"
        entrance={false}
        data-preview-stream=""
        {...(done ? {} : { status: 'streaming' as const })}
      >
        <ChatMarkdown
          id="preview-stream"
          markdown={source.slice(0, count)}
          streaming={!done}
          labels={chatMarkdownLabels()}
        />
      </ChatMessage>
    </Specimen>
  )
}

export function ChatComponentsSection() {
  const locale = getLocale()
  const markdownLabels = chatMarkdownLabels()
  const labels = toolLabels()
  return (
    <PreviewSection
      id="chat"
      title="ChatMessage · ThinkingSteps · ToolCall · InputMessage · ChatMarkdown"
      description={m.ui_preview_chat_desc()}
    >
      <Specimen label={m.ui_preview_chat_indicator()} className="flex-col items-stretch">
        <ChatMessage from="assistant" entrance={false} data-preview-indicator="">
          <ThinkingIndicator label={m.ui_preview_chat_thinking()} />
        </ChatMessage>
        <p className="m-0 text-caption text-muted-foreground">
          {m.ui_preview_chat_indicator_hint()}
        </p>
      </Specimen>
      <Specimen label={m.ui_preview_chat_streaming()} className="flex-col items-stretch">
        <ChatMessage from="user" entrance={false}>
          {m.ui_preview_chat_user_text()}
        </ChatMessage>
        <ChatMessage from="assistant" status="streaming" entrance={false}>
          {m.ui_preview_chat_answer_partial()}
        </ChatMessage>
      </Specimen>
      <Specimen
        label={m.ui_preview_chat_end_states()}
        wide
        className="flex-col items-stretch gap-6"
      >
        <ChatMessage
          from="assistant"
          status="aborted"
          statusLabel={m.ui_preview_chat_aborted()}
          entrance={false}
        >
          {m.ui_preview_chat_answer_stopped()}
        </ChatMessage>
        <ChatMessage
          from="assistant"
          status="incomplete"
          statusLabel={m.ui_preview_chat_incomplete()}
          statusDetail={m.ui_preview_chat_incomplete_detail()}
          entrance={false}
        >
          {m.ui_preview_chat_answer_budget()}
        </ChatMessage>
        <ChatMessage
          from="assistant"
          status="failed"
          statusLabel={m.ui_preview_chat_failed()}
          statusDetail={m.ui_preview_chat_failed_detail()}
          entrance={false}
        />
        <ChatMessage
          from="assistant"
          status="retrying"
          statusLabel={m.ui_preview_chat_retrying()}
          statusDetail={m.ui_preview_chat_retrying_detail()}
          entrance={false}
        />
        <ChatMessage
          from="assistant"
          entrance={false}
          actions={
            <MessageFeedback
              value={null}
              labels={feedbackLabels()}
              meta={m.ui_preview_biz_credits({ count: format(4) })}
              onChange={() => {}}
            />
          }
        >
          {m.ui_preview_chat_answer_done()}
        </ChatMessage>
      </Specimen>
      <Specimen label={m.ui_preview_chat_user()} wide className="flex-col items-stretch gap-4">
        <ChatMessage from="user" entrance={false}>
          {m.ui_preview_chat_user_link()}
        </ChatMessage>
        <ChatMessage from="user" status="streaming" entrance={false}>
          {m.ui_preview_chat_user_text()}
        </ChatMessage>
        <ChatMessage
          from="user"
          status="aborted"
          statusLabel={m.ui_preview_chat_aborted()}
          entrance={false}
        >
          {m.ui_preview_chat_user_text()}
        </ChatMessage>
        <ChatMessage
          from="user"
          status="incomplete"
          statusLabel={m.ui_preview_chat_incomplete()}
          statusDetail={m.ui_preview_chat_incomplete_detail()}
          entrance={false}
        >
          {m.ui_preview_chat_user_text()}
        </ChatMessage>
        <ChatMessage
          from="user"
          status="failed"
          statusLabel={m.ui_preview_chat_failed()}
          statusDetail={m.ui_preview_chat_failed_detail()}
          entrance={false}
        >
          {m.ui_preview_chat_user_text()}
        </ChatMessage>
        <ChatMessage
          from="user"
          status="retrying"
          statusLabel={m.ui_preview_chat_retrying()}
          statusDetail={m.ui_preview_chat_retrying_detail()}
          entrance={false}
        >
          {m.ui_preview_chat_user_text()}
        </ChatMessage>
      </Specimen>
      <Specimen label={m.ui_preview_chat_steps()} wide className="flex-col items-stretch gap-6">
        <ChatMessage
          from="assistant"
          entrance={false}
          leading={<Reasoning />}
          data-preview-steps="collapsed"
        >
          {m.ui_preview_chat_answer_done()}
        </ChatMessage>
        <ChatMessage
          from="assistant"
          entrance={false}
          leading={<Reasoning defaultOpen />}
          data-preview-steps="expanded"
        >
          {m.ui_preview_chat_answer_done()}
        </ChatMessage>
        <ChatMessage
          from="assistant"
          entrance={false}
          leading={<Reasoning busy defaultOpen />}
          data-preview-steps="busy"
        />
      </Specimen>
      <Specimen label={m.ui_preview_chat_tools()} wide className="flex-col items-stretch">
        {TOOL_STATES.map((state) => (
          <ToolCall
            key={state}
            data-preview-tool={state}
            name={m.ui_preview_chat_tool_name()}
            state={state}
            labels={labels}
            {...(state === 'done' ? { defaultOpen: true } : {})}
          >
            {state === 'done' ? m.ui_preview_chat_tool_detail() : undefined}
          </ToolCall>
        ))}
        <ToolCall
          data-preview-tool="generic"
          name={m.ui_preview_chat_tool_generic()}
          state="done"
          labels={labels}
        />
        <p className="m-0 text-caption text-muted-foreground">{m.ui_preview_chat_tool_hint()}</p>
      </Specimen>
      <InputSpecimen label={m.ui_preview_chat_input_empty()} />
      <InputSpecimen
        label={m.ui_preview_chat_input_multiline()}
        initial={m.ui_preview_chat_draft()}
      />
      <InputSpecimen label={m.ui_preview_chat_input_busy()} busy />
      <InputSpecimen label={m.ui_preview_chat_input_disabled()} disabled />
      <Specimen label={m.ui_preview_chat_markdown_basic()} className="flex-col items-stretch">
        <ChatMessage from="assistant" entrance={false}>
          <ChatMarkdown
            id="preview-basic"
            markdown={chatBasicSample(locale)}
            labels={markdownLabels}
          />
        </ChatMessage>
      </Specimen>
      <Specimen label={m.ui_preview_chat_markdown_safety()} className="flex-col items-stretch">
        <ChatMessage from="assistant" entrance={false} data-preview-safety="">
          <ChatMarkdown
            id="preview-safety"
            markdown={chatSafetySample(locale)}
            labels={markdownLabels}
          />
        </ChatMessage>
      </Specimen>
      <Specimen label={m.ui_preview_chat_markdown_table()} wide className="flex-col items-stretch">
        <ChatMessage
          from="assistant"
          entrance={false}
          leading={<Reasoning />}
          data-preview-table=""
        >
          <ToolCall name={m.ui_preview_chat_tool_name()} state="done" labels={labels} />
          <ChatMarkdown
            id="preview-table"
            markdown={chatTableSample(locale)}
            labels={markdownLabels}
          />
        </ChatMessage>
      </Specimen>
      <StreamingSimulation />
      <Specimen label={m.ui_preview_chat_widths()} wide className="flex-col items-start gap-6">
        {(
          [
            ['358', 'w-89.5', m.ui_preview_chat_width_narrow()],
            ['388', 'w-97', m.ui_preview_chat_width_wide()],
          ] as const
        ).map(([width, className, caption]) => (
          <div key={width} className="flex max-w-full flex-col gap-2">
            <span className="text-caption text-muted-foreground">{caption}</span>
            {/* 量宽容器不加边框与内边距（只用 ring 画边），ChatMessage 的宽度即为标注的像素值 */}
            <div
              data-preview-width={width}
              className={cn(className, 'max-w-full rounded-lg bg-background ring-1 ring-border')}
            >
              <ChatMessage from="assistant" entrance={false} leading={<Reasoning />}>
                {m.ui_preview_chat_answer_partial()}
              </ChatMessage>
            </div>
          </div>
        ))}
      </Specimen>
    </PreviewSection>
  )
}
