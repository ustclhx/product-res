import { buildCostingMatrix, findRate } from '@product-res/costing'
import { describe, expect, it } from 'vitest'
import { cellIssues, competitorMedian, crossRates, nearestNode } from './matrix-input.ts'
import { parseDimensions, parseQuoteTable, parseTiers } from './quote-import.ts'
import { quoteTemplateCsv } from './quote-template.ts'
import { waterfallRows } from './waterfall.tsx'

// tasks 2.3 / 3.1 的纯函数：汇率交叉、竞品中位价、最近节点、格子说明、报价表解析与成本瀑布分段。

describe('核算矩阵输入', () => {
  it('fx_rate 以 {币种}/CNY 观测，经 CNY 交叉出任意两币种', () => {
    const rates = crossRates(
      new Map([
        ['USD', 7.2],
        ['EUR', 7.8],
      ]),
    )
    expect(findRate('CNY', 'USD', rates)).toBeCloseTo(1 / 7.2)
    expect(findRate('EUR', 'USD', rates)).toBeCloseTo(7.8 / 7.2)
    expect(findRate('GBP', 'USD', rates)).toBeNull()
  })

  it('竞品中位价取出现最多的币种，偶数个取中间两者平均', () => {
    expect(
      competitorMedian(
        [
          { value: 19.99, currency: 'USD' },
          { value: 24.99, currency: 'usd' },
          { value: 21.5, currency: null },
          { value: 30, currency: 'USD' },
          { value: 99, currency: 'EUR' },
        ],
        'USD',
      ),
    ).toEqual({ amountMinor: 2325, currency: 'USD', sampleSize: 4 })
    expect(competitorMedian([], 'USD')).toBeNull()
  })

  it('最近节点：下一次销售开始日最早的；已过的取明年', () => {
    const nodes = [
      { id: 'a', name: '返校', startMonth: 8, startDay: 1 },
      { id: 'b', name: '黑五', startMonth: 11, startDay: 27 },
    ]
    expect(nearestNode(nodes, '2026-10-19')).toEqual({
      id: 'b',
      name: '黑五',
      saleStartDate: '2026-11-27',
    })
    expect(nearestNode(nodes, '2026-11-28')).toEqual({
      id: 'a',
      name: '返校',
      saleStartDate: '2027-08-01',
    })
    expect(nearestNode([], '2026-10-19')).toBeNull()
  })

  it('格子说明：低于 MOQ、禁运（属性）、来不及、缺少：…；最优只在可用格中选', () => {
    const matrix = buildCostingMatrix({
      plannedQty: 300,
      salePrice: { amountMinor: 1999, currency: 'USD' },
      quotes: [
        {
          id: 'q1',
          currency: 'USD',
          tiers: [{ minQty: 500, unitPriceMinor: 300 }],
          confidence: 'public',
          weightG: 300,
        },
        {
          id: 'q2',
          currency: 'USD',
          tiers: [{ minQty: 100, unitPriceMinor: 400 }],
          confidence: 'confirmed',
        },
      ],
      profiles: [
        {
          id: 'p',
          platform: 'ebay',
          type: 'ebay-direct',
          transitDays: 10,
          bannedAttributes: ['battery'],
          lastMile: {
            kind: 'first-additional',
            currency: 'USD',
            firstWeightG: 500,
            firstPriceMinor: 300,
            stepWeightG: 500,
            stepPriceMinor: 100,
          },
        },
      ],
      modes: ['same-source'],
      costParams: {
        ebay: { commissionRate: 0.13, fixedFeeMinor: 30, adRate: 0.05, returnRate: 0.03 },
      },
      fxRates: [],
      productAttributes: ['battery'],
    })
    expect(matrix.cells.map(cellIssues)).toEqual([
      ['低于 MOQ', '禁运（battery）'],
      ['禁运（battery）', '缺少：重量'],
    ])
    expect(matrix.best).toBeNull()
  })
})

describe('供应商报价表解析', () => {
  it('阶梯与尺寸的常见写法', () => {
    expect(parseTiers('100:12; 500:10.5')).toEqual([
      { minQty: 100, unitPriceMinor: 1200 },
      { minQty: 500, unitPriceMinor: 1050 },
    ])
    expect(parseTiers('500件=¥10；100件=¥12')).toEqual([
      { minQty: 100, unitPriceMinor: 1200 },
      { minQty: 500, unitPriceMinor: 1000 },
    ])
    expect(parseTiers('100:12; 100:11')).toBeUndefined()
    expect(parseTiers('')).toBeNull()
    expect(parseDimensions('30×20×10 cm')).toEqual({ lengthCm: 30, widthCm: 20, heightCm: 10 })
    expect(parseDimensions('30x20')).toBeUndefined()
  })

  it('一行一个报价：空值保持为空不补 0；缺列整体报错；错误行逐行报告', () => {
    const defaults = { currency: 'CNY', quotedOn: '2026-10-19' }
    expect(parseQuoteTable([['供应商', '单价']], defaults).issues).toEqual([
      { row: 0, message: '缺少“簇 ID”或“平台商品 ID”列' },
    ])
    const result = parseQuoteTable(
      [
        [
          'ASIN',
          'Supplier',
          '单价',
          'MOQ',
          '重量',
          '长',
          '宽',
          '高',
          '报价类型',
          '供应商链接',
          'Foo',
        ],
        [
          'B0X',
          '工厂甲',
          '¥12.5',
          '200',
          '',
          '',
          '',
          '',
          '',
          'https://detail.1688.com/offer/1.html',
          'x',
        ],
        ['B0Y', '', 'abc', '0', '-5', '1', '', '', '口头', '', ''],
        ['', '', '', '', '', '', '', '', '', '', ''],
      ],
      defaults,
    )
    expect(result.unknown).toEqual(['Foo'])
    expect(result.drafts).toEqual([
      {
        row: 1,
        clusterId: null,
        platformId: 'B0X',
        supplier: { name: '工厂甲', url: 'https://detail.1688.com/offer/1.html', platform: '1688' },
        tiers: [{ minQty: 200, unitPriceMinor: 1250 }],
        currency: 'CNY',
        moq: 200,
        weightG: null,
        dimensions: null,
        confidence: 'public',
        quotedOn: '2026-10-19',
        procurementDays: null,
        note: null,
      },
    ])
    expect(result.errorRows).toEqual([2])
    expect(result.issues.filter((i) => i.row === 2).map((i) => i.column)).toEqual([
      '供应商',
      'MOQ',
      '单价',
      '重量(g)',
      '尺寸(cm)',
      '可信度',
    ])
  })

  it('下载模板的表头能被解析器识别', () => {
    const [header] = quoteTemplateCsv().trim().split('\n')
    const table = [header?.split(',') ?? []]
    expect(parseQuoteTable(table, { currency: 'CNY', quotedOn: '2026-10-19' }).issues).toEqual([])
  })
})

describe('成本瀑布分段', () => {
  it('每段从上一步剩余处扣减，净利润从 0 起；亏损时截在 0 并画负向', () => {
    const steps = [
      { key: 'purchase', amountMinor: 600 },
      { key: 'headFreight', amountMinor: 0 },
      { key: 'platformFee', amountMinor: 300 },
      { key: 'fulfillment', amountMinor: 400 },
      { key: 'ads', amountMinor: 100 },
      { key: 'returns', amountMinor: 100 },
      { key: 'netProfit', amountMinor: 500 },
    ] as const
    const rows = waterfallRows(2000, steps)
    expect(rows.map((r) => [r.label, r.base, r.value])).toEqual([
      ['售价', 0, 2000],
      ['采购', 1400, 600],
      ['头程', 1400, 0],
      ['平台费', 1100, 300],
      ['配送/尾程', 700, 400],
      ['广告', 600, 100],
      ['退货预留', 500, 100],
      ['净利润', 0, 500],
    ])
    const loss = waterfallRows(1000, [
      { key: 'purchase', amountMinor: 900 },
      { key: 'platformFee', amountMinor: 300 },
      { key: 'netProfit', amountMinor: -200 },
    ])
    expect(loss.map((r) => [r.base, r.value])).toEqual([
      [0, 1000],
      [100, 900],
      [0, 100],
      [0, -200],
    ])
  })
})
