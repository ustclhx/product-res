/** 尚未实现的页面：只显示名称和计划阶段，不显示示例或虚构数据 */
export function PagePlaceholder({
  title,
  milestone,
  description,
}: {
  title: string
  milestone: string
  description: string
}) {
  return (
    <section className="grid gap-2 rounded-xl border bg-card p-6" data-testid="page-placeholder">
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="text-sm text-muted-foreground">{description}</p>
      <p className="text-xs text-muted-foreground">将在 {milestone} 提供</p>
    </section>
  )
}
