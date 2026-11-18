import { cn } from '@product-res/ui'
import { Link } from '@tanstack/react-router'
import { m } from '../../paraglide/messages.js'
import { templateConfig } from '../../server/template-config.ts'
import { SiteSettings } from '../theme/site-settings.tsx'
import { site } from './site.ts'

const footerLink = 'text-muted-foreground text-sm hover:text-foreground'

/**
 * 页脚区块：产品、资源与法律页链接。
 * floatingEntry：页面右下角有悬浮 AI 入口时，页脚内容盒底部留白，滚到底时页脚内容在入口之上。
 * md 及以上入口叠在浮动主题切换上方（视口底部 72–120px），留 136px。
 * 手机端无论有无 Ask AI 都留 80px：页面还可能有其他右下悬浮按钮（如 SubjectChat 触发器，底部 24–68px），
 * 不能遮挡设置行与版权（9.3 UI-03）。
 * 手机端语言与主题设置行放在版权行上方（设计稿 docs/design-system/prototypes/mobile-footer-controls）。
 */
export function SiteFooter({ floatingEntry = false }: { floatingEntry?: boolean }) {
  return (
    <footer
      data-site-footer
      className={cn('border-t pb-20', floatingEntry ? 'md:pb-34' : 'md:pb-0')}
    >
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
        {(site.blog || site.docs || site.guides) && (
          <FooterColumn title={m.marketing_footer_resources()}>
            {site.blog && (
              <Link to="/blog" className={footerLink}>
                {m.marketing_nav_blog()}
              </Link>
            )}
            {site.guides && (
              <Link to="/guides" className={footerLink}>
                {m.marketing_nav_guides()}
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
      <div className="mx-auto max-w-6xl px-4 md:hidden print:hidden">
        <SiteSettings className="border-t py-4" />
      </div>
      <p
        className={cn(
          'mx-auto max-w-6xl px-4 text-muted-foreground text-xs',
          !floatingEntry && 'md:pb-8',
        )}
      >
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
