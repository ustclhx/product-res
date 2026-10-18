import { cn } from '@product-res/ui'
import type { ReactNode } from 'react'

/** 区块的统一外框：标题、副标题与内容 */
export function Section({
  id,
  title,
  subtitle,
  className,
  children,
}: {
  id?: string
  title: string
  subtitle?: string
  className?: string
  children: ReactNode
}) {
  return (
    <section id={id} aria-labelledby={id && `${id}-title`} className={cn('py-20', className)}>
      <div className="mx-auto grid max-w-6xl gap-10 px-4">
        <div className="mx-auto grid max-w-2xl gap-3 text-center">
          <h2 id={id && `${id}-title`} className="font-semibold text-3xl tracking-tight">
            {title}
          </h2>
          {subtitle && <p className="text-muted-foreground">{subtitle}</p>}
        </div>
        {children}
      </div>
    </section>
  )
}
