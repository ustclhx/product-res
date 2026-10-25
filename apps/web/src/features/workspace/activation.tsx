import { notFound } from '@tanstack/react-router'
import { m } from '../../paraglide/messages.js'
import { SignOutButton } from '../workbench/shell.tsx'

/** notFound 的 data 标记：待开通走 `/app/$slug` 的 notFoundComponent，使子路由 loader 不再执行 */
export const ACCOUNT_PENDING_REASON = 'account-not-activated'

/** 待开通时中断路由加载（子 loader 的 403 会让 SSR 返回 500）；已开通时收窄为工作台数据 */
export interface PendingSpace {
  readonly id: string
  readonly name: string
  readonly slug: string
  readonly isPersonal: boolean
}

export function requireActivatedPage<
  Page extends { activation: 'active' } | { activation: 'pending'; otherSpaces?: PendingSpace[] },
>(page: Page): Extract<Page, { activation: 'active' }> {
  if (page.activation !== 'active')
    throw notFound({
      data: {
        reason: ACCOUNT_PENDING_REASON,
        otherSpaces: 'otherSpaces' in page ? (page.otherSpaces ?? []) : [],
      },
    })
  return page as Extract<Page, { activation: 'active' }>
}

export function isAccountPending(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { reason?: unknown }).reason === ACCOUNT_PENDING_REASON
  )
}

export function pendingSpaces(data: unknown): PendingSpace[] {
  const spaces = (data as { otherSpaces?: unknown } | null)?.otherSpaces
  return Array.isArray(spaces) ? (spaces as PendingSpace[]) : []
}

export function AccountPendingPage({ otherSpaces = [] }: { otherSpaces?: PendingSpace[] }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-4">
      <h1 className="font-semibold text-xl">{m.app_account_pending_title()}</h1>
      <p className="text-muted-foreground text-sm">{m.app_account_pending_body()}</p>
      {otherSpaces.length ? (
        <nav aria-label={m.workspace_pending_other_spaces()} className="grid gap-2 text-sm">
          <p className="text-muted-foreground">{m.workspace_pending_other_spaces()}</p>
          <ul className="grid gap-1">
            {otherSpaces.map((space) => (
              <li key={space.id}>
                <a href={`/app/${encodeURIComponent(space.slug)}`} className="underline">
                  {space.name}
                </a>{' '}
                <span className="text-muted-foreground text-xs">
                  {space.isPersonal ? m.workspace_kind_personal() : m.workspace_kind_team()}
                </span>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <a href="/account" className="underline">
          {m.app_account_pending_account()}
        </a>
        <SignOutButton />
      </div>
    </main>
  )
}
