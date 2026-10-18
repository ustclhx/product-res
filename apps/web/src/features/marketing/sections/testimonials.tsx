import { Card, CardContent, CardFooter } from '@product-res/ui'
import { m } from '../../../paraglide/messages.js'
import { Section } from './section.tsx'

/** 评价区块：模板示例，人名与职位均为虚构 */
const testimonials = [
  {
    quote: m.marketing_testimonial_1_quote,
    name: m.marketing_testimonial_1_name,
    role: m.marketing_testimonial_1_role,
  },
  {
    quote: m.marketing_testimonial_2_quote,
    name: m.marketing_testimonial_2_name,
    role: m.marketing_testimonial_2_role,
  },
  {
    quote: m.marketing_testimonial_3_quote,
    name: m.marketing_testimonial_3_name,
    role: m.marketing_testimonial_3_role,
  },
]

export function Testimonials() {
  return (
    <Section id="testimonials" title={m.marketing_testimonials_title()}>
      <div className="grid gap-4 md:grid-cols-3">
        {testimonials.map((item) => (
          <Card key={item.name()} className="justify-between">
            <CardContent>
              <blockquote className="text-pretty">“{item.quote()}”</blockquote>
            </CardContent>
            <CardFooter className="grid gap-0.5">
              <p className="font-medium text-sm">{item.name()}</p>
              <p className="text-muted-foreground text-sm">{item.role()}</p>
            </CardFooter>
          </Card>
        ))}
      </div>
    </Section>
  )
}
