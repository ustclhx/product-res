import { Button } from '@product-res/ui'
import { Link } from '@tanstack/react-router'
import { m } from '../../../paraglide/messages.js'

export function Cta() {
  return (
    <section className="px-4 py-20">
      <div className="mx-auto grid max-w-4xl justify-items-center gap-4 rounded-2xl bg-primary px-6 py-14 text-center text-primary-foreground">
        <h2 className="font-semibold text-3xl tracking-tight">{m.marketing_cta_title()}</h2>
        <p className="max-w-xl opacity-90">{m.marketing_cta_body()}</p>
        <Button asChild size="lg" variant="secondary">
          <Link to="/register">{m.marketing_cta_button()}</Link>
        </Button>
      </div>
    </section>
  )
}
