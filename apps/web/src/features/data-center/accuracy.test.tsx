import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AccuracyStatsTable, actualOf, collectedText } from './accuracy.tsx'
import { AccuracyKpiCard, type AccuracyKpis, percent } from './accuracy-kpi.tsx'
import { IntervalCell, intervalText, TierTag } from './observation-cells.tsx'
import { SourceSpend } from './overview.tsx'
import { PreviewRow } from './preview.tsx'
import { KIND_LABELS } from './shared.tsx'

const stat = (over: Partial<AccuracyKpis['stats'][number]> = {}) => ({
  sourceId: 'dataforseo',
  metric: 'price',
  agree: 20,
  samples: 20,
  rate: 1,
  disqualified: false,
  belowTarget: false,
  ...over,
})

describe('层级与区间显示', () => {
  it('区间显示 "100–200"，上界开放显示 "10K+"，点值显示 "—"', () => {
    expect(intervalText(100, 200)).toBe('100–200')
    expect(intervalText(10_000, null)).toBe('10K+')
    expect(intervalText(1_000, 2_000)).toBe('1K–2K')
    expect(intervalText(null, null)).toBe('—')
    expect(renderToString(<IntervalCell low={10_000} high={null} />)).toContain('10K+')
  })

  it('层级显示 T0–T4 并带说明', () => {
    const html = renderToString(<TierTag tier={2} />)
    expect(html).toContain('T2')
    expect(html).toContain('T2 页面展示')
    expect(renderToString(<TierTag tier={9} />)).not.toContain('T9')
  })

  it('观测预览行包含区间、层级与经由渠道', () => {
    const html = renderToString(
      <table>
        <tbody>
          <PreviewRow
            row={{
              platformId: 'B0TEST',
              marketplace: 'amazon-us',
              metric: 'bought_month',
              observedOn: '2026-10-20',
              value: 141.42,
              currency: null,
              method: 'import',
              tier: 2,
              valueLow: 100,
              valueHigh: 200,
              channel: 'aisa',
            }}
          />
        </tbody>
      </table>,
    )
    expect(html).toContain('100–200')
    expect(html).toContain('T2')
    expect(html).toContain('经由 AIsa')
  })

  it('抽检采集值：bought 显示区间，可售状态显示文字', () => {
    const base = {
      value: 141.42,
      low: 100,
      high: 200,
      currency: null,
      tier: 2,
      channel: null,
      fetchedAt: '2026-10-19T08:00:00.000Z',
    }
    expect(collectedText('bought_month', base)).toBe('100–200')
    expect(collectedText('bought_month', { ...base, low: 10_000, high: null })).toBe('10K+')
    expect(collectedText('price', { ...base, value: 19.99, currency: 'USD' })).toBe('19.99 USD')
    expect(collectedText('available_quantity', { ...base, value: 0 })).toBe('不可售')
  })
})

describe('准确率 KPI', () => {
  it('全部达标时不标红', () => {
    const html = renderToString(
      <AccuracyKpiCard kpis={{ overall: 0.99, samples: 40, stats: [stat()] }} />,
    )
    expect(html).toContain('data-tone="neutral"')
    expect(html).not.toContain('text-destructive')
    expect(html).toContain('99.0%')
    expect(html).toContain('≥ 95%')
  })

  it('某来源某字段低于 95% 时标红并列出', () => {
    const html = renderToString(
      <AccuracyKpiCard
        kpis={{
          overall: 0.95,
          samples: 40,
          stats: [
            stat(),
            stat({
              sourceId: 'serpapi',
              metric: 'bought_month',
              agree: 18,
              rate: 0.9,
              belowTarget: true,
              disqualified: true,
            }),
          ],
        }}
        sourceLabel={(id) => (id === 'serpapi' ? 'SerpApi' : id)}
      />,
    )
    expect(html).toContain('data-tone="danger"')
    expect(html).toContain('border-destructive')
    expect(html).toContain('SerpApi · bought 区间 90.0%')
  })

  it('没有抽检时显示提示', () => {
    const html = renderToString(<AccuracyKpiCard kpis={{ overall: null, samples: 0, stats: [] }} />)
    expect(html).toContain('还没有已提交的抽检')
    expect(html).toContain('data-tone="neutral"')
  })

  it('一致率向下取整，避免 94.96% 显示为 95.0%', () => {
    expect(percent(0.9496)).toBe('94.9%')
    expect(percent(null)).toBe('—')
  })

  it('一致率表：不达标标红，失去资格显示标签', () => {
    const html = renderToString(
      <AccuracyStatsTable
        kpis={{
          overall: 0.9,
          samples: 20,
          stats: [stat({ rate: 0.9, agree: 18, belowTarget: true, disqualified: true })],
        }}
      />,
    )
    expect(html).toContain('data-below="true"')
    expect(html).toContain('已失去资格')
    expect(html).toContain('18 / 20')
  })
})

describe('抽检填写', () => {
  const empty = {
    price: '',
    bought_month: '',
    review_count: '',
    rating: '',
    bsr: '',
    available_quantity: '',
  }
  it('空值为未填写，bought 可粘贴徽标文本', () => {
    expect(
      actualOf({
        ...empty,
        price: '$1,299.00',
        bought_month: '1K+ bought',
        available_quantity: 'no',
      }),
    ).toEqual({
      actual: {
        price: 1299,
        bought_month: 1000,
        review_count: null,
        rating: null,
        bsr: null,
        available_quantity: false,
      },
      invalid: null,
    })
    expect(actualOf({ ...empty, bsr: 'abc' }).invalid).toBe('bsr')
  })
})

describe('来源卡片的额度与花费', () => {
  it('AIsa（美元）显示本月花费与剩余', () => {
    const html = renderToString(
      <SourceSpend
        budget={{ unit: 'usd-micro', period: 'month', used: 12_340_000, hardCap: 50_000_000 }}
      />,
    )
    expect(html).toContain('本月花费 $12.34')
    expect(html).toContain('剩余 $37.66')
  })

  it('SerpApi（次）显示本月已用与剩余次数', () => {
    const html = renderToString(
      <SourceSpend budget={{ unit: 'call', period: 'month', used: 30, hardCap: 250 }} />,
    )
    expect(html).toContain('本月已用 30 次')
    expect(html).toContain('剩余 220 次')
  })

  it('非月度额度不显示', () => {
    expect(
      renderToString(
        <SourceSpend budget={{ unit: 'call', period: 'day', used: 1, hardCap: 10 }} />,
      ),
    ).toBe('')
  })

  it('新任务类型有中文名', () => {
    for (const kind of [
      'amazon-search',
      'amazon-asin',
      'amazon-offers',
      'amazon-keyword-volume',
      'amazon-product',
    ])
      expect(KIND_LABELS[kind]).toMatch(/Amazon/)
  })
})
