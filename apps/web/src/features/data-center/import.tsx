import { METRICS } from '@product-res/datasources'
import { Button, Input, Tag } from '@product-res/ui'
import { useEffect, useState } from 'react'
import { QuoteImportPanel } from '../costing/quote-import-panel.tsx'
import { QUOTE_IMPORT_SOURCE } from '../costing/quote-template.ts'
import {
  commitDataImport,
  getImports,
  previewDataImport,
  revertDataImport,
} from './data-center.functions.ts'
import { errorText, formatNumber, formatTime, Section, SimpleTable } from './shared.tsx'
import type { ImportsData } from './types.ts'

type Preview = Awaited<ReturnType<typeof previewDataImport>>
type Target = Preview['mapping'][string]
type Marketplace =
  | 'ebay-us'
  | 'amazon-us'
  | 'amazon-uk'
  | 'amazon-de'
  | 'amazon-jp'
  | 'amazon-ca'
  | 'global'

const MARKETPLACES: Marketplace[] = [
  'amazon-us',
  'ebay-us',
  'amazon-uk',
  'amazon-de',
  'amazon-jp',
  'amazon-ca',
]
const FIELD_OPTIONS: [string, string][] = [
  ['ignore', '不导入'],
  ['platformId', '平台 ID（ASIN / ItemID / 关键词）'],
  ['title', '标题'],
  ['brand', '品牌'],
  ['gtin', 'UPC / EAN'],
  ['url', '链接'],
  ['observedOn', '日期'],
  ...Object.entries(METRICS).map(([name, def]): [string, string] => [
    `metric:${name}`,
    `指标：${def.label}`,
  ]),
]

const targetValue = (t: Target | undefined) =>
  !t ? 'ignore' : t.kind === 'metric' ? `metric:${t.metric}` : t.kind
function parseTarget(value: string): Target {
  if (value.startsWith('metric:'))
    return { kind: 'metric', metric: value.slice('metric:'.length) } as Target
  return { kind: value as Exclude<Target['kind'], 'metric'> } as Target
}

async function toBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

export function FileImport({ slug }: { slug: string }) {
  const [data, setData] = useState<ImportsData | null>(null)
  const [sourceId, setSourceId] = useState('helium10')
  const [marketplace, setMarketplace] = useState<Marketplace>('amazon-us')
  const [entityType, setEntityType] = useState<'product' | 'keyword' | 'seller'>('product')
  const [observedOn, setObservedOn] = useState(() => new Date().toISOString().slice(0, 10))
  const [templateId, setTemplateId] = useState('')
  const [file, setFile] = useState<{ name: string; base64: string; sheet?: string } | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [mapping, setMapping] = useState<Record<string, Target>>({})
  const [skipErrorRows, setSkipErrorRows] = useState(false)
  const [confirmDuplicate, setConfirmDuplicate] = useState(false)
  const [templateName, setTemplateName] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function reload() {
    setData(await getImports({ data: { slug } }))
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: 首次加载
  useEffect(() => {
    reload().catch((e) => setError(errorText(e)))
  }, [])

  const request = (base64: string, name: string, map?: Record<string, Target>, sheet?: string) => ({
    slug,
    sourceId,
    fileName: name,
    contentBase64: base64,
    context: { marketplace, entityType, ...(observedOn ? { observedOn } : {}) },
    ...(map ? { mapping: map } : {}),
    ...(sheet ? { sheetName: sheet } : {}),
    ...(templateId ? { templateId } : {}),
  })

  async function runPreview(map?: Record<string, Target>, picked = file) {
    if (!picked) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await previewDataImport({
        data: request(picked.base64, picked.name, map, picked.sheet),
      })
      setPreview(result)
      setMapping(result.mapping)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  async function commit() {
    if (!file) return
    setBusy(true)
    setError('')
    try {
      const result = await commitDataImport({
        data: {
          ...request(file.base64, file.name, mapping, file.sheet),
          skipErrorRows,
          confirmDuplicate,
          ...(templateName ? { saveTemplateName: templateName } : {}),
        },
      })
      setMessage(`已导入 ${formatNumber(result.imported)} 条观测，跳过 ${result.skippedRows} 行`)
      setPreview(null)
      setFile(null)
      await reload()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  async function revert(importId: string) {
    setError('')
    try {
      const { removed } = await revertDataImport({ data: { slug, importId } })
      const row = data?.history.find((h) => h.id === importId)
      setMessage(
        `已撤销，删除 ${formatNumber(removed)} 条${row?.sourceId === QUOTE_IMPORT_SOURCE ? '导入的报价' : '观测'}`,
      )
      await reload()
    } catch (e) {
      setError(errorText(e))
    }
  }

  const templates = data?.templates.filter((t) => t.sourceId === sourceId) ?? []
  // 供应商报价写入空间级报价表，使用独立的导入面板（按簇或平台商品 ID 关联）
  const quoteMode = sourceId === QUOTE_IMPORT_SOURCE
  return (
    <div className="grid gap-4">
      <Section title="文件导入">
        <p className="text-xs text-muted-foreground">
          用于没有接口的工具导出（如 Helium 10）和供应商报价表。支持 CSV / TSV /
          XLSX（多工作表可在预览中切换，默认第一个），最大 5 MB；空单元格保持为空，不补零。
        </p>
        <div className="grid gap-3 md:grid-cols-3">
          <label className="grid gap-1 text-xs">
            <span className="text-muted-foreground">数据源</span>
            <select
              className="rounded-md border bg-background px-2 py-1.5 text-sm"
              value={sourceId}
              onChange={(e) => {
                setSourceId(e.target.value)
                setPreview(null)
                setFile(null)
              }}
            >
              {data?.sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs">
            <span className="text-muted-foreground">站点</span>
            <select
              className="rounded-md border bg-background px-2 py-1.5 text-sm"
              value={marketplace}
              onChange={(e) => setMarketplace(e.target.value as Marketplace)}
            >
              {MARKETPLACES.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          {quoteMode ? null : (
            <>
              <label className="grid gap-1 text-xs">
                <span className="text-muted-foreground">每行是</span>
                <select
                  className="rounded-md border bg-background px-2 py-1.5 text-sm"
                  value={entityType}
                  onChange={(e) => setEntityType(e.target.value as typeof entityType)}
                >
                  <option value="product">商品</option>
                  <option value="keyword">关键词</option>
                  <option value="seller">卖家</option>
                </select>
              </label>
              <div className="grid gap-1 text-xs">
                <label htmlFor="import-observed-on" className="text-muted-foreground">
                  观测日期（文件没有日期列时使用）
                </label>
                <Input
                  id="import-observed-on"
                  type="date"
                  value={observedOn}
                  onChange={(e) => setObservedOn(e.target.value)}
                />
              </div>
              <label className="grid gap-1 text-xs">
                <span className="text-muted-foreground">映射模板</span>
                <select
                  className="rounded-md border bg-background px-2 py-1.5 text-sm"
                  value={templateId}
                  onChange={(e) => setTemplateId(e.target.value)}
                >
                  <option value="">自动识别</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid gap-1 text-xs">
                <label htmlFor="import-file" className="text-muted-foreground">
                  文件
                </label>
                <Input
                  id="import-file"
                  type="file"
                  accept=".csv,.tsv,.txt,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  onChange={async (e) => {
                    const picked = e.target.files?.[0]
                    if (!picked) return
                    const next = { name: picked.name, base64: await toBase64(picked) }
                    setFile(next)
                    await runPreview(undefined, next)
                  }}
                />
              </div>
            </>
          )}
        </div>
        {quoteMode ? (
          <QuoteImportPanel slug={slug} marketplace={marketplace} onImported={reload} />
        ) : null}
        {message ? (
          <p role="status" className="text-sm text-success-strong">
            {message}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </Section>

      {preview && !quoteMode ? (
        <Section
          title={`预览：${preview.rowCount} 行 → ${preview.observationCount} 条观测、${preview.entityCount} 个实体`}
          actions={
            <Button size="sm" variant="outline" disabled={busy} onClick={() => runPreview(mapping)}>
              按当前映射重新预览
            </Button>
          }
        >
          {preview.sheetNames.length > 1 ? (
            <label className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">工作表</span>
              <select
                aria-label="工作表"
                className="rounded-md border bg-background px-2 py-1"
                value={preview.sheetName ?? ''}
                disabled={busy}
                onChange={async (e) => {
                  if (!file) return
                  // 换工作表后列不同，重新自动识别映射
                  const next = { ...file, sheet: e.target.value }
                  setFile(next)
                  await runPreview(undefined, next)
                }}
              >
                {preview.sheetNames.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="grid gap-2 md:grid-cols-2">
            {preview.headers.map((header) => (
              <label key={header} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate font-mono">
                  {header}
                  {preview.unmatched.includes(header) ? (
                    <Tag tone="warning" className="ml-1">
                      未识别
                    </Tag>
                  ) : null}
                </span>
                <select
                  aria-label={`列 ${header} 对应`}
                  className="w-56 rounded-md border bg-background px-2 py-1"
                  value={targetValue(mapping[header])}
                  onChange={(e) =>
                    setMapping({ ...mapping, [header]: parseTarget(e.target.value) })
                  }
                >
                  {FIELD_OPTIONS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <SimpleTable
            head={preview.headers.length ? preview.headers : ['（空）']}
            empty={preview.sampleRows.length === 0}
          >
            {preview.sampleRows
              .slice(0, 10)
              .map((row, i) => ({ row, rowNo: i + 1 }))
              .map(({ row, rowNo }) => (
                <tr
                  key={rowNo}
                  className={preview.errorRows.includes(rowNo) ? 'bg-destructive-soft' : undefined}
                >
                  {preview.headers.map((h, col) => (
                    <td key={h} className="px-3 py-1.5 whitespace-nowrap">
                      {row[col]}
                    </td>
                  ))}
                </tr>
              ))}
          </SimpleTable>
          {preview.issues.length > 0 ? (
            <ul className="grid gap-1 text-xs text-destructive">
              {preview.issues.slice(0, 20).map((issue) => (
                <li key={`${issue.row}-${issue.column ?? ''}-${issue.message}`}>
                  {issue.row > 0 ? `第 ${issue.row} 行` : '整体'}
                  {issue.column ? `「${issue.column}」` : ''}：{issue.message}
                </li>
              ))}
              {preview.issues.length > 20 ? <li>…共 {preview.issues.length} 个问题</li> : null}
            </ul>
          ) : null}
          <div className="flex flex-wrap items-end gap-3">
            {preview.errorRows.length > 0 ? (
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={skipErrorRows}
                  onChange={(e) => setSkipErrorRows(e.target.checked)}
                />
                跳过 {preview.errorRows.length} 行错误
              </label>
            ) : null}
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={confirmDuplicate}
                onChange={(e) => setConfirmDuplicate(e.target.checked)}
              />
              允许重复导入同一文件
            </label>
            <label className="grid gap-1 text-xs" htmlFor="import-template-name">
              <span className="text-muted-foreground">保存为模板（可选）</span>
              <Input
                id="import-template-name"
                className="h-8 w-48"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
              />
            </label>
            <Button
              disabled={
                busy ||
                preview.observationCount === 0 ||
                (preview.errorRows.length > 0 && !skipErrorRows)
              }
              onClick={commit}
            >
              确认导入
            </Button>
          </div>
        </Section>
      ) : null}

      <Section title="导入记录">
        <SimpleTable
          head={['时间', '数据源', '文件', '行数', '写入条数', '跳过', '状态', '']}
          empty={data?.history.length === 0}
        >
          {data?.history.map((row) => (
            <tr key={row.id}>
              <td className="px-3 py-2 whitespace-nowrap">{formatTime(row.createdAt)}</td>
              <td className="px-3 py-2">{row.sourceId}</td>
              <td className="px-3 py-2">{row.fileName}</td>
              <td className="px-3 py-2 font-mono">{formatNumber(row.rowCount)}</td>
              <td className="px-3 py-2 font-mono">{formatNumber(row.importedCount)}</td>
              <td className="px-3 py-2 font-mono">{row.skippedRows}</td>
              <td className="px-3 py-2">
                {row.revertedAt ? <Tag>已撤销</Tag> : <Tag tone="success">有效</Tag>}
              </td>
              <td className="px-3 py-2">
                {row.revertedAt ? null : (
                  <Button size="sm" variant="ghost" onClick={() => revert(row.id)}>
                    撤销
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </SimpleTable>
      </Section>
    </div>
  )
}
