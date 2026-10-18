import { Button } from '@product-res/ui'
import { Link } from '@tanstack/react-router'
import { m } from '../../paraglide/messages.js'
import { templateConfig } from '../../server/template-config.ts'
import { site } from './site.ts'

const navLink = 'text-muted-foreground text-sm transition-colors hover:text-foreground'

export function SiteHeader() {
  return (
    <header className="border-b">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
        <Link to="/" className="font-semibold">
          {site.name}
        </Link>
        <nav aria-label={m.marketing_nav_label()} className="flex flex-1 items-center gap-5">
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
          {site.docs && (
            <Link to="/docs" className={navLink}>
              {m.marketing_nav_docs()}
            </Link>
          )}
        </nav>
        <div className="flex items-center gap-2">
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
