// 来源：fluid-functionalism radix/switch（2026-11，https://www.fluidfunctionalism.com/r/switch.json，MIT）
// 适配：radix-ui 统一包导入、包内相对路径、去掉 "use client"；其余改动见 packages/ui/UPSTREAM.md
import {
  animate,
  m as motion,
  type Transition,
  useMotionValue,
  useReducedMotion,
} from 'motion/react'
import { Switch as SwitchPrimitive } from 'radix-ui'
import {
  forwardRef,
  type HTMLAttributes,
  type PointerEvent,
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { MotionFeatures } from '../lib/motion-features.tsx'
import { useShape } from '../lib/shape-context.tsx'
import { type SizeVariant, useSize } from '../lib/size-context.tsx'
import { spring } from '../lib/springs.ts'
import { cn } from '../lib/utils.ts'

// ---------------------------------------------------------------------------
// Switch is a whole labeled row: a click anywhere on it toggles, and the thumb
// can be dragged across the track. The thumb's x lives in a motion value that
// the pointer writes directly during a drag and that springs to its resting
// spot otherwise. Hover stretches the thumb into a pill; press stretches it
// further and squashes it. `checked` is always owned by the parent: the
// switch never flips itself, it only calls onToggle.
// ---------------------------------------------------------------------------

// 模板改动：id、aria-describedby、name / value / required 落到 role="switch" 的按钮（Radix Root）上，
// 外部 <Label htmlFor> 与表单提交都能用；其余属性仍给整行。label 放宽为 ReactNode，省略时必须给 aria-label。
type SwitchRowProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  'id' | 'aria-describedby' | 'aria-label' | 'aria-labelledby' | 'onToggle' | 'children'
>

type SwitchBaseProps = SwitchRowProps & {
  checked: boolean
  /** Called by a click, the keyboard, or a drag released past the
   *  midpoint. Update `checked` here. */
  onToggle: () => void
  disabled?: boolean
  /** Overrides the thumb's spring (spring.moderate by default). */
  thumbTransition?: Transition
  /** Pins the switch to one step of the size ladder.
   *  Omitted, it follows the surrounding SizeProvider. */
  size?: SizeVariant
  /** 开关按钮的 id（供外部 `<Label htmlFor>` 关联） */
  id?: string
  'aria-describedby'?: string
  /** 表单字段名：位于 <form> 内时，Radix 输出隐藏的 checkbox，开启时提交 value */
  name?: string
  /** 开启时提交的值，默认 "on" */
  value?: string
  required?: boolean
}

type SwitchProps = SwitchBaseProps &
  (
    | {
        /** 可见标签，同时是开关的可读名称 */
        label: ReactNode
        'aria-label'?: string
      }
    | {
        /** 不显示标签时（如表格行内），必须给可读名称 */
        label?: undefined
        'aria-label': string
      }
  )

// Track/thumb geometry per ladder step. The hover pill-extend is the same 2px
// at both steps; only the press extend/squash scales down with the thumb, so the
// compact switch keeps the same feel.
const METRICS = {
  default: {
    trackWidth: 34,
    trackHeight: 20,
    thumbSize: 16,
    pillExtend: 2,
    pressExtend: 4,
    pressShrink: 4,
  },
  compact: {
    trackWidth: 28,
    trackHeight: 16,
    thumbSize: 12,
    pillExtend: 2,
    pressExtend: 3,
    pressShrink: 3,
  },
} as const

// 2px between a resting thumb and every track edge: each track is its thumb
// plus 4 (20 = 16 + 4, 16 = 12 + 4), so the thumb sits centered.
const THUMB_OFFSET = 2
// Pointer travel (px) before a press turns into a drag. Under it the
// gesture stays a click, so a tap that wobbles a pixel still toggles.
const DRAG_DEAD_ZONE = 2
// 模板改动：减少动态效果时滑块直接落到终点。MotionConfig 只管声明式动画，
// 这里的 animate(motionX, …) 是命令式调用，需要自己判断
const INSTANT = { duration: 0 } as const

/** 先调用调用方的处理器，未 preventDefault() 时再执行内部处理器 */
function compose<E extends SyntheticEvent>(
  outer: ((event: E) => void) | undefined,
  inner: (event: E) => void,
) {
  return (event: E) => {
    outer?.(event)
    if (!event.defaultPrevented) inner(event)
  }
}

const Switch = forwardRef<HTMLDivElement, SwitchProps>(
  (
    {
      label,
      checked,
      onToggle,
      disabled = false,
      thumbTransition,
      size,
      className,
      id,
      name,
      value,
      required,
      'aria-label': ariaLabel,
      'aria-describedby': ariaDescribedBy,
      onPointerEnter,
      onPointerLeave,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onClick,
      ...props
    },
    ref,
  ) => {
    const labelId = useId()
    const hasMounted = useRef(false)
    const [hovered, setHovered] = useState(false)
    const [pressed, setPressed] = useState(false)
    const sizeClasses = useSize(size)
    const reduceMotion = useReducedMotion() ?? false
    const transition: Transition = reduceMotion ? INSTANT : (thumbTransition ?? spring.moderate)
    // Sharp squares the track and thumb; rounded and pill keep the pill.
    const sharp = useShape().variant === 'sharp'
    const m = METRICS[sizeClasses.variant]
    const thumbTravel = m.trackWidth - m.thumbSize - THUMB_OFFSET * 2

    // Drag refs (not state to avoid re-renders during drag)
    const dragging = useRef(false)
    // didDrag outlives the pointerup by one frame so the click fired by
    // the same release can be swallowed.
    const didDrag = useRef(false)
    // Non-null only while a press is in progress; move, up and cancel
    // ignore events without it.
    const pointerStart = useRef<{
      clientX: number
      originX: number
    } | null>(null)

    // The thumb's x is a motion value, not state: a drag writes it on every
    // pointermove without re-rendering, and springs pick up from wherever it
    // was left. It starts at the resting spot for `checked`, so a switch that
    // mounts on doesn't slide across.
    const motionX = useMotionValue(checked ? THUMB_OFFSET + thumbTravel : THUMB_OFFSET)

    useEffect(() => {
      hasMounted.current = true
    }, [])

    // Thumb shape. Press wins over hover: +pillExtend wide on hover, +pressExtend wide
    // and pressShrink shorter on press, with y moved down by half the
    // shrink so the thumb squashes toward its own center line.
    const thumbWidth = pressed
      ? m.thumbSize + m.pressExtend
      : hovered
        ? m.thumbSize + m.pillExtend
        : m.thumbSize
    const thumbHeight = pressed ? m.thumbSize - m.pressShrink : m.thumbSize
    const thumbY = pressed ? THUMB_OFFSET + m.pressShrink / 2 : THUMB_OFFSET
    // When checked, the extra width grows leftward (x backs off by extraWidth),
    // so the outer edge stays pinned 2px from the track end instead of
    // poking past it.
    const extraWidth = thumbWidth - m.thumbSize
    const thumbX = checked ? THUMB_OFFSET + thumbTravel - extraWidth : THUMB_OFFSET

    // Sync motionX when thumbX changes (hover, press, checked). Mid-drag the
    // pointer owns x, so this stands down; otherwise x springs on
    // thumbTransition, or spring.moderate by default.
    useEffect(() => {
      if (dragging.current) return
      if (!hasMounted.current || reduceMotion) {
        motionX.set(thumbX)
      } else {
        animate(motionX, thumbX, transition)
      }
    }, [thumbX, motionX, transition, reduceMotion])

    // --- Pointer handlers ---

    const handlePointerDown = useCallback(
      (e: PointerEvent<HTMLDivElement>) => {
        if (disabled) return
        if (e.pointerType === 'mouse' && e.button !== 0) return
        setPressed(true)
        dragging.current = false
        didDrag.current = false
        pointerStart.current = {
          clientX: e.clientX,
          // Start from where the thumb is now (even mid-spring), so the
          // first drag frame doesn't jump.
          originX: motionX.get(),
        }
        // Capture keeps move and up events on the row after the pointer
        // leaves it, so a drag can overshoot the track and still release.
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      },
      [disabled, motionX],
    )

    const handlePointerMove = useCallback(
      (e: PointerEvent<HTMLDivElement>) => {
        if (!pointerStart.current) return
        const delta = e.clientX - pointerStart.current.clientX

        // Under the 2px dead zone this is still a click; past it, the thumb
        // follows the pointer 1:1.
        if (!dragging.current) {
          if (Math.abs(delta) < DRAG_DEAD_ZONE) return
          dragging.current = true
        }

        // Clamp with the pressed width (the thumb stays stretched for the
        // whole drag), so it never pokes past either end of the track.
        const dragMin = THUMB_OFFSET
        const pressedThumbWidth = m.thumbSize + m.pressExtend
        const dragMax = m.trackWidth - THUMB_OFFSET - pressedThumbWidth
        const rawX = pointerStart.current.originX + delta
        motionX.set(Math.max(dragMin, Math.min(dragMax, rawX)))
      },
      [motionX, m],
    )

    const handlePointerUp = useCallback(() => {
      if (!pointerStart.current) return
      setPressed(false)

      if (dragging.current) {
        // The release that ends a drag still fires a click; the row's
        // onClick and the primitive's onCheckedChange both check didDrag,
        // so a drag never toggles twice.
        didDrag.current = true
        dragging.current = false

        const currentX = motionX.get()
        const dragMin = THUMB_OFFSET
        const pressedThumbWidth = m.thumbSize + m.pressExtend
        const dragMax = m.trackWidth - THUMB_OFFSET - pressedThumbWidth
        const midpoint = (dragMin + dragMax) / 2

        // Past the midpoint of the drag range means on, short of it means
        // off, whichever side the drag started from.
        const shouldBeOn = currentX > midpoint

        // A side change toggles, and the parent's new `checked` moves
        // thumbX, so the sync effect springs on from where the drag let go.
        // On the same side thumbX may not change at all, so spring home here.
        if (shouldBeOn !== checked) {
          onToggle()
        } else {
          // Snap back to current resting position (un-pressed)
          const snapTarget = checked ? THUMB_OFFSET + thumbTravel : THUMB_OFFSET
          animate(motionX, snapTarget, transition)
        }

        requestAnimationFrame(() => {
          didDrag.current = false
        })
      }

      pointerStart.current = null
    }, [checked, onToggle, motionX, transition, m, thumbTravel])

    const handlePointerCancel = useCallback(() => {
      if (!pointerStart.current) return
      setPressed(false)

      if (dragging.current) {
        dragging.current = false
        // Gesture cancelled by the system: snap back without toggling
        const snapTarget = checked ? THUMB_OFFSET + thumbTravel : THUMB_OFFSET
        animate(motionX, snapTarget, transition)
      }

      pointerStart.current = null
    }, [checked, motionX, transition, thumbTravel])

    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: 整行是指针目标（上游设计），键盘与读屏经内部的 role="switch" 按钮操作
      // biome-ignore lint/a11y/useKeyWithClickEvents: 同上，键盘切换由内部 Radix Switch 处理
      <div
        ref={ref}
        {...props}
        className={cn(
          // The whole row is the pointer target. 模板改动：上游 touch-none 会让从开关上开始的竖向滑动
          // 无法滚动页面；touch-pan-y 保留竖向滚动，横向拖动仍归滑块。select-none keeps a drag from
          // selecting the label.
          // 模板改动：去掉上游的左右内边距（sizeClasses.px），开关与表单里其他字段左缘对齐
          'relative z-10 flex items-center cursor-pointer select-none touch-pan-y',
          sizeClasses.gap,
          sizeClasses.variant === 'compact' ? 'py-1' : 'py-2',
          disabled && 'opacity-50 pointer-events-none',
          className,
        )}
        // 模板改动：调用方的处理器先执行并与内部处理器合成（上游把 props 展开在最后，会覆盖内部处理器）；
        // 调用方 preventDefault() 时跳过内部处理
        // Hover is mouse-only: a finger has no hover, so on touch the thumb
        // only ever takes the press shape.
        onPointerEnter={compose(onPointerEnter, (e) => {
          if (e.pointerType === 'mouse') setHovered(true)
        })}
        onPointerLeave={compose(onPointerLeave, () => setHovered(false))}
        onPointerDown={compose(onPointerDown, handlePointerDown)}
        onPointerMove={compose(onPointerMove, handlePointerMove)}
        onPointerUp={compose(onPointerUp, handlePointerUp)}
        onPointerCancel={compose(onPointerCancel, handlePointerCancel)}
        // A click anywhere on the row, label included, toggles, unless it is
        // the click that ends a drag.
        onClick={compose(onClick, () => {
          if (disabled || didDrag.current) return
          onToggle()
        })}
      >
        <SwitchPrimitive.Root
          checked={checked}
          {...(label !== undefined ? { 'aria-labelledby': labelId } : {})}
          {...(ariaLabel !== undefined && { 'aria-label': ariaLabel })}
          {...(ariaDescribedBy !== undefined && { 'aria-describedby': ariaDescribedBy })}
          {...(id !== undefined && { id })}
          {...(name !== undefined && { name })}
          {...(value !== undefined && { value })}
          {...(required !== undefined && { required })}
          onCheckedChange={() => {
            if (didDrag.current) return
            onToggle()
          }}
          disabled={disabled}
          tabIndex={0}
          className={cn(
            'relative shrink-0 outline-none cursor-pointer',
            sharp ? 'rounded-none' : 'rounded-full',
            'transition-colors duration-80',
            // 模板改动：焦点环改为 2px 描边加 2px 间隙（与 Button 一致），上游为 1px ring 加底色间隙
            'focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring)',
          )}
          style={{
            width: m.trackWidth,
            height: m.trackHeight,
            // On: the accent (--fluid-accent), mixing in 8% black on hover.
            // 模板改动：关闭态轨道用 --control-border（上游 --accent 与页面背景约 1.2:1，
            // 白色滑块在其上也看不清；轨道是开关唯一的边界，需 ≥ 3:1），悬停时掺入 10% 的 overlay 色。
            backgroundColor: checked
              ? hovered
                ? 'color-mix(in oklab, var(--fluid-accent), black 8%)'
                : 'var(--fluid-accent)'
              : hovered
                ? 'color-mix(in oklab, var(--control-border), rgb(var(--overlay)) 10%)'
                : 'var(--control-border)',
          }}
          // The primitive toggles through onCheckedChange; stopping the click
          // here keeps the row's onClick from toggling a second time.
          onClick={(e) => e.stopPropagation()}
        >
          {/* asChild makes the motion.span itself Radix's thumb, so its
              data-state attributes land on the element that animates. */}
          <MotionFeatures>
            <SwitchPrimitive.Thumb asChild>
              <motion.span
                // Pinned to the top-left and placed only by the x and y transforms;
                // width and height carry the hover and press shapes.
                className={cn(
                  'absolute top-0 left-0 block shadow-sm transition-colors duration-80',
                  // 模板改动：开启态滑块取 --switch-thumb-on（默认白色，深色预设的浅强调色上改为深色）
                  checked ? 'bg-(--switch-thumb-on)' : 'bg-(--switch-thumb-off)',
                  sharp ? 'rounded-none' : 'rounded-full',
                )}
                initial={false}
                style={{ x: motionX }}
                animate={{
                  y: thumbY,
                  width: thumbWidth,
                  height: thumbHeight,
                }}
                // Duration 0 on the first render (initial={false} already skips the
                // entrance), then shape changes ride the same spring as x.
                transition={hasMounted.current ? transition : INSTANT}
              />
            </SwitchPrimitive.Thumb>
          </MotionFeatures>
        </SwitchPrimitive.Root>

        {label !== undefined && (
          <span
            id={labelId}
            className={cn(
              // text-box trim recenters the letterforms against the track; the
              // track is taller than the label, so layout doesn't change.
              '[text-box:trim-both_cap_alphabetic] transition-[color] duration-80',
              sizeClasses.text,
              // Brightens when on (muted → foreground over 80ms), so
              // on/off reads in the label as well as the track color.
              checked ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            {label}
          </span>
        )}
      </div>
    )
  },
)

Switch.displayName = 'Switch'

export type { SwitchProps }
export { Switch }
