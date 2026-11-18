// 来源：fluid-functionalism input-message（2026-11，https://www.fluidfunctionalism.com/r/input-message.json，MIT）
// 适配：包内相对路径、去掉 "use client"、`m as motion` + MotionFeatures；其余改动见 packages/ui/UPSTREAM.md
// 模板改动（openspec add-ai-chat-components design D1，设计稿 docs/design-system/prototypes/chat-components/States.dc.html、
// Main.dc.html、Mobile.dc.html）：
// - 只保留输入框、自适应高度与发送 / 停止按钮。不移植附件（拖放、文件选择、file-thumbnail）、生成中排队、
//   历史消息上下翻、推荐提示与 Tab 补全：对话没有上传能力，推荐问题由 SuggestionChips 负责，以后需要时按上游合并；
// - 插槽改名 `leading`（左下：模型选择、Thinking 开关）/ `trailing`（右下、发送按钮之前：预计消耗），不再接受函数形式；
// - 英文默认文案（"Ask me anything…"、"Send"、"Stop"、"Message"）改为必填的 `placeholder` 与 `labels`；
// - 生成中（`busy`）发送按钮换成停止按钮（上游有草稿时为排队）；同一个按钮元素换图标，切换时若焦点在按钮上
//   移到输入框，不会因按钮变为不可用而丢到页面开头；Enter 发送、Shift+Enter 换行、输入法组字（isComposing）
//   不发送；空内容、`disabled`、`sendDisabled`（如没有可用模型）与生成中不发送；
// - 外观按设计稿：12px 圆角、1px 边框、卡片底与小阴影，输入区 12px / 14px 内边距（输入区窄于 --container-chat-message
//   与 compact 时 10px / 12px，容器查询），底栏 32px 按钮；不可用时 --chat-fill 底并降低不透明度；焦点在输入框时整个外框画 2px 焦点环（上游为边框加深）；
// - 高度随内容增长：支持 `field-sizing: content` 的浏览器由 CSS 完成，其余浏览器回退为上游的脚本测量，
//   约 8 行（max-h-44）后框内滚动。
import { ArrowUp } from 'lucide-react'
import { AnimatePresence, m as motion } from 'motion/react'
import {
  forwardRef,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react'
import { MotionFeatures } from '../lib/motion-features.tsx'
import { useShape } from '../lib/shape-context.tsx'
import {
  fieldTouchClass,
  type SizeVariant,
  typeClass,
  useSizeVariant,
} from '../lib/size-context.tsx'
import { spring } from '../lib/springs.ts'
import { cn } from '../lib/utils.ts'
import { Button } from './button.tsx'

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

interface InputMessageLabels {
  /** 输入框的可读名称，如「消息」 */
  message: string
  /** 发送按钮的可读名称 */
  send: string
  /** 停止按钮的可读名称，如「停止生成」 */
  stop: string
}

interface InputMessageProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  /** Controlled textarea value. */
  value: string
  /** Called with the new value on every textarea change. */
  onValueChange: (value: string) => void
  /** 发送（Enter 或发送按钮），参数为去掉首尾空白的内容；清空草稿由调用方决定 */
  onSend: (value: string) => void
  /** 生成中点击停止按钮 */
  onStop?: () => void
  /** 正在生成回复：发送按钮换成停止按钮，Enter 不发送 */
  busy?: boolean
  /** 整体不可用（如只读空间）：输入框与按钮都禁用 */
  disabled?: boolean
  /** 只禁止发送，输入框仍可编辑（如没有可用模型、余额不足） */
  sendDisabled?: boolean
  /** 占位文字（必填，组件不带默认文案） */
  placeholder: string
  labels: InputMessageLabels
  /** 左下角：模型选择、Thinking 开关等 */
  leading?: ReactNode
  /** 右下角、发送按钮之前：预计消耗等说明 */
  trailing?: ReactNode
  /** When false, clicking the surrounding container won't refocus the textarea. */
  clickToFocus?: boolean
  /** 输入框元素的 ref（如外部「回到输入框」） */
  textareaRef?: Ref<HTMLTextAreaElement>
  /** Extra props forwarded to the underlying textarea（不能覆盖 value、事件、disabled、placeholder 与 aria-label） */
  textareaProps?: Omit<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    'value' | 'onChange' | 'onKeyDown' | 'disabled' | 'placeholder'
  >
  /** Step on the size ladder. Wins over the surrounding SizeProvider. */
  size?: SizeVariant
}

/** 浏览器是否支持 `field-sizing: content`（只在客户端判断，结果不变） */
let fieldSizingSupport: boolean | null = null
function supportsFieldSizing() {
  if (fieldSizingSupport === null) {
    fieldSizingSupport =
      typeof CSS !== 'undefined' &&
      typeof CSS.supports === 'function' &&
      CSS.supports('field-sizing', 'content')
  }
  return fieldSizingSupport
}

const InputMessage = forwardRef<HTMLDivElement, InputMessageProps>(
  (
    {
      value,
      onValueChange,
      onSend,
      onStop,
      busy = false,
      disabled = false,
      sendDisabled = false,
      placeholder,
      labels,
      leading,
      trailing,
      clickToFocus = true,
      textareaProps,
      textareaRef: externalTextareaRef,
      size,
      className,
      ...props
    },
    ref,
  ) => {
    const shape = useShape()
    const compact = useSizeVariant(size) === 'compact'
    const textareaRef = useRef<HTMLTextAreaElement | null>(null)
    // 内部 ref 与调用方的 textareaRef 合并
    const setTextareaRef = useCallback(
      (el: HTMLTextAreaElement | null) => {
        textareaRef.current = el
        if (typeof externalTextareaRef === 'function') externalTextareaRef(el)
        else if (externalTextareaRef) externalTextareaRef.current = el
      },
      [externalTextareaRef],
    )
    const actionRef = useRef<HTMLButtonElement>(null)
    // 焦点是否在发送 / 停止按钮上。按钮变为不可用时浏览器不一定触发 blur，所以自己记录
    const actionFocused = useRef(false)

    const trimmed = value.trim()
    const canSend = !disabled && !sendDisabled && !busy && trimmed.length > 0
    const mode: 'send' | 'stop' = busy ? 'stop' : 'send'

    // 不支持 field-sizing 的浏览器：上游的脚本测量，上限取 CSS 的 max-height
    const resizeTextarea = useCallback(() => {
      const el = textareaRef.current
      if (!el || supportsFieldSizing()) return
      el.style.height = 'auto'
      const max = Number.parseFloat(getComputedStyle(el).maxHeight)
      const next = Number.isNaN(max) ? el.scrollHeight : Math.min(el.scrollHeight, max)
      el.style.height = `${next}px`
      el.style.overflowY = !Number.isNaN(max) && el.scrollHeight > max ? 'auto' : 'hidden'
    }, [])

    useIsoLayoutEffect(() => {
      resizeTextarea()
    }, [value, resizeTextarea])

    // Re-measure when the textarea's width changes (the mount-time pass can run at near-zero width).
    useEffect(() => {
      const el = textareaRef.current
      if (!el || supportsFieldSizing() || typeof ResizeObserver === 'undefined') return
      let lastWidth = el.offsetWidth
      const ro = new ResizeObserver(() => {
        const width = el.offsetWidth
        if (width === lastWidth) return
        lastWidth = width
        resizeTextarea()
      })
      ro.observe(el)
      return () => ro.disconnect()
    }, [resizeTextarea])

    // 发送 ⇄ 停止切换时，焦点在按钮上就移到输入框：停止后按钮多半变为不可用（草稿为空），焦点会落到 body
    const previousBusy = useRef(busy)
    useIsoLayoutEffect(() => {
      if (previousBusy.current === busy) return
      previousBusy.current = busy
      const active = typeof document !== 'undefined' ? document.activeElement : null
      if (actionFocused.current || active === actionRef.current) {
        actionFocused.current = false
        textareaRef.current?.focus()
      }
    }, [busy])

    const handleSend = useCallback(() => {
      if (!canSend) return
      onSend(trimmed)
    }, [canSend, onSend, trimmed])

    const handleKeyDown = useCallback(
      (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
        // 输入法组字中的 Enter 只确认候选词（Safari 组字结束的 keydown 报 keyCode 229）
        if (e.nativeEvent.isComposing || e.keyCode === 229) return
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          handleSend()
        }
      },
      [handleSend],
    )

    const handleContainerMouseDown = useCallback(
      (e: ReactMouseEvent<HTMLDivElement>) => {
        if (!clickToFocus || disabled) return
        const target = e.target as HTMLElement
        if (target === textareaRef.current) return
        if (
          target.closest(
            'button, a, input, select, textarea, [contenteditable], [role="button"], [role="switch"], label',
          )
        ) {
          return
        }
        e.preventDefault()
        textareaRef.current?.focus()
      },
      [clickToFocus, disabled],
    )

    const { className: textareaClassName, ...restTextareaProps } = textareaProps ?? {}

    return (
      <MotionFeatures>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: 点击外框空白处把焦点交给输入框（上游行为），键盘用户直接 Tab 到输入框 */}
        <div
          ref={ref}
          data-input-message=""
          data-busy={busy || undefined}
          onMouseDown={handleContainerMouseDown}
          className={cn(
            'flex w-full min-w-0 flex-col border border-border shadow-sm transition-[background-color,opacity] duration-80',
            'has-[textarea:focus-visible]:outline-2 has-[textarea:focus-visible]:outline-(--focus-ring) has-[textarea:focus-visible]:outline-offset-2',
            shape.container,
            // 不可用：设计稿浅色更灰、深色更亮，用半透明的 --chat-fill（深色下 bg-muted 比卡片更暗）
            disabled ? 'bg-chat-fill opacity-85' : 'bg-card',
            clickToFocus && !disabled && 'cursor-text',
            className,
          )}
          {...props}
        >
          {/* 查询容器：内边距随输入区自身宽度变化（嵌入式面板与对话页一致），不看视口。放在内层而不是根节点：
              根节点作为 inline-size 容器时，在 flex-col flex-wrap 父级中 Chromium 会把它的高度撑大（92px → 220px） */}
          <div data-input-message-body="" className="flex min-w-0 flex-col @container">
            <textarea
              // 调用方的属性先展开，下面的受控值、事件与可读名称不会被覆盖
              {...restTextareaProps}
              ref={setTextareaRef}
              value={value}
              onChange={(e) => onValueChange(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={disabled}
              placeholder={placeholder}
              rows={1}
              aria-label={labels.message}
              className={cn(
                'field-sizing-content block max-h-44 w-full resize-none overflow-y-auto bg-transparent text-foreground outline-none',
                'placeholder:text-muted-foreground disabled:cursor-not-allowed',
                typeClass('body'),
                fieldTouchClass,
                compact
                  ? 'min-h-8.5 px-3 pt-2.5 pb-0.5'
                  : 'min-h-8.5 px-3 pt-2.5 pb-0.5 @chat-message:min-h-11 @chat-message:px-3.5 @chat-message:pt-3 @chat-message:pb-1',
                textareaClassName,
              )}
            />
            <div
              className={cn(
                'flex min-w-0 items-center',
                compact
                  ? 'gap-1 px-1.5 pt-1 pb-1.5'
                  : 'gap-1 px-1.5 pt-1 pb-1.5 @chat-message:gap-1.5 @chat-message:px-2 @chat-message:pt-1.5 @chat-message:pb-2',
              )}
            >
              <div className="flex min-w-0 items-center gap-1 @chat-message:gap-1.5">{leading}</div>
              <span className="flex-1" />
              {trailing != null && (
                <div className={cn('min-w-0 text-muted-foreground', typeClass('caption'))}>
                  {trailing}
                </div>
              )}
              <Button
                ref={actionRef}
                type="button"
                variant="primary"
                size="icon"
                className="size-8"
                data-action={mode}
                aria-label={mode === 'stop' ? labels.stop : labels.send}
                disabled={mode === 'stop' ? disabled || !onStop : !canSend}
                onClick={mode === 'stop' ? onStop : handleSend}
                onFocus={() => {
                  actionFocused.current = true
                }}
                onBlur={() => {
                  actionFocused.current = false
                }}
              >
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span
                    key={mode}
                    initial={{ opacity: 0, scale: 0.6 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.6, transition: spring.fast.exit }}
                    transition={spring.fast}
                    className="flex items-center justify-center leading-none"
                  >
                    {mode === 'stop' ? (
                      <span aria-hidden="true" className="size-2.5 rounded-xs bg-current" />
                    ) : (
                      <ArrowUp aria-hidden="true" className="size-4" strokeWidth={1.75} />
                    )}
                  </motion.span>
                </AnimatePresence>
              </Button>
            </div>
          </div>
        </div>
      </MotionFeatures>
    )
  },
)
InputMessage.displayName = 'InputMessage'

export type { InputMessageLabels, InputMessageProps }
export { InputMessage }
