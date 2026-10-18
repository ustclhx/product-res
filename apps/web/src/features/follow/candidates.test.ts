import { describe, expect, it } from 'vitest'
import {
  attention,
  candidateColumnIds,
  candidateSearch,
  displayGrade,
  hitSignals,
  parseConfidence,
  parseEvidence,
  parseGates,
  parseSignalInputs,
} from './candidates.ts'

describe('候选列表的列', () => {
  it('eBay 不显示 BSR 列，Amazon 显示', () => {
    expect(candidateColumnIds('ebay')).not.toContain('bsr')
    expect(candidateColumnIds('amazon')).toContain('bsr')
    // 其余列两个平台相同
    expect(candidateColumnIds('amazon').filter((id) => id !== 'bsr')).toEqual(
      candidateColumnIds('ebay'),
    )
  })

  it('search 缺省为 Amazon、第一页；非法方向与 offset 被丢弃', () => {
    expect(candidateSearch({})).toEqual({ platform: 'amazon', offset: 0 })
    expect(candidateSearch({ platform: 'ebay', direction: 'x', offset: '-5' })).toEqual({
      platform: 'ebay',
      offset: 0,
    })
  })
})

describe('等级显示', () => {
  const base = { score: 82, gatesPassed: true, vetoed: false, readiness: 'cold-start' as const }
  it('冷启动显示未验证；硬门槛不通过仍为不推荐', () => {
    expect(displayGrade(base)).toBe('unverified')
    expect(displayGrade({ ...base, gatesPassed: false })).toBe('reject')
    expect(displayGrade({ ...base, vetoed: true })).toBe('reject')
  })
  it('准备度可用后按 75 / 50 分级；没有综合分时未验证', () => {
    expect(displayGrade({ ...base, readiness: 'usable' })).toBe('recommend')
    expect(displayGrade({ ...base, score: 60, readiness: 'usable' })).toBe('caution')
    expect(displayGrade({ ...base, score: null, readiness: 'usable' })).toBe('unverified')
  })
  it('高分低置信标“值得关注但证据不足”', () => {
    expect(attention(80, 0.3)).toBe(true)
    expect(attention(80, 0.8)).toBe(false)
    expect(attention(60, 0.3)).toBe(false)
    expect(attention(null, 0.3)).toBe(false)
  })
})

describe('命中信号', () => {
  it('按有效分取前三，反向维度取 100 − 分数，缺失维度不参与', () => {
    const signals = hitSignals([
      { dimension: 'market-demand', score: 82 },
      { dimension: 'competition', score: 10 },
      { dimension: 'peer-spread', score: 55 },
      { dimension: 'profit', score: null },
      { dimension: 'growth-season', score: 70 },
      { dimension: 'compliance', score: 100 },
    ])
    expect(signals.map((s) => [s.label, s.effective])).toEqual([
      ['合规与侵权', 100],
      ['竞争强度', 90],
      ['市场需求', 82],
    ])
  })
})

describe('流水线 JSON 解析', () => {
  it('维度输入：只保留结构完整的来源引用', () => {
    const parsed = parseSignalInputs({
      reason: '7 天增量 120',
      inputs: [
        {
          metric: 'sold_quantity_total',
          value: 120,
          observedOn: '2026-10-18',
          sourceId: 'ebay-browse',
          method: 'official',
          fetchedAt: '2026-10-18T01:00:00Z',
        },
        { metric: 'x', value: 'bad' },
      ],
      detail: { salesAvailable: true, nested: { a: 1 } },
    })
    expect(parsed.sources).toHaveLength(1)
    expect(parsed.reason).toBe('7 天增量 120')
    expect(parsed.detail).toEqual({ salesAvailable: true })
    expect(parseSignalInputs(null)).toEqual({ reason: null, sources: [], detail: {} })
  })

  it('维度输入：接受流水线写入的 refs 字段', () => {
    const parsed = parseSignalInputs({
      reason: '月销量估算 300',
      refs: [
        {
          metric: 'sales_estimate_monthly',
          value: 300,
          observedOn: '2026-10-18',
          sourceId: 'keepa',
          method: 'estimate',
          fetchedAt: '2026-10-18T01:00:00Z',
        },
      ],
      detail: {},
    })
    expect(parsed.sources).toHaveLength(1)
    expect(parsed.sources[0]?.sourceId).toBe('keepa')
  })

  it('置信度明细缺准备度时按冷启动；门槛失败给出原因；证据链接只接受 http(s)', () => {
    const conf = parseConfidence({
      items: [
        { id: 'coverage', value: 0.5, note: '快照 15 天' },
        { id: 'unknown', value: 1 },
      ],
      unverifiedMetrics: ['sales_estimate_monthly'],
    })
    expect(conf.items.map((i) => i.id)).toEqual(['coverage'])
    expect(conf.readiness).toBe('cold-start')
    expect(
      parseGates({ passed: false, failures: [{ gate: 'compliance', reason: '合规低' }] }),
    ).toEqual({ passed: false, reasons: ['合规低'] })
    expect(parseGates({})).toEqual({ passed: true, reasons: [] })
    expect(parseEvidence({ basis: 'VeRO', link: 'javascript:alert(1)' }).link).toBeNull()
  })
})
