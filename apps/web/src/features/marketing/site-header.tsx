import { Button } from '@product-res/ui'
import { Link } from '@tanstack/react-router'
import { m } from '../../paraglide/messages.js'
import { templateConfig } from '../../server/template-config.ts'
import { site } from './site.ts'

const navLink = 'text-muted-foreground text-sm transition-colors hover:text-foreground'

export function SiteHeader() {
  return (
    <header className="border-b">
      {/* 窄屏允许换行：导航独占第二行（过长时行内横向滚动），登录与注册留在第一行，避免 390px 下整页横向溢出 */}
      <div className="mx-auto flex min-h-14 max-w-6xl flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2 sm:flex-nowrap sm:py-0">
        <Link to="/" className="font-semibold">
          {site.name}
        </Link>
        <nav
          aria-label={m.marketing_nav_label()}
          className="order-last flex w-full items-center gap-5 overflow-x-auto pb-1 sm:order-none sm:w-auto sm:flex-1 sm:overflow-visible sm:pb-0"
        >
          {templateConfig.billing.enabled && (
            <Link to="/pricing" className={navLink}>
              {m.marketing_nav_pricing()}
            </Link>
          )}
          {site.blog && (
            <Link to="/blog" className={navLink}>
              {m.marketing_nav_blog()}
            </Link>
          )}
          {site.guides && (
            <Link to="/guides" className={navLink}>
              {m.marketing_nav_guides()}
            </Link>
          )}
          {site.docs && (
            <Link to="/docs" className={navLink}>
              {m.marketing_nav_docs()}
            </Link>
          )}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-2 sm:ml-0">
          <Button asChild variant="ghost" size="sm">
            <Link to="/login">{m.marketing_nav_sign_in()}</Link>
          </Button>
          <Button asChild size="sm">
            <Link to="/register">{m.marketing_nav_get_started()}</Link>
          </Button>
        </div>
      </div>
    </header>
  )
}
