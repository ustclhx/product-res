// 来源：fluid-functionalism radix/button（2026-11，https://www.fluidfunctionalism.com/r/button.json，MIT）
// 适配：保留模板原有公开 API（variant/size/asChild、buttonVariants），吸收 Fluid 的样式、尺寸阶梯、
// 按压收缩与加载态；详见 packages/ui/UPSTREAM.md。
import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import type { ComponentProps } from 'react'
import type { IconComponent } from '../lib/icon-context.tsx'
import { useShape } from '../lib/shape-context.tsx'
import { useSizeVariant } from '../lib/size-context.tsx'
import { cn } from '../lib/utils.ts'

// 底色画在 ::before 上：它比按钮小 1px，再用同色 1px 外圈（ring）补回整个尺寸；按下时外圈收为 0，
// 底色每边正好收 1px，任何宽度下都一致（缩放会让宽按钮横向收得更多）。上游用内部 span 实现，
// 这里改为伪元素，按钮内部仍只有调用方的子元素，现有调用方与 SSR 断言不受影响。
// 强调色取 --primary（上游取 --foreground），主题预设改它即可换色。悬停 / 按下用 color-mix
// 掺黑加深（上游降不透明度），保证按钮文字在各状态下的对比度。
const surface =
  'before:pointer-events-none before:absolute before:inset-px before:-z-10 before:rounded-[inherit] before:transition-[box-shadow,background-color] before:[transition-duration:180ms,80ms] before:[transition-timing-function:cubic-bezier(0.23,1,0.32,1),ease] active:before:[transition-duration:80ms,80ms]'

const primary =
  'text-primary-foreground before:bg-primary before:ring-1 before:ring-primary hover:before:bg-[color-mix(in_oklab,var(--primary)_88%,black)] hover:before:ring-[color-mix(in_oklab,var(--primary)_88%,black)] active:before:bg-[color-mix(in_oklab,var(--primary)_78%,black)] active:before:ring-0'
const tertiary =
  'text-foreground before:ring-1 before:ring-border hover:before:bg-hover active:before:bg-active active:before:ring-0 active:before:inset-ring-1 active:before:inset-ring-border'

export const buttonVariants = cva(
  [
    'group/button relative isolate inline-flex shrink-0 cursor-pointer select-none items-center justify-center whitespace-nowrap outline-none',
    'transition-colors duration-80',
    // 加载中的按钮同样 disabled，但保持原有强度：aria-busy 表示「处理中」而不是「不可用」
    'disabled:pointer-events-none disabled:not-aria-busy:opacity-50',
    // 焦点环：2px 描边加 2px 间隙，环落在页面背景上，与按钮底色无关
    'focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring)',
    'aria-invalid:ring-1 aria-invalid:ring-destructive',
    "[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
    surface,
  ],
  {
    variants: {
      variant: {
        // default 即 Fluid 的 primary：实心强调色
        default: primary,
        primary,
        // Fluid 的 destructive：红色浅底配红字，比实心红更克制
        destructive:
          'text-destructive before:bg-destructive/10 before:ring-1 before:ring-destructive/10 hover:before:bg-destructive/15 hover:before:ring-destructive/15 active:before:bg-destructive/10 active:before:ring-0 dark:before:bg-destructive/15 dark:before:ring-destructive/15 dark:hover:before:bg-destructive/20 dark:hover:before:ring-destructive/20 dark:active:before:bg-destructive/15',
        // outline 即 Fluid 的 tertiary：1px 边框圈，按下时边框向内收
        outline: tertiary,
        tertiary,
        // secondary：半透明 tint，能透出所在表面
        secondary:
          'text-foreground before:bg-tint before:ring-1 before:ring-tint hover:before:bg-tint-hover hover:before:ring-tint-hover active:before:bg-tint active:before:ring-0',
        ghost:
          'text-muted-foreground hover:text-foreground hover:before:bg-hover hover:before:ring-1 hover:before:ring-hover active:before:bg-active active:before:ring-0',
        // link 为模板原有变体，Fluid 无对应：不画底色层
        // 文字色用 --primary-text（深色预设下实心主按钮色作文字不足 4.5:1）
        link: 'text-primary-text underline-offset-4 before:hidden hover:underline',
      },
      // 尺寸阶梯：default 36px、compact 28px（Fluid）；sm 32px、lg 40px 为模板原有尺寸，保持兼容
      size: {
        default: 'h-9 gap-1.5 px-4 text-body has-[>svg]:px-3',
        sm: 'h-8 gap-1.5 px-3 text-body has-[>svg]:px-2.5',
        lg: 'h-10 gap-2 px-6 text-body has-[>svg]:px-4',
        compact: 'h-7 gap-1 px-3 text-(length:--fs-body-compact) leading-(--lh-body-compact)',
        icon: 'size-9 p-0',
        'icon-compact': "size-7 p-0 [&_svg:not([class*='size-'])]:size-3.5",
        'icon-sm': "size-7 p-0 [&_svg:not([class*='size-'])]:size-3.5",
      },
      iconLeft: { true: '' },
      iconRight: { true: '' },
    },
    // 图标比文字离边缘近 4px：default 12px、compact 8px
    compoundVariants: [
      { size: 'compact', iconLeft: true, className: 'pl-2' },
      { size: ['default', 'sm', 'lg'], iconLeft: true, className: 'pl-3' },
      { size: 'compact', iconRight: true, className: 'pr-2' },
      { size: ['default', 'sm', 'lg'], iconRight: true, className: 'pr-3' },
    ],
    defaultVariants: { variant: 'default' },
  },
)

type ButtonVariantProps = VariantProps<typeof buttonVariants>

export type ButtonProps = ComponentProps<'button'> &
  Omit<ButtonVariantProps, 'iconLeft' | 'iconRight'> & {
    /** 把样式交给唯一的子元素（如 `<a>` 或路由的 `<Link>`），不渲染 `<button>` */
    asChild?: boolean
    /** 加载中：禁用点击并显示转圈，文字保持占位，按钮宽度不跳动 */
    loading?: boolean
    leadingIcon?: IconComponent
    trailingIcon?: IconComponent
  }

function Spinner({ size }: { size: number }) {
  // 两段弧每秒缓动转一圈；减少动态效果时放慢到 2 秒
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" fill="none">
      <g className="origin-center animate-[spinner-turn_1s_cubic-bezier(0.65,0,0.35,1)_infinite] [transform-box:fill-box] motion-reduce:[animation-duration:2s]">
        <circle
          cx="8"
          cy="8"
          r="6.25"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          pathLength="100"
          transform="rotate(-90 8 8)"
          className="animate-[spinner-breathe_1s_cubic-bezier(0.65,0,0.35,1)_infinite] motion-reduce:[animation-duration:2s]"
        />
      </g>
    </svg>
  )
}

export function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  leadingIcon: LeadingIcon,
  trailingIcon: TrailingIcon,
  children,
  ...props
}: ButtonProps) {
  const shape = useShape()
  // 未指定尺寸时跟随外层 SizeProvider（ui.density = compact 时为 28px）
  const density = useSizeVariant()
  const resolvedSize = size ?? (density === 'compact' ? 'compact' : 'default')
  const compact = resolvedSize === 'compact' || resolvedSize.startsWith('icon-')
  const iconSize = compact ? 14 : 16
  const iconOnly = resolvedSize.startsWith('icon')
  const Comp = asChild ? Slot.Root : 'button'

  // asChild 时 Slot 只接受一个子元素，加载态与图标只用于原生按钮；无附加内容时子元素原样输出
  const content =
    asChild || (!loading && !LeadingIcon && !TrailingIcon) ? (
      children
    ) : (
      <>
        {loading ? (
          <span className="absolute inset-0 flex items-center justify-center">
            <Spinner size={iconSize} />
          </span>
        ) : null}
        {/* 加载中只隐藏文字的绘制：visibility:hidden 会把文字移出无障碍树，按钮失去可读名称 */}
        <span
          className={cn(
            'inline-flex items-center justify-center gap-[inherit]',
            loading && 'opacity-0',
          )}
        >
          {LeadingIcon && !iconOnly ? <LeadingIcon size={iconSize} strokeWidth={1.5} /> : null}
          {children}
          {TrailingIcon && !iconOnly ? <TrailingIcon size={iconSize} strokeWidth={1.5} /> : null}
        </span>
      </>
    )

  return (
    <Comp
      data-slot="button"
      className={cn(
        buttonVariants({
          variant,
          size: resolvedSize,
          iconLeft: !iconOnly && !!LeadingIcon,
          iconRight: !iconOnly && !!TrailingIcon,
        }),
        variant !== 'link' && shape.button,
        className,
      )}
      {...props}
      // 加载中强制禁用；disabled 仍随 props 原样传递，属性顺序与现有调用方的 SSR 输出一致
      {...(loading && !asChild && { disabled: true, 'aria-busy': true })}
    >
      {content}
    </Comp>
  )
}
