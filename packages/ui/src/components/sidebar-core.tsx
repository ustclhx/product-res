// 来源：fluid-functionalism sidebar-core.tsx（2026-11，https://www.fluidfunctionalism.com/r/sidebar.json 附带文件，MIT）
// 适配：radix-ui 统一包导入、包内相对路径、去掉 "use client"；其余改动见 packages/ui/UPSTREAM.md
import { AnimatePresence, type HTMLMotionProps, m as motion, useReducedMotion } from 'motion/react'
import {
  Children,
  type CSSProperties,
  createContext,
  type Dispatch,
  type ElementType,
  forwardRef,
  type HTMLAttributes,
  type InputHTMLAttributes,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type Ref,
  type SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useIcons } from '../lib/icon-context.tsx'
import { isEditable, isInsidePopup } from '../lib/keyboard.ts'
import { MotionFeatures } from '../lib/motion-features.tsx'
import { useShape } from '../lib/shape-context.tsx'
import { typeClass, useSize, useSizeVariant } from '../lib/size-context.tsx'
import { exitFallbackMs, spring } from '../lib/springs.ts'
import { surfaceClasses } from '../lib/surface-classes.ts'
import { SurfaceProvider, useSurface } from '../lib/surface-context.tsx'
import { cn } from '../lib/utils.ts'
import { Button, type ButtonProps } from './button.tsx'
import { Tooltip } from './tooltip.tsx'

// SSR-safe layout effect (client components still server-render in Next).
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

// ─── Constants ───────────────────────────────────────────────────────────────

// 模板改动：去掉上游的 sidebar_state cookie 常量与写入（持久化由工作台布局经 onOpenChange 负责）
export const SIDEBAR_WIDTH = '16rem'
export const SIDEBAR_WIDTH_MOBILE = '18rem'
/** 模板新增：collapsible="icon" 收起后的图标栏宽度（分组 8px 内边距 + 32px 行 + 8px） */
export const SIDEBAR_WIDTH_ICON = '3rem'
/** Bare-key toggle defaults: "[" for a left sidebar, "]" for a right one.
 *  Bare (no ⌘/Ctrl) so the browser's history shortcuts stay untouched. */
export const SIDEBAR_KEYBOARD_SHORTCUT = '['
export const SIDEBAR_KEYBOARD_SHORTCUT_RIGHT = ']'
/** Drag-resize clamp for the built-in rail handle (px). */
export const SIDEBAR_MIN_WIDTH = 160
export const SIDEBAR_MAX_WIDTH = 360
/** Dragging this far past the minimum width collapses the sidebar instead of
 *  bottoming out — the same "throw it at the edge to dismiss" affordance
 *  native apps use. */
export const SIDEBAR_COLLAPSE_SLOP = 56

// ─── Context ─────────────────────────────────────────────────────────────────

export type SidebarSide = 'left' | 'right'
export type SidebarVariant = 'sidebar' | 'floating' | 'inset'
/** 模板改动：新增 `"icon"`（收起到图标栏，行名称改由提示显示）；上游只有 offcanvas / none */
export type SidebarCollapsible = 'offcanvas' | 'icon' | 'none'
type SidebarPeek = 'hover' | 'click' | 'none'

/** 模板改动（tasks 4.6）：上游写死的英文文案改为调用方必传 */
export interface SidebarLabels {
  /** 移动端抽屉（对话框）的可读名称 */
  title: string
  /** 收起状态下触发按钮的名称与提示，如「展开侧栏」；图标栏的边缘拖拽条也用它 */
  expand: string
  /** 展开状态下触发按钮的名称与提示，如「收起侧栏」 */
  collapse: string
  /** 边缘拖拽条的可读名称，如「调整宽度或收起侧栏」 */
  rail: string
  /** 边缘拖拽条提示第一行，如「拖动调整宽度」（可传带加粗的节点） */
  railResize: ReactNode
  /** 边缘拖拽条提示第二行，如「点击收起」 */
  railCollapse: ReactNode
  /** peek 模式下边缘条的可读名称，如「临时显示侧栏」；只在 peek 不为 none 时需要 */
  peek?: string
}

export interface SidebarContextValue {
  state: 'expanded' | 'collapsed'
  open: boolean
  setOpen: (open: boolean | ((prev: boolean) => boolean)) => void
  openMobile: boolean
  setOpenMobile: Dispatch<SetStateAction<boolean>>
  isMobile: boolean
  toggleSidebar: () => void
  /** Live rail width — the rail's drag-resize updates it. */
  width: string
  setWidth: (width: string) => void
  widthMobile: string
  /** 模板新增：collapsible="icon" 收起后的图标栏宽度 */
  widthIcon: string
  mobileBreakpoint: number
  /** Which edge the rendered Sidebar sits on (registered by <Sidebar/>). */
  side: SidebarSide
  /** Internal: <Sidebar/> reports its side so the provider can resolve the
   *  default shortcut and the rail can mirror. */
  registerSide: (side: SidebarSide) => void
  /** The resolved toggle key ("[" / "]" / custom / null when disabled). */
  shortcut: string | null
  /** Collapsed-peek mode: reveal the sidebar as a floating overlay from the
   *  collapsed edge on hover or click, without pinning it open. */
  peek: SidebarPeek
  /** True while the collapsed sidebar is peeking as an overlay. */
  isPeeking: boolean
  setIsPeeking: Dispatch<SetStateAction<boolean>>
  /** Shared hover-intent machinery for the peek: ONE timer serves every
   *  affordance that can float the rail out (the edge strip, the trigger),
   *  so crossing between them — or into the peeked card — cancels a pending
   *  dismissal instead of racing a second timer. */
  schedulePeek: () => void
  scheduleDismissPeek: () => void
  cancelPeekTimer: () => void
  /** Internal: true while the rail is being drag-resized (disables the
   *  width spring so the panel tracks the pointer 1:1). */
  isResizing: boolean
  setIsResizing: Dispatch<SetStateAction<boolean>>
  labels: SidebarLabels
}

// Mounted-provider registry for the global toggle shortcut. The listener has
// to be global (the key should work without focus in the sidebar), but only
// ONE provider may answer a keypress: the innermost one containing focus, or —
// when focus is outside every provider — the OUTERMOST mounted one (the
// app-shell provider that wraps everything else; mount order can't be used
// because a persistent layout provider mounts once while demos mount later
// on navigation). Same pattern as AskUserQuestions' 1-9 shortcuts.
const mountedProviders: HTMLElement[] = []

const SidebarContext = createContext<SidebarContextValue | null>(null)

export function useSidebar(): SidebarContextValue {
  const ctx = useContext(SidebarContext)
  if (!ctx) throw new Error('useSidebar must be used within a SidebarProvider')
  return ctx
}

// 模板新增：图标栏状态。桌面外壳在 collapsible="icon" 时提供；移动抽屉与 offcanvas 下为默认值。
// 菜单行据此在收起时只留图标、把名称放进提示，分组标题与行尾徽标 / 操作隐藏。
interface SidebarIconRailValue {
  /** 外壳是 collapsible="icon"：菜单行挂上收起时的名称提示 */
  iconMode: boolean
  /** 当前收起为图标栏 */
  collapsed: boolean
  side: SidebarSide
}

const SidebarIconRailContext = createContext<SidebarIconRailValue>({
  iconMode: false,
  collapsed: false,
  side: 'left',
})

export function useSidebarIconRail(): SidebarIconRailValue {
  return useContext(SidebarIconRailContext)
}

export function assignRef<T>(target: Ref<T> | undefined, node: T | null) {
  if (typeof target === 'function') target(node)
  else if (target) (target as { current: T | null }).current = node
}

// Starts undefined so the server and first client render agree (both treat it
// as desktop); the media query corrects it in an effect before interaction.
function useIsMobile(breakpoint: number): boolean {
  const [isMobile, setIsMobile] = useState<boolean | undefined>(undefined)
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`)
    const onChange = () => setIsMobile(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [breakpoint])
  return !!isMobile
}

const subscribeNever = () => () => {}

/** False on the server and while hydrating, true after: a client-only value
 *  without a hydration mismatch. */
function useIsClient() {
  return useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  )
}

// ─── SidebarProvider ─────────────────────────────────────────────────────────

interface SidebarProviderBaseProps extends HTMLAttributes<HTMLDivElement> {
  defaultOpen?: boolean
  open?: boolean
  /** 桌面展开状态变化（受控与非受控都会通知）。工作台布局在这里写 cookie，下次服务端渲染读回
   *  `defaultOpen`；移动抽屉的开合不经过这里。模板改动：上游的 `persist` 由组件直接写 cookie，已去掉 */
  onOpenChange?: (open: boolean) => void
  /** Bare-key toggle shortcut, e.g. "[" for a left sidebar and "]" for a right one.
   *  模板改动：默认关闭（`null`）。单字符快捷键须可关闭或由用户开启（WCAG 2.1.4），由使用方显式传入；
   *  上游默认按边开启 "[" / "]"。 */
  shortcut?: string | null
  /** Viewport width (px) below which the sidebar renders as a drawer. */
  mobileBreakpoint?: number
  width?: string
  widthMobile?: string
  /** 模板新增：collapsible="icon" 收起后的图标栏宽度，收起的菜单行在栏内居中。@default "3rem" */
  widthIcon?: string
}

// peek 模式会渲染边缘条按钮，此时类型上要求 labels.peek
export type SidebarProviderProps = SidebarProviderBaseProps &
  (
    | {
        /** While collapsed, reveal the sidebar as a floating overlay from the
         *  edge — on hover (with intent delay) or on click of the edge strip.
         *  Peeking never pins the sidebar. @default "none" */
        peek?: 'none'
        labels: SidebarLabels
      }
    | { peek: 'hover' | 'click'; labels: SidebarLabels & { peek: string } }
  )

const SidebarProvider = forwardRef<HTMLDivElement, SidebarProviderProps>(
  (
    {
      defaultOpen = true,
      open: openProp,
      onOpenChange,
      shortcut: shortcutProp,
      mobileBreakpoint = 768,
      peek = 'none',
      width: widthProp = SIDEBAR_WIDTH,
      widthMobile = SIDEBAR_WIDTH_MOBILE,
      widthIcon = SIDEBAR_WIDTH_ICON,
      labels,
      className,
      style,
      children,
      ...props
    },
    ref,
  ) => {
    const isMobile = useIsMobile(mobileBreakpoint)
    const [openMobile, setOpenMobile] = useState(false)
    const [side, setSide] = useState<SidebarSide>('left')
    const wrapperRef = useRef<HTMLDivElement | null>(null)

    useEffect(() => {
      const el = wrapperRef.current
      if (!el) return
      mountedProviders.push(el)
      return () => {
        const i = mountedProviders.indexOf(el)
        if (i !== -1) mountedProviders.splice(i, 1)
      }
    }, [])
    const registerSide = useCallback((next: SidebarSide) => setSide(next), [])

    // Live width: the prop is the starting point, the rail's drag-resize
    // updates it at runtime. A new prop resets it, during that render.
    const [width, setWidth] = useState(widthProp)
    const [syncedWidthProp, setSyncedWidthProp] = useState(widthProp)
    if (syncedWidthProp !== widthProp) {
      setSyncedWidthProp(widthProp)
      setWidth(widthProp)
    }
    const [isResizing, setIsResizing] = useState(false)

    // 模板改动：省略时不绑定（上游默认按边取 "[" / "]"）
    const shortcut = shortcutProp ?? null

    const [internalOpen, setInternalOpen] = useState(defaultOpen)
    const open = openProp ?? internalOpen
    const openRef = useRef(open)
    useIsoLayoutEffect(() => {
      openRef.current = open
    })

    // 模板改动：上游传了 onOpenChange 就不再更新内部状态，「defaultOpen + onOpenChange 记录状态」
    // 的非受控用法会切换不了；这里与 Dialog 一致：未受控时内部状态照常更新，同时通知调用方
    const setOpen = useCallback(
      (value: boolean | ((prev: boolean) => boolean)) => {
        const next = typeof value === 'function' ? value(openRef.current) : value
        openRef.current = next
        if (openProp === undefined) setInternalOpen(next)
        onOpenChange?.(next)
      },
      [onOpenChange, openProp],
    )

    const toggleSidebar = useCallback(() => {
      if (isMobile) setOpenMobile((prev) => !prev)
      else setOpen((prev) => !prev)
    }, [isMobile, setOpen])

    // Collapsed-peek overlay state. Pinning the sidebar open (or disabling
    // the mode) always dismisses the peek — including a PENDING intent
    // timer, or a hover armed just before the pin would fire setIsPeeking on
    // an open sidebar (the effect's deps never re-run for the late timer).
    // The peek itself is cleared during the render that pins or disables
    // it; the timer is cleared after that commit.
    const [isPeeking, setIsPeeking] = useState(false)
    const peekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    if ((open || peek === 'none') && isPeeking) setIsPeeking(false)
    useEffect(() => {
      if (open || peek === 'none') {
        if (peekTimerRef.current) clearTimeout(peekTimerRef.current)
        peekTimerRef.current = null
      }
    }, [open, peek])
    const cancelPeekTimer = useCallback(() => {
      if (peekTimerRef.current) clearTimeout(peekTimerRef.current)
      peekTimerRef.current = null
    }, [])
    const schedulePeek = useCallback(() => {
      cancelPeekTimer()
      peekTimerRef.current = setTimeout(() => setIsPeeking(true), 150)
    }, [cancelPeekTimer])
    const scheduleDismissPeek = useCallback(() => {
      cancelPeekTimer()
      peekTimerRef.current = setTimeout(() => setIsPeeking(false), 250)
    }, [cancelPeekTimer])
    useEffect(() => cancelPeekTimer, [cancelPeekTimer])

    // The bare shortcut key toggles the sidebar app-wide. Bound to the
    // provider's lifetime (not a docs-only global), skipped while typing, and
    // skipped when a modifier is held so ⌘[ / ⌘] keep their browser meaning.
    useEffect(() => {
      if (shortcut == null) return
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key.toLowerCase() !== shortcut.toLowerCase()) return
        if (event.metaKey || event.ctrlKey || event.altKey) return
        // 模板改动：按住不放的重复、已被其他处理器消费的按键、菜单 / 列表框 / 对话框内的按键都不切换
        if (event.repeat || event.defaultPrevented) return
        const target = event.target as HTMLElement
        if (isEditable(target) || isInsidePopup(target)) return
        // Only one mounted provider answers (see mountedProviders). Providers
        // can NEST (an app shell wrapping doc previews), so containment alone
        // isn't enough: the innermost provider containing focus wins.
        const root = wrapperRef.current
        if (!root) return
        // Focus inside a keyboard scope (an embedded preview marked
        // data-keyboard-scope) that this provider sits outside: the keys
        // belong to what's in the scope.
        const scope = target.closest?.('[data-keyboard-scope]')
        if (scope && !scope.contains(root)) return
        if (root.contains(target)) {
          if (
            mountedProviders.some((el) => el !== root && root.contains(el) && el.contains(target))
          )
            return
          // The focused element itself WRAPS another provider (a docs
          // preview frame holding keyboard scope for the demo inside it —
          // see click-to-focus): the wrapped provider answers, not this
          // ancestor shell.
          if (mountedProviders.some((el) => el !== root && target.contains(el))) return
        } else {
          // Focus outside this provider. A focused element that WRAPS
          // providers — a docs preview frame holding keyboard scope for the
          // demo inside it (see click-to-focus) — scopes the key to what it
          // wraps: the outermost wrapped provider answers, and this check
          // must come BEFORE the containment guard below (an app-shell
          // provider always contains the preview frame, and must not steal
          // the key from the demo the frame scopes to). Focus on <body>
          // wraps every provider, which degenerates to the original rule:
          // the OUTERMOST provider overall answers — mount order is
          // unreliable here (a persistent app-shell provider mounts once,
          // while doc demos mount later on client-side navigation).
          const wrapped = mountedProviders.filter((el) => target.contains(el))
          if (wrapped.length > 0) {
            const outermost = wrapped.find(
              (el) => !wrapped.some((other) => other !== el && other.contains(el)),
            )
            if (outermost !== root) return
          } else {
            if (mountedProviders.some((el) => el !== root && el.contains(target))) return
            const outermost = mountedProviders.find(
              (el) => !mountedProviders.some((other) => other !== el && other.contains(el)),
            )
            if (outermost !== root) return
          }
        }
        event.preventDefault()
        toggleSidebar()
      }
      window.addEventListener('keydown', onKeyDown)
      return () => window.removeEventListener('keydown', onKeyDown)
    }, [shortcut, toggleSidebar])

    const value = useMemo<SidebarContextValue>(
      () => ({
        state: open ? 'expanded' : 'collapsed',
        open,
        setOpen,
        openMobile,
        setOpenMobile,
        isMobile,
        toggleSidebar,
        width,
        setWidth,
        widthMobile,
        widthIcon,
        mobileBreakpoint,
        side,
        registerSide,
        shortcut,
        peek,
        isPeeking,
        setIsPeeking,
        schedulePeek,
        scheduleDismissPeek,
        cancelPeekTimer,
        isResizing,
        setIsResizing,
        labels,
      }),
      [
        open,
        setOpen,
        openMobile,
        isMobile,
        toggleSidebar,
        width,
        widthMobile,
        widthIcon,
        mobileBreakpoint,
        side,
        registerSide,
        shortcut,
        peek,
        isPeeking,
        schedulePeek,
        scheduleDismissPeek,
        cancelPeekTimer,
        isResizing,
        labels,
      ],
    )

    return (
      <SidebarContext.Provider value={value}>
        <MotionFeatures>
          <div
            ref={(node) => {
              wrapperRef.current = node
              assignRef(ref, node)
            }}
            data-slot="sidebar-wrapper"
            className={cn('group/sidebar-wrapper relative flex min-h-svh w-full', className)}
            style={
              {
                '--sidebar-width': width,
                '--sidebar-width-mobile': widthMobile,
                '--sidebar-width-icon': widthIcon,
                ...style,
              } as CSSProperties
            }
            {...props}
          >
            {children}
          </div>
        </MotionFeatures>
      </SidebarContext.Provider>
    )
  },
)
SidebarProvider.displayName = 'SidebarProvider'

// ─── Slot helpers (render / asChild polymorphism) ────────────────────────────
//
// A local slot instead of a primitive-library one so every menu part exists in
// exactly one flavor-neutral copy: Radix's Slot would leak into the Base UI
// flavor, and Base UI's useRender the other way around. Supports both the
// library's `render={<Link/>}` convention and shadcn's `asChild`.

export type SlotProps = {
  className?: string | undefined
  style?: CSSProperties | undefined
  children?: ReactNode
} & Record<string, unknown>

/** Resolves the element to clone: `render` wins, else `asChild`'s single
 *  element child. `content` is what should render inside it — for `asChild`
 *  the child element's own children, otherwise the caller's. */
export function resolveSlotTemplate(
  render: ReactElement | undefined,
  asChild: boolean | undefined,
  children: ReactNode,
): { template: ReactElement<SlotProps> | null; content: ReactNode } {
  if (render && isValidElement(render)) {
    return { template: render as ReactElement<SlotProps>, content: children }
  }
  if (asChild) {
    const only = Children.toArray(children)[0]
    if (isValidElement(only)) {
      return {
        template: only as ReactElement<SlotProps>,
        content: (only.props as SlotProps).children,
      }
    }
  }
  return { template: null, content: children }
}

/** Renders `children` into the template element (merging class/style/
 *  handlers, composing refs) or into the default tag when there is no
 *  template. A component rather than a helper the parts call during their
 *  render: the forwarded ref it composes arrives as the `elementRef` prop,
 *  and only lands on the element at commit. */
export function SlotElement({
  template,
  defaultTag: DefaultTag,
  elementRef,
  props,
  children,
}: {
  template: ReactElement<SlotProps> | null
  defaultTag: ElementType
  elementRef?: Ref<HTMLElement> | undefined
  props: SlotProps
  children?: ReactNode
}): ReactElement {
  if (!template) {
    const Tag = DefaultTag as ElementType
    return (
      <Tag {...props} ref={elementRef}>
        {children}
      </Tag>
    )
  }
  const TemplateTag = template.type as ElementType
  const templateProps = template.props
  const merged: SlotProps = {
    ...props,
    ...templateProps,
    className: cn(props.className, templateProps.className),
    style: { ...props.style, ...(templateProps.style as CSSProperties | undefined) },
  }
  // Chain duplicated event handlers, template's first (it owns the element).
  for (const key of Object.keys(props)) {
    if (!/^on[A-Z]/.test(key)) continue
    const ours = props[key]
    const theirs = templateProps[key]
    if (typeof ours === 'function' && typeof theirs === 'function') {
      merged[key] = (...args: unknown[]) => {
        ;(theirs as (...a: unknown[]) => void)(...args)
        ;(ours as (...a: unknown[]) => void)(...args)
      }
    }
  }
  const templateRef =
    (templateProps as { ref?: Ref<HTMLElement> }).ref ??
    (template as unknown as { ref?: Ref<HTMLElement> }).ref
  // Both refs get the element, through a callback that only runs at commit.
  const composedRef = (node: HTMLElement | null) => {
    assignRef(elementRef, node)
    assignRef(templateRef, node)
  }
  return (
    <TemplateTag key={template.key ?? undefined} {...merged} ref={composedRef}>
      {children}
    </TemplateTag>
  )
}

// ─── SidebarShell (shared desktop DOM for both flavors) ──────────────────────

// Literal map so Tailwind's scanner emits the utilities: for the standard
// breakpoints the shell is also hidden by CSS, avoiding a pre-hydration flash
// of the rail on small screens. Non-standard breakpoints fall back to a
// JS-driven `hidden` in the shell (no dissolve, but never rail + drawer at
// once).
// Crossing the drawer breakpoint DISSOLVES the desktop rail instead of
// snapping it away: opacity fades while `display` rides the same transition
// with allow-discrete, so none applies only once the fade lands (and
// @starting-style fades it back in when the window grows). Literal classes
// per breakpoint — Tailwind's scanner can't see composed strings. The fade
// classes only join after hydration: the server-rendered rail is there on
// first paint and must not fade in with it (a bare duration is enough to fade
// it, since transition-property starts at `all`).
const BREAKPOINT_FADE_BASE =
  'transition-[opacity,display] ease-out [transition-behavior:allow-discrete] motion-reduce:transition-none'
const BREAKPOINT_HIDDEN: Record<number, string> = {
  640: 'max-sm:hidden max-sm:opacity-0',
  768: 'max-md:hidden max-md:opacity-0',
  1024: 'max-lg:hidden max-lg:opacity-0',
  1280: 'max-xl:hidden max-xl:opacity-0',
}
const BREAKPOINT_FADE: Record<number, string> = {
  640: 'max-sm:duration-160 sm:duration-240 sm:starting:opacity-0',
  768: 'max-md:duration-160 md:duration-240 md:starting:opacity-0',
  1024: 'max-lg:duration-160 lg:duration-240 lg:starting:opacity-0',
  1280: 'max-xl:duration-160 xl:duration-240 xl:starting:opacity-0',
}

// Props Motion redefines with incompatible signatures; they must not
// be forwarded onto a motion.div.
type MotionSafeDivProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  | 'onDrag'
  | 'onDragStart'
  | 'onDragEnd'
  | 'onAnimationStart'
  | 'onAnimationEnd'
  | 'onAnimationIteration'
>

export interface SidebarShellProps extends MotionSafeDivProps {
  side: SidebarSide
  variant: SidebarVariant
  /** 模板新增：offcanvas 整体滑出，icon 收起为图标栏 */
  collapsible: Exclude<SidebarCollapsible, 'none'>
  /** The `sidebar` variant's inner-edge border. Default true. */
  bordered?: boolean | undefined
  /** Render the built-in resize/collapse rail handle. `false` hides it and
   *  disables drag-resize — the trigger and keyboard shortcut still toggle. */
  rail?: boolean | undefined
  /** Pin the rail's tooltip open (`true`) or closed (`false`); `undefined`
   *  leaves it on hover. Dragging always hides it. */
  railTooltipOpen?: boolean | undefined
}

/** Internal: the expanded/collapsed desktop rail. An in-flow sticky column
 *  animates its width (this is what reflows the inset) while the fixed-width
 *  panel inside slides out under overflow clipping — container-relative, so
 *  the whole sidebar works inside any bounded frame, not just the viewport.
 *  Ships the resize/collapse rail handle on its inner edge by default. */
const SidebarShell = forwardRef<HTMLDivElement, SidebarShellProps>(
  (
    {
      side,
      variant,
      collapsible,
      bordered = true,
      rail = true,
      railTooltipOpen,
      className,
      children,
      ...props
    },
    ref,
  ) => {
    const {
      open,
      width,
      widthIcon,
      mobileBreakpoint,
      isMobile,
      isResizing,
      peek,
      isPeeking,
      setIsPeeking,
      schedulePeek,
      scheduleDismissPeek,
      cancelPeekTimer,
      labels,
    } = useSidebar()
    const shape = useShape()
    const shellRef = useRef<HTMLDivElement | null>(null)
    const iconMode = collapsible === 'icon'
    const iconRail = useMemo<SidebarIconRailValue>(
      () => ({ iconMode, collapsed: iconMode && !open, side }),
      [iconMode, open, side],
    )

    // Collapsed-peek: the edge strip reveals the sidebar as a floating
    // overlay without pinning it. Hover mode uses small intent/leave delays;
    // both modes dismiss on Escape or an outside press.
    // `!isResizing`: a drag can preview the collapsed state mid-gesture; the
    // shell must not swap to the peek strip then, or it would unmount the
    // rail holding the pointer capture and kill the drag.
    // 模板改动：图标栏收起后仍在屏幕上，不需要 peek
    const peekEnabled = peek !== 'none' && !open && !isResizing && !iconMode
    useEffect(() => {
      if (!(peekEnabled && isPeeking)) return
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') setIsPeeking(false)
      }
      const onPointerDown = (event: PointerEvent) => {
        if (!shellRef.current?.contains(event.target as Node)) setIsPeeking(false)
      }
      // Hover mode holds the peek by geometric containment, not
      // enter/leave: a portalled tooltip or menu covering the card steals
      // the hit-test and fires pointerleave on the shell even though the
      // cursor never left the sidebar. Dismissal is armed only when the
      // pointer's position actually crosses out of the overlay's box (with
      // a little margin), and disarmed the moment it crosses back.
      let wasInside = true
      const onPointerMove = (event: PointerEvent) => {
        const overlay = shellRef.current?.querySelector('[data-sidebar="peek"]') ?? shellRef.current
        if (!overlay) return
        const box = overlay.getBoundingClientRect()
        const inside =
          event.clientX >= box.left - 8 &&
          event.clientX <= box.right + 8 &&
          event.clientY >= box.top - 8 &&
          event.clientY <= box.bottom + 8
        if (inside) {
          // Unconditional (not transition-gated): another surface's leave —
          // the hover-peek trigger's, say — may have armed a dismissal while
          // the pointer was already inside the box.
          wasInside = true
          cancelPeekTimer()
        } else if (wasInside) {
          wasInside = false
          scheduleDismissPeek()
        }
      }
      document.addEventListener('keydown', onKeyDown)
      document.addEventListener('pointerdown', onPointerDown)
      if (peek === 'hover') document.addEventListener('pointermove', onPointerMove)
      return () => {
        document.removeEventListener('keydown', onKeyDown)
        document.removeEventListener('pointerdown', onPointerDown)
        document.removeEventListener('pointermove', onPointerMove)
      }
    }, [peekEnabled, isPeeking, setIsPeeking, peek, cancelPeekTimer, scheduleDismissPeek])
    const substrate = useSurface()
    const floatingLevel = Math.min(substrate + 1, 8)
    // Drag-resize needs the panel glued to the pointer; the spring resumes
    // for open/close. Reduced motion snaps instead of sliding — the state
    // change stays legible without the 256px of travel. The open/close ride
    // the SLOW tier: a whole column moving is the largest thing this
    // component animates (the sheet and peek stay on moderate — drawers
    // settle precisely, per the tier notes).
    const reduceMotion = useReducedMotion() ?? false
    // Mid-drag open flips — the collapse preview and its drag-back rescue —
    // ride the moderate tier instead of the drag's glued duration-0 tracking.
    // The flip is detected synchronously (transition must be right on the
    // very commit whose animate target changes; effects run too late), then
    // `dragFlip` holds the spring through its settle so pointer moves landing
    // right after a flip retarget the spring instead of snapping.
    // Counts drag flips, so each one restarts the hold; 0 is no hold.
    const [dragFlip, setDragFlip] = useState(0)
    // Pinning open from an active peek: the panel is already fully on screen
    // as the overlay card, so while the width spring makes room the shell
    // must not clip — otherwise the visible sidebar wipes in from a mask it
    // never left. The state hold keeps the clip off through the spring.
    const [pinFromPeekHold, setPinFromPeekHold] = useState(false)
    // Both holds start in the render whose `open` flipped (comparing with
    // the last render's `open` and `isPeeking`, kept as state): the provider
    // clears isPeeking in that same render, so only the previous render
    // still knows the card was up.
    const [prevOpen, setPrevOpen] = useState(open)
    const [wasPeeking, setWasPeeking] = useState(isPeeking)
    if (prevOpen !== open) {
      setPrevOpen(open)
      if (isResizing) setDragFlip((n) => n + 1)
      if (open && wasPeeking) setPinFromPeekHold(true)
    }
    if (wasPeeking !== isPeeking) setWasPeeking(isPeeking)
    if (!isResizing && dragFlip !== 0) setDragFlip(0)
    useEffect(() => {
      if (dragFlip === 0) return
      const id = setTimeout(() => setDragFlip(0), exitFallbackMs(spring.moderate))
      return () => clearTimeout(id)
    }, [dragFlip])
    useEffect(() => {
      if (!pinFromPeekHold) return
      const id = setTimeout(() => setPinFromPeekHold(false), exitFallbackMs(spring.slow))
      return () => clearTimeout(id)
    }, [pinFromPeekHold])
    const pinnedFromPeek = pinFromPeekHold
    const isClient = useIsClient()
    // Below the drawer breakpoint the rail also gives its width back, on the
    // same exit tween as the CSS dissolve (slow.exit = 160ms), so the inset
    // slides into the space instead of snapping when display:none lands.
    const shown = open && !isMobile
    // 模板改动：图标栏收起时外壳保留图标栏宽度
    const collapsedWidth = iconMode && !isMobile ? widthIcon : '0rem'
    const widthTransition = reduceMotion
      ? { duration: 0 }
      : isResizing
        ? dragFlip !== 0
          ? open
            ? spring.moderate
            : spring.moderate.exit
          : { duration: 0 }
        : shown
          ? spring.slow
          : spring.slow.exit

    return (
      <motion.div
        ref={(node: HTMLDivElement | null) => {
          shellRef.current = node
          assignRef(ref, node)
        }}
        data-slot="sidebar"
        data-state={open ? 'expanded' : 'collapsed'}
        data-collapsible={open ? '' : collapsible}
        data-variant={variant}
        data-side={side}
        className={cn(
          // No bare `group` here: an unnamed group on the whole rail would
          // fire every descendant's group-hover (Button fills, icon strokes)
          // on rail hover. Named groups (menu-item etc.) handle row states.
          'peer shrink-0 sticky top-0 h-svh',
          // While peek is armed the 0-width shell must not clip the edge
          // strip or the overlay card — and the shell must rise above the
          // inset (a later sibling) so the card paints over it. Pinning from
          // a peek keeps both through the width spring for the same reason.
          peekEnabled || pinnedFromPeek ? 'z-[var(--z-sticky,30)]' : 'overflow-hidden',
          // Flex order (not DOM order) decides the side, so consumers can
          // keep Sidebar before SidebarInset regardless of `side`.
          side === 'right' && 'order-last',
          // The inset rail has no card edge of its own, so its scroll hairline
          // hugs the rows' 8px gutter instead of running panel-wide.
          variant === 'inset' && '[--scroll-divider-inset:8px]',
          BREAKPOINT_HIDDEN[mobileBreakpoint],
          isClient && [BREAKPOINT_FADE_BASE, BREAKPOINT_FADE[mobileBreakpoint]],
          // A non-standard breakpoint has no literal utility in the map, so
          // JS hides the shell (no fade, but never rail + drawer at once).
          !BREAKPOINT_HIDDEN[mobileBreakpoint] && isMobile && 'hidden',
          className,
        )}
        initial={false}
        animate={{ width: shown ? width : collapsedWidth }}
        transition={widthTransition}
        // Hover-mode dismissal lives on the shell root: the pointer can land
        // on the overlay without ever crossing it (the card slides in under
        // a stationary cursor), so per-element leave events are unreliable —
        // leaving the shell subtree is the signal that matters.
        onPointerEnter={peekEnabled && peek === 'hover' ? cancelPeekTimer : undefined}
        // While PEEKED, dismissal belongs to the geometric watcher above —
        // leave events lie whenever portalled content (tooltip, menu) covers
        // the card. This leave handler only retires a pending peek-arm when
        // the cursor departs before the intent delay lands.
        onPointerLeave={
          peekEnabled && peek === 'hover'
            ? () => {
                if (!isPeeking) cancelPeekTimer()
              }
            : undefined
        }
        // 模板改动：exactOptionalPropertyTypes 下 HTML 属性与 motion 属性的可选类型不完全一致，经类型断言转交
        {...(props as Omit<HTMLMotionProps<'div'>, 'ref'>)}
      >
        <SidebarIconRailContext.Provider value={iconRail}>
          {peekEnabled ? (
            <>
              {/* Edge strip: the collapsed sidebar's reveal affordance. A thin
                hairline brightens on hover; hover mode peeks after a short
                intent delay, click mode on press. */}
              <button
                type="button"
                aria-label={labels.peek}
                aria-expanded={isPeeking}
                className={cn(
                  // 模板改动：键盘聚焦时在条内画 2px 焦点环（上游只把细线提亮）
                  'group/peek-strip absolute inset-y-0 z-40 w-3 cursor-pointer outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--focus-ring)',
                  side === 'left' ? 'left-0' : 'right-0',
                )}
                onPointerEnter={
                  peek === 'hover'
                    ? (event) => {
                        if (event.pointerType === 'mouse') schedulePeek()
                      }
                    : undefined
                }
                onClick={() => {
                  cancelPeekTimer()
                  setIsPeeking(true)
                }}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'absolute inset-y-0 w-px bg-border opacity-0 transition-opacity duration-80 group-hover/peek-strip:opacity-100 group-focus-visible/peek-strip:opacity-100',
                    side === 'left' ? 'left-0' : 'right-0',
                  )}
                />
              </button>
              <AnimatePresence>
                {isPeeking && (
                  <motion.div
                    data-sidebar="peek"
                    className={cn(
                      'absolute inset-y-2 z-50 flex flex-col overflow-hidden',
                      // The card's edge inset matches where the PINNED rail's
                      // content sits, so pinning from a peek never shifts the
                      // rows sideways: floating pins into a card inset by the
                      // same gutter; inset/sidebar pin flush to the edge.
                      side === 'left'
                        ? variant === 'floating'
                          ? 'left-2'
                          : 'left-0'
                        : variant === 'floating'
                          ? 'right-2'
                          : 'right-0',
                      shape.container,
                      surfaceClasses(floatingLevel, 3),
                    )}
                    style={{
                      width: `calc(${width} - ${variant === 'floating' ? '1rem' : '0.5rem'})`,
                    }}
                    initial={reduceMotion ? false : { x: side === 'left' ? '-108%' : '108%' }}
                    animate={{ x: 0 }}
                    exit={{
                      x: side === 'left' ? '-108%' : '108%',
                      transition: reduceMotion ? { duration: 0 } : spring.moderate.exit,
                    }}
                    transition={reduceMotion ? { duration: 0 } : spring.moderate}
                  >
                    <SurfaceProvider value={floatingLevel}>{children}</SurfaceProvider>
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          ) : (
            <motion.div
              className={cn(
                'absolute inset-y-0 flex h-full flex-col',
                side === 'left' ? 'left-0' : 'right-0',
                // Floating floats its card inside a full gutter; inset only needs
                // the vertical inset (horizontal room belongs to the nav rows).
                variant === 'floating' && 'p-2',
                variant === 'inset' && 'py-2',
              )}
              // 模板改动：图标栏模式下面板跟随外壳宽度（不滑出），收起后边框与拖拽条仍在图标栏边缘
              style={{ width: iconMode ? '100%' : width }}
              initial={false}
              animate={{ x: open || iconMode ? '0%' : side === 'left' ? '-100%' : '100%' }}
              transition={widthTransition}
            >
              {variant === 'floating' ? (
                <div
                  data-sidebar="sidebar"
                  className={cn(
                    'flex h-full w-full min-h-0 flex-col',
                    shape.container,
                    surfaceClasses(floatingLevel, 3),
                  )}
                >
                  <SurfaceProvider value={floatingLevel}>{children}</SurfaceProvider>
                </div>
              ) : (
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
              )}
              {rail && (
                <SidebarRail
                  {...(railTooltipOpen !== undefined && { tooltipOpen: railTooltipOpen })}
                  className={cn(
                    // The floating card sits inside the panel's p-2 gutter, so the
                    // grab strip (and its hover hairline) moves in to straddle the
                    // card's edge instead of the panel's.
                    variant === 'floating' &&
                      (side === 'left'
                        ? 'right-1 after:right-[3.5px]'
                        : 'left-1 after:left-[3.5px]'),
                    // Cards are vertically inset and rounded — the hover hairline
                    // hugs the card's straight run: fully transparent through the
                    // corner radius, then fading in over 24px (mirrored at the
                    // bottom). The radius rides the shape system via CSS vars.
                    variant !== 'sidebar' &&
                      'after:inset-y-2 after:[mask-image:linear-gradient(to_bottom,transparent_var(--rail-fade-start),black_var(--rail-fade-end),black_calc(100%-var(--rail-fade-end)),transparent_calc(100%-var(--rail-fade-start)))]',
                  )}
                  {...(variant !== 'sidebar' && {
                    style: {
                      '--rail-fade-start': `${shape.containerRadius}px`,
                      '--rail-fade-end': `${shape.containerRadius + 24}px`,
                    } as CSSProperties,
                  })}
                />
              )}
            </motion.div>
          )}
        </SidebarIconRailContext.Provider>
      </motion.div>
    )
  },
)
SidebarShell.displayName = 'SidebarShell'

// ─── SidebarTrigger ──────────────────────────────────────────────────────────

export type SidebarTriggerProps = ButtonProps

/** Keystroke chip rendered inside the (inverted) tooltip surface. */
function ShortcutKbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="-my-1 flex h-4 min-w-4 items-center justify-center rounded border border-background/30 px-1 font-sans text-[length:var(--fs-micro-compact,10px)] leading-[var(--lh-micro-compact,12px)] text-background">
      {children}
    </kbd>
  )
}

/** The toggle keystroke shown in tooltips (null when no shortcut is bound). */
function useShortcutKey(): string | null {
  // 模板改动：快捷键未开启时提示里不显示键帽（上游回退显示默认键）
  return useSidebar().shortcut
}

/** Ghost icon button calling toggleSidebar(). The icon mirrors the
 *  sidebar's side, and its tooltip names the action with the toggle
 *  keystroke by default. */
const SidebarTrigger = forwardRef<HTMLButtonElement, SidebarTriggerProps>(
  ({ onClick, size, children, ...props }, ref) => {
    const {
      toggleSidebar,
      open,
      openMobile,
      isMobile,
      side,
      peek,
      isPeeking,
      schedulePeek,
      cancelPeekTimer,
      labels,
    } = useSidebar()
    const shortcutKey = useShortcutKey()
    // With hover-peek enabled, the COLLAPSED trigger is a peek affordance
    // too: resting on it floats the rail out exactly like the edge strip —
    // same shared intent timer, so moving from the trigger into the peeked
    // card (or back) cancels the pending dismissal.
    const hoverPeek = peek === 'hover' && !isMobile && !open
    const icons = useIcons()
    const PanelLeftIcon = icons['panel-left']
    const PanelRightIcon = icons['panel-right']
    const TriggerIcon = side === 'right' ? PanelRightIcon : PanelLeftIcon
    const iconSize = useSizeVariant() === 'compact' ? ('icon-compact' as const) : ('icon' as const)
    const collapsed = isMobile ? !openMobile : !open
    // 模板改动：上游可读名称固定为英文 "Toggle Sidebar"，这里随状态取调用方传入的展开 / 收起文案
    const actionLabel = collapsed ? labels.expand : labels.collapse

    return (
      <Tooltip
        side="bottom"
        content={
          <span className="flex items-center gap-1.5">
            {/* A flex row escapes the surface's text-box trim, so the label
                re-applies it — otherwise the shortcut row would sit taller
                than a tooltip without a chip. */}
            <span className="[text-box:trim-both_cap_alphabetic]">{actionLabel}</span>
            {shortcutKey && <ShortcutKbd>{shortcutKey}</ShortcutKbd>}
          </span>
        }
      >
        <Button
          ref={ref}
          variant="ghost"
          size={size ?? iconSize}
          data-sidebar="trigger"
          aria-label={actionLabel}
          // 模板改动：读屏可知侧栏当前是否展开；移动端打开的是抽屉（对话框）
          aria-expanded={!collapsed}
          {...(isMobile && { 'aria-haspopup': 'dialog' as const })}
          onClick={(event) => {
            onClick?.(event)
            toggleSidebar()
          }}
          onPointerEnter={
            hoverPeek
              ? (event: ReactPointerEvent) => {
                  if (event.pointerType !== 'mouse') return
                  if (isPeeking) cancelPeekTimer()
                  else schedulePeek()
                }
              : undefined
          }
          // While PEEKED the shell's geometric watcher owns dismissal — a
          // leave fired here can be the peek card sliding over a stationary
          // cursor (layout-driven boundary event, no accompanying move to
          // disarm it), which would flicker the peek closed and open again.
          // This leave only retires a pending intent timer.
          onPointerLeave={
            hoverPeek
              ? () => {
                  if (!isPeeking) cancelPeekTimer()
                }
              : undefined
          }
          {...props}
        >
          {children ?? <TriggerIcon />}
        </Button>
      </Tooltip>
    )
  },
)
SidebarTrigger.displayName = 'SidebarTrigger'

// ─── SidebarRail ─────────────────────────────────────────────────────────────

export interface SidebarRailProps extends HTMLAttributes<HTMLButtonElement> {
  /** Pin the tooltip open/closed; `undefined` leaves it on hover. */
  tooltipOpen?: boolean
}

/** The grab strip on the sidebar's inner edge, rendered by default inside
 *  the desktop shell: drag it to resize (clamped), click it to collapse, and
 *  its tooltip explains both with the toggle keystroke. Hovering it
 *  brightens the edge border. */
const SidebarRail = forwardRef<HTMLButtonElement, SidebarRailProps>(
  ({ className, tooltipOpen, ...props }, ref) => {
    const { toggleSidebar, open, setOpen, setWidth, side, setIsResizing, labels } = useSidebar()
    const iconRail = useSidebarIconRail()
    const shortcutKey = useShortcutKey()
    const railRef = useRef<HTMLButtonElement | null>(null)
    const dragRef = useRef<{
      startX: number
      startWidth: number
      moved: boolean
      collapsed: boolean
    } | null>(null)
    const [dragging, setDragging] = useState(false)

    const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
      const panel = railRef.current?.closest('[data-slot="sidebar"]') as HTMLElement | null
      if (!panel) return
      // 模板改动：图标栏收起时从收起状态开始拖，拉过阈值即展开（上游收起后拖拽条不可见）
      dragRef.current = {
        startX: event.clientX,
        startWidth: panel.offsetWidth,
        moved: false,
        collapsed: !open,
      }
      event.currentTarget.setPointerCapture(event.pointerId)
    }

    const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current
      if (!drag) return
      const dx = event.clientX - drag.startX
      if (!drag.moved && Math.abs(dx) < 4) return
      if (!drag.moved) {
        drag.moved = true
        setDragging(true)
        setIsResizing(true)
      }
      const delta = side === 'left' ? dx : -dx
      const raw = drag.startWidth + delta
      // Dragged well past the minimum, toward the edge: preview the collapse
      // but keep the drag session alive — pulling back past the threshold
      // re-expands, so an overshoot isn't committed until release.
      if (raw < SIDEBAR_MIN_WIDTH - SIDEBAR_COLLAPSE_SLOP) {
        if (!drag.collapsed) {
          drag.collapsed = true
          setWidth(`${SIDEBAR_MIN_WIDTH}px`)
          setOpen(false)
        }
        return
      }
      if (drag.collapsed) {
        drag.collapsed = false
        setOpen(true)
      }
      const next = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, raw))
      setWidth(`${next}px`)
    }

    const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current
      dragRef.current = null
      event.currentTarget.releasePointerCapture(event.pointerId)
      setDragging(false)
      setIsResizing(false)
      // A press that never turned into a drag is the collapse click.
      if (drag && !drag.moved) toggleSidebar()
    }

    // A cancelled pointer (touch interruption, capture loss) ends the drag
    // where it stands — no collapse-click, capture is already released.
    const onPointerCancel = () => {
      dragRef.current = null
      setDragging(false)
      setIsResizing(false)
    }

    const forceOpen = dragging ? false : tooltipOpen

    return (
      <Tooltip
        side={side === 'left' ? 'right' : 'left'}
        sideOffset={8}
        followCursor="y"
        {...(forceOpen !== undefined && { forceOpen })}
        content={
          iconRail.collapsed ? (
            // 模板新增：图标栏收起时拖拽条点击是展开
            <span className="flex items-center gap-1.5">
              <span className="[text-box:trim-both_cap_alphabetic]">{labels.expand}</span>
              {shortcutKey && <ShortcutKbd>{shortcutKey}</ShortcutKbd>}
            </span>
          ) : (
            // The flex column escapes the tooltip surface's text-box trim, so
            // BOTH lines re-apply it and the gap alone carries the line rhythm
            // — an untrimmed line would smuggle its half-leading back in as
            // lopsided padding.
            <span className="flex flex-col items-start gap-2">
              <span className="[text-box:trim-both_cap_alphabetic]">{labels.railResize}</span>
              <span className="flex items-center gap-1.5">
                <span className="[text-box:trim-both_cap_alphabetic]">{labels.railCollapse}</span>
                {shortcutKey && <ShortcutKbd>{shortcutKey}</ShortcutKbd>}
              </span>
            </span>
          )
        }
      >
        <button
          ref={(node) => {
            railRef.current = node
            assignRef(ref, node)
          }}
          type="button"
          data-sidebar="rail"
          aria-label={iconRail.collapsed ? labels.expand : labels.rail}
          tabIndex={-1}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          className={cn(
            // touch-none: without it the browser claims a touch drag for
            // scrolling and pointercancels the resize mid-gesture.
            'absolute inset-y-0 z-20 w-2 cursor-col-resize touch-none outline-none',
            // Positioned from context (not group-data selectors) so variant
            // offsets passed via className can win the merge.
            side === 'left' ? 'right-0' : 'left-0',
            // Hovering brightens the edge border the shell draws by default;
            // a pinned tooltip brightens it too, so the spotlight reads as
            // the hover it stands in for.
            'after:absolute after:inset-y-0 after:w-px after:bg-transparent hover:after:bg-foreground/25 after:transition-colors after:duration-80',
            tooltipOpen && 'after:bg-foreground/25',
            side === 'left' ? 'after:right-0' : 'after:left-0',
            className,
          )}
          {...props}
        />
      </Tooltip>
    )
  },
)
SidebarRail.displayName = 'SidebarRail'

// ─── SidebarInset ────────────────────────────────────────────────────────────

export interface SidebarInsetProps extends HTMLAttributes<HTMLElement> {
  /** 模板新增：面板元素。面板里同时放顶部条与正文时传 `div`，正文自己用 `<main>`，顶部条不落在 main 地标里。
   *  @default "main" */
  as?: 'main' | 'div'
}

const SidebarInset = forwardRef<HTMLElement, SidebarInsetProps>(
  ({ as: Tag = 'main', className, ...props }, ref) => {
    const shape = useShape()
    return (
      <Tag
        // main 与 div 都是 HTMLElement，按 div 的 ref 类型交给 JSX
        ref={ref as Ref<HTMLDivElement>}
        data-slot="sidebar-inset"
        className={cn(
          'relative flex min-h-0 w-full min-w-0 flex-1 flex-col bg-background',
          'peer-data-[variant=inset]:m-2 peer-data-[variant=inset]:peer-data-[side=left]:ml-0 peer-data-[variant=inset]:peer-data-[side=right]:mr-0',
          // With the rail collapsed away, restore the sidebar-side margin so
          // the card keeps symmetric insets.
          // 模板改动：只在 offcanvas 整体收走时补边距；图标栏收起后栏仍在，面板贴着图标栏不加左边距
          'peer-data-[variant=inset]:peer-data-[collapsible=offcanvas]:peer-data-[side=left]:ml-2 peer-data-[variant=inset]:peer-data-[collapsible=offcanvas]:peer-data-[side=right]:mr-2',
          // 模板改动：抽屉断点（默认 768px）以下栏已隐藏，面板铺满视口，不留外边距、圆角与阴影
          'peer-data-[variant=inset]:max-md:m-0 peer-data-[variant=inset]:max-md:rounded-none peer-data-[variant=inset]:max-md:shadow-none',
          'transition-[margin] duration-80',
          // Container radius follows the shape system (literal classes so
          // Tailwind's scanner emits both).
          {
            pill: 'peer-data-[variant=inset]:rounded-3xl',
            rounded: 'peer-data-[variant=inset]:rounded-xl',
            sharp: 'peer-data-[variant=inset]:rounded-[1px]',
          }[shape.variant],
          'peer-data-[variant=inset]:bg-surface-2 peer-data-[variant=inset]:shadow-surface-2',
          className,
        )}
        {...props}
      />
    )
  },
)
SidebarInset.displayName = 'SidebarInset'

// ─── SidebarInput ────────────────────────────────────────────────────────────

export type SidebarInputProps = InputHTMLAttributes<HTMLInputElement>

const SidebarInput = forwardRef<HTMLInputElement, SidebarInputProps>(
  ({ className, ...props }, ref) => {
    const shape = useShape()
    const size = useSize()
    return (
      <input
        ref={ref}
        data-sidebar="input"
        className={cn(
          // Mirrors the InputGroup field ladder: transparent at rest,
          // muted fill + border ring on hover, card fill when focused.
          // 模板改动：悬停底色用 bg-hover、边框取 --field-border（与 Input 一致），焦点为 2px 描边加间隙
          'w-full bg-transparent px-3 text-foreground placeholder:text-muted-foreground outline-none',
          'ring-1 ring-transparent transition-[background-color,box-shadow] duration-80',
          'hover:bg-hover hover:ring-(--field-border)',
          'focus:bg-card focus:ring-(--field-border)',
          'focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring)',
          size.variant === 'compact' ? 'h-7' : 'h-8',
          size.field,
          shape.input,
          className,
        )}
        {...props}
      />
    )
  },
)
SidebarInput.displayName = 'SidebarInput'

// ─── SidebarHeader / SidebarFooter / SidebarSeparator ────────────────────────

export type SidebarSectionProps = HTMLAttributes<HTMLDivElement>

const SidebarHeader = forwardRef<HTMLDivElement, SidebarSectionProps>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-sidebar="header"
      className={cn('flex shrink-0 flex-col gap-2 p-2', className)}
      {...props}
    />
  ),
)
SidebarHeader.displayName = 'SidebarHeader'

const SidebarFooter = forwardRef<HTMLDivElement, SidebarSectionProps>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-sidebar="footer"
      className={cn('mt-auto flex shrink-0 flex-col gap-2 p-2', className)}
      {...props}
    />
  ),
)
SidebarFooter.displayName = 'SidebarFooter'

const SidebarSeparator = forwardRef<HTMLDivElement, SidebarSectionProps>(
  ({ className, ...props }, ref) => (
    // biome-ignore lint/a11y/useSemanticElements: 与分组同为 div，hr 在 flex 列中有默认外边距与边框（上游写法）
    <div
      ref={ref}
      data-sidebar="separator"
      role="separator"
      aria-orientation="horizontal"
      className={cn('mx-2 h-px shrink-0 bg-border', className)}
      {...props}
    />
  ),
)
SidebarSeparator.displayName = 'SidebarSeparator'

// ─── SidebarGroup family ─────────────────────────────────────────────────────

interface SidebarGroupContextValue {
  open: boolean
  toggle: () => void
  contentId: string
  /** How many header action buttons overlay the label's right edge — the
   *  collapsible label pads itself so its chevron clears them. */
  actionsCount: number
}

const SidebarGroupContext = createContext<SidebarGroupContextValue | null>(null)

export interface SidebarGroupProps extends SidebarSectionProps {
  /** Makes the group's SidebarGroupLabel a toggle that collapses everything
   *  rendered after it — a group-level accordion. Uncontrolled by default;
   *  pass `open`/`onOpenChange` to control it. */
  collapsible?: boolean
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
}

const SidebarGroup = forwardRef<HTMLDivElement, SidebarGroupProps>(
  (
    {
      className,
      collapsible = false,
      open: openProp,
      defaultOpen = true,
      onOpenChange,
      children,
      ...props
    },
    ref,
  ) => {
    const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen)
    const open = openProp ?? uncontrolledOpen
    const contentId = useId()
    const toggle = useCallback(() => {
      const next = !(openProp ?? uncontrolledOpen)
      setUncontrolledOpen(next)
      onOpenChange?.(next)
    }, [openProp, uncontrolledOpen, onOpenChange])
    // Measured-height collapse: animate between 0 and the content's real
    // offsetHeight — never to "auto", which framer measures wrong under a
    // scaled ancestor.
    const contentRef = useRef<HTMLDivElement>(null)
    const [contentHeight, setContentHeight] = useState<number | null>(null)
    useIsoLayoutEffect(() => {
      if (!collapsible) return
      const el = contentRef.current
      if (!el || typeof ResizeObserver === 'undefined') return
      const measure = () => setContentHeight(el.offsetHeight)
      measure()
      const ro = new ResizeObserver(measure)
      ro.observe(el)
      return () => ro.disconnect()
    }, [collapsible])
    const measured = contentHeight !== null
    // The collapse wrapper must clip while animating, but a permanently
    // clipped box shaves the 2px focus ring off a group's first and last
    // rows — so clipping lifts once an open group has settled.
    const [settled, setSettled] = useState(open)
    if (!open && settled) setSettled(false)

    // Height animates only when THIS group toggles. When the measured height
    // changes underneath it instead — a nested sub-menu collapsing inside the
    // group — the wrapper must snap: a spring re-targeted every frame chases
    // the child's own animation, lands well after it, and drags everything
    // below the group along late. Tracked against the previous `open` so a
    // controlled `open` is covered too, and cleared once the toggle's
    // animation lands.
    const [prevOpen, setPrevOpen] = useState(open)
    const [toggling, setToggling] = useState(false)
    if (prevOpen !== open) {
      setPrevOpen(open)
      setToggling(true)
    }

    // The label and any header actions stay put; everything else after the
    // label rides in the collapse wrapper. If no SidebarGroupLabel child is
    // found the group renders untouched.
    const isHeaderAction = (k: ReactNode) =>
      isValidElement(k) && (k.type === SidebarGroupAction || k.type === SidebarGroupActions)
    let inner: ReactNode = children
    let actionsCount = 0
    if (collapsible) {
      const kids = Children.toArray(children)
      const labelIdx = kids.findIndex((k) => isValidElement(k) && k.type === SidebarGroupLabel)
      if (labelIdx !== -1) {
        const tail = kids.slice(labelIdx + 1)
        const headerActions = tail.filter(isHeaderAction)
        const rest = tail.filter((k) => !isHeaderAction(k))
        actionsCount = headerActions.reduce<number>(
          (n, k) =>
            n +
            (isValidElement(k) && k.type === SidebarGroupActions
              ? Children.count((k.props as { children?: ReactNode }).children)
              : 1),
          0,
        )
        inner = (
          <>
            {kids.slice(0, labelIdx)}
            {/* Header hover scope: hovering anywhere on the row — the
                overlaid action cluster included, which never :hovers the
                label element itself — reveals the label's chevron. Kept
                position-static so the cluster's absolute box still anchors
                to the group and stays on the rows' action axis. */}
            <div className="group/group-header w-full">
              {kids[labelIdx]}
              {headerActions}
            </div>
            <motion.div
              id={contentId}
              aria-hidden={open ? undefined : true}
              className={cn(
                open && settled ? 'overflow-visible' : 'overflow-hidden',
                !measured && !open && 'h-0',
              )}
              initial={false}
              animate={
                measured
                  ? { height: open ? (contentHeight ?? 0) : 0, opacity: open ? 1 : 0 }
                  : { opacity: open ? 1 : 0 }
              }
              // Do NOT simplify this to `open ? spring.moderate : …`. The
              // toggling arm is what stops a re-measure from springing —
              // without it a nested collapse makes this wrapper chase its own
              // child and everything below the group moves late.
              transition={
                toggling ? (open ? spring.moderate : spring.moderate.exit) : { duration: 0 }
              }
              onAnimationComplete={() => {
                setToggling(false)
                if (open) setSettled(true)
              }}
            >
              <div ref={contentRef} className="flex w-full min-w-0 flex-col">
                {rest}
              </div>
            </motion.div>
          </>
        )
      }
    }

    const ctx = useMemo(
      () => ({ open, toggle, contentId, actionsCount }),
      [open, toggle, contentId, actionsCount],
    )

    return (
      <MotionFeatures>
        <div
          ref={ref}
          data-sidebar="group"
          data-state={collapsible ? (open ? 'open' : 'closed') : undefined}
          className={cn('relative flex w-full min-w-0 flex-col p-2', className)}
          {...props}
        >
          <SidebarGroupContext.Provider value={collapsible ? ctx : null}>
            {inner}
          </SidebarGroupContext.Provider>
        </div>
      </MotionFeatures>
    )
  },
)
SidebarGroup.displayName = 'SidebarGroup'

export interface SidebarGroupLabelProps extends HTMLAttributes<HTMLDivElement> {
  render?: ReactElement
  asChild?: boolean
}

const SidebarGroupLabel = forwardRef<HTMLDivElement, SidebarGroupLabelProps>(
  ({ className, render, asChild, children, ...props }, ref) => {
    const sizeVariant = useSizeVariant()
    const sizeClasses = useSize()
    const group = useContext(SidebarGroupContext)
    const shape = useShape()
    const icons = useIcons()
    const ChevronRightIcon = icons['chevron-right']
    // 模板新增：收起为图标栏时分组标题隐藏但保留高度，各行图标不随收起上下跳动
    const iconCollapsed = useSidebarIconRail().collapsed
    const { template, content } = resolveSlotTemplate(render, asChild, children)

    // Truncate only the leading text; element children (count badges,
    // trailing controls) stay flex siblings so the row's gap keeps spacing
    // them — same split MenuRowLabel does for menu rows.
    const nodes = Children.toArray(content)
    let textEnd = 0
    while (
      textEnd < nodes.length &&
      (typeof nodes[textEnd] === 'string' || typeof nodes[textEnd] === 'number')
    ) {
      textEnd++
    }
    const leadingText = nodes.slice(0, textEnd).join('')
    const labelContent = leadingText ? (
      <>
        <span className="min-w-0 truncate">{leadingText}</span>
        {nodes.slice(textEnd)}
      </>
    ) : (
      content
    )

    // Inside a collapsible group the label becomes the toggle. Design
    // treatment is unchanged — hover only raises the label's contrast and
    // reveals a chevron (kept visible while collapsed as the reopen cue).
    if (group) {
      return (
        <SlotElement
          template={template}
          defaultTag="button"
          elementRef={ref as Ref<HTMLElement>}
          props={{
            type: template ? undefined : 'button',
            'data-sidebar': 'group-label',
            'aria-expanded': group.open,
            'aria-controls': group.contentId,
            onClick: group.toggle,
            // The action cluster overlays the label's right edge, so the label
            // pads past it — far enough that the hover-revealed chevron lands
            // one cluster gap (4px) to its left and the whole trailing run
            // keeps a single rhythm. Cluster width is 24px per action plus 4px
            // between them; add that gap again, less the 8px the group's
            // padding already gives back: 28n + 6. The cluster is always
            // visible, so the reservation is permanent.
            style:
              group.actionsCount > 0
                ? ({ '--group-actions-pad': `${group.actionsCount * 28 + 6}px` } as CSSProperties)
                : undefined,
            className: cn(
              'flex h-8 w-full shrink-0 cursor-pointer select-none items-center gap-2 px-2 text-left text-muted-foreground outline-none',
              'transition-colors duration-80 hover:text-muted-foreground',
              group.actionsCount > 0 && 'pr-[var(--group-actions-pad)]',
              // 模板改动：焦点环 2px 描边加 2px 间隙（上游 1px ring）
              'focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring)',
              iconCollapsed && 'invisible',
              shape.item,
              typeClass('caption', sizeVariant),
              className,
            ),
            ...props,
          }}
        >
          {labelContent}
          {/* The chevron occupies an action-sized box, so it reads as one more
                icon in the row rather than a smaller glyph tacked on the end.
                One chevron-right glyph for both states, sprung 90° to point
                down while the group is open — the motion wrapper is what
                animates: Tailwind's rotate-* sets the standalone CSS `rotate`
                property, which transition-transform never covers. While open
                the whole box collapses to zero width at rest so the label text
                keeps the full row; hover/focus (or an open action popup)
                reveals it. Collapsed keeps it visible as the reopen cue. */}
          {/* No width/opacity transition: animating the box's width slides
                the glyph in from the side — the chevron should simply be
                there once the header is hovered. */}
          <span
            className={cn(
              'ml-auto flex h-6 shrink-0 items-center justify-center overflow-hidden',
              group.open
                ? 'w-0 opacity-0 group-hover/group-header:w-6 group-hover/group-header:opacity-100 group-focus-within/group-header:w-6 group-focus-within/group-header:opacity-100 group-has-[[data-sidebar=group-action]:is([data-state=open],[data-popup-open],[aria-expanded=true])]/group-header:w-6 group-has-[[data-sidebar=group-action]:is([data-state=open],[data-popup-open],[aria-expanded=true])]/group-header:opacity-100 pointer-coarse:w-6 pointer-coarse:opacity-100'
                : 'w-6 opacity-100',
            )}
          >
            <motion.span
              className="inline-flex"
              animate={{ rotate: group.open ? 90 : 0 }}
              transition={spring.fast}
            >
              <ChevronRightIcon size={sizeClasses.icon} strokeWidth={1.5} className="shrink-0" />
            </motion.span>
          </span>
        </SlotElement>
      )
    }

    return (
      <SlotElement
        template={template}
        defaultTag="div"
        elementRef={ref as Ref<HTMLElement>}
        props={{
          'data-sidebar': 'group-label',
          className: cn(
            'flex h-8 shrink-0 items-center gap-2 px-2 text-muted-foreground outline-none',
            iconCollapsed && 'invisible',
            typeClass('caption', sizeVariant),
            className,
          ),
          ...props,
        }}
      >
        {labelContent}
      </SlotElement>
    )
  },
)
SidebarGroupLabel.displayName = 'SidebarGroupLabel'

export interface SidebarGroupActionProps extends HTMLAttributes<HTMLButtonElement> {
  render?: ReactElement
  asChild?: boolean
}

/** True while rendering inside a SidebarGroupActions cluster, where each
 *  action sits in the flex row instead of positioning itself absolutely. */
const GroupActionsContext = createContext(false)

const SidebarGroupAction = forwardRef<HTMLButtonElement, SidebarGroupActionProps>(
  ({ className, render, asChild, children, ...props }, ref) => {
    const shape = useShape()
    const sizeClasses = useSize()
    const inCluster = useContext(GroupActionsContext)
    const iconCollapsed = useSidebarIconRail().collapsed
    const { template, content } = resolveSlotTemplate(render, asChild, children)
    return (
      <SlotElement
        template={template}
        defaultTag="button"
        elementRef={ref as Ref<HTMLElement>}
        props={{
          type: template ? undefined : 'button',
          'data-sidebar': 'group-action',
          className: cn(
            inCluster
              ? 'relative flex size-6 items-center justify-center text-muted-foreground outline-none'
              : // size-6 matches the rows' action hit-box, and right-3.5 puts that
                // 24px box's centre 26px from the sidebar's inner edge — the axis
                // the rows' badges and actions already sit on.
                'absolute right-3.5 top-3 flex size-6 items-center justify-center text-muted-foreground outline-none',
            'hover:bg-hover hover:text-foreground transition-colors duration-80',
            // 模板改动：焦点环 2px 描边加 2px 间隙（上游 1px ring）
            'focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring)',
            // Normalize bare icons to the site's 1.5 stroke (library defaults
            // vary), thickening to 2 on hover — the same treatment Button's
            // icon-only span applies.
            '[&_svg]:size-[var(--icon-size)] [&_svg]:shrink-0 [&_svg]:stroke-[1.5] [&_svg]:transition-[stroke-width] [&_svg]:duration-80 hover:[&_svg]:stroke-[2]',
            !inCluster && iconCollapsed && 'invisible',
            shape.item,
            className,
          ),
          ...props,
          // After ...props: the spread would otherwise replace this object
          // wholesale and drop the icon-size the glyph is sized from.
          style: {
            ...({ '--icon-size': `${sizeClasses.icon}px` } as CSSProperties),
            ...(props.style ?? {}),
          },
        }}
      >
        {content}
      </SlotElement>
    )
  },
)
SidebarGroupAction.displayName = 'SidebarGroupAction'

/** Header action cluster: 1–3 SidebarGroupActions laid out in a row over the
 *  group label's right edge. Use instead of a lone SidebarGroupAction when a
 *  section needs several controls. */
export type SidebarGroupActionsProps = HTMLAttributes<HTMLDivElement>

const SidebarGroupActions = forwardRef<HTMLDivElement, SidebarGroupActionsProps>(
  ({ className, children, ...props }, ref) => {
    const iconCollapsed = useSidebarIconRail().collapsed
    return (
      <div
        ref={ref}
        data-sidebar="group-actions"
        className={cn(
          // right-3.5 lands the last 24px action's centre 26px from the
          // sidebar's inner edge — the rows' badge/action axis, so the header's
          // controls line up with the column below them.
          'absolute right-3.5 top-2 z-10 flex h-8 items-center gap-1',
          iconCollapsed && 'invisible',
          className,
        )}
        {...props}
      >
        <GroupActionsContext.Provider value={true}>{children}</GroupActionsContext.Provider>
      </div>
    )
  },
)
SidebarGroupActions.displayName = 'SidebarGroupActions'

const SidebarGroupContent = forwardRef<HTMLDivElement, SidebarSectionProps>(
  ({ className, ...props }, ref) => (
    <div ref={ref} data-sidebar="group-content" className={cn('w-full', className)} {...props} />
  ),
)
SidebarGroupContent.displayName = 'SidebarGroupContent'

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
  SidebarShell,
  SidebarTrigger,
}
