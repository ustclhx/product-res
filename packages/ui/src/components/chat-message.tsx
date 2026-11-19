// 来源：fluid-functionalism chat-message（2026-11，https://www.fluidfunctionalism.com/r/chat-message.json，MIT）
// 适配：包内相对路径、去掉 "use client"、`m as motion` + MotionFeatures；其余改动见 packages/ui/UPSTREAM.md
// 模板改动（openspec add-ai-chat-components design D1，设计稿 docs/design-system/prototypes/chat-components/Main.dc.html、
// States.dc.html、Mobile.dc.html、Embedded.dc.html、EmbeddedMobile.dc.html）：
// - 角色属性沿用上游 `from`（design D1 写作 `role`：与 HTML role 属性同名，Biome a11y 规则会把调用处当作无效 ARIA role）；
// - 用户消息为右侧 12px 圆角的气泡（--chat-fill 底，上游为 accent 混色），最宽 80%（消息列窄于阈值与 compact 85%）；
//   助手消息正文无底色，根节点为查询容器，按消息自身宽度切换版式（阈值 globals.css 的 --container-chat-message，
//   23rem）：窄时 24px 头像与 `leading`（推理按钮）同一行、正文与操作区通栏在下（Mobile / EmbeddedMobile 画板），
//   宽时为 28px 头像列（compact 24px）+ 内容列（Main / Embedded 画板）。用容器查询而不是视口断点，
//   对话页与嵌入式面板、底部抽屉得到同样的版式；
// - 新增 `status`（streaming / aborted / failed / incomplete / retrying）：流式中正文末尾显示闪烁光标，
//   其余四种在正文下方显示状态徽标与可选说明 `statusDetail`，已生成的正文保留；状态文字经 `statusLabel` 传入；
//   光标约定：流式时内容区带 data-chat-streaming，光标只画在其中的 [data-chat-tail] 之后（见 globals.css）；
// - 操作区（`actions`）始终可见（设计稿），上游悬停才显示；时间戳 `time` 与附件 `files` 不移植；
// - 去掉上游的 `layout="position"`（需要 domMax，本包统一 domAnimation），只保留入场动效；`entrance={false}`
//   时不播放（首屏已有的历史消息）；减少动态效果时由 UiRoot 的 MotionConfig 去掉位移与缩放，只保留淡入；
// - 长单词与长链接按 `overflow-wrap: anywhere` 换行，不撑出容器。
import { CircleAlert, LoaderCircle, Sparkle } from 'lucide-react'
import { type MotionStyle, m as motion } from 'motion/react'
import { Children, forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { MotionFeatures } from '../lib/motion-features.tsx'
import { useShape } from '../lib/shape-context.tsx'
import { type SizeVariant, typeClass, useSizeVariant } from '../lib/size-context.tsx'
import { spring } from '../lib/springs.ts'
import { cn } from '../lib/utils.ts'

type ChatMessageRole = 'user' | 'assistant'
/** 在正文下方显示徽标的结束状态 */
type ChatMessageEndStatus = 'aborted' | 'failed' | 'incomplete' | 'retrying'
type ChatMessageStatus = 'streaming' | ChatMessageEndStatus

type ChatMessageStatusProps =
  | {
      /** 无状态（已完成）或流式生成中（正文末尾显示光标） */
      status?: 'streaming'
      statusLabel?: never
      statusDetail?: never
    }
  | {
      status: ChatMessageEndStatus
      /** 徽标文字，如「已停止」「失败」（必填，组件不带默认文案） */
      statusLabel: ReactNode
      /** 徽标右侧的说明，如失败原因 */
      statusDetail?: ReactNode
    }

// 与 motion 同名的事件属性（动画 / 拖拽回调）签名不同，不透传
type ChatMessageProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  'children' | 'onAnimationStart' | 'onDrag' | 'onDragStart' | 'onDragEnd'
> &
  ChatMessageStatusProps & {
    /** Who sent the message. Drives alignment and bubble colour. */
    from: ChatMessageRole
    /** 消息内容；助手消息由调用方按内容类型组合（推理、工具调用、正文），依次竖排 */
    children?: ReactNode
    /** 助手消息头像旁的内容，如推理按钮（ThinkingSteps）；窄版式中与头像同一行 */
    leading?: ReactNode
    /** 正文下方的操作区，如复制回复与评分 */
    actions?: ReactNode
    /** 助手头像；默认为强调色圆底上的星形图标，传 `false` 不显示 */
    avatar?: ReactNode | false
    /** 是否播放入场动效；首屏渲染的历史消息传 false */
    entrance?: boolean
    /** Pins the message to one step of the size ladder. Omitted, it follows the surrounding SizeProvider. */
    size?: SizeVariant
  }

const STATUS_BADGE: Record<ChatMessageEndStatus, string> = {
  // 中性填充用 --chat-fill（半透明前景色）：深色下 --secondary 与卡片同色，嵌入式面板里会看不出底色
  aborted: 'bg-chat-fill text-muted-foreground',
  retrying: 'bg-chat-fill text-muted-foreground',
  incomplete: 'bg-warning/10 text-warning dark:bg-warning/15',
  failed: 'bg-destructive/10 text-destructive dark:bg-destructive/15',
}

function StatusIcon({ status }: { status: ChatMessageEndStatus }) {
  if (status === 'aborted') {
    // 设计稿：实心小方块（与停止按钮同一图形）
    return <span aria-hidden="true" className="size-2 shrink-0 rounded-xs bg-current" />
  }
  if (status === 'failed') return <CircleAlert aria-hidden="true" size={12} strokeWidth={2} />
  if (status === 'retrying') {
    return (
      <LoaderCircle
        aria-hidden="true"
        size={12}
        strokeWidth={2}
        className="animate-spin motion-reduce:animate-none"
      />
    )
  }
  return null
}

/** 纯文本子节点包进段落；最后一个子节点是纯文本时标上 data-chat-tail，流式光标接在它之后（globals.css） */
function wrapText(children: ReactNode) {
  const items = Children.toArray(children)
  return items.map((child, index) =>
    typeof child === 'string' || typeof child === 'number' ? (
      <p
        // biome-ignore lint/suspicious/noArrayIndexKey: 子节点顺序即内容顺序，纯文本没有其他稳定标识
        key={index}
        className="whitespace-pre-wrap"
        {...(index === items.length - 1 ? { 'data-chat-tail': '' } : {})}
      >
        {child}
      </p>
    ) : (
      child
    ),
  )
}

const ChatMessage = forwardRef<HTMLDivElement, ChatMessageProps>(
  (
    {
      from,
      status,
      statusLabel,
      statusDetail,
      actions,
      leading,
      avatar,
      entrance = true,
      children,
      size,
      className,
      style,
      ...props
    },
    ref,
  ) => {
    const shape = useShape()
    const compact = useSizeVariant(size) === 'compact'
    const isUser = from === 'user'
    const endStatus = status && status !== 'streaming' ? status : null
    const hasContent = children != null && children !== '' && children !== false

    const statusRow = endStatus && (
      <div data-chat-status={endStatus} className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className={cn(
            'inline-flex h-5 items-center gap-1 rounded-full px-2 font-medium',
            typeClass('caption'),
            STATUS_BADGE[endStatus],
          )}
        >
          <StatusIcon status={endStatus} />
          {statusLabel}
        </span>
        {statusDetail != null && (
          <span className={cn('min-w-0 text-muted-foreground', typeClass('caption'))}>
            {statusDetail}
          </span>
        )}
      </div>
    )

    const actionsRow = actions != null && (
      // 设计稿：28px 图标按钮，左缘外移 6px 与正文对齐
      <div
        data-chat-actions=""
        className={cn('flex items-center gap-0.5', isUser ? 'self-end' : '-ml-1.5')}
      >
        {actions}
      </div>
    )

    // 助手消息的版式：头像格、leading 与正文区放进两列网格（见文件头说明）
    function assistantLayout() {
      const hasLeading = leading != null && leading !== false
      const body = (hasContent || statusRow || actionsRow) && (
        <div
          data-chat-body=""
          className={cn(
            'flex min-w-0 flex-col gap-2',
            avatar !== false &&
              cn(
                // 窄：通栏在头像行之下；宽：内容列
                'col-span-2 row-start-2 @chat-message:col-span-1 @chat-message:col-start-2',
                !hasLeading && '@chat-message:row-start-1',
              ),
          )}
        >
          {hasContent && (
            <div
              data-chat-content=""
              className={cn('flex min-w-0 flex-col gap-2 text-foreground wrap-anywhere')}
              {...(status === 'streaming' ? { 'data-chat-streaming': '' } : {})}
            >
              {wrapText(children)}
            </div>
          )}
          {statusRow}
          {actionsRow}
        </div>
      )
      const leadingCell = hasLeading && (
        <div
          data-chat-leading=""
          className={cn('min-w-0', avatar !== false && 'col-start-2 row-start-1')}
        >
          {leading}
        </div>
      )
      if (avatar === false) {
        return (
          <div className="flex min-w-0 flex-col gap-2">
            {leadingCell}
            {body}
          </div>
        )
      }
      return (
        <div
          data-chat-layout=""
          className={cn(
            // 两列网格：头像列 + 内容列。窄版式头像与 leading 垂直居中成一行，宽版式顶端对齐
            'grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 @chat-message:items-start',
            compact ? '@chat-message:gap-x-2.5' : '@chat-message:gap-x-3',
          )}
        >
          <div data-chat-avatar-cell="" className="col-start-1 row-start-1 flex">
            {avatar ?? (
              <span
                aria-hidden="true"
                data-chat-avatar=""
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground',
                  !compact && '@chat-message:size-7',
                )}
              >
                <Sparkle size={compact ? 12 : 14} strokeWidth={2} />
              </span>
            )}
          </div>
          {leadingCell}
          {body}
        </div>
      )
    }

    return (
      <MotionFeatures>
        <motion.div
          ref={ref}
          data-chat-role={from}
          data-status={status}
          aria-busy={status === 'streaming' || status === 'retrying' ? true : undefined}
          initial={entrance ? { opacity: 0, y: 8, scale: 0.96 } : false}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={spring.moderate}
          style={{
            ...(style as MotionStyle),
            transformOrigin: isUser ? 'bottom right' : 'bottom left',
          }}
          className={cn(
            'flex min-w-0',
            typeClass('subtitle', 'default'),
            isUser
              ? // 同样是查询容器：气泡宽度与内边距随消息列宽度变化（嵌入式面板与对话页一致），不看视口
                'w-full flex-col items-end gap-1.5 self-end @container'
              : // 查询容器：版式随消息自身宽度变化（@chat-message: 即宽度 ≥ --container-chat-message）
                'w-full flex-col self-start @container',
            className,
          )}
          {...props}
        >
          {isUser ? (
            <>
              {hasContent && (
                <div
                  className={cn(
                    'min-w-0 max-w-17/20 whitespace-pre-wrap bg-chat-fill text-foreground wrap-anywhere',
                    shape.container,
                    compact
                      ? 'px-3 py-2.25'
                      : 'px-3 py-2.25 @chat-message:max-w-4/5 @chat-message:px-3.5 @chat-message:py-2.5',
                  )}
                >
                  {children}
                </div>
              )}
              {statusRow}
              {actionsRow}
            </>
          ) : (
            assistantLayout()
          )}
        </motion.div>
      </MotionFeatures>
    )
  },
)
ChatMessage.displayName = 'ChatMessage'

export type { ChatMessageEndStatus, ChatMessageProps, ChatMessageRole, ChatMessageStatus }
export { ChatMessage }
