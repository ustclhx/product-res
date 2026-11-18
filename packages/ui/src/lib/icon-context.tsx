// 来源：fluid-functionalism icon-context（2026-11，https://www.fluidfunctionalism.com/r/icon-context.json，MIT）
// 适配：radix-ui 统一包导入、包内相对路径、去掉 "use client"；其余改动见 packages/ui/UPSTREAM.md
// ---------------------------------------------------------------------------
// Components never import an icon directly: they look one up by the role it
// plays (`useIcons()["chevron-down"]`). That keeps the icon set swappable in
// one place, so an app on another library wraps its tree in IconProvider and
// every component follows. Lucide is the default and the only icon library
// this file depends on.
//
// Components read from the map rather than calling `useIcon(name)`: React
// Compiler's lint (`react-hooks/static-components`, on in a fresh Next app)
// takes a component returned by a hook call for one created during render,
// and flags rendering it. A property read from the map is the same lookup
// without the false alarm.
// ---------------------------------------------------------------------------

import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  PanelLeft,
  PanelRight,
  Plus,
  Search,
  X,
} from 'lucide-react'
import { type ComponentType, createContext, type ReactNode, useContext, useMemo } from 'react'

// The whole contract an icon has to meet. Components pass `strokeWidth` and
// also animate stroke width through `className` (1.5 → 2 on hover is a
// common cue), so an icon from another library should forward both to its
// `<svg>`. A filled icon set ignores them and simply loses that cue.
export interface IconComponentProps {
  size?: number
  strokeWidth?: number
  className?: string
}

export type IconComponent = ComponentType<IconComponentProps>

// Names describe the role, not the glyph, so a library whose icon is called
// something else still fills the same slot (`more-horizontal` is Lucide's
// Ellipsis).
// 模板改动：上游登记 70 个图标槽位并全部导入，Provider 放在根布局时会把它们全部打进首屏包。
// 这里只保留已接入组件用到的槽位，接入新组件时按上游名称补充（见 packages/ui/UPSTREAM.md）。
export type IconName =
  | 'x'
  | 'chevron-down'
  | 'chevron-right'
  | 'check'
  | 'circle-alert'
  | 'search'
  | 'panel-left'
  | 'panel-right'
  | 'plus'

export const defaultIcons: Record<IconName, IconComponent> = {
  x: X,
  'chevron-down': ChevronDown,
  'chevron-right': ChevronRight,
  check: Check,
  'circle-alert': CircleAlert,
  search: Search,
  'panel-left': PanelLeft,
  'panel-right': PanelRight,
  plus: Plus,
}

const IconContext = createContext<Record<IconName, IconComponent> | null>(null)

/**
 * Returns a single icon component for the given name.
 * Falls back to the default (Lucide) set if no provider is present, so a
 * component works on its own before any IconProvider is set up.
 *
 * Fine for passing an icon on as a prop. To render it as `<Icon />`, take it
 * from `useIcons()` instead (see the note at the top of this file).
 */
function useIcon(name: IconName): IconComponent {
  const icons = useContext(IconContext)
  return (icons ?? defaultIcons)[name]
}

/**
 * Returns the full icon map.
 * Falls back to the default (Lucide) set if no provider is present.
 */
function useIcons(): Record<IconName, IconComponent> {
  const icons = useContext(IconContext)
  return icons ?? defaultIcons
}

/**
 * Swap some or all icons for components from another library.
 * Names left out of `icons` keep their default (Lucide) component, so a
 * partial map never leaves a component without an icon.
 *
 * Pass a stable `icons` object (module scope or memoized): an inline object
 * is new on every render and re-renders every component that reads an icon.
 */
function IconProvider({
  children,
  icons,
}: {
  children: ReactNode
  icons?: Partial<Record<IconName, IconComponent>>
}) {
  const value = useMemo(() => ({ ...defaultIcons, ...icons }), [icons])
  return <IconContext.Provider value={value}>{children}</IconContext.Provider>
}

export { IconProvider, useIcon, useIcons }
