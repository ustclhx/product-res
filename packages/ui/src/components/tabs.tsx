// 来源：fluid-functionalism radix/tabs（2026-11，https://www.fluidfunctionalism.com/r/tabs.json，MIT）
// 适配：radix-ui 统一包导入、包内相对路径、去掉 "use client"；其余改动见 packages/ui/UPSTREAM.md

import { AnimatePresence, m as motion, type Transition, useReducedMotion } from 'motion/react'
import { Tabs as TabsPrimitive } from 'radix-ui'
import {
  createContext,
  type FocusEvent,
  forwardRef,
  type HTMLAttributes,
  type MouseEvent,
  type MutableRefObject,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useFluidHover } from '../hooks/use-fluid-hover.ts'
import { fontWeights } from '../lib/font-weight.ts'
import type { IconComponent } from '../lib/icon-context.tsx'
import { MotionFeatures } from '../lib/motion-features.tsx'
import { useShape } from '../lib/shape-context.tsx'
import { SizeProvider, type SizeVariant, useSize } from '../lib/size-context.tsx'
import { spring } from '../lib/springs.ts'
import { cn } from '../lib/utils.ts'

// 模板改动：减少动态效果时药丸与焦点环直接落到目标位置、折叠标签直接展开到终宽，只保留透明度淡入淡出。
// 这些动画驱动的是 left / width 等布局属性而不是 transform，UiRoot 的 MotionConfig 不会去掉它们，
// 所以组件自己读取系统设置（同 FluidHoverHighlight、Switch）。
const SNAP = { duration: 0 } as const

/** 位置用给定弹簧（减少动态效果时瞬移），透明度保持给定的淡入淡出 */
function positional(base: Transition, reduceMotion: boolean, opacity: Transition): Transition {
  return { ...(reduceMotion ? SNAP : base), opacity }
}

interface TabsContextValue {
  registerTab: (index: number, element: HTMLElement | null) => void
  hoveredIndex: number | null
  selectedIndex: number
  idPrefix: string | undefined
  activeLabel: boolean
  reduceMotion: boolean
}

const TabsContext = createContext<TabsContextValue | null>(null)

function useTabs() {
  const ctx = useContext(TabsContext)
  if (!ctx) throw new Error('useTabs must be used within a Tabs')
  return ctx
}

function assignRef<T>(
  ref: ((node: T | null) => void) | MutableRefObject<T | null> | null,
  node: T | null,
) {
  if (typeof ref === 'function') ref(node)
  else if (ref) ref.current = node
}

interface TabsProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  children: ReactNode
  selectedIndex: number
  onSelect: (index: number) => void
  idPrefix?: string
  /** When true, only the selected tab shows its text label. Requires icons on tabs.
   *  未选中的标签只显示图标，其可读名称取自 TabsItem 的必填 `label`。 */
  activeLabel?: boolean
  /** Pins the tabs to one step of the size ladder (default 36px, compact
   *  28px — see /docs/sizes). Omitted, they follow the surrounding
   *  SizeProvider. */
  size?: SizeVariant
}

const Tabs = forwardRef<HTMLDivElement, TabsProps>(
  (
    { children, selectedIndex, onSelect, idPrefix, activeLabel = false, size, className, ...props },
    ref,
  ) => {
    const containerRef = useRef<HTMLDivElement>(null)
    // Whether the pointer is over the list: a ref for blur, which reads it at
    // the moment it runs, and the same flag as state for the render, which
    // picks the hover pill's exit from it. Both flip in the same handlers.
    const isMouseInside = useRef(false)
    const [mouseInside, setMouseInside] = useState(false)
    const shape = useShape()
    const reduceMotion = useReducedMotion() ?? false

    const {
      activeIndex: hoveredIndex,
      setActiveIndex: setHoveredIndex,
      itemRects: tabRects,
      handlers,
      registerItem,
      measureItems: measureTabs,
    } = useFluidHover(containerRef, { axis: 'x' })

    // Track tab elements locally so we can observe their individual resizes
    const tabElementsRef = useRef(new Map<number, HTMLElement>())
    const registerTab = useCallback(
      (index: number, element: HTMLElement | null) => {
        registerItem(index, element)
        if (element) {
          tabElementsRef.current.set(index, element)
        } else {
          tabElementsRef.current.delete(index)
        }
      },
      [registerItem],
    )

    // biome-ignore lint/correctness/useExhaustiveDependencies: 上游按 children 变化重新测量
    useEffect(() => {
      measureTabs()
    }, [measureTabs, children])

    // Observe individual tab buttons for resize (label expand/collapse in activeLabel mode)
    // biome-ignore lint/correctness/useExhaustiveDependencies: 上游按 children 变化重新订阅
    useEffect(() => {
      const elements = tabElementsRef.current
      if (elements.size === 0 || typeof ResizeObserver === 'undefined') return
      const ro = new ResizeObserver(() => measureTabs())
      for (const el of elements.values()) ro.observe(el)
      return () => ro.disconnect()
    }, [measureTabs, children])

    // Wrap handlers to track isMouseInside
    const handleMouseMove = useCallback(
      (e: MouseEvent) => {
        isMouseInside.current = true
        setMouseInside(true)
        handlers.onMouseMove(e)
      },
      [handlers],
    )

    const handleMouseLeave = useCallback(() => {
      isMouseInside.current = false
      setMouseInside(false)
      handlers.onMouseLeave()
    }, [handlers])

    const [focusedIndex, setFocusedIndex] = useState<number | null>(null)

    const selectedRect = tabRects[selectedIndex]
    const hoverRect = hoveredIndex !== null ? tabRects[hoveredIndex] : null
    const focusRect = focusedIndex !== null ? tabRects[focusedIndex] : null
    const isHoveringSelected = hoveredIndex === selectedIndex
    const isHovering = hoveredIndex !== null && !isHoveringSelected

    const root = (
      <MotionFeatures>
        <TabsContext.Provider
          value={{ registerTab, hoveredIndex, selectedIndex, idPrefix, activeLabel, reduceMotion }}
        >
          {/* Root is merged into List via `asChild` so a single <div> is
            emitted. Radix owns
            role="tablist", roving tabindex, and Arrow/Home/End keyboard
            navigation. Radix tab values are strings, so the numeric
            selectedIndex is mapped through String()/Number().
            `activationMode="manual"` keeps manual activation: arrows move
            focus, Enter/Space selects. */}
          <TabsPrimitive.Root
            asChild
            value={String(selectedIndex)}
            onValueChange={(value) => onSelect(Number(value))}
            activationMode="manual"
          >
            <TabsPrimitive.List
              ref={(node: HTMLDivElement | null) => {
                containerRef.current = node
                assignRef(ref, node)
              }}
              onMouseMove={handleMouseMove}
              onMouseLeave={handleMouseLeave}
              onFocus={(e: FocusEvent<HTMLDivElement>) => {
                const indexAttr = (e.target as HTMLElement)
                  .closest('[data-fluid-hover-index]')
                  ?.getAttribute('data-fluid-hover-index')
                if (indexAttr != null) {
                  const idx = Number(indexAttr)
                  setHoveredIndex(idx)
                  setFocusedIndex((e.target as HTMLElement).matches(':focus-visible') ? idx : null)
                }
              }}
              onBlur={(e: FocusEvent<HTMLDivElement>) => {
                if (containerRef.current?.contains(e.relatedTarget as Node)) return
                setFocusedIndex(null)
                if (isMouseInside.current) return
                setHoveredIndex(null)
              }}
              className={cn(
                // -mx-1 px-1 / -my-1 py-1 give the 2px-outset focus ring room
                // to draw without being clipped by overflow-x-auto. The
                // max-width allows for the negative margins: fit-content
                // parents size against the margin box (8px narrower than the
                // border box), so a plain max-w-full would clamp the list 8px
                // too small and clip the first/last tab's ring.
                // 模板改动：焦点环为 2px 描边 + 2px 间隙，共外扩 4px，正好落在这 4px 内边距里
                'relative flex items-center select-none overflow-x-auto max-w-[calc(100%_+_8px)] scrollbar-hide -mx-1 px-1 -my-1 py-1',
                className,
              )}
              {...props}
            >
              {/* Selected pill */}
              {selectedRect && (
                <motion.div
                  data-slot="tabs-indicator"
                  className={cn('absolute bg-active pointer-events-none', shape.bg)}
                  initial={false}
                  animate={{
                    left: selectedRect.left,
                    width: selectedRect.width,
                    top: selectedRect.top,
                    height: selectedRect.height,
                    opacity: isHovering ? 0.8 : 1,
                  }}
                  transition={positional(spring.moderate, reduceMotion, { duration: 0.08 })}
                />
              )}

              {/* Hover pill */}
              <AnimatePresence>
                {hoverRect && !isHoveringSelected && selectedRect && (
                  <motion.div
                    data-slot="tabs-hover"
                    className={cn('absolute bg-active pointer-events-none', shape.bg)}
                    initial={{
                      left: selectedRect.left,
                      width: selectedRect.width,
                      top: selectedRect.top,
                      height: selectedRect.height,
                      opacity: 0,
                    }}
                    animate={{
                      left: hoverRect.left,
                      width: hoverRect.width,
                      top: hoverRect.top,
                      height: hoverRect.height,
                      opacity: 0.4,
                    }}
                    exit={
                      !mouseInside && selectedRect
                        ? {
                            left: selectedRect.left,
                            width: selectedRect.width,
                            top: selectedRect.top,
                            height: selectedRect.height,
                            opacity: 0,
                            transition: positional(spring.moderate, reduceMotion, {
                              duration: 0.06,
                            }),
                          }
                        : { opacity: 0, transition: spring.fast.exit }
                    }
                    transition={positional(spring.fast, reduceMotion, { duration: 0.08 })}
                  />
                )}
              </AnimatePresence>

              {/* Focus ring */}
              <AnimatePresence>
                {focusRect && (
                  <motion.div
                    data-slot="tabs-focus-ring"
                    // 模板改动：上游为外扩 2px 的 1px 边框；这里与其他控件一致，盒子贴合标签、用 2px 描边 + 2px 间隙，
                    // 描边沿用标签自身的圆角向外扩
                    className={cn(
                      'absolute pointer-events-none z-20 outline-solid outline-2 outline-offset-2 outline-(--focus-ring)',
                      shape.bg,
                    )}
                    initial={false}
                    animate={{
                      left: focusRect.left,
                      top: focusRect.top,
                      width: focusRect.width,
                      height: focusRect.height,
                    }}
                    exit={{ opacity: 0, transition: spring.fast.exit }}
                    transition={positional(spring.fast, reduceMotion, { duration: 0.08 })}
                  />
                )}
              </AnimatePresence>

              {children}
            </TabsPrimitive.List>
          </TabsPrimitive.Root>
        </TabsContext.Provider>
      </MotionFeatures>
    )

    // A size prop pins every tab to one ladder step.
    return size ? <SizeProvider size={size}>{root}</SizeProvider> : root
  },
)

Tabs.displayName = 'Tabs'

interface TabsItemProps extends HTMLAttributes<HTMLButtonElement> {
  icon?: IconComponent
  /** 标签文字，由应用按语言传入；`activeLabel` 折叠为仅图标时同时作为可读名称 */
  label: string
  index: number
}

const TabsItem = forwardRef<HTMLButtonElement, TabsItemProps>(
  ({ icon: Icon, label, index, className, ...props }, ref) => {
    const internalRef = useRef<HTMLButtonElement | null>(null)
    // The collapsing label animates to a MEASURED layout width, not "auto":
    // framer resolves an "auto" target from the element's *visual*
    // (transformed) size, so under a scaled ancestor (e.g. /demo's card) the
    // spring overshoots to scale-x the real width and snaps when "auto"
    // lands. offsetWidth and ResizeObserver are transform-immune — same
    // setup as the accordions' height animation.
    const [labelWidth, setLabelWidth] = useState<number | null>(null)
    const labelRoRef = useRef<ResizeObserver | null>(null)
    const measureLabel = useCallback((el: HTMLSpanElement | null) => {
      labelRoRef.current?.disconnect()
      labelRoRef.current = null
      if (!el) return
      const update = () => setLabelWidth(el.offsetWidth)
      update()
      if (typeof ResizeObserver === 'undefined') return
      labelRoRef.current = new ResizeObserver(update)
      labelRoRef.current.observe(el)
    }, [])
    const shape = useShape()
    const sizeClasses = useSize()
    const { registerTab, hoveredIndex, selectedIndex, idPrefix, activeLabel, reduceMotion } =
      useTabs()

    useEffect(() => {
      registerTab(index, internalRef.current)
      return () => registerTab(index, null)
    }, [index, registerTab])

    const isSelected = selectedIndex === index
    const isActive = hoveredIndex === index || isSelected
    const collapseLabel = activeLabel && !!Icon
    const showLabel = !collapseLabel || isSelected

    const labelContent = (
      // Both stacked spans carry the text-box trim so the invisible bold
      // sizer and the visible label keep identical boxes.
      <span ref={measureLabel} className={cn('inline-grid whitespace-nowrap', sizeClasses.text)}>
        <span
          className="col-start-1 row-start-1 invisible [text-box:trim-both_cap_alphabetic]"
          style={{ fontVariationSettings: fontWeights.semibold }}
          aria-hidden="true"
        >
          {label}
        </span>
        <span
          className={cn(
            'col-start-1 row-start-1 transition-[color,font-variation-settings] duration-80 [text-box:trim-both_cap_alphabetic]',
            isActive ? 'text-foreground' : 'text-muted-foreground',
          )}
          style={{
            fontVariationSettings: isSelected ? fontWeights.semibold : fontWeights.normal,
          }}
        >
          {label}
        </span>
      </span>
    )

    return (
      // Radix Trigger renders a native <button type="button"> and wires
      // role="tab", aria-selected, roving tabindex, and activation for us.
      // id/aria-controls are only overridden when an idPrefix is supplied so
      // externally rendered TabsPanel elements stay linked.
      <TabsPrimitive.Trigger
        ref={(node: HTMLButtonElement | null) => {
          internalRef.current = node
          assignRef(ref, node)
        }}
        value={String(index)}
        data-fluid-hover-index={index}
        {...(idPrefix && {
          id: `${idPrefix}-tab-${index}`,
          'aria-controls': `${idPrefix}-panel-${index}`,
        })}
        {...(collapseLabel && !showLabel && { 'aria-label': label })}
        className={cn(
          // Fixed heights (was py-2 around a 19.5px line box ≈ 35.5px) so the
          // text-box trim on the label doesn't shrink the tab. Standalone
          // pills sit directly on the ladder's control height.
          'relative z-10 flex items-center cursor-pointer bg-transparent border-none outline-none',
          sizeClasses.control,
          sizeClasses.px,
          !collapseLabel && sizeClasses.gap,
          shape.bg,
          className,
        )}
        {...props}
      >
        {Icon && (
          <Icon
            size={sizeClasses.icon}
            strokeWidth={isActive ? 2 : 1.5}
            className={cn(
              'shrink-0 transition-[color,stroke-width] duration-80',
              isActive ? 'text-foreground' : 'text-muted-foreground',
            )}
          />
        )}
        {collapseLabel ? (
          <AnimatePresence initial={false}>
            {showLabel && (
              <motion.span
                key="label"
                className="overflow-hidden"
                // Until the measurement lands, let CSS resolve the width
                // instead of handing framer "auto": framer resolves an "auto"
                // target from the element's *visual* size, so under a scaled
                // ancestor (the /demo card, ~1.76x) it writes back a layout
                // width that much too wide, then springs back down when the
                // measured value arrives — the selected tab visibly pulses on
                // arrival. Plain CSS auto is the true layout width, and the
                // measured number that follows matches it exactly.
                {...(labelWidth == null && { style: { width: 'auto' } })}
                initial={{ width: 0, opacity: 0, marginLeft: 0 }}
                animate={{
                  ...(labelWidth != null ? { width: labelWidth } : null),
                  opacity: 1,
                  // 8px matches the ladder's icon-to-label gap (gap-2); the
                  // compact 6px is its own value, 2px wider than gap-1.
                  marginLeft: sizeClasses.variant === 'compact' ? 6 : 8,
                }}
                exit={{ width: 0, opacity: 0, marginLeft: 0 }}
                transition={positional(spring.fast, reduceMotion, { duration: 0.06 })}
              >
                {labelContent}
              </motion.span>
            )}
          </AnimatePresence>
        ) : (
          labelContent
        )}
      </TabsPrimitive.Trigger>
    )
  },
)

TabsItem.displayName = 'TabsItem'

interface TabsPanelProps extends HTMLAttributes<HTMLDivElement> {
  index: number
  selectedIndex: number
  idPrefix: string
  children: ReactNode
}

// Rendered outside <Tabs> at every call site, so it cannot use Radix's
// Tabs.Content (which requires the Tabs.Root context). It stays a plain
// tabpanel linked to its tab through the shared idPrefix.
const TabsPanel = forwardRef<HTMLDivElement, TabsPanelProps>(
  ({ index, selectedIndex, idPrefix, children, className, ...props }, ref) => {
    const isSelected = selectedIndex === index

    return (
      <div
        ref={ref}
        id={`${idPrefix}-panel-${index}`}
        role="tabpanel"
        aria-labelledby={`${idPrefix}-tab-${index}`}
        hidden={!isSelected}
        tabIndex={-1}
        className={cn('outline-none', className)}
        {...props}
      >
        {isSelected && children}
      </div>
    )
  },
)

TabsPanel.displayName = 'TabsPanel'

export type { TabsItemProps, TabsPanelProps, TabsProps }
export { Tabs, TabsItem, TabsPanel }
