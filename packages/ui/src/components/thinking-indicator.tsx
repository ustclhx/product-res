// 来源：fluid-functionalism thinking-indicator（2026-11，https://www.fluidfunctionalism.com/r/thinking-indicator.json，MIT）
// 适配：包内相对路径、去掉 "use client"；其余改动见 packages/ui/UPSTREAM.md
// 模板改动（openspec add-ai-chat-components design D1，设计稿 docs/design-system/prototypes/chat-components/States.dc.html）：
// - 外观按设计稿改为「三个圆点 + 文字」：上游的圆 ⇄ ∞ 变形图标与轮换英文词（Thinking / Moonwalking…）不移植，
//   文字由调用方经 `label` 传入（上游写死英文）；
// - 去掉上游根节点的 role="status"：对话页另有只在状态变化时写入的播报区域（design D6），
//   这里再设实时区域会重复朗读；
// - 三点用 CSS 关键帧（globals.css 的 animate-chat-dot）而不是 motion：减少动态效果时由 motion-reduce:animate-none
//   静止，服务端渲染即生效，不依赖 useReducedMotion 在客户端换元素。
import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { type SizeVariant, typeClass, useSizeVariant } from '../lib/size-context.tsx'
import { cn } from '../lib/utils.ts'

const DOT_DELAYS = ['[animation-delay:0ms]', '[animation-delay:150ms]', '[animation-delay:300ms]']

/** 三个依次明暗的圆点；ThinkingStepsHeader 的「思考中」状态共用 */
function ThinkingDots({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-thinking-dots=""
      className={cn('inline-flex gap-0.75', className)}
    >
      {DOT_DELAYS.map((delay) => (
        <span
          key={delay}
          className={cn(
            'size-1.25 rounded-full bg-current opacity-25 animate-chat-dot motion-reduce:animate-none motion-reduce:opacity-100',
            delay,
          )}
        />
      ))}
    </span>
  )
}

interface ThinkingIndicatorProps extends HTMLAttributes<HTMLDivElement> {
  /** 显示的文字，如「正在思考」（必填，组件不带默认文案） */
  label: ReactNode
  /** Show the dots before the label. Set to `false` for a text-only indicator. */
  showIcon?: boolean
  /** Step on the size ladder. Wins over the surrounding SizeProvider. */
  size?: SizeVariant
}

const ThinkingIndicator = forwardRef<HTMLDivElement, ThinkingIndicatorProps>(
  ({ label, className, showIcon = true, size, ...props }, ref) => {
    const compact = useSizeVariant(size) === 'compact'
    return (
      <div
        ref={ref}
        data-thinking-indicator=""
        className={cn(
          'inline-flex h-7 items-center gap-1.5 self-start pr-2 pl-1.5 text-muted-foreground',
          // 设计稿 13px / 18px，即 subtitle 角色的紧凑档；compact 再降一档
          compact ? typeClass('caption', 'default') : typeClass('subtitle', 'compact'),
          className,
        )}
        {...props}
      >
        {showIcon && <ThinkingDots />}
        <span>{label}</span>
      </div>
    )
  },
)
ThinkingIndicator.displayName = 'ThinkingIndicator'

export type { ThinkingIndicatorProps }
export { ThinkingDots, ThinkingIndicator }
