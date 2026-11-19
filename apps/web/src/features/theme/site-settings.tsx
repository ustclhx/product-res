import { cn } from '@product-res/ui'
import { templateConfig } from '../../server/template-config.ts'
import { LanguageControls } from '../i18n/language-controls.tsx'
import { ThemeToggle } from './theme-toggle.tsx'

/**
 * 手机端（< md）的语言与主题设置行（设计稿 docs/design-system/prototypes/mobile-footer-controls）：
 * 小屏上浮动控件会遮挡正文，改为随页面滚动的一行；桌面仍用根布局的浮动控件。
 * 语言建议横幅由根布局的浮动实例负责，这里不重复请求。
 */
export function SiteSettings({ className }: { className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-3', className)}>
      {templateConfig.i18n.enabled && <LanguageControls placement="bare" suggest={false} />}
      <ThemeToggle />
    </div>
  )
}
