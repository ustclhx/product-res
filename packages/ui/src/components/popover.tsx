// 来源：shadcn/ui popover（new-york-v4，2026-11，https://ui.shadcn.com/r/styles/new-york-v4/popover.json，MIT）补缺：
// Fluid 没有 Popover。结构与 API 取 shadcn，外观与开合动效沿用本包 Dropdown 的弹层（Elevated 表面、popupMotionClass、
// spring.fast）；其余改动见 packages/ui/UPSTREAM.md

import { m as motion } from 'motion/react'
import { Popover as PopoverPrimitive } from 'radix-ui'
import {
  type ComponentPropsWithoutRef,
  createContext,
  forwardRef,
  type HTMLAttributes,
  type MutableRefObject,
  type ReactElement,
  type Ref,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { MotionFeatures } from '../lib/motion-features.tsx'
import { popupMotionClass } from '../lib/popup.ts'
import { usePopupShape } from '../lib/shape-context.tsx'
import { exitFallbackMs, spring } from '../lib/springs.ts'
import { surfaceClasses } from '../lib/surface-classes.ts'
import { SurfaceProvider, useSurface } from '../lib/surface-context.tsx'
import { cn } from '../lib/utils.ts'

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/** 弹层比所在表面高两级（与 Dropdown 一致），阴影固定为 surface-5（设计稿通知弹层） */
const POPOVER_OFFSET = 2
const POPOVER_SHADOW = 5

const PopoverStateContext = createContext<{
  open: boolean
  triggerRef: MutableRefObject<HTMLElement | null>
}>({ open: false, triggerRef: { current: null } })

function assignRef<T>(ref: Ref<T> | undefined, value: T) {
  if (typeof ref === 'function') ref(value)
  else if (ref) (ref as MutableRefObject<T>).current = value
}

function Popover({
  children,
  open: controlledOpen,
  defaultOpen,
  onOpenChange,
  ...props
}: PopoverPrimitive.PopoverProps) {
  // 与 Dialog 相同：内部状态始终跟随，调用方的 onOpenChange 只是通知；Root 始终受控，供面板做退场动画
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen ?? false)
  const open = controlledOpen ?? uncontrolledOpen
  const triggerRef = useRef<HTMLElement | null>(null)
  const state = useMemo(() => ({ open, triggerRef }), [open])
  const handleOpenChange = (next: boolean) => {
    setUncontrolledOpen(next)
    onOpenChange?.(next)
  }
  return (
    <PopoverStateContext.Provider value={state}>
      <PopoverPrimitive.Root open={open} onOpenChange={handleOpenChange} {...props}>
        {children}
      </PopoverPrimitive.Root>
    </PopoverStateContext.Provider>
  )
}

// 与 Dialog 一致：Trigger 与 Close 既可 `render={<Button/>}`，也可 Radix 风格的 `asChild` 包一个子元素
interface PopoverSlotProps
  extends Omit<ComponentPropsWithoutRef<typeof PopoverPrimitive.Trigger>, 'asChild'> {
  /** Element to render as the control, e.g. a Button. */
  render?: ReactElement
  /** Compose onto the single child element instead. */
  asChild?: boolean
}

const PopoverTrigger = forwardRef<HTMLButtonElement, PopoverSlotProps>(
  ({ render, asChild, children, ...props }, ref) => {
    // 记下触发按钮，关闭后焦点落空时还给它（见 PopoverContent）
    const { triggerRef } = useContext(PopoverStateContext)
    const setRef = (node: HTMLButtonElement | null) => {
      triggerRef.current = node
      assignRef(ref, node)
    }
    return render ? (
      <PopoverPrimitive.Trigger ref={setRef} asChild {...props}>
        {render}
      </PopoverPrimitive.Trigger>
    ) : (
      <PopoverPrimitive.Trigger ref={setRef} asChild={asChild ?? false} {...props}>
        {children}
      </PopoverPrimitive.Trigger>
    )
  },
)
PopoverTrigger.displayName = 'PopoverTrigger'

const PopoverClose = forwardRef<HTMLButtonElement, PopoverSlotProps>(
  ({ render, asChild, children, ...props }, ref) =>
    render ? (
      <PopoverPrimitive.Close ref={ref} asChild {...props}>
        {render}
      </PopoverPrimitive.Close>
    ) : (
      <PopoverPrimitive.Close ref={ref} asChild={asChild ?? false} {...props}>
        {children}
      </PopoverPrimitive.Close>
    ),
)
PopoverClose.displayName = 'PopoverClose'

const PopoverAnchor = PopoverPrimitive.Anchor

interface PopoverContentProps extends ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> {
  /** Portal 目标；默认 document.body */
  container?: HTMLElement | null
}

const PopoverContent = forwardRef<HTMLDivElement, PopoverContentProps>(
  (
    {
      className,
      children,
      align = 'center',
      sideOffset = 4,
      collisionPadding = 8,
      container,
      onCloseAutoFocus,
      ...props
    },
    ref,
  ) => {
    const { open, triggerRef } = useContext(PopoverStateContext)
    const shape = usePopupShape()
    const level = Math.min(useSurface() + POPOVER_OFFSET, 8)
    const [mounted, setMounted] = useState(false)
    if (open && !mounted) setMounted(true)

    // 模板改动：Radix 在点击外部关闭时不还焦点（焦点交给被点的元素）；点在不可聚焦的空白处时焦点会落到 body，
    // 这里记下打开前的焦点元素（通常是触发按钮），关闭后焦点仍在 body 时还给它。布局副作用先于 Radix 的自动聚焦执行。
    // Safari 点击按钮不会聚焦它，记到的是 body，此时改还给触发按钮。
    const returnFocusRef = useRef<HTMLElement | null>(null)
    useIsoLayoutEffect(() => {
      if (open) returnFocusRef.current = document.activeElement as HTMLElement | null
    }, [open])

    // 退场动画的回调在后台标签页可能停住，按 spring.fast 的退场时长兜底卸载
    useEffect(() => {
      if (open) return
      const id = setTimeout(() => setMounted(false), exitFallbackMs(spring.fast))
      return () => clearTimeout(id)
    }, [open])

    if (!mounted) return null

    return (
      <MotionFeatures>
        <PopoverPrimitive.Portal forceMount container={container ?? undefined}>
          <PopoverPrimitive.Content
            ref={ref}
            asChild
            forceMount
            align={align}
            sideOffset={sideOffset}
            collisionPadding={collisionPadding}
            onCloseAutoFocus={(event) => {
              onCloseAutoFocus?.(event)
              const recorded = returnFocusRef.current
              returnFocusRef.current = null
              const target = recorded && recorded !== document.body ? recorded : triggerRef.current
              if (event.defaultPrevented || !target?.isConnected) return
              // Radix 的处理在本回调之后；下一帧再判断焦点是否落空
              requestAnimationFrame(() => {
                const active = document.activeElement
                if (!active || active === document.body) target.focus({ preventScroll: true })
              })
            }}
            {...props}
          >
            <motion.div
              // 退场动画期间面板仍在页面上：inert 让其中的按钮不可点击、不可聚焦
              inert={!open}
              className={cn(
                'z-(--z-popover) w-72 overflow-hidden p-4 text-body text-foreground outline-none',
                popupMotionClass,
                surfaceClasses(level, POPOVER_SHADOW),
                shape.container,
                !open && 'pointer-events-none',
                className,
              )}
              initial={{ opacity: 0, y: 'var(--popup-enter-y)', scale: 0.98 }}
              animate={
                open
                  ? { opacity: 1, y: 0, scale: 1 }
                  : { opacity: 0, y: 'var(--popup-enter-y)', scale: 0.98 }
              }
              transition={open ? spring.fast : spring.fast.exit}
              onAnimationComplete={() => {
                if (!open) setMounted(false)
              }}
            >
              <SurfaceProvider value={level}>{children}</SurfaceProvider>
            </motion.div>
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </MotionFeatures>
    )
  },
)
PopoverContent.displayName = 'PopoverContent'

function PopoverHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1', className)} {...props} />
}

/** 弹层标题：Radix Popover 没有 Title，调用方给它 id 并在 PopoverContent 上传 aria-labelledby */
const PopoverTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h2
      ref={ref}
      className={cn('m-0 font-semibold text-foreground text-subtitle', className)}
      {...props}
    />
  ),
)
PopoverTitle.displayName = 'PopoverTitle'

function PopoverDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('m-0 text-body text-muted-foreground', className)} {...props} />
}

export type {
  PopoverContentProps,
  PopoverSlotProps as PopoverCloseProps,
  PopoverSlotProps as PopoverTriggerProps,
}
export {
  Popover,
  PopoverAnchor,
  PopoverClose,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
}
