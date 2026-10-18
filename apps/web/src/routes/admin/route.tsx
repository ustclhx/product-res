import { Button, Separator } from '@product-res/ui'
import { createFileRoute, Link, Outlet } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { getAdminViewer } from '../../features/admin/admin.functions.ts'
import { ADMIN_COPY } from '../../features/admin/copy.ts'
import { getAdminNavGroups } from '../../features/admin/nav.ts'
import { authClient } from '../../features/auth/auth-client.ts'
import { LanguageControls } from '../../features/i18n/language-controls.tsx'
import { ThemeToggle } from '../../features/theme/theme-toggle.tsx'
import { templateConfig } from '../../server/template-config.ts'

// 后台布局：守卫在 server function 中执行（requireFreshSession + admin 角色），
// 不满足时整个 /admin/** 返回 404（tasks.md 5.1）。
// 侧栏导航见 features/admin/nav.ts（add-admin-console tasks.md 1.3）。
export const Route = createFileRoute('/admin')({
  beforeLoad: async () => ({ admin: await getAdminViewer() }),
  head: () => ({ meta: [{ title: ADMIN_COPY.title }] }),
  component: AdminLayout,
})

function AdminLayout() {
  const { admin } = Route.useRouteContext()
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      {/* 外层随正文拉伸提供整列背景与分隔线，内层在桌面端吸顶，底部控件始终可见 */}
      <div className="border-b bg-muted/30 md:w-60 md:shrink-0 md:border-r md:border-b-0">
        <aside className="flex min-w-0 flex-col gap-4 p-4 md:sticky md:top-0 md:h-screen md:overflow-y-auto">
          <header className="flex flex-col gap-1">
            <h1 className="font-semibold text-lg">{ADMIN_COPY.heading}</h1>
            <p className="break-all text-muted-foreground text-xs">
              {ADMIN_COPY.signedInAs} {admin.email}
            </p>
          </header>
          <nav aria-label={ADMIN_COPY.nav.label} className="flex flex-col gap-3 md:gap-4">
            {getAdminNavGroups().map((group) => (
              <div key={group.id} className="flex flex-col gap-1">
                {group.label && (
                  <p className="px-3 font-medium text-muted-foreground text-xs">{group.label}</p>
                )}
                <ul className="flex flex-wrap gap-1 md:flex-col">
                  {group.items.map(({ label, ...link }) => (
                    <li key={link.to}>
                      <Link
                        {...link}
                        className="block rounded-md px-3 py-1.5 text-sm hover:bg-accent"
                        activeProps={{ className: 'bg-accent font-medium', 'aria-current': 'page' }}
                      >
                        {label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
          <div className="mt-auto flex flex-col gap-3">
            <Separator />
            <div className="flex flex-wrap items-center gap-2">
              {templateConfig.i18n.enabled && <LanguageControls placement="inline" />}
              <ThemeToggle />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild variant="outline" size="sm">
                <Link to="/app">{ADMIN_COPY.backToApp}</Link>
              </Button>
              <SignOutButton />
            </div>
          </div>
        </aside>
      </div>
      <main className="min-w-0 flex-1 p-4 sm:p-6">
        <Outlet />
      </main>
    </div>
  )
}

/** 与账号删除页一致：Better Auth 客户端登出后整页跳转到登录页，清掉所有客户端状态 */
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
      setError(ADMIN_COPY.signOutFailed)
      setBusy(false)
    }
  }
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={!ready || busy}
        onClick={() => void signOut()}
      >
        {busy ? ADMIN_COPY.signingOut : ADMIN_COPY.signOut}
      </Button>
      {error && (
        <p role="alert" className="w-full text-destructive text-sm">
          {error}
        </p>
      )}
    </>
  )
}
