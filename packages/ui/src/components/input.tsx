// 来源：fluid-functionalism input（2026-11，https://www.fluidfunctionalism.com/r/input.json，MIT）
// 适配：保留模板原有公开 API（原生 input 属性与 ref），吸收 Fluid 的边框、尺寸阶梯与字号；
// 焦点环改为与 Button/Select 一致的 2px 描边加间隙；未移植文件图标与数字步进按钮，见 packages/ui/UPSTREAM.md。
import type { ComponentProps } from 'react'
import { fontWeights } from '../lib/font-weight.ts'
import { useShape } from '../lib/shape-context.tsx'
import { type SizeVariant, useSize } from '../lib/size-context.tsx'
import { cn } from '../lib/utils.ts'

// 模板改动：上游聚焦时只把边框加深到 40%，不画强调色焦点环；模板的所有控件统一为 2px 描边加 2px 间隙，
// 与 Button、Select 触发器一致。文本框在鼠标点击时同样匹配 :focus-visible，这是浏览器对可输入控件的约定。
export const fieldFocusClasses =
  'focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring)'

// ---------------------------------------------------------------------------
// A single-line text field drawn like the Select trigger: a fixed --border
// hairline, the hover fill, and the ladder's height, padding and body text.
// Focus darkens the hairline to a neutral 40%, and it wins over the error
// tint while the value is being fixed.
// ---------------------------------------------------------------------------

const inputClasses = [
  'w-full min-w-0 border border-field-border bg-transparent text-foreground outline-none',
  'transition-[background-color,border-color] duration-80',
  'placeholder:text-muted-foreground',
  'hover:bg-hover',
  // 模板改动：错误边框用实色 --destructive（上游 /50 与背景只有约 2.5:1）
  'aria-invalid:border-destructive',
  // Focus wins over the error tint while the value is fixed. Tailwind sorts
  // aria-* after focus, so the invalid case needs its own stacked variant.
  'focus:border-foreground/40 aria-invalid:focus:border-foreground/40 focus:hover:bg-transparent',
  fieldFocusClasses,
  'disabled:opacity-50 disabled:pointer-events-none',
  'file:mr-2 file:cursor-pointer file:border-0 file:bg-transparent file:p-0 file:font-[inherit] file:text-[length:inherit] file:text-foreground',
]

export type InputProps = Omit<ComponentProps<'input'>, 'size'> & {
  /** Pins the field to one step of the size ladder (default 36px, compact
   *  28px). Omitted, it follows the surrounding SizeProvider. */
  size?: SizeVariant
}

export function Input({ className, size, type, style, ...props }: InputProps) {
  const shape = useShape()
  const sizeClasses = useSize(size)
  const compact = sizeClasses.variant === 'compact'

  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        inputClasses,
        shape.input,
        sizeClasses.control,
        sizeClasses.px,
        sizeClasses.field,
        // 文件选择框的文字从顶部排列，补上让文字落在中线的上下内边距：(36 - 2 - 20) / 2、(28 - 2 - 18) / 2
        type === 'file' && (compact ? 'py-1' : 'py-[7px]'),
        className,
      )}
      style={{ fontVariationSettings: fontWeights.normal, ...style }}
      {...props}
    />
  )
}
