import { Badge, Button } from '@product-res/ui'
import { Link2Off } from '@product-res/ui/icons'
import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { m } from '../../paraglide/messages.js'
import { templateConfig } from '../../server/template-config.ts'
import { MarketingShell } from '../marketing/marketing-shell.tsx'
import type { SharePageView } from './page.ts'

const site = templateConfig.app.name

/** 设计稿 share-cards/SharePage(.Mobile).dc.html：复用营销页头尾；关闭营销站时只保留正文。 */
function Shell({ children }: { children: ReactNode }) {
  const body = (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 pt-6 pb-10 sm:gap-6 sm:px-8 sm:pt-12 sm:pb-16">
      {children}
    </div>
  )
  return templateConfig.marketing.enabled ? (
    <MarketingShell>{body}</MarketingShell>
  ) : (
    <main className="min-h-screen bg-background text-foreground">{body}</main>
  )
}

export function SharePage({ view }: { view: Extract<SharePageView, { status: 'ok' }> }) {
  return (
    <Shell>
      <article className="flex flex-col gap-5 sm:gap-6" data-share-page="ok">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-caption text-muted-foreground">
          {view.label && <Badge size="compact">{view.label}</Badge>}
          <span>{m.share_page_shared_by({ site, date: view.sharedOn })}</span>
        </div>
        <div className="overflow-hidden rounded-lg border bg-muted shadow-sm sm:rounded-xl">
          <img
            src={view.card.image}
            width={view.card.width}
            height={view.card.height}
            alt={view.card.alt}
            className="block h-auto w-full"
            data-share-card-image
          />
        </div>
        <div className="flex flex-col gap-2">
          <h1 className="font-semibold text-xl tracking-tight sm:text-display">{view.title}</h1>
          <p className="text-base text-muted-foreground">{view.description}</p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <Button asChild size="lg">
            <Link to="/register">{m.share_page_cta_primary({ site })}</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link to="/">{m.share_page_cta_secondary({ site })}</Link>
          </Button>
        </div>
        <p className="border-t pt-4 text-caption text-muted-foreground">
          {view.expiresOn
            ? m.share_page_note_expires({ site, date: view.expiresOn })
            : m.share_page_note({ site })}
        </p>
      </article>
    </Shell>
  )
}

export type SharePageGoneReason = 'not-found' | 'expired' | 'rate-limited'

const goneCopy = {
  'not-found': () => [m.share_page_not_found_title(), m.share_page_not_found_body()],
  expired: () => [m.share_page_expired_title(), m.share_page_expired_body()],
  'rate-limited': () => [m.share_page_rate_limited_title(), m.share_page_rate_limited_body()],
} satisfies Record<SharePageGoneReason, () => [string, string]>

/** 404、到期与限流共用的空状态，不显示任何资源信息。 */
export function SharePageGone({ reason }: { reason: SharePageGoneReason }) {
  const [title, body] = goneCopy[reason]()
  return (
    <Shell>
      <div
        className="flex flex-col items-center gap-4 pt-18 pb-12 text-center sm:pt-24 sm:pb-16"
        data-share-page={reason}
      >
        <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Link2Off aria-hidden className="size-6" strokeWidth={1.75} />
        </div>
        <h1 className="font-semibold text-xl">{title}</h1>
        <p className="max-w-md text-body text-muted-foreground">{body}</p>
        <Button asChild>
          <Link to={templateConfig.marketing.enabled ? '/' : '/app'}>{m.share_page_home()}</Link>
        </Button>
      </div>
    </Shell>
  )
}
