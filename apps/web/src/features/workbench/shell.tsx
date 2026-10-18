import { Button, cn } from '@product-res/ui'
import { Link, useRouterState } from '@tanstack/react-router'
import { type ReactNode, useEffect, useState } from 'react'
import { templateConfig } from '../../server/template-config.ts'
import { authClient } from '../auth/auth-client.ts'
import { NotificationCenter } from '../notifications/center.tsx'
import { ThemeToggle } from '../theme/theme-toggle.tsx'
import { type WorkspacePage, WorkspaceSwitcher } from '../workspace/components.tsx'
import { activeNavKey, WORKBENCH_NAV } from './nav.ts'

/** 选品工作台外壳：左侧深色导航 + 白色顶栏（对照 docs/design/workbench-overview.html） */
export function WorkbenchShell({ page, children }: { page: WorkspacePage; children: ReactNode }) {
  const slug = page.workspace.slug
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const active = activeNavKey(pathname, slug)
  const current = WORKBENCH_NAV.find((item) => item.key === active)
  return (
    <div className="flex min-h-screen bg-page">
      <aside className="w-[200px] shrink-0 bg-sidebar text-sidebar-foreground">
        <div className="flex items-center gap-2 border-b border-white/10 p-4 text-[15px] font-semibold">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary text-sm text-primary-foreground">
            选
          </span>
          <span>选品工作台</span>
        </div>
        <nav aria-label="主导航" className="py-2">
          <ul>
            {WORKBENCH_NAV.map((item) => (
              <li key={item.key}>
                <Link
                  to={item.to}
                  params={{ slug }}
                  aria-current={active === item.key ? 'page' : undefined}
                  className={cn(
                    'flex items-center px-5 py-2.5 text-[13px] text-sidebar-muted transition-colors hover:bg-white/5 hover:text-white',
                    active === item.key && 'bg-primary font-medium text-white hover:bg-primary',
                  )}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 border-b bg-card px-5 py-3">
          <div className="text-[13px] text-muted-foreground">
            <span data-testid="workspace-name">{page.workspace.name}</span>
            {current ? (
              <>
                {' / '}
                <span className="font-medium text-foreground">{current.label}</span>
              </>
            ) : null}
          </div>
          <div className="flex items-center gap-3">
            {page.readOnly ? (
              <span role="status" className="text-xs text-warning-strong">
                只读
              </span>
            ) : null}
            <NotificationCenter key={slug} slug={slug} />
            <AccountMenu page={page} />
          </div>
        </header>
        <main className="min-w-0 flex-1 p-5">{children}</main>
      </div>
    </div>
  )
}

function AccountMenu({ page }: { page: WorkspacePage }) {
  const slug = page.workspace.slug
  return (
    <details className="relative">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-[13px]">
        <span className="flex size-7 items-center justify-center rounded-full bg-primary-soft text-xs font-semibold text-primary">
          {(page.user.name || page.user.email).slice(0, 1).toUpperCase()}
        </span>
        <span data-testid="current-user">
          {page.user.name} ({page.user.email})
        </span>
      </summary>
      <div className="absolute right-0 z-20 mt-2 grid w-56 gap-1 rounded-lg border bg-popover p-2 text-sm shadow-md">
        {templateConfig.ai.text.enabled ? (
          <MenuLink to="/app/$slug/chat" slug={slug}>
            AI 对话
          </MenuLink>
        ) : null}
        <MenuLink to="/app/$slug/settings" slug={slug}>
          空间设置
        </MenuLink>
        {templateConfig.credits.enabled ? (
          <MenuLink to="/app/$slug/usage" slug={slug}>
            AI 用量
          </MenuLink>
        ) : null}
        <a href="/account" className="rounded-md px-2 py-1.5 hover:bg-accent">
          账号设置
        </a>
        <WorkspaceSwitcher page={page} />
        <ThemeToggle className="px-1 py-1" />
        <SignOutButton />
      </div>
    </details>
  )
}

function MenuLink({
  to,
  slug,
  children,
}: {
  to: '/app/$slug/chat' | '/app/$slug/settings' | '/app/$slug/usage'
  slug: string
  children: ReactNode
}) {
  return (
    <Link to={to} params={{ slug }} className="rounded-md px-2 py-1.5 hover:bg-accent">
      {children}
    </Link>
  )
}

function SignOutButton() {
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function signOut() {
    setBusy(true)
    setError('')
    try {
      const result = await authClient().signOut()
      if (result.error) throw new Error(result.error.message)
      window.location.assign('/login')
    } catch {
      setError('退出失败，请重试')
      setBusy(false)
    }
  }
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="justify-start"
        disabled={!ready || busy}
        onClick={() => void signOut()}
      >
        {busy ? '正在退出…' : '退出登录'}
      </Button>
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </>
  )
}
