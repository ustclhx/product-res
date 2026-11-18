// 模板新增（openspec add-ai-chat-components design D2，设计稿 docs/design-system/prototypes/chat-components/States.dc.html）：
// 工具调用的名称与状态卡片。Fluid 没有对应组件，状态划分参考 Vercel AI Elements 的 Tool：
// pending（准备中）→ running（执行中）→ done（已完成）/ error（出错）。
// 默认不渲染参数与结果（常含内部 ID、提示词片段或上游错误细节）；调用方传入 `children` 时才有可折叠的详情，
// 没有详情时头部不是按钮。纯展示：显示名与状态文字由调用方传入。
import { Check, LoaderCircle, Wrench } from 'lucide-react'
import { m as motion } from 'motion/react'
import { Collapsible } from 'radix-ui'
import { forwardRef, type HTMLAttributes, type ReactNode, useState } from 'react'
import { useIcons } from '../lib/icon-context.tsx'
import { MotionFeatures } from '../lib/motion-features.tsx'
import { useShape } from '../lib/shape-context.tsx'
import { type SizeVariant, typeClass, useSizeVariant } from '../lib/size-context.tsx'
import { spring } from '../lib/springs.ts'
import { cn } from '../lib/utils.ts'
import { CollapsePanel } from './thinking-steps.tsx'

type ToolCallState = 'pending' | 'running' | 'done' | 'error'

interface ToolCallLabels {
  /** 四种状态的徽标文字，如「准备中」「执行中」「已完成」「出错」 */
  pending: string
  running: string
  done: string
  error: string
}

interface ToolCallProps extends HTMLAttributes<HTMLDivElement> {
  /** 显示名；未登记的工具由调用方传通用文案（如「工具」），不传内部名称 */
  name: ReactNode
  state: ToolCallState
  labels: ToolCallLabels
  /** 可折叠的详情；不传时没有展开按钮 */
  children?: ReactNode
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  size?: SizeVariant
}

const BADGE: Record<ToolCallState, string> = {
  // 中性填充用 --chat-fill：深色下 --secondary 与卡片同色
  pending: 'bg-chat-fill text-muted-foreground',
  running: 'bg-fluid-accent/12 text-fluid-accent-text dark:bg-fluid-accent/18',
  // 浅色下 --success 在白底上对比度约 4.95:1，10% 底色降到 4.31:1（axe color-contrast 不通过），6% 为 4.56:1
  done: 'bg-success/6 text-success dark:bg-success/15',
  error: 'bg-destructive/10 text-destructive dark:bg-destructive/15',
}

const ToolCall = forwardRef<HTMLDivElement, ToolCallProps>(
  (
    {
      name,
      state,
      labels,
      children,
      defaultOpen = false,
      open,
      onOpenChange,
      size,
      className,
      ...props
    },
    ref,
  ) => {
    const shape = useShape()
    const icons = useIcons()
    const ChevronRight = icons['chevron-right']
    const compact = useSizeVariant(size) === 'compact'
    const [internalOpen, setInternalOpen] = useState(defaultOpen)
    const isOpen = open ?? internalOpen
    const expandable = children != null && children !== false

    const header = (
      <>
        {state === 'running' ? (
          <LoaderCircle
            aria-hidden="true"
            size={14}
            strokeWidth={2}
            className="shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
          />
        ) : (
          <Wrench
            aria-hidden="true"
            size={14}
            strokeWidth={1.5}
            className="shrink-0 text-muted-foreground"
          />
        )}
        {/* 可展开时卡片占满消息列，名称撑开，徽标靠右（States 画板），展开前后宽度不变 */}
        <span className={cn('min-w-0 truncate font-medium', expandable && 'flex-1')}>{name}</span>
        <span
          data-tool-state={state}
          className={cn(
            'inline-flex h-4.5 shrink-0 items-center gap-1 rounded-full px-1.5 font-medium',
            typeClass('caption'),
            BADGE[state],
          )}
        >
          {state === 'done' && <Check aria-hidden="true" size={11} strokeWidth={2.5} />}
          {labels[state]}
        </span>
      </>
    )
    const headerClass = cn(
      'flex w-full min-w-0 items-center gap-2 px-2.5 text-left',
      compact ? 'h-8' : 'h-8.5',
    )

    return (
      <Collapsible.Root
        ref={ref}
        open={expandable ? isOpen : false}
        onOpenChange={(next: boolean) => {
          if (open === undefined) setInternalOpen(next)
          onOpenChange?.(next)
        }}
        data-tool-call=""
        className={cn(
          // 设计稿：8px 圆角、1px 内描边、13px / 18px 文字；宽度随内容，最宽为消息列
          'flex max-w-full flex-col self-start text-foreground inset-ring inset-ring-border',
          expandable && 'w-full',
          typeClass('subtitle', 'compact'),
          shape.item,
          className,
        )}
        {...props}
      >
        {expandable ? (
          <MotionFeatures>
            <Collapsible.Trigger
              className={cn(
                headerClass,
                'cursor-pointer outline-none transition-colors duration-80 hover:bg-hover',
                'focus-visible:outline-2 focus-visible:outline-(--focus-ring) focus-visible:outline-offset-2',
                shape.item,
                // 展开时头部只保留上圆角，悬停底色与下方详情区相接
                isOpen && 'rounded-b-none',
              )}
            >
              {header}
              <motion.span
                aria-hidden="true"
                className="inline-flex shrink-0 items-center text-muted-foreground"
                initial={false}
                animate={{ rotate: isOpen ? 90 : 0 }}
                transition={spring.fast}
              >
                <ChevronRight size={14} strokeWidth={1.5} />
              </motion.span>
            </Collapsible.Trigger>
          </MotionFeatures>
        ) : (
          <div className={headerClass}>{header}</div>
        )}
        {expandable && (
          <CollapsePanel
            open={isOpen}
            className="border-border border-t pt-2 pr-3 pb-2.5 pl-8 text-caption text-muted-foreground leading-4.5 wrap-anywhere"
          >
            {children}
          </CollapsePanel>
        )}
      </Collapsible.Root>
    )
  },
)
ToolCall.displayName = 'ToolCall'

export type { ToolCallLabels, ToolCallProps, ToolCallState }
export { ToolCall }
