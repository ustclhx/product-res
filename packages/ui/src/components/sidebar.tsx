// 来源：fluid-functionalism radix/sidebar（2026-11，https://www.fluidfunctionalism.com/r/sidebar.json，MIT）
// 适配：radix-ui 统一包导入、包内相对路径、去掉 "use client"；其余改动见 packages/ui/UPSTREAM.md
import { m as motion, useReducedMotion } from 'motion/react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import {
  type CSSProperties,
  forwardRef,
  type HTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { MotionFeatures } from '../lib/motion-features.tsx'
import { exitFallbackMs, spring } from '../lib/springs.ts'
import { surfaceClasses } from '../lib/surface-classes.ts'
import { SurfaceProvider, useSurface } from '../lib/surface-context.tsx'
import { cn } from '../lib/utils.ts'
import { ScrollArea } from './scroll-area.tsx'
import {
  type SidebarCollapsible,
  SidebarShell,
  type SidebarSide,
  type SidebarVariant,
  useSidebar,
} from './sidebar-core.tsx'

// SSR-safe layout effect (client components still server-render in Next).
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

// ─── Mobile sheet ────────────────────────────────────────────────────────────
//
// Built on Radix Dialog: it provides scroll lock, focus trap, focus restore,
// Esc + outside-click dismissal, while leaving the slide animation to
// Motion. Radix has no actionsRef-style deferred unmount, so the
// portal lifetime is managed with local `mounted` state: mount on open, keep
// the portal alive with `forceMount` through the exit tween, and unmount once
// the panel's exit animation completes.

interface SidebarSheetProps {
  side: SidebarSide
  open: boolean
  onClose: () => void
  closeOnNavigate: boolean
  children: ReactNode
}

/** 模板新增：抽屉内点击了会在当前页导航的链接（非新窗口、无修饰键） */
function isSameTabLinkClick(event: ReactMouseEvent<HTMLElement>) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return false
  const target = event.target instanceof Element ? event.target : null
  // 不能用 defaultPrevented 判断：客户端路由的链接自己会 preventDefault 再导航
  const link = target?.closest('a[href]')
  if (!link || !event.currentTarget.contains(link) || link.hasAttribute('download')) return false
  const linkTarget = link.getAttribute('target')
  return !linkTarget || linkTarget === '_self'
}

function SidebarSheet({ side, open, onClose, closeOnNavigate, children }: SidebarSheetProps) {
  const { widthMobile, labels } = useSidebar()
  // Reduced motion drops the slide (the movement) but keeps the scrim's
  // opacity fade — the state change stays legible without the travel.
  const reduceMotion = useReducedMotion() ?? false
  const substrate = useSurface()
  const level = Math.min(substrate + 2, 8)
  const panelRef = useRef<HTMLDivElement | null>(null)
  // 模板改动：抽屉没有 Radix Trigger（由 SidebarTrigger 切换），Radix 关闭后只把焦点还给 Trigger，
  // 这里记录打开前的焦点元素（通常是 SidebarTrigger），关闭后还给它。布局副作用先于 Radix 的
  // 自动聚焦（被动副作用）执行，读到的仍是打开前的焦点。
  const returnFocusRef = useRef<HTMLElement | null>(null)
  useIsoLayoutEffect(() => {
    if (open) returnFocusRef.current = document.activeElement as HTMLElement | null
  }, [open])

  const [mounted, setMounted] = useState(false)
  // Set during the render that opens it, so the portal mounts in the same
  // commit as `open` rather than one after.
  if (open && !mounted) setMounted(true)

  // Fallback release for the deferred unmount: onAnimationComplete on the
  // panel is the primary signal, but rAF-driven animation callbacks can stall
  // in throttled/background tabs.
  useEffect(() => {
    if (open) return
    const id = setTimeout(() => setMounted(false), exitFallbackMs(spring.moderate))
    return () => clearTimeout(id)
  }, [open])

  const offscreen = side === 'left' ? '-100%' : '100%'

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose()
      }}
    >
      {mounted && (
        <MotionFeatures>
          <DialogPrimitive.Portal forceMount>
            {/* Scrim: an always-on bg-black/40 base that stays visible for
              system-dark users (`dark:` only matches the explicit .dark
              class), boosted to /80 in explicit dark mode. */}
            <DialogPrimitive.Overlay asChild forceMount>
              <motion.div
                data-sidebar="overlay"
                className="fixed inset-0 bg-black/40 dark:bg-black/80 z-[var(--z-overlay,40)] print:hidden"
                initial={{ opacity: 0 }}
                animate={{ opacity: open ? 1 : 0 }}
                transition={open ? { duration: spring.moderate.duration } : spring.moderate.exit}
              />
            </DialogPrimitive.Overlay>

            <DialogPrimitive.Content
              asChild
              forceMount
              // The panel takes initial focus itself. Left to Radix, the trap
              // lands on the first focusable child — the top nav row — which
              // reads as a selected item the moment the drawer opens, and
              // Chrome grants :focus-visible to script-driven focus so it shows
              // the keyboard ring too.
              onOpenAutoFocus={(event) => {
                event.preventDefault()
                panelRef.current?.focus()
              }}
              onCloseAutoFocus={(event) => {
                const target = returnFocusRef.current
                returnFocusRef.current = null
                // 记录的是 body 或元素已被移除时，交给 Radix 的默认行为
                if (!target || target === document.body || !target.isConnected) return
                event.preventDefault()
                target.focus({ preventScroll: true })
              }}
              // Radix warns when Content has no Description; an explicit
              // undefined clears the rendered attribute, which is what its
              // DescriptionWarning checks.
              {...({ 'aria-describedby': undefined } as object)}
            >
              <motion.div
                ref={panelRef}
                tabIndex={-1}
                data-sidebar="sidebar"
                data-mobile="true"
                data-side={side}
                // 模板改动：退场动画期间面板仍在页面上，inert 让其中的链接不可点击、不可聚焦
                inert={!open}
                className={cn(
                  // 模板改动：打开的抽屉不进入打印
                  'fixed inset-y-0 z-[var(--z-modal,50)] flex flex-col overflow-hidden outline-none print:hidden',
                  side === 'left' ? 'left-0' : 'right-0',
                  !open && 'pointer-events-none',
                  surfaceClasses(level, 3),
                )}
                style={{ width: widthMobile }}
                initial={{ x: offscreen }}
                // spring.moderate: critically damped, so the panel decelerates
                // into x: 0 without overshooting and exposing the page behind
                // its leading edge.
                animate={{ x: open ? 0 : offscreen }}
                transition={
                  reduceMotion ? { duration: 0 } : open ? spring.moderate : spring.moderate.exit
                }
                onAnimationComplete={() => {
                  if (!open) setMounted(false)
                }}
                // 模板改动：选择抽屉里的导航条目后关闭抽屉，焦点照常还给打开前的元素（菜单按钮）
                onClick={(event) => {
                  if (closeOnNavigate && isSameTabLinkClick(event)) onClose()
                }}
              >
                {/* Radix's TitleWarning checks for a rendered DialogTitle, so
                  ship a visually hidden one as the accessible name. */}
                {/* 模板改动（tasks 4.6）：上游名称写死英文 "Sidebar"，改为 labels.title */}
                <DialogPrimitive.Title className="sr-only">{labels.title}</DialogPrimitive.Title>
                <SurfaceProvider value={level}>{children}</SurfaceProvider>
              </motion.div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </MotionFeatures>
      )}
    </DialogPrimitive.Root>
  )
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

export interface SidebarProps
  extends Omit<
    HTMLAttributes<HTMLDivElement>,
    | 'onDrag'
    | 'onDragStart'
    | 'onDragEnd'
    | 'onAnimationStart'
    | 'onAnimationEnd'
    | 'onAnimationIteration'
  > {
  side?: SidebarSide
  variant?: SidebarVariant
  /** 收起方式：`offcanvas` 整体滑出（上游默认）、`icon` 收起为图标栏（模板新增，行名称改由提示显示）、
   *  `none` 不可收起。@default "offcanvas" */
  collapsible?: SidebarCollapsible
  /** The `sidebar` variant's inner-edge border. Default true. */
  bordered?: boolean
  /** Pin the rail's tooltip open (`true`) or closed (`false`); `undefined`
   *  leaves it on hover. Dragging always hides it. */
  railTooltipOpen?: boolean
  /** Render the built-in resize/collapse rail. Default true. */
  rail?: boolean
  /** 模板新增：移动抽屉里点击同页导航的链接后关闭抽屉。@default true */
  closeOnNavigate?: boolean
}

const Sidebar = forwardRef<HTMLDivElement, SidebarProps>(
  (
    {
      side = 'left',
      variant = 'sidebar',
      collapsible = 'offcanvas',
      bordered = true,
      rail = true,
      railTooltipOpen,
      closeOnNavigate = true,
      className,
      style,
      children,
      ...props
    },
    ref,
  ) => {
    const { isMobile, openMobile, setOpenMobile, width, registerSide } = useSidebar()

    // The provider mirrors the side into the default shortcut ("[" / "]")
    // and the rail handle.
    useEffect(() => registerSide(side), [side, registerSide])

    if (collapsible === 'none') {
      return (
        <div
          ref={ref}
          data-slot="sidebar"
          data-variant={variant}
          data-side={side}
          className={cn(
            'peer sticky top-0 flex h-svh shrink-0 flex-col',
            side === 'right' && 'order-last',
            className,
          )}
          style={{ width, ...style } as CSSProperties}
          {...props}
        >
          <div
            data-sidebar="sidebar"
            className={cn(
              'flex h-full w-full min-h-0 flex-col',
              bordered &&
                variant === 'sidebar' &&
                (side === 'left' ? 'border-r border-border' : 'border-l border-border'),
            )}
          >
            {children}
          </div>
        </div>
      )
    }

    // The desktop shell stays MOUNTED across the drawer breakpoint — its
    // breakpoint classes fade it out (opacity + display, allow-discrete)
    // instead of this component unmounting it, which snapped the rail away
    // the instant the window shrank. The sheet mounts alongside it below the
    // breakpoint; the hidden shell costs nothing visible (display: none).
    return (
      <>
        {isMobile && (
          <SidebarSheet
            side={side}
            open={openMobile}
            onClose={() => setOpenMobile(false)}
            closeOnNavigate={closeOnNavigate}
          >
            {children}
          </SidebarSheet>
        )}
        <SidebarShell
          ref={ref}
          side={side}
          variant={variant}
          collapsible={collapsible}
          bordered={bordered}
          rail={rail}
          railTooltipOpen={railTooltipOpen}
          className={className}
          {...(style !== undefined && { style })}
          {...props}
        >
          {children}
        </SidebarShell>
      </>
    )
  },
)
Sidebar.displayName = 'Sidebar'

// ─── SidebarContent ──────────────────────────────────────────────────────────

export interface SidebarContentProps extends HTMLAttributes<HTMLDivElement> {
  viewportClassName?: string
}

const SidebarContent = forwardRef<HTMLDivElement, SidebarContentProps>(
  ({ className, viewportClassName, children, ...props }, ref) => {
    const { isMobile } = useSidebar()

    // Inside the mobile sheet, the sheet's flex column owns layout and this
    // region scrolls natively — a nested ScrollArea would double-scroll. The
    // boundary hairline still needs a frame to ride: scroll-divider can't sit
    // on the scroller itself (its own fade mask would erase the line), so the
    // region is wrapped the way ScrollArea wraps its viewport on desktop.
    if (isMobile) {
      return (
        <div className="scroll-divider [--scroll-divider-inset:8px] flex min-h-0 w-full flex-1 flex-col">
          <div
            ref={ref}
            data-sidebar="content"
            className={cn(
              'scroll-fade flex min-h-0 w-full flex-1 flex-col overflow-y-auto',
              className,
            )}
            {...props}
          >
            {children}
          </div>
        </div>
      )
    }

    // The scroll primitive wraps children in an inline-styled sizer that
    // sizes to content — rows would stop shrinking near the min width
    // instead of truncating, so the viewport's direct child is forced back
    // to a plain shrinkable block.
    return (
      <ScrollArea
        className={cn('scroll-divider min-h-0 w-full flex-1', className)}
        viewportClassName={cn('scroll-fade [&>div]:!block [&>div]:!min-w-0', viewportClassName)}
      >
        <div ref={ref} data-sidebar="content" className="flex w-full min-w-0 flex-col" {...props}>
          {children}
        </div>
      </ScrollArea>
    )
  },
)
SidebarContent.displayName = 'SidebarContent'

// Re-export the flavor-neutral parts so `sidebar` is a one-stop import.
// 模板改动：只转出组件与 Props 类型；上游的 useSidebar、cookie / 宽度常量与 sidebarMenuButtonVariants
// 不公开（见 packages/ui/UPSTREAM.md 统一适配规则 10）
export type {
  SidebarCollapsible,
  SidebarGroupActionProps,
  SidebarGroupActionsProps,
  SidebarGroupLabelProps,
  SidebarGroupProps,
  SidebarInputProps,
  SidebarInsetProps,
  SidebarLabels,
  SidebarProviderProps,
  SidebarRailProps,
  SidebarSectionProps,
  SidebarSide,
  SidebarTriggerProps,
  SidebarVariant,
} from './sidebar-core.tsx'
export {
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupActions,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
} from './sidebar-core.tsx'
export type {
  SidebarMenuActionProps,
  SidebarMenuActionsProps,
  SidebarMenuBadgeProps,
  SidebarMenuButtonProps,
  SidebarMenuItemProps,
  SidebarMenuProps,
  SidebarMenuSkeletonProps,
  SidebarMenuSubButtonProps,
  SidebarMenuSubItemProps,
  SidebarMenuSubProps,
} from './sidebar-menu.tsx'
export {
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuActions,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from './sidebar-menu.tsx'
export { Sidebar, SidebarContent }
