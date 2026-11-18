import { cn } from '@product-res/ui'
import type { ReactNode } from 'react'

/** 预览页的一节：一个组件（或一组相关组件），锚点供顶部目录跳转 */
export function PreviewSection({
  id,
  title,
  description,
  children,
}: {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly children: ReactNode
}) {
  const headingId = `${id}-title`
  return (
    <section id={id} aria-labelledby={headingId} className="flex scroll-mt-6 flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 id={headingId} className="font-semibold text-subtitle">
          {title}
        </h2>
        {description ? <p className="text-body text-muted-foreground">{description}</p> : null}
      </header>
      <div className="grid gap-4 md:grid-cols-2">{children}</div>
    </section>
  )
}

/** 一个变体或状态的展示格：上方标注名称，内容放在卡片表面上 */
export function Specimen({
  label,
  wide,
  className,
  children,
}: {
  readonly label: string
  /** 占满整行（表格、侧边栏等宽内容） */
  readonly wide?: boolean
  readonly className?: string
  readonly children: ReactNode
}) {
  return (
    <figure className={cn('m-0 flex min-w-0 flex-col gap-2', wide && 'md:col-span-2')}>
      <figcaption className="text-caption text-muted-foreground">{label}</figcaption>
      <div
        className={cn(
          'flex min-w-0 flex-wrap items-center gap-3 rounded-xl border bg-card p-4',
          className,
        )}
      >
        {children}
      </div>
    </figure>
  )
}
