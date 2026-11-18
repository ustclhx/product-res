// 来源：fluid-functionalism radix/dialog（2026-11，https://www.fluidfunctionalism.com/r/dialog.json，MIT）
// 适配：radix-ui 统一包导入、包内相对路径、去掉 "use client"；其余改动见 packages/ui/UPSTREAM.md

import { m as motion } from 'motion/react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import {
  type ComponentPropsWithoutRef,
  createContext,
  forwardRef,
  type HTMLAttributes,
  type ReactElement,
  useContext,
  useEffect,
  useState,
} from 'react'
import { fontWeights } from '../lib/font-weight.ts'
import { useIcons } from '../lib/icon-context.tsx'
import { MotionFeatures } from '../lib/motion-features.tsx'
import { useShape } from '../lib/shape-context.tsx'
import { typeClass, useSize, useSizeVariant } from '../lib/size-context.tsx'
import { exitFallbackMs, spring } from '../lib/springs.ts'
import { surfaceClasses } from '../lib/surface-classes.ts'
import { SurfaceProvider, useSurface } from '../lib/surface-context.tsx'
import { cn } from '../lib/utils.ts'
import { Button } from './button.tsx'

const DIALOG_OFFSET = 4

const DialogOpenContext = createContext(false)

function Dialog({
  children,
  open: controlledOpen,
  defaultOpen,
  onOpenChange,
  ...props
}: DialogPrimitive.DialogProps) {
  // Internal state always tracks changes, and the consumer's onOpenChange is
  // notified alongside it — a listener must not replace state handling, or an
  // uncontrolled dialog with an onOpenChange prop could never open. The Root
  // below is always controlled by `open`, so defaultOpen seeds our state
  // instead of being forwarded.
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen ?? false)
  const open = controlledOpen ?? uncontrolledOpen
  const handleOpenChange = (next: boolean) => {
    setUncontrolledOpen(next)
    onOpenChange?.(next)
  }

  return (
    <DialogOpenContext.Provider value={open}>
      <DialogPrimitive.Root open={open} onOpenChange={handleOpenChange} {...props}>
        {children}
      </DialogPrimitive.Root>
    </DialogOpenContext.Provider>
  )
}

// Trigger and Close compose either way — `render={<Button/>}` (the
// library's composition API, shared with DropdownTrigger) or Radix-style
// `asChild` with a single child element — so one snippet works everywhere.
interface DialogSlotProps
  extends Omit<ComponentPropsWithoutRef<typeof DialogPrimitive.Trigger>, 'asChild'> {
  /** Element to render as the control, e.g. a Button. */
  render?: ReactElement
  /** Compose onto the single child element instead. */
  asChild?: boolean
}

const DialogTrigger = forwardRef<HTMLButtonElement, DialogSlotProps>(
  ({ render, asChild, children, ...props }, ref) =>
    render ? (
      <DialogPrimitive.Trigger ref={ref} asChild {...props}>
        {render}
      </DialogPrimitive.Trigger>
    ) : (
      <DialogPrimitive.Trigger ref={ref} asChild={asChild ?? false} {...props}>
        {children}
      </DialogPrimitive.Trigger>
    ),
)
DialogTrigger.displayName = 'DialogTrigger'

const DialogClose = forwardRef<HTMLButtonElement, DialogSlotProps>(
  ({ render, asChild, children, ...props }, ref) =>
    render ? (
      <DialogPrimitive.Close ref={ref} asChild {...props}>
        {render}
      </DialogPrimitive.Close>
    ) : (
      <DialogPrimitive.Close ref={ref} asChild={asChild ?? false} {...props}>
        {children}
      </DialogPrimitive.Close>
    ),
)
DialogClose.displayName = 'DialogClose'

interface DialogContentBaseProps extends ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  /** Width: sm 400, lg 540, xl 880 (each one notch narrower in compact
   *  regions). `xl` is the canvas for composed layouts — a sidebar beside
   *  a panel — which usually pair it with `className="p-0"` and a fixed
   *  height. */
  size?: 'sm' | 'lg' | 'xl'
  /** Portal target. When set, the overlay and panel render inside this element
   *  (positioned `absolute`) instead of covering the viewport (`fixed`). Pair
   *  with a `position: relative; overflow: hidden` container — and usually
   *  `<Dialog modal={false}>` — to scope a dialog to a bounded region, e.g. a
   *  docs preview. Defaults to the document body / full-viewport behaviour. */
  container?: HTMLElement | null
  /** Where the panel sits: centered, or anchored 12dvh from the top so a
   *  panel whose height follows its content (a command menu) keeps its top
   *  edge still. @default "center" */
  position?: 'center' | 'top'
}

// 模板改动（tasks 4.6）：上游关闭按钮的可读名称写死英文 "Close"。这里不给默认值：显示关闭按钮时
// 必须由应用按语言传入 closeLabel（调用处传 `m.*()` 文案）；内容自带出口时传 showCloseButton={false}。
type DialogContentProps = DialogContentBaseProps &
  (
    | {
        /** The ✕ in the top-right corner. @default true
         *  传了 closeLabel 时可用布尔变量控制（`showCloseButton={editable}`） */
        showCloseButton?: boolean
        /** 右上角关闭按钮的可读名称，由应用按语言传入 */
        closeLabel: string
      }
    | {
        /** Drop the ✕ when the content has its own way out, e.g. a command
         *  menu that closes on Escape and on a pick. */
        showCloseButton: false
        closeLabel?: never
      }
  )

const DialogContent = forwardRef<HTMLDivElement, DialogContentProps>(
  (
    {
      className,
      children,
      size = 'sm',
      container,
      showCloseButton = true,
      closeLabel,
      position = 'center',
      ...props
    },
    ref,
  ) => {
    const icons = useIcons()
    const XIcon = icons.x
    const open = useContext(DialogOpenContext)
    const shape = useShape()
    const substrate = useSurface()
    const dialogLevel = Math.min(substrate + DIALOG_OFFSET, 8)
    // The size ladder narrows the dialog one notch in compact regions —
    // width only, the padding stays put (see /docs/sizes).
    const compact = useSize().variant === 'compact'
    const [mounted, setMounted] = useState(false)

    // Set during the render that opens it, so the portal mounts in the same
    // commit as `open` rather than one after.
    if (open && !mounted) setMounted(true)

    // Fallback release for the deferred unmount: onAnimationComplete on the
    // panel is the primary signal, but rAF-driven animation callbacks can
    // stall in throttled/background tabs — leaving an invisible full-screen
    // overlay (and Radix's scroll lock) in place. Both exit tweens run at
    // spring.slow.exit, so the fallback tracks that tier.
    useEffect(() => {
      if (open) return
      const id = setTimeout(() => setMounted(false), exitFallbackMs(spring.slow))
      return () => clearTimeout(id)
    }, [open])

    const handleExitComplete = () => {
      if (!open) setMounted(false)
    }

    if (!mounted) return null

    return (
      <MotionFeatures>
        <DialogPrimitive.Portal forceMount container={container ?? undefined}>
          <DialogPrimitive.Overlay asChild forceMount>
            <motion.div
              className={cn(
                container ? 'absolute' : 'fixed',
                'inset-0 z-[var(--z-overlay,40)] bg-black/40 dark:bg-black/80',
              )}
              initial={{ opacity: 0 }}
              animate={{ opacity: open ? 1 : 0 }}
              transition={open ? spring.slow : spring.slow.exit}
            />
          </DialogPrimitive.Overlay>
          <DialogPrimitive.Content ref={ref} asChild forceMount {...props}>
            <motion.div
              // 模板改动：退场动画期间面板仍在页面上，inert 让其中的按钮不可点击、不可聚焦（避免重复提交）
              inert={!open}
              className={cn(
                container ? 'absolute' : 'fixed',
                'left-1/2 z-[var(--z-modal,50)] w-[calc(100%-2rem)]',
                !open && 'pointer-events-none',
                position === 'top' ? 'top-[12dvh]' : 'top-1/2',
                surfaceClasses(dialogLevel),
                'p-6 focus:outline-none',
                size === 'sm' && (compact ? 'max-w-[360px]' : 'max-w-[400px]'),
                size === 'lg' && (compact ? 'max-w-[480px]' : 'max-w-[540px]'),
                size === 'xl' && (compact ? 'max-w-[800px]' : 'max-w-[880px]'),
                shape.container,
                className,
              )}
              initial={{ opacity: 0, scale: 0.97, x: '-50%', y: position === 'top' ? 0 : '-50%' }}
              animate={{
                opacity: open ? 1 : 0,
                scale: open ? 1 : 0.97,
                x: '-50%',
                y: position === 'top' ? 0 : '-50%',
              }}
              transition={open ? spring.slow : spring.slow.exit}
              onAnimationComplete={handleExitComplete}
            >
              <SurfaceProvider value={dialogLevel}>
                {children}
                {showCloseButton && (
                  <DialogPrimitive.Close asChild>
                    <Button variant="ghost" size="icon-sm" className="absolute right-3 top-3">
                      <XIcon />
                      <span className="sr-only">{closeLabel}</span>
                    </Button>
                  </DialogPrimitive.Close>
                )}
              </SurfaceProvider>
            </motion.div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </MotionFeatures>
    )
  },
)
DialogContent.displayName = 'DialogContent'

function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1.5 mb-4', className)} {...props} />
}

function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex justify-end gap-2 mt-6', className)} {...props} />
}

const DialogTitle = forwardRef<
  HTMLHeadingElement,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => {
  // The title role of the type scale — see /docs/sizes.
  const compact = useSizeVariant() === 'compact'
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn(
        typeClass('title', compact ? 'compact' : 'default'),
        // 模板改动：fontVariationSettings 只作用于 Inter，中文回退字体需要 font-semibold 才会加粗
        'font-semibold text-foreground',
        className,
      )}
      style={{ fontVariationSettings: fontWeights.semibold }}
      {...props}
    />
  )
})
DialogTitle.displayName = 'DialogTitle'

const DialogDescription = forwardRef<
  HTMLParagraphElement,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => {
  const compact = useSizeVariant() === 'compact'
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={cn(
        typeClass('body', compact ? 'compact' : 'default'),
        'text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
})
DialogDescription.displayName = 'DialogDescription'

export type {
  DialogContentProps,
  DialogSlotProps as DialogCloseProps,
  DialogSlotProps as DialogTriggerProps,
}
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
}
