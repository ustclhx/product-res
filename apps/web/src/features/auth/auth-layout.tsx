import {
  Alert,
  AlertDescription,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Separator,
} from '@product-res/ui'
import { Link } from '@tanstack/react-router'
import { type ReactNode, useEffect, useState } from 'react'
import { templateConfig } from '../../server/template-config.ts'
import { LanguageControls } from '../i18n/language-controls.tsx'
import { ThemeToggle } from '../theme/theme-toggle.tsx'

/** 认证页面的公共外框：应用名 + 居中卡片（标题 / 说明 / 内容 / 页脚链接） */
export function AuthLayout({
  title,
  description,
  footer,
  children,
}: {
  title: ReactNode
  description?: ReactNode
  footer?: ReactNode
  children: ReactNode
}) {
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted/40 px-4 py-8">
      {/* 应用名取模板配置，作为回到首页的出口；不是标题，页面只保留卡片内一个 h1 */}
      <Link
        to="/"
        className="rounded-sm font-semibold text-foreground text-lg tracking-tight outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {templateConfig.app.name}
      </Link>
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl tracking-tight">
            <h1>{title}</h1>
          </CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
        <CardContent>
          {/* SSR controls stay disabled until event handlers are attached. */}
          <fieldset disabled={!hydrated} className="grid min-w-0 gap-5">
            {children}
          </fieldset>
        </CardContent>
        {footer ? (
          <CardFooter className="flex-wrap justify-center border-t pt-6 text-center text-muted-foreground text-sm">
            {footer}
          </CardFooter>
        ) : null}
      </Card>
      {/* 控件随卡片排版，窄屏和较矮视口下都不会遮挡页脚链接。 */}
      <footer className="flex w-full max-w-sm flex-wrap items-center justify-between gap-3">
        {templateConfig.i18n.enabled && <LanguageControls placement="inline" />}
        <ThemeToggle className="ml-auto" />
      </footer>
    </main>
  )
}

/** 带文字的横向分隔线（如 OAuth 按钮与邮箱表单之间） */
export function AuthDivider({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-muted-foreground text-xs">
      <Separator className="flex-1" />
      <span className="shrink-0">{children}</span>
      <Separator className="flex-1" />
    </div>
  )
}

/** 页脚等处的文字链接统一样式 */
export const authLinkClassName =
  'font-medium text-foreground underline-offset-4 hover:underline focus-visible:underline'

/** 表单级错误提示（接口错误按错误码给出的文案） */
export function FormAlert({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <Alert variant="destructive">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

/** 成功 / 状态提示 */
export function StatusAlert({ children }: { children: ReactNode }) {
  return (
    <Alert variant="success">
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  )
}
