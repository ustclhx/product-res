import { describe, expect, it } from 'vitest'
import { buildInsightPrompt, InsightOutputError, parseInsightOutput } from './ai.ts'

// tasks 3.3：模型输出的解析与引用校验
const review = (id: string, body: string) => ({
  id,
  productId: 'p',
  rating: 2,
  title: '',
  body,
  truncated: false,
  sourceId: 'import',
})
const input = buildInsightPrompt(
  [review('rev-a', 'slides on floor'), review('rev-b', 'cracked'), review('rev-c', 'slides')],
  [{ id: 'prod-1', title: 'Slow feeder', brand: 'X', price: 12, rating: 4.5, salesMonthly: 900 }],
)

describe('parseInsightOutput', () => {
  it('提示词用短别名代替真实 ID', () => {
    expect(input.prompt.user).toContain('R1 [2星]')
    expect(input.prompt.user).toContain('P1 Slow feeder')
    expect(input.prompt.user).not.toContain('rev-a')
  })

  it('没有有效引用的建议被丢弃，引用映射回真实 ID；主题占比按差评数计算', () => {
    const out = parseInsightOutput(
      `好的：\n\`\`\`json\n${JSON.stringify({
        themes: [
          { label: '底部打滑', reviewIds: ['R1', 'r3', 'R9'] },
          // 已归入上一个主题的差评不重复计
          { label: '易碎', reviewIds: ['R2', 'R1'] },
          { label: '编造', reviewIds: ['R42'] },
        ],
        suggestions: [
          { title: '加防滑垫', detail: '底部硅胶', citations: ['R1', 'P1', 'X9'] },
          { title: '没有依据', detail: '', citations: ['R77'] },
          { title: '也没有依据', citations: [] },
        ],
      })}\n\`\`\``,
      input,
    )
    expect(out.themes).toEqual([
      { label: '底部打滑', reviewCount: 2, share: 2 / 3, reviewIds: ['rev-a', 'rev-c'] },
      { label: '易碎', reviewCount: 1, share: 1 / 3, reviewIds: ['rev-b'] },
    ])
    expect(out.suggestions).toEqual([
      {
        title: '加防滑垫',
        detail: '底部硅胶',
        citations: [
          { kind: 'review', id: 'rev-a' },
          { kind: 'product', id: 'prod-1' },
        ],
      },
    ])
    expect(out.dropped).toBe(2)
  })

  it('不是 JSON 或结构不符时报错，不写入半成品', () => {
    expect(() => parseInsightOutput('抱歉，我无法回答', input)).toThrow(InsightOutputError)
    expect(() => parseInsightOutput('{"themes":"x"}', input)).toThrow(InsightOutputError)
  })
})
