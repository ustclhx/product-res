import { Button } from '@product-res/ui'
import { Link, useRouterState } from '@tanstack/react-router'
import { m } from '../../paraglide/messages.js'
import { templateConfig } from '../../server/template-config.ts'
import { isAppAreaPath } from '../i18n/app-area.ts'
import { MarketingShell } from './marketing-shell.tsx'

/** 未匹配的地址都落到这里：给出回到站内的路径，关闭营销站时回到应用区。 */
export function NotFoundPage() {
  // 应用区页面内的 notFound() 渲染在应用布局的 Outlet 中，不能再套一层营销页头页脚。
  const inApp = useRouterState({ select: (state) => isAppAreaPath(state.location.pathname) })
  const marketing = templateConfig.marketing.enabled && !inApp
  const body = (
    <div className="mx-auto grid max-w-xl gap-4 px-4 py-24 text-center">
      <h1 className="font-bold text-4xl tracking-tight">{m.marketing_not_found_title()}</h1>
      <p className="text-muted-foreground">{m.marketing_not_found_body()}</p>
      <div>
        <Button asChild>
          <Link to={marketing ? '/' : '/app'}>{m.marketing_not_found_home()}</Link>
        </Button>
      </div>
    </div>
  )
  return templateConfig.marketing.enabled ? (
    <MarketingShell>{body}</MarketingShell>
  ) : (
    <main>{body}</main>
  )
}
