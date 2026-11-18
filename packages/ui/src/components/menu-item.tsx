// 来源：fluid-functionalism menu-item.tsx（2026-11，https://www.fluidfunctionalism.com/r/dropdown.json 附带文件，MIT）
// 适配：radix-ui 统一包导入、包内相对路径、去掉 "use client"；其余改动见 packages/ui/UPSTREAM.md

import { AnimatePresence, m as motion } from 'motion/react'
import {
  cloneElement,
  createContext,
  forwardRef,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useRef,
  useState,
} from 'react'
import {
  type FluidHoverActiveStore,
  useFluidHoverSelect,
  useRegisterFluidHoverItem,
} from '../hooks/use-fluid-hover.ts'
import { fontWeights } from '../lib/font-weight.ts'
import type { IconComponent } from '../lib/icon-context.tsx'
import { MotionFeatures } from '../lib/motion-features.tsx'
import { usePopupShape } from '../lib/shape-context.tsx'
import { useSize } from '../lib/size-context.tsx'
import { cn } from '../lib/utils.ts'

// ---------------------------------------------------------------------------
// Dropdown context — the single shared context for every Dropdown build.
//
// It lives here rather than in the dropdown module so that (a) MenuItem stays
// primitive-free and self-contained, and (b) dropdowns built on different
// primitives (Radix, Base UI) can render side by side — each provides this
// same context object, so MenuItem resolves whichever provider actually
// wraps it.
// ---------------------------------------------------------------------------

/** What MenuItem hands to the popup's primitive wrapper. `element` is the
 *  styled row div (visuals + fluid hover registration, no children); `children`
 *  is the row content (icon, label, check). The dropdown wraps them in its
 *  own Item / RadioItem primitive, so MenuItem itself stays primitive-free. */
export interface MenuItemRenderOptions {
  /** Radio-style option (boolean `checked` on MenuItem) vs plain action item. */
  radio: boolean
  /** Checkbox-style option: a boolean `checked` inside a multiple-selection
   *  dropdown (`checkedIndices`). Takes precedence over `radio`. */
  checkbox: boolean
  /** The item's checked state (radio and checkbox items). */
  checked?: boolean | undefined
  /** The item's index — doubles as the radio value. */
  value: number
  disabled?: boolean | undefined
  label: string
  closeOnClick: boolean
  /** The row's activation (consumer onClick, then onSelect). The dropdown
   *  hands it to its primitive item as `onClick`, never to `element`. */
  onActivate?: ((e: React.MouseEvent<HTMLDivElement>) => void) | undefined
  element: ReactElement
  children: ReactNode
}

export interface DropdownContextValue {
  registerItem: (index: number, element: HTMLElement | null) => void
  /** The highlighted row, read per row with `useFluidHoverSelect` so a
   *  highlight change re-renders two rows instead of the whole menu. */
  activeStore: FluidHoverActiveStore
  checkedIndex?: number | undefined
  /** Multiple selection (`checkedIndices` on the dropdown): rows are
   *  checkbox items and activating one keeps the menu open by default. */
  multiple?: boolean | undefined
  checkedIndices?: number[] | undefined
  /** True when items render inside a Menu popup (DropdownContent), where the
   *  primitive's Item / RadioItem own roles, roving highlight, typeahead,
   *  and activation. MenuItem switches its rendering accordingly. */
  inMenu?: boolean | undefined
  /** Popup-only: wraps a MenuItem's styled div in the dropdown's menu-item
   *  primitive. Absent in the inline Dropdown panel, where MenuItem renders
   *  its own ARIA menuitem div. */
  renderMenuItem?: ((opts: MenuItemRenderOptions) => ReactElement) | undefined
  /** Popup-only: a DropdownSubTrigger reports its submenu opening and
   *  closing here, so the menu keeps that row lit while the pointer crosses
   *  to the submenu and while it is inside it. */
  onSubmenuOpenChange?: ((index: number, open: boolean) => void) | undefined
}

export const DropdownContext = createContext<DropdownContextValue | null>(null)

export function useDropdown() {
  const ctx = useContext(DropdownContext)
  if (!ctx) throw new Error('useDropdown must be used within a Dropdown')
  return ctx
}

/**
 * Open state for DropdownMenu and DropdownSub: controlled by `open` when it
 * is passed, else local state seeded by `defaultOpen`. Either way the
 * primitive is always handed a controlled value, so the popup can play its
 * exit tween before it unmounts.
 */
export function useControllableOpen(
  openProp: boolean | undefined,
  defaultOpen: boolean,
  onOpenChange?: (open: boolean) => void,
) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen)
  const open = openProp !== undefined ? openProp : internalOpen
  const setOpen = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setInternalOpen(next)
      onOpenChange?.(next)
    },
    [openProp, onOpenChange],
  )
  return [open, setOpen] as const
}

export interface MenuItemProps extends HTMLAttributes<HTMLDivElement> {
  /** Optional leading icon. When omitted, the row renders text-only with no
   *  reserved icon column. */
  icon?: IconComponent
  /** 可见文字，同时是读屏名称与 typeahead 文本，由调用方按语言传入 */
  label: string
  /** 本项在所在面板内的顺序（从 0 起），驱动 fluid-hover 注册与选中背景；子菜单内重新从 0 编号 */
  index: number
  /** When a boolean, the item is a radio-style option (role="menuitemradio"
   *  with aria-checked). When undefined, it is a plain action item
   *  (role="menuitem", no checked state announced). Inside a dropdown with
   *  `checkedIndices` a boolean makes it a checkbox item. */
  checked?: boolean
  onSelect?: () => void
  disabled?: boolean
  /** Popup-only (inside DropdownContent): whether activating the item closes
   *  the menu. Ignored in the inline Dropdown panel. @default true */
  closeOnClick?: boolean
  /** Content before the icon, e.g. a drag handle. Its clicks are its own:
   *  they don't activate the item. */
  leading?: ReactNode
  /** 模板新增：弹出菜单中把菜单项渲染为该元素（如路由 `<Link to="/account" />`），得到真实链接语义
   *  （href、中键新标签页）；键盘与点击激活仍由菜单处理。只在 DropdownContent 内生效 */
  render?: ReactElement
}

const MenuItem = forwardRef<HTMLDivElement, MenuItemProps>(
  (
    {
      icon: Icon,
      label,
      index,
      checked,
      onSelect,
      disabled,
      closeOnClick,
      leading,
      render,
      className,
      onClick,
      ...props
    },
    ref,
  ) => {
    const shape = usePopupShape()
    const internalRef = useRef<HTMLDivElement>(null)
    const { registerItem, activeStore, checkedIndex, multiple, checkedIndices, renderMenuItem } =
      useDropdown()
    const isCheckbox = !!multiple && typeof checked === 'boolean'

    useRegisterFluidHoverItem(registerItem, index, internalRef)

    const isActive = useFluidHoverSelect(activeStore, (i) => i === index)
    const sizeClasses = useSize()

    const mergeRef = (node: HTMLDivElement | null) => {
      ;(internalRef as React.MutableRefObject<HTMLDivElement | null>).current = node
      if (typeof ref === 'function') ref(node)
      else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node
    }

    const handleActivate = disabled
      ? undefined
      : (e: React.MouseEvent<HTMLDivElement>) => {
          onClick?.(e)
          onSelect?.()
        }

    const itemClassName = cn(
      // Fixed height so the text-box trim on the label doesn't shrink the
      // row. shrink-0 because menu popups are max-height flex columns —
      // without it a long list compresses rows to fit instead of scrolling.
      `relative z-10 flex ${sizeClasses.control} shrink-0 items-center ${sizeClasses.gap} ${shape.item} ${sizeClasses.itemPx} cursor-pointer outline-none`,
      disabled && 'opacity-50 pointer-events-none',
      className,
    )

    const content = (
      <>
        {leading && (
          // biome-ignore lint/a11y/noStaticElementInteractions: 只拦截冒泡，不让前置内容（拖拽柄等）的点击激活本行
          // biome-ignore lint/a11y/useKeyWithClickEvents: 同上，前置内容自己处理键盘
          <span className="flex shrink-0 items-center" onClick={(e) => e.stopPropagation()}>
            {leading}
          </span>
        )}
        {Icon && (
          <span className="inline-grid shrink-0">
            <span className="col-start-1 row-start-1 invisible">
              <Icon size={sizeClasses.icon} strokeWidth={2} />
            </span>
            <Icon
              size={sizeClasses.icon}
              strokeWidth={isActive || checked ? 2 : 1.5}
              className={cn(
                'col-start-1 row-start-1 transition-[color,stroke-width] duration-80',
                isActive || checked ? 'text-foreground' : 'text-muted-foreground',
              )}
            />
          </span>
        )}
        {/* Both stacked spans carry the text-box trim so the invisible bold
            sizer and the visible label keep identical boxes. Both truncate:
            the popup has a fixed width and the row a fixed height, so a long
            label clips with an ellipsis instead of wrapping into the next
            row. The padding pair extends the clip box past the trim so
            ascenders and descenders aren't shaved. */}
        <span className={cn('inline-grid min-w-0 flex-1', sizeClasses.text)}>
          <span
            className="col-start-1 row-start-1 invisible truncate pt-[0.25em] -mt-[0.25em] pb-[0.25em] -mb-[0.25em] [text-box:trim-both_cap_alphabetic]"
            style={{ fontVariationSettings: fontWeights.semibold }}
            aria-hidden="true"
          >
            {label}
          </span>
          <span
            className={cn(
              'col-start-1 row-start-1 truncate pt-[0.25em] -mt-[0.25em] pb-[0.25em] -mb-[0.25em] transition-[color,font-variation-settings] duration-80 [text-box:trim-both_cap_alphabetic]',
              isActive || checked ? 'text-foreground' : 'text-muted-foreground',
            )}
            style={{
              fontVariationSettings: checked ? fontWeights.semibold : fontWeights.normal,
            }}
          >
            {label}
          </span>
        </span>
        {/* initial={false}: a row checked at mount shows the finished
            check instead of drawing it, so default selections don't
            animate on page load. */}
        {/* 模板改动：勾在 MenuItem 内自带 MotionFeatures，行在内联 Dropdown 中渲染时也有动画能力 */}
        <MotionFeatures>
          <AnimatePresence initial={false}>
            {checked && (
              <motion.svg
                key="check"
                aria-hidden="true"
                width={sizeClasses.icon}
                height={sizeClasses.icon}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-foreground shrink-0"
                initial={{ opacity: 1 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 1 }}
              >
                <motion.path
                  d="M4 12L9 17L20 6"
                  initial={{ pathLength: 0 }}
                  animate={{
                    pathLength: 1,
                    transition: { duration: 0.08, ease: 'easeOut' },
                  }}
                  exit={{
                    pathLength: 0,
                    transition: { duration: 0.04, ease: 'easeIn' },
                  }}
                />
              </motion.svg>
            )}
          </AnimatePresence>
        </MotionFeatures>
      </>
    )

    if (renderMenuItem) {
      // Inside DropdownContent, the menu-item primitive (supplied by the
      // surrounding DropdownContent through context) owns the role,
      // aria-checked, tabIndex, roving highlight, typeahead, and Enter/Space/
      // click activation. handleActivate rides on the primitive as onActivate,
      // not on the div: that is the handler keyboard activation calls.
      return renderMenuItem({
        radio: !isCheckbox && typeof checked === 'boolean',
        checkbox: isCheckbox,
        checked,
        value: index,
        disabled,
        label,
        // Toggling one of several stays open; picking one of one closes.
        closeOnClick: closeOnClick ?? !multiple,
        onActivate: handleActivate,
        element: render ? (
          cloneElement(render, {
            ref: mergeRef,
            'data-fluid-hover-index': index,
            'aria-label': label,
            className: itemClassName,
            ...props,
          } as Record<string, unknown>)
        ) : (
          // biome-ignore lint/a11y/useAriaPropsSupportedByRole: role 由外层 Radix 菜单项经 asChild 合成到这个 div 上
          <div
            ref={mergeRef}
            data-fluid-hover-index={index}
            aria-label={label}
            className={itemClassName}
            {...props}
          />
        ),
        children: content,
      })
    }

    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: role 按 checked 动态取 menuitem / menuitemradio / menuitemcheckbox，静态分析识别不了
      // biome-ignore lint/a11y/useAriaPropsSupportedByRole: 同上，aria-checked 只在 radio / checkbox 角色时输出
      <div
        ref={mergeRef}
        data-fluid-hover-index={index}
        // Disabled items are never the roving tab stop.
        tabIndex={!disabled && index === (checkedIndex ?? checkedIndices?.[0] ?? 0) ? 0 : -1}
        role={
          isCheckbox
            ? 'menuitemcheckbox'
            : typeof checked === 'boolean'
              ? 'menuitemradio'
              : 'menuitem'
        }
        aria-checked={typeof checked === 'boolean' ? checked : undefined}
        aria-disabled={disabled || undefined}
        aria-label={label}
        onClick={handleActivate}
        onKeyDown={(e) => {
          if (disabled) return
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault()
            onSelect?.()
          }
        }}
        className={itemClassName}
        {...props}
      >
        {content}
      </div>
    )
  },
)

MenuItem.displayName = 'MenuItem'

export { MenuItem }
