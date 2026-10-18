import { ThemeToggle as BaseThemeToggle } from '@product-res/ui'
import { m } from '../../paraglide/messages.js'

/** 带当前语言文案的主题切换（浅色 / 深色 / 跟随系统） */
export function ThemeToggle({ className }: { className?: string }) {
  return (
    <BaseThemeToggle
      className={className}
      labels={{
        group: m.theme_toggle_label(),
        light: m.theme_light(),
        dark: m.theme_dark(),
        system: m.theme_system(),
      }}
    />
  )
}
