import { cn } from '@product-res/ui'
import { useState } from 'react'
import { getDataCenter } from './data-center.functions.ts'
import { FileImport } from './import.tsx'
import { Overview } from './overview.tsx'
import { DataPreview } from './preview.tsx'
import { QualityIssues } from './quality.tsx'
import { SyncRuns } from './runs.tsx'
import { ScoringSettings } from './scoring.tsx'
import type { DataCenterData } from './types.ts'

const TABS = [
  ['overview', '总览'],
  ['runs', '同步记录'],
  ['preview', '数据预览'],
  ['import', '文件导入'],
  ['quality', '数据质量'],
  ['scoring', '评分维度管理'],
] as const
export type DataCenterTab = (typeof TABS)[number][0]

/** 数据中心（docs/design/data-center.html）；AI 助手后置，回测命中率在 M5 填充 */
export function DataCenterPage({ slug, initial }: { slug: string; initial: DataCenterData }) {
  const [tab, setTab] = useState<DataCenterTab>('overview')
  const [data, setData] = useState(initial)
  const apiSources = data.sources
    .filter((s) => s.access === 'api')
    .map((s) => ({ id: s.id, label: s.label }))
  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h1 className="text-lg font-semibold">数据中心</h1>
        <p className="text-sm text-muted-foreground">
          数据源状态与额度、同步记录、数据预览、文件导入、数据质量和评分维度。每个数值都可追溯到来源和获取方式。
        </p>
      </div>
      <div role="tablist" aria-label="数据中心" className="flex flex-wrap gap-1 border-b">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm',
              tab === key
                ? 'border-primary font-medium text-primary'
                : 'border-transparent text-muted-foreground',
            )}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'overview' ? (
        <Overview
          slug={slug}
          data={data}
          onChanged={async () => setData(await getDataCenter({ data: { slug } }))}
        />
      ) : null}
      {tab === 'runs' ? <SyncRuns slug={slug} /> : null}
      {tab === 'preview' ? <DataPreview slug={slug} sources={apiSources} /> : null}
      {tab === 'import' ? <FileImport slug={slug} /> : null}
      {tab === 'quality' ? <QualityIssues slug={slug} /> : null}
      {tab === 'scoring' ? <ScoringSettings slug={slug} /> : null}
    </div>
  )
}
