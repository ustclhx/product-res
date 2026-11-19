import { cn } from '@product-res/ui'
import { m } from '../../../paraglide/messages.js'

export interface StepItem {
  readonly title: string
  readonly description: string
}

/**
 * 「如何开始」流程（openspec add-ui-design-system 8.5）：步骤来自模板配置 `marketing.steps`，为空时不渲染；
 * 眉标与标题在 messages/<locale>/marketing-blocks.json。
 */
export function Steps({ steps }: { steps: readonly StepItem[] }) {
  if (steps.length === 0) return null
  return (
    <section id="steps" aria-labelledby="steps-title" className="py-20">
      <div className="mx-auto grid max-w-6xl gap-10 px-4">
        <div className="grid justify-items-center gap-2 text-center">
          <p className="font-medium text-caption text-muted-foreground">
            {m.marketing_steps_eyebrow()}
          </p>
          <h2 id="steps-title" className="font-bold text-3xl tracking-tight">
            {m.marketing_steps_title()}
          </h2>
        </div>
        {/* biome-ignore lint/a11y/noRedundantRoles: list-none 会让 Safari 读屏丢失列表语义，需显式声明 */}
        <ol role="list" className="m-0 grid list-none gap-8 p-0 md:grid-cols-3">
          {steps.map((step, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 配置顺序即序号
            <li key={index} className="grid content-start gap-3">
              <div className="flex items-center gap-3">
                {/* 编号由有序列表语义表达，圆形数字只作视觉 */}
                <span
                  aria-hidden="true"
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground text-subtitle"
                >
                  {index + 1}
                </span>
                <span
                  aria-hidden="true"
                  className={cn(
                    'hidden h-px flex-1 bg-border md:block',
                    index === steps.length - 1 && 'md:hidden',
                  )}
                />
              </div>
              <h3 className="font-semibold text-title">{step.title}</h3>
              <p className="text-body text-muted-foreground">{step.description}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}
