import { Button, Tag } from '@product-res/ui'
import { useEffect, useState } from 'react'
import { getQualityIssues, setQualityIssueStatus } from './data-center.functions.ts'
import { errorText, formatTime, Section, SimpleTable } from './shared.tsx'
import type { QualityIssueRow } from './types.ts'

const TYPES: Record<string, string> = {
  missing: '缺失',
  spike: '突变',
  'source-divergence': '来源差异',
  stale: '数据过期',
  'sync-failure': '同步失败',
}
const STATUS = {
  open: { label: '待处理', tone: 'warning' },
  known: { label: '已知', tone: 'info' },
  ignored: { label: '忽略', tone: 'neutral' },
  resolved: { label: '已解决', tone: 'success' },
} as const

function describe(issue: QualityIssueRow) {
  const detail = JSON.parse(issue.detail) as Record<string, unknown>
  switch (issue.type) {
    case 'source-divergence': {
      const list = (value: unknown) =>
        Array.isArray(value) ? value.join(' / ') : String(value ?? '')
      return `${issue.metric}：${list(detail.sources)} = ${list(detail.values)}`
    }
    case 'spike':
      return `${issue.metric}：${detail.yesterday} → ${detail.today}`
    case 'missing':
      return `${issue.metric} 缺失率 ${Math.round(Number(detail.missingRate) * 100)}%`
    case 'stale':
      return detail.lastSuccessAt
        ? `最近成功同步 ${formatTime(String(detail.lastSuccessAt))}`
        : '从未成功同步'
    case 'sync-failure':
      return `${detail.errorCode} × ${detail.count}`
    default:
      return issue.detail
  }
}

export function QualityIssues({ slug }: { slug: string }) {
  const [rows, setRows] = useState<QualityIssueRow[] | null>(null)
  const [error, setError] = useState('')
  async function load() {
    try {
      setRows(await getQualityIssues({ data: { slug } }))
    } catch (e) {
      setError(errorText(e))
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: 首次加载
  useEffect(() => {
    void load()
  }, [])
  async function mark(id: string, status: keyof typeof STATUS) {
    try {
      await setQualityIssueStatus({ data: { slug, id, status } })
      await load()
    } catch (e) {
      setError(errorText(e))
    }
  }
  return (
    <Section title="数据质量">
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <SimpleTable
        head={['类型', '数据源', '详情', '首次出现', '最近出现', '状态', '']}
        empty={rows?.length === 0}
      >
        {rows?.map((issue) => (
          <tr key={issue.id}>
            <td className="px-3 py-2">{TYPES[issue.type] ?? issue.type}</td>
            <td className="px-3 py-2">{issue.sourceId ?? '—'}</td>
            <td className="px-3 py-2 text-xs">{describe(issue)}</td>
            <td className="px-3 py-2 whitespace-nowrap">{formatTime(issue.firstSeenAt)}</td>
            <td className="px-3 py-2 whitespace-nowrap">{formatTime(issue.lastSeenAt)}</td>
            <td className="px-3 py-2">
              <Tag tone={STATUS[issue.status].tone}>{STATUS[issue.status].label}</Tag>
            </td>
            <td className="flex gap-1 px-3 py-2">
              {issue.status !== 'known' ? (
                <Button size="sm" variant="outline" onClick={() => mark(issue.id, 'known')}>
                  标为已知
                </Button>
              ) : null}
              {issue.status !== 'ignored' ? (
                <Button size="sm" variant="ghost" onClick={() => mark(issue.id, 'ignored')}>
                  忽略
                </Button>
              ) : null}
            </td>
          </tr>
        ))}
      </SimpleTable>
    </Section>
  )
}
