import { useCallback, useSyncExternalStore } from 'react'
import { cn } from '../lib/utils.ts'
import { Button } from './button.tsx'

// 主题切换（next-themes 风格）：偏好存 localStorage，未设置时跟随系统；
// 给 <html> 切换 `dark` 类，颜色全部来自 globals.css 中的 CSS 变量。
// 首屏前由 themeInitScript 在 <head> 内同步设置类名，避免先浅后深的闪烁。

export const THEMES = ['light', 'dark', 'system'] as const
export type Theme = (typeof THEMES)[number]

export const THEME_STORAGE_KEY = 'theme'

const DARK_QUERY = '(prefers-color-scheme: dark)'

/**
 * 首屏前执行的内联脚本：读取偏好并给 <html> 设置 `dark` 类。
 * 放在 <head> 中、样式表之前，且不依赖任何打包产物；读取失败（如禁用存储）时按跟随系统处理。
 */
export function themeInitScript(storageKey: string = THEME_STORAGE_KEY): string {
  return `(function(){var t;try{t=localStorage.getItem(${JSON.stringify(storageKey)})}catch(e){}var d=t==='dark'||(t!=='light'&&matchMedia(${JSON.stringify(DARK_QUERY)}).matches);document.documentElement.classList.toggle('dark',d)})()`
}

function isTheme(value: unknown): value is Theme {
  return THEMES.includes(value as Theme)
}

function readTheme(storageKey: string): Theme {
  try {
    const value = localStorage.getItem(storageKey)
    return isTheme(value) ? value : 'system'
  } catch {
    return 'system'
  }
}

function applyTheme(theme: Theme) {
  const dark = theme === 'dark' || (theme === 'system' && matchMedia(DARK_QUERY).matches)
  document.documentElement.classList.toggle('dark', dark)
}

// 同一页面内的订阅者（storage 事件只在其他标签页触发）
const listeners = new Set<() => void>()

function subscribe(storageKey: string, onChange: () => void) {
  const sync = () => {
    applyTheme(readTheme(storageKey))
    onChange()
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key === storageKey) sync()
  }
  const media = matchMedia(DARK_QUERY)
  listeners.add(onChange)
  window.addEventListener('storage', onStorage)
  media.addEventListener('change', sync)
  return () => {
    listeners.delete(onChange)
    window.removeEventListener('storage', onStorage)
    media.removeEventListener('change', sync)
  }
}

/** 当前主题偏好与切换函数；服务端渲染与水合时为 `system`，水合后读取实际偏好 */
export function useTheme(storageKey: string = THEME_STORAGE_KEY) {
  const theme = useSyncExternalStore(
    useCallback((onChange) => subscribe(storageKey, onChange), [storageKey]),
    () => readTheme(storageKey),
    () => 'system' as const,
  )
  const setTheme = useCallback(
    (next: Theme) => {
      try {
        if (next === 'system') localStorage.removeItem(storageKey)
        else localStorage.setItem(storageKey, next)
      } catch {
        // 存储不可用时只在本次页面内生效
      }
      applyTheme(next)
      for (const listener of listeners) listener()
    },
    [storageKey],
  )
  return { theme, setTheme }
}

export type ThemeToggleProps = {
  /** 各选项与整组的可读名称（由应用按语言传入） */
  labels: Record<Theme | 'group', string>
  storageKey?: string | undefined
  className?: string | undefined
}

const noopSubscribe = () => () => {}

/** 浅色 / 深色 / 跟随系统 三选一的切换按钮组；水合前禁用，避免点击丢失 */
export function ThemeToggle({ labels, storageKey, className }: ThemeToggleProps) {
  const { theme, setTheme } = useTheme(storageKey)
  const hydrated = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  )
  return (
    <fieldset
      aria-label={labels.group}
      data-slot="theme-toggle"
      className={cn('inline-flex gap-1 rounded-md border bg-background p-1', className)}
    >
      {THEMES.map((value) => (
        <Button
          key={value}
          type="button"
          size="sm"
          variant={theme === value ? 'secondary' : 'ghost'}
          aria-pressed={theme === value}
          disabled={!hydrated}
          data-theme-option={value}
          onClick={() => setTheme(value)}
        >
          {labels[value]}
        </Button>
      ))}
    </fieldset>
  )
}
