import { Button } from '@product-res/ui'
import { Link } from '@tanstack/react-router'
import { m } from '../../../paraglide/messages.js'

export function Hero() {
  return (
    <section className="py-24">
      <div className="mx-auto grid max-w-3xl justify-items-center gap-6 px-4 text-center">
        <span className="rounded-full border px-3 py-1 text-muted-foreground text-xs">
          {m.marketing_hero_badge()}
        </span>
        <h1 className="font-bold text-4xl tracking-tight sm:text-5xl">
          {m.marketing_hero_title()}
        </h1>
        <p data-testid="tagline" className="text-lg text-muted-foreground">
          {m.marketing_hero_subtitle()}
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <Button asChild size="lg">
            <Link to="/register">{m.marketing_hero_cta_primary()}</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <a href="#pricing">{m.marketing_hero_cta_secondary()}</a>
          </Button>
        </div>
      </div>
    </section>
  )
}
