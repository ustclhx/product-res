import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FileSourceCard } from './file-source-card.tsx'

const base = {
  id: 'helium10',
  label: 'Helium 10（导出文件）',
  marketplaces: ['amazon-us'],
  capabilities: ['sales-estimate'],
  records: 1200,
}

describe('文件导入类型的数据源卡片', () => {
  it('不显示同步频率、额度与立即刷新，显示导入入口与最近导入时间', () => {
    const html = renderToString(
      <FileSourceCard
        source={{ ...base, lastImport: { at: '2026-10-18T08:00:00.000Z', fileName: 'xray.csv' } }}
        onImport={() => {}}
      />,
    )
    for (const text of ['同步频率', '额度', '安全线', '立即刷新', '最近同步'])
      expect(html).not.toContain(text)
    expect(html).toContain('导入文件')
    expect(html).toContain('最近导入')
    expect(html).toContain('xray.csv')
    expect(html).toContain('1,200')
  })

  it('尚未导入时提示', () => {
    const html = renderToString(
      <FileSourceCard source={{ ...base, lastImport: null }} onImport={() => {}} />,
    )
    expect(html).toContain('尚未导入')
  })
})
