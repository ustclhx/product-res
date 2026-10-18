import { Button, Tag } from '@product-res/ui'
import { formatNumber, formatTime, KIND_LABELS } from './shared.tsx'

export interface FileSourceCardData {
  id: string
  label: string
  marketplaces: readonly string[]
  capabilities: readonly string[]
  records: number
  lastImport: { at: string; fileName: string } | null
}

/**
 * 只能文件导入的数据源（如 Helium 10）：没有同步频率、额度与“立即刷新”，
 * 只显示最近导入时间与记录数，并提供跳到导入标签的入口（specs/connector-helium10）。
 */
export function FileSourceCard({
  source,
  onImport,
}: {
  source: FileSourceCardData
  onImport: (sourceId: string) => void
}) {
  return (
    <article className="grid gap-3 rounded-lg border p-4" data-testid={`source-${source.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="grid gap-0.5">
          <h3 className="font-medium">{source.label}</h3>
          <p className="text-xs text-muted-foreground">
            {source.marketplaces.join(' · ')} · 文件导入
          </p>
        </div>
        <Tag tone="neutral">文件导入</Tag>
      </div>
      <div className="flex flex-wrap gap-1">
        {source.capabilities.map((kind) => (
          <Tag key={kind} tone="info">
            {KIND_LABELS[kind] ?? kind}
          </Tag>
        ))}
      </div>
      <dl className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <dt className="text-muted-foreground">记录数</dt>
          <dd className="font-medium">{formatNumber(source.records)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">最近导入</dt>
          <dd className="font-medium" data-testid="last-import">
            {source.lastImport
              ? `${formatTime(source.lastImport.at)} · ${source.lastImport.fileName}`
              : '尚未导入'}
          </dd>
        </div>
      </dl>
      <div>
        <Button size="sm" onClick={() => onImport(source.id)}>
          导入文件
        </Button>
      </div>
    </article>
  )
}
