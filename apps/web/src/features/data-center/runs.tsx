import { Button, Tag } from '@product-res/ui'
import { useEffect, useState } from 'react'
import { getSyncRuns, retrySyncRun } from './data-center.functions.ts'
import {
  errorText,
  formatNumber,
  formatTime,
  KIND_LABELS,
  RUN_STATUS,
  Section,
  SimpleTable,
} from './shared.tsx'
import type { SyncRunRow } from './types.ts'

export function SyncRuns({ slug }: { slug: string }) {
  const [rows, setRows] = useState<SyncRunRow[] | null>(null)
  const [failedOnly, setFailedOnly] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  async function load(onlyFailed = failedOnly) {
    try {
      setRows(await getSyncRuns({ data: { slug, failedOnly: onlyFailed } }))
    } catch (e) {
      setError(errorText(e))
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在切换筛选时重新加载
  useEffect(() => {
    void load(failedOnly)
  }, [failedOnly])
  async function retry(id: string) {
    setBusy(id)
    setError('')
    try {
      await retrySyncRun({ data: { slug, runId: id } })
      await load()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <Section
      title="同步记录"
      actions={
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={failedOnly}
            onChange={(e) => setFailedOnly(e.target.checked)}
          />
          只看失败
        </label>
      }
    >
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <SimpleTable
        head={[
          '开始时间',
          '数据源',
          '类型',
          '站点',
          '触发',
          '状态',
          '调用 / 花费',
          '写入',
          '错误',
          '',
        ]}
        empty={rows?.length === 0}
      >
        {rows?.map((run) => {
          const status = RUN_STATUS[run.status] ?? { label: run.status, tone: 'neutral' as const }
          return (
            <tr key={run.id}>
              <td className="px-3 py-2 whitespace-nowrap">{formatTime(run.startedAt)}</td>
              <td className="px-3 py-2">{run.sourceId}</td>
              <td className="px-3 py-2">{KIND_LABELS[run.dataKind] ?? run.dataKind}</td>
              <td className="px-3 py-2">{run.marketplace}</td>
              <td className="px-3 py-2">
                {{ scheduled: '定时', manual: '人工', replay: '回放' }[run.trigger]}
              </td>
              <td className="px-3 py-2">
                <Tag tone={status.tone}>{status.label}</Tag>
              </td>
              <td className="px-3 py-2 font-mono">
                {run.calls} / {formatNumber(run.cost)}
              </td>
              <td className="px-3 py-2 font-mono">{formatNumber(run.okCount)}</td>
              <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                {run.errorCode ?? ''}
              </td>
              <td className="px-3 py-2">
                {run.status === 'failed' ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === run.id}
                    onClick={() => retry(run.id)}
                  >
                    重新执行
                  </Button>
                ) : null}
              </td>
            </tr>
          )
        })}
      </SimpleTable>
    </Section>
  )
}
