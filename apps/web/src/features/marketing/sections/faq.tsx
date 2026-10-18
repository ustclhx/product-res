import { m } from '../../../paraglide/messages.js'
import { Section } from './section.tsx'

const questions = [
  { q: m.marketing_faq_1_q, a: m.marketing_faq_1_a },
  { q: m.marketing_faq_2_q, a: m.marketing_faq_2_a },
  { q: m.marketing_faq_3_q, a: m.marketing_faq_3_a },
  { q: m.marketing_faq_4_q, a: m.marketing_faq_4_a },
]

/** 常见问题：原生 details，无需脚本即可展开 */
export function Faq() {
  return (
    <Section id="faq" title={m.marketing_faq_title()}>
      <div className="mx-auto grid w-full max-w-3xl divide-y rounded-xl border">
        {questions.map((item) => (
          <details key={item.q()} className="group px-5 py-4">
            <summary className="cursor-pointer list-none font-medium marker:hidden">
              {item.q()}
            </summary>
            <p className="mt-3 text-muted-foreground">{item.a()}</p>
          </details>
        ))}
      </div>
    </Section>
  )
}
