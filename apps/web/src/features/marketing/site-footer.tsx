import { Link } from '@tanstack/react-router'
import { m } from '../../paraglide/messages.js'
import { templateConfig } from '../../server/template-config.ts'
import { site } from './site.ts'

const footerLink = 'text-muted-foreground text-sm hover:text-foreground'

/** 页脚区块：产品、资源与法律页链接 */
export function SiteFooter() {
  return (
    <footer className="border-t">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:grid-cols-4">
        <div className="grid content-start gap-2">
          <p className="font-semibold">{site.name}</p>
          <p className="text-muted-foreground text-sm">{m.common_site_tagline()}</p>
        </div>
        <FooterColumn title={m.marketing_footer_product()}>
          {templateConfig.billing.enabled && (
            <Link to="/pricing" className={footerLink}>
              {m.marketing_nav_pricing()}
            </Link>
          )}
          <Link to="/register" className={footerLink}>
            {m.marketing_nav_get_started()}
          </Link>
        </FooterColumn>
        {(site.blog || site.docs) && (
          <FooterColumn title={m.marketing_footer_resources()}>
            {site.blog && (
              <Link to="/blog" className={footerLink}>
                {m.marketing_nav_blog()}
              </Link>
            )}
            {site.docs && (
              <Link to="/docs" className={footerLink}>
                {m.marketing_nav_docs()}
              </Link>
            )}
          </FooterColumn>
        )}
        <FooterColumn title={m.marketing_footer_legal()}>
          <Link to="/legal/$slug" params={{ slug: 'privacy' }} className={footerLink}>
            {m.marketing_footer_privacy()}
          </Link>
          <Link to="/legal/$slug" params={{ slug: 'terms' }} className={footerLink}>
            {m.marketing_footer_terms()}
          </Link>
          <Link to="/legal/$slug" params={{ slug: 'refund' }} className={footerLink}>
            {m.marketing_footer_refund()}
          </Link>
        </FooterColumn>
      </div>
      <p className="mx-auto max-w-6xl px-4 pb-8 text-muted-foreground text-xs">
        {m.marketing_footer_copyright({ year: new Date().getFullYear(), name: site.name })}
      </p>
    </footer>
  )
}

function FooterColumn({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid content-start gap-2">
      <p className="font-medium text-sm">{title}</p>
      {children}
    </div>
  )
}
