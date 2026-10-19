import { notFound } from '@tanstack/react-router'
import { m } from '../../paraglide/messages.js'
import { SignOutButton } from '../workbench/shell.tsx'

/** notFound 的 data 标记：待开通走 `/app/$slug` 的 notFoundComponent，使子路由 loader 不再执行 */
export const ACCOUNT_PENDING_REASON = 'account-not-activated'

/** 待开通时中断路由加载（子 loader 的 403 会让 SSR 返回 500）；已开通时收窄为工作台数据 */
export function requireActivatedPage<Page extends { activation: 'active' | 'pending' }>(
  page: Page,
): Extract<Page, { activation: 'active' }> {
  if (page.activation !== 'active') throw notFound({ data: { reason: ACCOUNT_PENDING_REASON } })
  return page as Extract<Page, { activation: 'active' }>
}

export function isAccountPending(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { reason?: unknown }).reason === ACCOUNT_PENDING_REASON
  )
}

export function AccountPendingPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-4">
      <h1 className="font-semibold text-xl">{m.app_account_pending_title()}</h1>
      <p className="text-muted-foreground text-sm">{m.app_account_pending_body()}</p>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <a href="/account" className="underline">
          {m.app_account_pending_account()}
        </a>
        <SignOutButton />
      </div>
    </main>
  )
}
