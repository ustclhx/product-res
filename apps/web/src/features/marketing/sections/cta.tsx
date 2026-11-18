import { Button } from '@product-res/ui'
import { Link } from '@tanstack/react-router'
import { m } from '../../../paraglide/messages.js'

/**
 * 底部行动号召：按 Marketing 画板（add-ui-design-system 8.5）用卡片表面加主按钮。
 * 原先主色底配 secondary 按钮，深色模式下主色接近白色、按钮文字也是前景白，几乎看不见。
 */
export function Cta() {
  return (
    <section className="px-4 pb-24">
      <div className="mx-auto grid max-w-6xl justify-items-center gap-4 rounded-xl bg-card px-6 py-12 text-center shadow-surface-2">
        <h2 className="font-bold text-3xl tracking-tight">{m.marketing_cta_title()}</h2>
        <p className="max-w-xl text-body text-muted-foreground">{m.marketing_cta_body()}</p>
        <Button asChild size="lg">
          <Link to="/register">{m.marketing_cta_button()}</Link>
        </Button>
      </div>
    </section>
  )
}
