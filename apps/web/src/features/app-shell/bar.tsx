import { createContext, type ReactNode, useContext } from 'react'
import { createPortal } from 'react-dom'

// 工作台顶部条的页面级扩展点（tasks 8.3）：页面渲染 <AppShellBar>，把标题、操作与进度条放进壳的顶部条，
// 壳不认识具体页面（阅读器等）。内容经 portal 挂到顶部条插槽，水合后才出现；服务端首屏与水合前
// 显示默认标题（当前导航项名称）。标题插槽有内容时默认标题由 CSS 隐藏，页面卸载（路由切换）后自动恢复；
// 同一页面可渲染多个 AppShellBar，内容按渲染顺序追加。

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    /**
     * false：页面自己渲染带 h1 标题的头部（如对话页的「全部对话」+ 标题行），侧边栏布局的顶部条不显示标题，
     * 只保留菜单、通知与语言 / 主题切换（openspec add-ai-chat-components，设计稿 chat-components/Main.dc.html）
     */
    shellTitle?: boolean
  }
}

export interface AppShellBarSlots {
  title: HTMLElement | null
  actions: HTMLElement | null
  progress: HTMLElement | null
}

export const AppShellBarContext = createContext<AppShellBarSlots | null>(null)

/** 是否在提供顶部条插槽的工作台壳里（顶部布局中为 false，页面应自行渲染自己的工具条） */
export function useAppShellBarAvailable() {
  return useContext(AppShellBarContext) !== null
}

export interface AppShellBarProps {
  /** 替换默认标题，渲染在顶部条的 h1 中（如当前文档名或面包屑） */
  title?: ReactNode
  /** 顶部条右侧操作（如导出按钮），排在语言与主题切换之前 */
  actions?: ReactNode
  /** 顶部条底边的进度条位置（如阅读进度），宽度占满顶部条 */
  progress?: ReactNode
}

export function AppShellBar({ title, actions, progress }: AppShellBarProps) {
  const slots = useContext(AppShellBarContext)
  if (!slots) return null
  return (
    <>
      {title != null && slots.title ? createPortal(title, slots.title) : null}
      {actions != null && slots.actions ? createPortal(actions, slots.actions) : null}
      {progress != null && slots.progress ? createPortal(progress, slots.progress) : null}
    </>
  )
}
