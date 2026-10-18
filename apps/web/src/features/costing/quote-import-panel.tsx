import { Button, Input, Tag } from '@product-res/ui'
import { useState } from 'react'
import { errorText, formatNumber, SimpleTable } from '../data-center/shared.tsx'
import { commitQuoteImport, previewQuoteImport } from './costing.functions.ts'
import { formatMoney } from './format.ts'
import { QUOTE_CONFIDENCE_LABELS } from './labels.ts'
import { quoteTemplateCsv } from './quote-template.ts'

type Preview = Awaited<ReturnType<typeof previewQuoteImport>>
type Marketplace = 'ebay-us' | 'amazon-us' | 'amazon-uk' | 'amazon-de' | 'amazon-jp' | 'amazon-ca'

async function toBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

function downloadTemplate() {
  // 带 BOM，Excel 打开 UTF-8 中文表头不乱码
  const blob = new Blob([`﻿${quoteTemplateCsv()}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = '供应商报价导入模板.csv'
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * 数据中心“供应商报价表”导入：一行一个报价，按簇 ID 或平台商品 ID 关联商品簇；
 * 预览显示关联结果与错误行，确认后报价来源记为导入，可在导入记录中撤销。
 */
export function QuoteImportPanel({
  slug,
  marketplace,
  onImported,
}: {
  slug: string
  marketplace: string
  onImported: () => Promise<void>
}) {
  const [currency, setCurrency] = useState('CNY')
  const [file, setFile] = useState<{ name: string; base64: string; sheet?: string } | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [skipErrorRows, setSkipErrorRows] = useState(false)
  const [confirmDuplicate, setConfirmDuplicate] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const request = (picked: NonNullable<typeof file>) => ({
    slug,
    fileName: picked.name,
    contentBase64: picked.base64,
    marketplace: (marketplace === 'global' ? 'amazon-us' : marketplace) as Marketplace,
    currency,
    ...(picked.sheet ? { sheetName: picked.sheet } : {}),
  })

  async function runPreview(picked = file) {
    if (!picked) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      setPreview(await previewQuoteImport({ data: request(picked) }))
    } catch (e) {
      setPreview(null)
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
      const result = await commitQuoteImport({
        data: { ...request(file), skipErrorRows, confirmDuplicate },
      })
      setMessage(`已导入 ${formatNumber(result.imported)} 条报价，跳过 ${result.skippedRows} 行`)
      setPreview(null)
      setFile(null)
      await onImported()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-3" data-testid="quote-import">
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-xs">
          <span className="text-muted-foreground">默认币种（币种列为空时）</span>
          <select
            aria-label="默认币种"
            className="rounded-md border bg-background px-2 py-1.5 text-sm"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
          >
            {['CNY', 'USD', 'EUR', 'GBP', 'JPY'].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <div className="grid gap-1 text-xs">
          <label htmlFor="quote-import-file" className="text-muted-foreground">
            报价文件
          </label>
          <Input
            id="quote-import-file"
            type="file"
            accept=".csv,.tsv,.txt,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={async (e) => {
              const picked = e.target.files?.[0]
              if (!picked) return
              const next = { name: picked.name, base64: await toBase64(picked) }
              setFile(next)
              await runPreview(next)
            }}
          />
        </div>
        <Button type="button" size="sm" variant="outline" onClick={downloadTemplate}>
          下载导入模板
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        每行一个报价。用“簇 ID”或“平台商品 ID”（ASIN / ItemID，按上方站点查找）关联商品簇；
        阶梯价写成“100:12; 500:10.5”，也可只填单价与
        MOQ。重量、尺寸留空即为未录入，核算时显示“缺少”。
      </p>
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

      {preview ? (
        <div className="grid gap-3 rounded-lg border p-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">
              预览：{preview.rowCount} 行 → {preview.quoteCount} 条报价、{preview.clusterCount}{' '}
              个商品簇
            </span>
            {preview.errorRows.length > 0 ? (
              <Tag tone="danger">{preview.errorRows.length} 行有错误</Tag>
            ) : (
              <Tag tone="success">无错误</Tag>
            )}
            {preview.unknownHeaders.length > 0 ? (
              <Tag tone="warning">未识别列：{preview.unknownHeaders.join('、')}</Tag>
            ) : null}
            {preview.sheetNames.length > 1 ? (
              <select
                aria-label="工作表"
                className="rounded-md border bg-background px-2 py-1 text-xs"
                value={preview.sheetName ?? ''}
                disabled={busy}
                onChange={async (e) => {
                  if (!file) return
                  const next = { ...file, sheet: e.target.value }
                  setFile(next)
                  await runPreview(next)
                }}
              >
                {preview.sheetNames.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            ) : null}
          </div>
          <SimpleTable
            head={['行', '商品簇', '供应商', '阶梯价', 'MOQ', '重量', '尺寸', '可信度', '报价日期']}
            empty={preview.rows.length === 0}
          >
            {preview.rows.map((r) => (
              <tr key={r.row}>
                <td className="px-3 py-1.5 font-mono text-muted-foreground">{r.row}</td>
                <td className="max-w-[220px] truncate px-3 py-1.5">{r.clusterName}</td>
                <td className="px-3 py-1.5">{r.supplier}</td>
                <td className="px-3 py-1.5 whitespace-nowrap font-mono">
                  {r.tiers
                    .map((t) => `${t.minQty}+ ${formatMoney(t.unitPriceMinor, r.currency)}`)
                    .join(' / ')}
                </td>
                <td className="px-3 py-1.5 font-mono">{r.moq ?? '—'}</td>
                <td className="px-3 py-1.5 font-mono">{r.weightG ? `${r.weightG} g` : '—'}</td>
                <td className="px-3 py-1.5 whitespace-nowrap font-mono">
                  {r.dimensions
                    ? `${r.dimensions.lengthCm}×${r.dimensions.widthCm}×${r.dimensions.heightCm}`
                    : '—'}
                </td>
                <td className="px-3 py-1.5">{QUOTE_CONFIDENCE_LABELS[r.confidence]}</td>
                <td className="px-3 py-1.5 font-mono">{r.quotedOn}</td>
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
          <div className="flex flex-wrap items-center gap-3">
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
            <Button
              disabled={
                busy || preview.quoteCount === 0 || (preview.errorRows.length > 0 && !skipErrorRows)
              }
              onClick={commit}
            >
              确认导入报价
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
