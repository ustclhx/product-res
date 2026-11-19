// 来源：fluid-functionalism thinking-steps（2026-11，https://www.fluidfunctionalism.com/r/thinking-steps.json，Radix 版，MIT）
// 适配：radix-ui 统一包导入、包内相对路径、去掉 "use client"、`m as motion` + MotionFeatures；其余改动见 packages/ui/UPSTREAM.md
// 模板改动（openspec add-ai-chat-components design D1，设计稿 docs/design-system/prototypes/chat-components/States.dc.html）：
// - 触发按钮按设计稿改为 28px 描边小按钮（13px 次要文字 + 右箭头，展开时转 90°）；上游的悬停滑块与
//   展开时加粗的双层文字不移植，悬停改为 bg-hover；焦点环 2px 描边加 2px 间隙；
// - 默认折叠（上游 defaultOpen = true）；标题文字必填（上游默认英文 "Thinking"）；新增 `busy`：
//   推理仍在输出时在文字前显示与 ThinkingIndicator 相同的三点；
// - 展开内容为左侧 2px 竖线 + 12px 次要文字（设计稿）；保留上游 `ThinkingStep` 步骤接口，用于推理文本时只有一步，
//   步骤的图标列与连接线不移植；ThinkingStepDetails / Sources / Image 不移植（依赖 Badge 与图片，
//   对话回复不显示图片）。
import { m as motion, useReducedMotion } from 'motion/react'
import { Collapsible } from 'radix-ui'
import {
  createContext,
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { useIcons } from '../lib/icon-context.tsx'
import { MotionFeatures } from '../lib/motion-features.tsx'
import { useShape } from '../lib/shape-context.tsx'
import { SizeProvider, type SizeVariant, typeClass, useSizeVariant } from '../lib/size-context.tsx'
import { spring } from '../lib/springs.ts'
import { cn } from '../lib/utils.ts'
import { ThinkingDots } from './thinking-indicator.tsx'

// SSR-safe layout effect (client components still server-render in Next).
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

/** Open state of the nearest ThinkingSteps root, for the header trigger/panel. */
const ThinkingStepsOpenContext = createContext(false)

interface CollapsePanelProps {
  open: boolean
  children: ReactNode
  /** 模板改动：内层（被测量的元素）的样式由调用方决定，ToolCall 的详情区共用本组件 */
  className?: string
}

/**
 * Collapsible panel with a Motion height + spring animation.
 *
 * Radix's Content would apply `hidden` the moment a collapsible closes (it
 * can't observe the JS-driven exit animation), which is `display: none` and
 * would freeze the exit mid-flight. With `forceMount` the element stays
 * mounted and Radix's internal `hidden: !isOpen` is always false (Presence
 * reports the content as permanently present), so the attribute is entirely
 * ours to manage: we apply it only once the framer exit has actually
 * completed. `asChild` keeps our own div as the rendered element, and the
 * persistent panel keeps the trigger ↔ panel ARIA contract intact (the
 * trigger's `aria-controls` id lives on it).
 */
function CollapsePanel({ open, children, className }: CollapsePanelProps) {
  // 模板改动：高度是布局属性，UiRoot 的 MotionConfig 不会去掉；减少动态效果时直接跳到终值（同 command-menu）
  const reduceMotion = useReducedMotion() ?? false
  // The open height is animated to a self-measured LAYOUT pixel value, not
  // `height: "auto"`: framer resolves an "auto" target by measuring the
  // element's *visual* (transformed) size, so under a scaled ancestor the
  // animation overshoots to scale× the real height and snaps back when the
  // final "auto" lands. offsetHeight and ResizeObserver are transform-immune.
  const innerRef = useRef<HTMLDivElement | null>(null)
  const roRef = useRef<ResizeObserver | null>(null)
  const [contentHeight, setContentHeight] = useState<number | null>(null)
  // Panels open at mount render `initial: "auto"` and receive their first
  // pixel target a commit later; that hand-off must SNAP (duration 0), not
  // spring. Panels that open later spring normally.
  const [needsSnap, setNeedsSnap] = useState(open)

  const measureRef = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect()
    roRef.current = null
    innerRef.current = el
    if (!el) return
    if (el.offsetHeight > 0) setContentHeight(el.offsetHeight)
    // 模板改动：测试环境（happy-dom 旧版）可能没有 ResizeObserver，缺失时只用打开时的测量
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      // Ignore the 0 that fires while the panel is display:none.
      if (el.offsetHeight > 0) setContentHeight(el.offsetHeight)
    })
    ro.observe(el)
    roRef.current = ro
  }, [])

  // Re-measure synchronously (pre-paint) when opening, so the spring's
  // target is the fresh layout height from its first frame.
  useIsoLayoutEffect(() => {
    if (open && innerRef.current && innerRef.current.offsetHeight > 0) {
      setContentHeight(innerRef.current.offsetHeight)
    }
  }, [open])

  // Cleared a frame after the first measured height commits: the hand-off
  // render keeps the snap, and height changes after it spring.
  useEffect(() => {
    if (!needsSnap || contentHeight === null) return
    const frame = requestAnimationFrame(() => setNeedsSnap(false))
    return () => cancelAnimationFrame(frame)
  }, [needsSnap, contentHeight])

  const [exitComplete, setExitComplete] = useState(!open)
  if (open && exitComplete) {
    // Reset during render so the panel is un-hidden before the opening
    // animation's first paint.
    setExitComplete(false)
  }

  return (
    <MotionFeatures>
      <Collapsible.Content forceMount asChild hidden={!open && exitComplete}>
        <div>
          <motion.div
            className="overflow-hidden"
            initial={{ height: open ? 'auto' : 0 }}
            // 模板改动：测量不到高度（如 happy-dom 中 offsetHeight 恒为 0）时展开到 auto，内容不会被裁成 0 高
            animate={{ height: open ? (contentHeight ?? 'auto') : 0 }}
            // bounce: 0 — pure height looks better without overshoot.
            transition={
              needsSnap || reduceMotion ? { duration: 0 } : { ...spring.moderate, bounce: 0 }
            }
            onAnimationComplete={() => {
              if (!open) setExitComplete(true)
            }}
          >
            <div ref={measureRef} className={className}>
              {children}
            </div>
          </motion.div>
        </div>
      </Collapsible.Content>
    </MotionFeatures>
  )
}

// ─── ThinkingSteps (root) ───────────────────────────────────────────────────

interface ThinkingStepsProps extends HTMLAttributes<HTMLDivElement> {
  /** Step on the size ladder. Wins over the surrounding SizeProvider and
   *  propagates to every row inside. */
  size?: SizeVariant
  /** 模板改动：默认折叠（上游默认展开） */
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children: ReactNode
}

const ThinkingSteps = forwardRef<HTMLDivElement, ThinkingStepsProps>(
  ({ size, defaultOpen = false, open, onOpenChange, children, className, ...props }, ref) => {
    // Always drive Radix as controlled so the header/panel can read the
    // open state (chevron rotation, framer enter/exit) from context.
    const [internalOpen, setInternalOpen] = useState(defaultOpen)
    const isOpen = open ?? internalOpen

    const root = (
      <Collapsible.Root
        ref={ref}
        open={isOpen}
        onOpenChange={(next: boolean) => {
          if (open === undefined) setInternalOpen(next)
          onOpenChange?.(next)
        }}
        // 模板改动：上游固定 w-80；对话中推理区随消息列宽，按钮本身按内容收缩
        className={cn('flex max-w-full flex-col items-start gap-1.5', className)}
        {...props}
      >
        <ThinkingStepsOpenContext.Provider value={isOpen}>
          {children}
        </ThinkingStepsOpenContext.Provider>
      </Collapsible.Root>
    )

    // A size prop pins every row inside to one ladder step.
    return size ? <SizeProvider size={size}>{root}</SizeProvider> : root
  },
)
ThinkingSteps.displayName = 'ThinkingSteps'

// ─── ThinkingStepsHeader ────────────────────────────────────────────────────

interface ThinkingStepsHeaderProps extends HTMLAttributes<HTMLButtonElement> {
  /** 按钮文字，如「已思考 6 秒」「思考中…」（必填，组件不带默认文案） */
  children: ReactNode
  /** 推理仍在输出：文字前显示三点 */
  busy?: boolean
}

const ThinkingStepsHeader = forwardRef<HTMLButtonElement, ThinkingStepsHeaderProps>(
  ({ children, busy = false, className, ...props }, ref) => {
    const isOpen = useContext(ThinkingStepsOpenContext)
    const icons = useIcons()
    const ChevronRight = icons['chevron-right']
    const shape = useShape()
    const compact = useSizeVariant() === 'compact'
    return (
      <MotionFeatures>
        {/* Radix's Trigger renders a <button type="button"> and takes our classes/props directly. */}
        <Collapsible.Trigger
          ref={ref}
          data-thinking-steps-trigger=""
          className={cn(
            'inline-flex h-7 max-w-full cursor-pointer select-none items-center gap-1.5 pr-2 pl-1.5 text-muted-foreground',
            'inset-ring inset-ring-border outline-none transition-colors duration-80 hover:bg-hover hover:text-foreground',
            'focus-visible:outline-2 focus-visible:outline-(--focus-ring) focus-visible:outline-offset-2',
            compact ? typeClass('caption', 'default') : typeClass('subtitle', 'compact'),
            shape.item,
            className,
          )}
          {...props}
        >
          {busy && <ThinkingDots />}
          <span className="min-w-0 truncate">{children}</span>
          {/* Chevron — right when collapsed, rotates 90° down when expanded */}
          <motion.span
            aria-hidden="true"
            className="inline-flex shrink-0 items-center justify-center"
            initial={false}
            animate={{ rotate: isOpen ? 90 : 0 }}
            transition={spring.fast}
          >
            <ChevronRight size={14} strokeWidth={1.5} />
          </motion.span>
        </Collapsible.Trigger>
      </MotionFeatures>
    )
  },
)
ThinkingStepsHeader.displayName = 'ThinkingStepsHeader'

// ─── ThinkingStepsContent ───────────────────────────────────────────────────

interface ThinkingStepsContentProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
}

const ThinkingStepsContent = forwardRef<HTMLDivElement, ThinkingStepsContentProps>(
  ({ children, className, ...props }, ref) => {
    const isOpen = useContext(ThinkingStepsOpenContext)
    return (
      <CollapsePanel open={isOpen}>
        <div
          ref={ref}
          className={cn(
            // 设计稿：左侧 2px 竖线，12px / 18px 次要文字；长词换行，不撑出消息列
            'flex flex-col gap-2 border-border border-l-2 py-0.5 pl-3 text-muted-foreground',
            'text-caption leading-4.5 wrap-anywhere',
            className,
          )}
          {...props}
        >
          {children}
        </div>
      </CollapsePanel>
    )
  },
)
ThinkingStepsContent.displayName = 'ThinkingStepsContent'

// ─── ThinkingStep ───────────────────────────────────────────────────────────

type StepStatus = 'complete' | 'active' | 'pending'

interface ThinkingStepProps {
  /** 步骤标题；推理文本只有一步时可省略 */
  label?: ReactNode
  /** 步骤正文（推理文本按原样换行显示） */
  children?: ReactNode
  status?: StepStatus
  /** Fade-in delay in seconds. */
  delay?: number
  className?: string
}

function ThinkingStep({
  label,
  children,
  status = 'complete',
  delay = 0,
  className,
}: ThinkingStepProps) {
  if (status === 'pending') return null
  return (
    <MotionFeatures>
      <motion.div
        className={cn('flex min-w-0 flex-col gap-1', className)}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.24, delay, ease: 'easeOut' }}
        data-status={status}
      >
        {label != null && <span className="font-medium text-foreground">{label}</span>}
        {children != null && <div className="whitespace-pre-wrap">{children}</div>}
      </motion.div>
    </MotionFeatures>
  )
}

export type {
  StepStatus,
  ThinkingStepProps,
  ThinkingStepsContentProps,
  ThinkingStepsHeaderProps,
  ThinkingStepsProps,
}
export { CollapsePanel, ThinkingStep, ThinkingSteps, ThinkingStepsContent, ThinkingStepsHeader }
