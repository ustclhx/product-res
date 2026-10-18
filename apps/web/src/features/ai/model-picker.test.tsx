import type { Pricing } from '@product-res/ai'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { creditEstimate, DEFAULT_MAX_OUTPUT_TOKENS, type PickerModel } from './model-picker.ts'
import { CreditEstimateText, ModelPicker } from './model-picker.tsx'

const perCall: PickerModel = {
  id: '00000000-0000-4000-8000-000000000001',
  key: 'fast-chat',
  supportsThinking: false,
  pricing: {
    mode: 'per_call',
    credits: 5,
    multipliers: { quality: { high: 2 } },
    limits: { maxInputTokens: 8000, maxOutputTokens: 2000 },
  },
}
const perToken: PickerModel = {
  id: '00000000-0000-4000-8000-000000000002',
  key: 'smart-chat',
  supportsThinking: false,
  // 每 1k 输入 2 积分、每 1k 输出 10 积分
  pricing: { mode: 'token', inputPer1k: 2, outputPer1k: 10, minCharge: 1 },
}

describe('CreditEstimateText', () => {
  it('按次计费显示确定值，并按参数倍率加权', () => {
    const html = renderToString(<CreditEstimateText model={perCall} inputTokens={1500} />)
    expect(html).toContain('>5 credits</span>')
    const weighted = renderToString(
      <CreditEstimateText model={perCall} inputTokens={0} params={{ quality: 'high' }} />,
    )
    expect(weighted).toContain('>10 credits</span>')
    expect(html).not.toContain('~')
  })

  it('按 token 计费显示「约 X–Y」区间：下限为输入估算 + 0 输出，上限加上最大输出', () => {
    // 输入 1500 token → 3 积分；最大输出 2000 token → 3 + 20 = 23 积分
    const html = renderToString(
      <CreditEstimateText model={perToken} inputTokens={1500} maxOutputTokens={2000} />,
    )
    expect(html).toContain('>~3–23 credits</span>')
  })

  it('按 token 计费的上限按余额压低最大输出', () => {
    // 余额 8：输入 3 积分后只够 500 输出 token → 上限 3 + 5 = 8
    const html = renderToString(
      <CreditEstimateText model={perToken} inputTokens={1500} maxOutputTokens={2000} balance={8} />,
    )
    expect(html).toContain('>~3–8 credits</span>')
  })

  it('未选择模型时不渲染', () => {
    expect(renderToString(<CreditEstimateText model={undefined} inputTokens={0} />)).toBe('')
  })
})

describe('creditEstimate', () => {
  it('按 token 未指定最大输出时使用默认上限，下限不低于 minCharge', () => {
    expect(creditEstimate(perToken.pricing, { inputTokens: 0 })).toEqual({
      kind: 'range',
      min: 1,
      max: Math.ceil((DEFAULT_MAX_OUTPUT_TOKENS * 10) / 1000),
    })
  })

  it('按用量计费显示单价', () => {
    const pricing: Pricing = { mode: 'per_unit', unit: 'image', perUnit: 4 }
    expect(creditEstimate(pricing, { inputTokens: 0 })).toEqual({
      kind: 'per_unit',
      credits: 4,
      unit: 'image',
    })
  })
})

describe('ModelPicker', () => {
  it('只渲染传入的模型（停用与权益不允许的模型已由 listAvailableModels 过滤）', () => {
    const html = renderToString(
      <ModelPicker models={[perCall, perToken]} value={perToken.id} onChange={() => {}} />,
    )
    const options = [...html.matchAll(/<option value="([^"]+)"[^>]*>([^<]+)<\/option>/g)]
    expect(options.map((o) => o[2])).toEqual(['fast-chat', 'smart-chat'])
    expect(html).toMatch(new RegExp(`<option value="${perToken.id}" selected=""`))
  })

  it('没有可用模型时显示提示', () => {
    const html = renderToString(<ModelPicker models={[]} value={undefined} onChange={() => {}} />)
    expect(html).toContain('No models are available')
    expect(html).not.toContain('<select')
  })
})
