// 模板新增（openspec add-ui-design-system tasks 8.6，设计稿 docs/design-system/prototypes/ui-review/Chat.dc.html）：
// 推荐追问按钮组。纯展示：问题文字与分组名称由调用方传入，点击后经 onSelect 交给调用方发送。
import { forwardRef, type HTMLAttributes, useId } from 'react'
import { cn } from '../lib/utils.ts'

// 药丸按钮：设计稿 .chip（32px 高、全圆角、1px 内描边）；窄屏时长问题换行而不是撑出横向滚动
export const chipClasses = cn(
  'inline-flex min-h-8 max-w-full cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 text-left',
  'font-medium text-body text-foreground inset-ring-1 inset-ring-border',
  'transition-colors duration-80 hover:bg-hover active:bg-active',
  'outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring)',
  'disabled:pointer-events-none disabled:opacity-50',
)

interface SuggestionChipsProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  /** 已本地化的问题；为空时不渲染 */
  suggestions: readonly string[]
  /** 点击后立即作为用户消息发送（问题本身不写入历史由调用方负责） */
  onSelect: (text: string) => void
  /** 分组的可读名称（如「推荐问题」「继续追问」），由调用方按语言传入 */
  label: string
  /** 在按钮组上方显示分组名称（设计稿回复下方的「继续追问」）；默认只给读屏 */
  showLabel?: boolean
  /** 生成中或只读空间 */
  disabled?: boolean
}

const SuggestionChips = forwardRef<HTMLDivElement, SuggestionChipsProps>(
  (
    { suggestions, onSelect, label, showLabel = false, disabled = false, className, ...props },
    ref,
  ) => {
    const labelId = useId()
    if (suggestions.length === 0) return null
    const chips = suggestions.map((text, index) => (
      <button
        // 推荐问题可能重复，key 带上位置；列表只整体替换，不会重排
        // biome-ignore lint/suspicious/noArrayIndexKey: 与文字组合使用，位置变化即整组新问题
        key={`${index}:${text}`}
        type="button"
        className={chipClasses}
        disabled={disabled}
        onClick={() => onSelect(text)}
      >
        {text}
      </button>
    ))
    if (!showLabel)
      return (
        // biome-ignore lint/a11y/useSemanticElements: 按钮组不是表单字段，fieldset 会带入表单语义与默认最小宽度
        <div
          ref={ref}
          role="group"
          aria-label={label}
          className={cn('flex min-w-0 flex-wrap gap-2', className)}
          {...props}
        >
          {chips}
        </div>
      )
    return (
      <div ref={ref} className={cn('flex min-w-0 flex-col gap-2', className)} {...props}>
        <span id={labelId} className="text-caption text-muted-foreground">
          {label}
        </span>
        {/* biome-ignore lint/a11y/useSemanticElements: 按钮组不是表单字段，fieldset 会带入表单语义与默认最小宽度 */}
        <div role="group" aria-labelledby={labelId} className="flex min-w-0 flex-wrap gap-2">
          {chips}
        </div>
      </div>
    )
  },
)
SuggestionChips.displayName = 'SuggestionChips'

export type { SuggestionChipsProps }
export { SuggestionChips }
