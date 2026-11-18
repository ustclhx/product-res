// 来源：fluid-functionalism badge（2026-11，https://www.fluidfunctionalism.com/r/badge.json，MIT）
// 适配：包内相对路径、去掉 "use client"；色值移入 globals.css 的 --badge-* 变量，其余改动见 packages/ui/UPSTREAM.md
import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef, type HTMLAttributes } from 'react'
import { useShape } from '../lib/shape-context.tsx'
import { useSizeVariant } from '../lib/size-context.tsx'
import { cn } from '../lib/utils.ts'

// ---------------------------------------------------------------------------
// Badge is a short label for status, category or metadata, in 3 variants:
//   solid: a light tint of the color behind foreground text.
//   dot:   a neutral outline and foreground text; only the dot is colored.
//   ghost: the dot and its label alone, no outline and no side padding, in
//          the surrounding text color. For rows and tables, where the label
//          lines up with the column and lifts with the row.
// Each color is a single value. The solid tint is mixed against the page
// background at render time, so the same color works in light and dark themes.
// ---------------------------------------------------------------------------

// Tailwind's 500 step for each hue (400 for gray). Text never takes the hue:
// it stays on the foreground color, so it keeps its contrast on every color.
// `accent` is the app's accent (--fluid-accent), for marks like New that
// should follow the brand color.
// 模板改动：组件不写死颜色，上游的色值放在 globals.css 的 --badge-<色名> 变量中（预设与品牌层可覆盖）
const badgeColors = {
  accent: 'var(--fluid-accent)',
  gray: 'var(--badge-gray)',
  red: 'var(--badge-red)',
  orange: 'var(--badge-orange)',
  amber: 'var(--badge-amber)',
  yellow: 'var(--badge-yellow)',
  lime: 'var(--badge-lime)',
  green: 'var(--badge-green)',
  emerald: 'var(--badge-emerald)',
  teal: 'var(--badge-teal)',
  cyan: 'var(--badge-cyan)',
  blue: 'var(--badge-blue)',
  indigo: 'var(--badge-indigo)',
  violet: 'var(--badge-violet)',
  purple: 'var(--badge-purple)',
  fuchsia: 'var(--badge-fuchsia)',
  pink: 'var(--badge-pink)',
  rose: 'var(--badge-rose)',
} as const

type BadgeColor = keyof typeof badgeColors

const badgeVariants = cva('inline-flex items-center whitespace-nowrap', {
  variants: {
    variant: {
      solid: '',
      dot: 'border border-border text-foreground',
      ghost: '',
    },
    // The two-step size ladder shared by every control: 24px tall by
    // default, 20px compact. The height is fixed rather than padded so the
    // trimmed label below can't shrink the badge.
    size: {
      default:
        'h-6 px-2.5 text-[length:var(--fs-caption,12px)] leading-[var(--lh-caption,16px)] gap-1.5',
      compact:
        'h-5 px-2 text-[length:var(--fs-caption-compact,11px)] leading-[var(--lh-caption-compact,14px)] gap-1',
    },
  },
  // Ghost has nothing to pad away from, so its dot sits on the edge.
  compoundVariants: [{ variant: 'ghost', className: 'px-0' }],
  defaultVariants: {
    variant: 'solid',
    size: 'default',
  },
})

// 模板改动：只公开尺寸阶梯的两档；上游为兼容旧版保留的 sm / md / lg 别名不移植（模板没有旧调用方）
type BadgeSize = 'default' | 'compact'

interface BadgeProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, 'color'>,
    Omit<VariantProps<typeof badgeVariants>, 'size'> {
  color?: BadgeColor
  /** Omitted, the badge follows the surrounding SizeProvider. */
  size?: BadgeSize
}

const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  (
    { className, variant = 'solid', size: sizeProp, color = 'gray', children, style, ...props },
    ref,
  ) => {
    // Corner radius comes from the shape context (rounded, pill or sharp), so
    // badges follow the rest of the app instead of hard-coding a radius.
    const shape = useShape()
    // Resolve the size: explicit prop > surrounding SizeProvider > default.
    const contextSize = useSizeVariant()
    const size: BadgeSize = sizeProp ?? (contextSize === 'compact' ? 'compact' : 'default')
    const colorValue = badgeColors[color]
    const isSolid = variant === 'solid'
    const dotSize = size === 'compact' ? 6 : 7

    // 15% of the hue mixed into the page background: a tint that sits at the
    // right depth in either theme, under plain foreground text. Gray skips
    // the mix and takes the theme's neutral fill (`--neutral-fill`). 模板改动：
    // 不用 `--accent`——衍生项目常把它改成品牌主色，灰色徽标会随之变色、对比度不足。
    const colorStyle = isSolid
      ? color === 'gray'
        ? { backgroundColor: 'var(--neutral-fill)', color: 'var(--foreground)' }
        : {
            color: 'var(--foreground)',
            backgroundColor: `color-mix(in srgb, ${colorValue} 15%, var(--background))`,
          }
      : {}

    // The dot carries the full-strength hue. Gray uses the theme's muted text
    // color instead, so the neutral dot stays visible in both themes.
    const dotColor = color === 'gray' ? 'var(--muted-foreground)' : colorValue

    return (
      <span
        ref={ref}
        className={cn(badgeVariants({ variant, size }), shape.item, className)}
        style={{ ...colorStyle, ...style }}
        {...props}
      >
        {!isSolid && (
          <span
            aria-hidden="true"
            className="shrink-0 rounded-full"
            style={{
              width: dotSize,
              height: dotSize,
              backgroundColor: dotColor,
            }}
          />
        )}
        {/* text-box needs a block container. The badge root is a flex
            container, so the label gets its own span. Height is fixed (h-*),
            so trimming only recenters the letterforms. */}
        <span className="[text-box:trim-both_cap_alphabetic]">{children}</span>
      </span>
    )
  },
)

Badge.displayName = 'Badge'

export type { BadgeColor, BadgeProps, BadgeSize }
export { Badge, badgeColors, badgeVariants }
