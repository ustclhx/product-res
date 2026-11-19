// 来源：shadcn/ui sheet（new-york-v4，2026-11，https://ui.shadcn.com/r/styles/new-york-v4/sheet.json，MIT）补缺：
// Fluid 只有左侧导航抽屉 mobile-drawer。结构与 API（side 四个方向）取 shadcn，遮罩、滑入动效与延迟卸载沿用 Fluid
// mobile-drawer（radix-ui Dialog + motion，与本包 Sidebar 移动抽屉同一套）；其余改动见 packages/ui/UPSTREAM.md

import { m as motion, useReducedMotion } from 'motion/react'
import { Dialog as SheetPrimitive } from 'radix-ui'
import {
  type ComponentPropsWithoutRef,
  createContext,
  forwardRef,
  type HTMLAttributes,
  type ReactElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { useIcons } from '../lib/icon-context.tsx'
import { MotionFeatures } from '../lib/motion-features.tsx'
import { usePopupShape } from '../lib/shape-context.tsx'
import { exitFallbackMs, spring } from '../lib/springs.ts'
import { surfaceClasses } from '../lib/surface-classes.ts'
import { SurfaceProvider, useSurface } from '../lib/surface-context.tsx'
import { cn } from '../lib/utils.ts'
import { Button } from './button.tsx'

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/** 面板比所在表面高四级（与 Dialog 一致），阴影固定为 surface-5 */
const SHEET_OFFSET = 4
const SHEET_SHADOW = 5

type SheetSide = 'top' | 'right' | 'bottom' | 'left'

const SheetOpenContext = createContext(false)

function Sheet({
  children,
  open: controlledOpen,
  defaultOpen,
  onOpenChange,
  ...props
}: SheetPrimitive.DialogProps) {
  // 与 Dialog 相同：内部状态始终跟随，Root 始终受控，供面板做退场动画
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen ?? false)
  const open = controlledOpen ?? uncontrolledOpen
  const handleOpenChange = (next: boolean) => {
    setUncontrolledOpen(next)
    onOpenChange?.(next)
  }
  return (
    <SheetOpenContext.Provider value={open}>
      <SheetPrimitive.Root open={open} onOpenChange={handleOpenChange} {...props}>
        {children}
      </SheetPrimitive.Root>
    </SheetOpenContext.Provider>
  )
}

// 与 Dialog 一致：Trigger 与 Close 既可 `render={<Button/>}`，也可 Radix 风格的 `asChild` 包一个子元素
interface SheetSlotProps
  extends Omit<ComponentPropsWithoutRef<typeof SheetPrimitive.Trigger>, 'asChild'> {
  /** Element to render as the control, e.g. a Button. */
  render?: ReactElement
  /** Compose onto the single child element instead. */
  asChild?: boolean
}

const SheetTrigger = forwardRef<HTMLButtonElement, SheetSlotProps>(
  ({ render, asChild, children, ...props }, ref) =>
    render ? (
      <SheetPrimitive.Trigger ref={ref} asChild {...props}>
        {render}
      </SheetPrimitive.Trigger>
    ) : (
      <SheetPrimitive.Trigger ref={ref} asChild={asChild ?? false} {...props}>
        {children}
      </SheetPrimitive.Trigger>
    ),
)
SheetTrigger.displayName = 'SheetTrigger'

const SheetClose = forwardRef<HTMLButtonElement, SheetSlotProps>(
  ({ render, asChild, children, ...props }, ref) =>
    render ? (
      <SheetPrimitive.Close ref={ref} asChild {...props}>
        {render}
      </SheetPrimitive.Close>
    ) : (
      <SheetPrimitive.Close ref={ref} asChild={asChild ?? false} {...props}>
        {children}
      </SheetPrimitive.Close>
    ),
)
SheetClose.displayName = 'SheetClose'

const OFFSCREEN: Record<SheetSide, { x?: string; y?: string }> = {
  top: { y: '-100%' },
  right: { x: '100%' },
  bottom: { y: '100%' },
  left: { x: '-100%' },
}

interface SheetContentBaseProps
  extends Omit<ComponentPropsWithoutRef<typeof SheetPrimitive.Content>, 'aria-describedby'> {
  /** 没有 SheetDescription 时传 undefined 显式清空（避免 Radix 的缺少 Description 警告） */
  'aria-describedby'?: string | undefined
  /** Portal 目标；默认 document.body（遮罩与面板仍为 fixed） */
  container?: HTMLElement | null
  /** 从哪一侧滑入。@default "right" */
  side?: SheetSide
  /** 底部面板顶端的拖拽条样式把手（装饰，读屏隐藏）。@default side === 'bottom' */
  handle?: boolean
}

// 与 DialogContent 相同：显示关闭按钮时必须由应用按语言传入 closeLabel
type SheetContentProps = SheetContentBaseProps &
  (
    | {
        /** 右上角关闭按钮。@default true */
        showCloseButton?: boolean
        closeLabel: string
      }
    | {
        showCloseButton: false
        closeLabel?: never
      }
  )

const SheetContent = forwardRef<HTMLDivElement, SheetContentProps>(
  (
    {
      className,
      children,
      side = 'right',
      handle = side === 'bottom',
      showCloseButton = true,
      closeLabel,
      container,
      onCloseAutoFocus,
      ...props
    },
    ref,
  ) => {
    const XIcon = useIcons().x
    const open = useContext(SheetOpenContext)
    const shape = usePopupShape()
    const level = Math.min(useSurface() + SHEET_OFFSET, 8)
    // 减少动态效果时去掉滑动位移，只保留遮罩淡入淡出
    const reduceMotion = useReducedMotion() ?? false
    const [mounted, setMounted] = useState(false)
    if (open && !mounted) setMounted(true)

    // 模板改动：没有 Trigger 的受控用法，Radix 关闭后不还焦点；记下打开前的焦点元素，关闭后还给它
    const returnFocusRef = useRef<HTMLElement | null>(null)
    useIsoLayoutEffect(() => {
      if (open) returnFocusRef.current = document.activeElement as HTMLElement | null
    }, [open])

    useEffect(() => {
      if (open) return
      const id = setTimeout(() => setMounted(false), exitFallbackMs(spring.moderate))
      return () => clearTimeout(id)
    }, [open])

    if (!mounted) return null

    const offscreen = OFFSCREEN[side]
    const onscreen = { x: 0, y: 0 }

    return (
      <MotionFeatures>
        <SheetPrimitive.Portal forceMount container={container ?? undefined}>
          <SheetPrimitive.Overlay asChild forceMount>
            <motion.div
              // 退场动画期间遮罩不再拦截点击
              className={cn(
                'fixed inset-0 z-(--z-overlay) bg-black/40 dark:bg-black/80',
                !open && 'pointer-events-none',
              )}
              initial={{ opacity: 0 }}
              animate={{ opacity: open ? 1 : 0 }}
              transition={open ? { duration: spring.moderate.duration } : spring.moderate.exit}
            />
          </SheetPrimitive.Overlay>
          <SheetPrimitive.Content
            ref={ref}
            asChild
            forceMount
            // 模态面板：读屏据此只朗读面板内容（Radix 另把背景设为 aria-hidden 并锁定焦点）
            aria-modal="true"
            onCloseAutoFocus={(event) => {
              onCloseAutoFocus?.(event)
              const target = returnFocusRef.current
              returnFocusRef.current = null
              if (event.defaultPrevented) return
              // 记录的是 body 或元素已被移除时，交给 Radix 的默认行为
              if (!target || target === document.body || !target.isConnected) return
              event.preventDefault()
              target.focus({ preventScroll: true })
            }}
            // 显式传入的 aria-describedby={undefined} 需要原样覆盖 Radix 的默认值
            {...(props as ComponentPropsWithoutRef<typeof SheetPrimitive.Content>)}
          >
            <motion.div
              inert={!open}
              data-side={side}
              className={cn(
                'fixed z-(--z-modal) flex flex-col overflow-hidden text-body text-foreground outline-none',
                surfaceClasses(level, SHEET_SHADOW),
                // 圆角放在方向类之前：贴边一侧的 rounded-*-none 覆盖它
                shape.container,
                side === 'bottom' &&
                  'inset-x-0 bottom-0 max-h-[85dvh] rounded-b-none pb-[env(safe-area-inset-bottom)]',
                side === 'top' && 'inset-x-0 top-0 max-h-[85dvh] rounded-t-none',
                side === 'left' && 'inset-y-0 left-0 w-3/4 max-w-sm rounded-l-none',
                side === 'right' && 'inset-y-0 right-0 w-3/4 max-w-sm rounded-r-none',
                !open && 'pointer-events-none',
                className,
              )}
              initial={offscreen}
              animate={open ? onscreen : offscreen}
              transition={
                reduceMotion ? { duration: 0 } : open ? spring.moderate : spring.moderate.exit
              }
              onAnimationComplete={() => {
                if (!open) setMounted(false)
              }}
            >
              <SurfaceProvider value={level}>
                {handle ? (
                  <span
                    aria-hidden="true"
                    className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-active"
                  />
                ) : null}
                {children}
                {showCloseButton && (
                  <SheetPrimitive.Close asChild>
                    <Button variant="ghost" size="icon-sm" className="absolute top-3 right-3">
                      <XIcon />
                      <span className="sr-only">{closeLabel}</span>
                    </Button>
                  </SheetPrimitive.Close>
                )}
              </SurfaceProvider>
            </motion.div>
          </SheetPrimitive.Content>
        </SheetPrimitive.Portal>
      </MotionFeatures>
    )
  },
)
SheetContent.displayName = 'SheetContent'

function SheetHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1.5 p-4', className)} {...props} />
}

function SheetFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mt-auto flex flex-col gap-2 p-4', className)} {...props} />
}

const SheetTitle = forwardRef<
  HTMLHeadingElement,
  ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Title
    ref={ref}
    // 中文回退字体需要 font-semibold 才会加粗
    className={cn('m-0 font-semibold text-foreground text-title', className)}
    {...props}
  />
))
SheetTitle.displayName = 'SheetTitle'

const SheetDescription = forwardRef<
  HTMLParagraphElement,
  ComponentPropsWithoutRef<typeof SheetPrimitive.Description>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Description
    ref={ref}
    className={cn('m-0 text-body text-muted-foreground', className)}
    {...props}
  />
))
SheetDescription.displayName = 'SheetDescription'

export type {
  SheetContentProps,
  SheetSide,
  SheetSlotProps as SheetCloseProps,
  SheetSlotProps as SheetTriggerProps,
}
export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
}
