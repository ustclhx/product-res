import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { coldStartText, replayErrorText } from './labels.ts'
import { type ValidationData, ValidationPage } from './validation-page.tsx'

const kinds = () => ({ shadow: 0, replay: 0, import: 0 })
const months = Array.from({ length: 12 }, (_, i) => ({
  month: `2032-${String(i + 1).padStart(2, '0')}`,
  effectiveSamples: 0,
  hitRate: null,
  byKind: {
    shadow: { hits: 0, labeled: 0 },
    replay: { hits: 0, labeled: 0 },
    import: { hits: 0, labeled: 0 },
  },
}))

const coldStart: ValidationData = {
  asOf: '2032-12-01',
  readiness: [],
  monthly: months,
  composition: { recommendations: kinds(), labeled: kinds(), insufficient: kinds() },
  pendingLabels: { total: 0, byWindow: { '14': 0, '30': 0, '60': 0 } },
  bySignalType: [],
  latestSuggestion: null,
  replays: [],
  coldStart: { allColdStart: true, samplesNeeded: 20, dailyShadowRate: 0.5, estimatedDays: 70 },
  amazonDirections: [],
  dimensions: [{ id: 'market-demand', label: '市场需求' }],
  thresholds: { observation: 20, usable: 50, trusted: 100, fitMinSamples: 50 },
  replayQueueAvailable: false,
  canWrite: true,
}

describe('算法验证页：冷启动', () => {
  it('说明还需的样本数与预计天数，不渲染命中率曲线', () => {
    const html = renderToStaticMarkup(<ValidationPage slug="s" initial={coldStart} />)
    expect(html).toContain('data-testid="cold-start"')
    expect(html).toContain('至少 20 个有效样本')
    expect(html).toContain('还差 20 个')
    expect(html).toContain('约需 70 天')
    // 图表只渲染空状态容器，不初始化 ECharts 画布
    expect(html).toContain('data-slot="chart-empty"')
    expect(html).not.toContain('data-slot="chart"')
    expect(html).toContain('还没有准备度统计')
    expect(html).toContain('还没有权重建议')
  })

  it('无新增影子推荐时不估算天数', () => {
    const text = coldStartText({
      observation: 20,
      samplesNeeded: 20,
      dailyShadowRate: 0,
      estimatedDays: null,
    })
    expect(text.eta).toContain('暂无法估算时间')
  })

  it('回放错误码映射为说明，未知码原样显示', () => {
    expect(replayErrorText('KEEPA_API_KEY_MISSING')).toBe('未配置 Keepa 凭据')
    expect(replayErrorText('SOMETHING_NEW')).toBe('SOMETHING_NEW')
    expect(replayErrorText(null)).toBeNull()
  })
})
