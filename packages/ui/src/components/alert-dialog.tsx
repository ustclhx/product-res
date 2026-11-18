// 来源：Fluid 无 AlertDialog，按 design D1「shadcn 补缺」：结构与 API 取 shadcn alert-dialog（Radix AlertDialog），
// 外观与开合动效沿用本包 dialog.tsx（fluid-functionalism radix/dialog，2026-11）；改动见 packages/ui/UPSTREAM.md
//
// 确认对话框：必须明确选择「确认」或「取消」，点击遮罩不关闭（Escape 等同取消）。组件内没有任何默认文案，
// 标题、说明与两个按钮的文字都由应用按语言传入。
import { m as motion } from 'motion/react'
import { AlertDialog as AlertDialogPrimitive } from 'radix-ui'
import {
  type ComponentPropsWithoutRef,
  createContext,
  forwardRef,
  type HTMLAttributes,
  type MouseEvent,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { fontWeights } from '../lib/font-weight.ts'
import { MotionFeatures } from '../lib/motion-features.tsx'
import { useShape } from '../lib/shape-context.tsx'
import { typeClass, useSize, useSizeVariant } from '../lib/size-context.tsx'
import { exitFallbackMs, spring } from '../lib/springs.ts'
import { surfaceClasses } from '../lib/surface-classes.ts'
import { SurfaceProvider, useSurface } from '../lib/surface-context.tsx'
import { cn } from '../lib/utils.ts'
import { Button, type ButtonProps } from './button.tsx'

const DIALOG_OFFSET = 4

const AlertDialogOpenContext = createContext(false)

function AlertDialog({
  children,
  open: controlledOpen,
  defaultOpen,
  onOpenChange,
}: AlertDialogPrimitive.AlertDialogProps) {
  // 与 Dialog 相同：内部状态始终跟随变化并通知调用方，Root 始终受控，退场动画结束后才真正卸载
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen ?? false)
  const open = controlledOpen ?? uncontrolledOpen
  const handleOpenChange = (next: boolean) => {
    setUncontrolledOpen(next)
    onOpenChange?.(next)
  }

  return (
    <AlertDialogOpenContext.Provider value={open}>
      <AlertDialogPrimitive.Root open={open} onOpenChange={handleOpenChange}>
        {children}
      </AlertDialogPrimitive.Root>
    </AlertDialogOpenContext.Provider>
  )
}

const AlertDialogTrigger = AlertDialogPrimitive.Trigger

interface AlertDialogContentProps
  extends ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Content> {
  /** 宽度：sm 400、lg 540（compact 区域各窄一档），与 Dialog 一致 */
  size?: 'sm' | 'lg'
}

const AlertDialogContent = forwardRef<HTMLDivElement, AlertDialogContentProps>(
  ({ className, children, size = 'sm', onCloseAutoFocus, ...props }, ref) => {
    const open = useContext(AlertDialogOpenContext)
    const shape = useShape()
    const substrate = useSurface()
    const dialogLevel = Math.min(substrate + DIALOG_OFFSET, 8)
    const compact = useSize().variant === 'compact'
    const [mounted, setMounted] = useState(false)
    // 打开前获得焦点的元素。Radix 只把焦点还给 AlertDialogTrigger；确认框常由列表行内的按钮
    // 以受控方式打开（替换 confirm()），没有 Trigger，关闭后焦点会落到 body，所以这里自己记录并归还。
    const returnFocusRef = useRef<HTMLElement | null>(null)

    if (open && !mounted) {
      // 打开的那次渲染中读取：此时 Radix 还没有把焦点移进对话框
      if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
        returnFocusRef.current = document.activeElement
      }
      setMounted(true)
    }

    // 退场动画回调在后台标签页可能停摆，按退场时长兜底卸载（同 Dialog）
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
        <AlertDialogPrimitive.Portal forceMount>
          <AlertDialogPrimitive.Overlay asChild forceMount>
            <motion.div
              className="fixed inset-0 z-[var(--z-overlay,40)] bg-black/40 dark:bg-black/80"
              initial={{ opacity: 0 }}
              animate={{ opacity: open ? 1 : 0 }}
              transition={open ? spring.slow : spring.slow.exit}
            />
          </AlertDialogPrimitive.Overlay>
          <AlertDialogPrimitive.Content
            ref={ref}
            asChild
            forceMount
            onCloseAutoFocus={(event) => {
              onCloseAutoFocus?.(event)
              if (event.defaultPrevented) return
              const target = returnFocusRef.current
              returnFocusRef.current = null
              // 记录的是 body（Safari 点击按钮不聚焦）或元素已被移除（如删除了所在行）时，交给 Radix 的默认行为
              if (!target || target === document.body || !target.isConnected) return
              event.preventDefault()
              target.focus({ preventScroll: true })
            }}
            {...props}
          >
            <motion.div
              // 退场动画期间面板仍在页面上：inert 让其中的按钮不可点击、不可聚焦，避免双击提交两次
              inert={!open}
              className={cn(
                'fixed left-1/2 top-1/2 z-[var(--z-modal,50)] w-[calc(100%-2rem)]',
                !open && 'pointer-events-none',
                surfaceClasses(dialogLevel),
                'p-6 focus:outline-none',
                size === 'sm' && (compact ? 'max-w-[360px]' : 'max-w-[400px]'),
                size === 'lg' && (compact ? 'max-w-[480px]' : 'max-w-[540px]'),
                shape.container,
                className,
              )}
              initial={{ opacity: 0, scale: 0.97, x: '-50%', y: '-50%' }}
              animate={{ opacity: open ? 1 : 0, scale: open ? 1 : 0.97, x: '-50%', y: '-50%' }}
              transition={open ? spring.slow : spring.slow.exit}
              onAnimationComplete={handleExitComplete}
            >
              <SurfaceProvider value={dialogLevel}>{children}</SurfaceProvider>
            </motion.div>
          </AlertDialogPrimitive.Content>
        </AlertDialogPrimitive.Portal>
      </MotionFeatures>
    )
  },
)
AlertDialogContent.displayName = 'AlertDialogContent'

function AlertDialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1.5 mb-4', className)} {...props} />
}

function AlertDialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex justify-end gap-2 mt-6', className)} {...props} />
}

const AlertDialogTitle = forwardRef<
  HTMLHeadingElement,
  ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Title>
>(({ className, ...props }, ref) => {
  const compact = useSizeVariant() === 'compact'
  return (
    <AlertDialogPrimitive.Title
      ref={ref}
      className={cn(
        typeClass('title', compact ? 'compact' : 'default'),
        // fontVariationSettings 只作用于 Inter，中文回退字体需要 font-semibold 才会加粗（同 DialogTitle）
        'font-semibold text-foreground',
        className,
      )}
      style={{ fontVariationSettings: fontWeights.semibold }}
      {...props}
    />
  )
})
AlertDialogTitle.displayName = 'AlertDialogTitle'

const AlertDialogDescription = forwardRef<
  HTMLParagraphElement,
  ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Description>
>(({ className, ...props }, ref) => {
  const compact = useSizeVariant() === 'compact'
  return (
    <AlertDialogPrimitive.Description
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
AlertDialogDescription.displayName = 'AlertDialogDescription'

/** 已开始关闭（退场动画中）时吞掉点击：不调用回调，也不让 Radix 再次关闭。inert 之外的兜底，
 *  覆盖不支持 inert 的环境与动画结束前的连击 */
function guardClosed(open: boolean, onClick: ButtonProps['onClick']) {
  return (event: MouseEvent<HTMLButtonElement>) => {
    if (!open) {
      event.preventDefault()
      return
    }
    onClick?.(event)
  }
}

type AlertDialogButtonProps = Omit<ButtonProps, 'asChild' | 'children'> & {
  /** 按钮文字，由应用按语言传入（组件不提供默认文案） */
  children: ReactNode
}

/** 确认按钮：默认实心主色；危险操作传 `variant="destructive"`。点击后关闭对话框，
 *  需要等待异步结果时在 onClick 中 `preventDefault()` 并改用受控 `open`。 */
function AlertDialogAction({ variant = 'default', onClick, ...props }: AlertDialogButtonProps) {
  const open = useContext(AlertDialogOpenContext)
  return (
    <AlertDialogPrimitive.Action asChild>
      <Button variant={variant} onClick={guardClosed(open, onClick)} {...props} />
    </AlertDialogPrimitive.Action>
  )
}

/** 取消按钮：打开时默认获得焦点（Radix 约定），避免误按 Enter 直接执行危险操作 */
function AlertDialogCancel({ variant = 'outline', onClick, ...props }: AlertDialogButtonProps) {
  const open = useContext(AlertDialogOpenContext)
  return (
    <AlertDialogPrimitive.Cancel asChild>
      <Button variant={variant} onClick={guardClosed(open, onClick)} {...props} />
    </AlertDialogPrimitive.Cancel>
  )
}

export type { AlertDialogButtonProps, AlertDialogContentProps }
export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
}
