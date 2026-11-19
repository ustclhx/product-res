import type { Pricing } from '@product-res/ai'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { m } from '../../paraglide/messages.js'
import {
  creditEstimate,
  DEFAULT_MAX_OUTPUT_TOKENS,
  formatEstimate,
  type PickerModel,
} from './model-picker.ts'
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
    expect(html).toContain(`>${formatEstimate({ kind: 'exact', credits: 5 })}</span>`)
    const weighted = renderToString(
      <CreditEstimateText model={perCall} inputTokens={0} params={{ quality: 'high' }} />,
    )
    expect(weighted).toContain(`>${formatEstimate({ kind: 'exact', credits: 10 })}</span>`)
    expect(html).not.toContain('~')
  })

  it('按 token 计费显示「约 X–Y」区间：下限为输入估算 + 0 输出，上限加上最大输出', () => {
    // 输入 1500 token → 3 积分；最大输出 2000 token → 3 + 20 = 23 积分
    const html = renderToString(
      <CreditEstimateText model={perToken} inputTokens={1500} maxOutputTokens={2000} />,
    )
    expect(html).toContain(`>${formatEstimate({ kind: 'range', min: 3, max: 23 })}</span>`)
  })

  it('按 token 计费的上限按余额压低最大输出', () => {
    // 余额 8：输入 3 积分后只够 500 输出 token → 上限 3 + 5 = 8
    const html = renderToString(
      <CreditEstimateText model={perToken} inputTokens={1500} maxOutputTokens={2000} balance={8} />,
    )
    expect(html).toContain(`>${formatEstimate({ kind: 'range', min: 3, max: 8 })}</span>`)
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
  it('SSR 触发器显示当前可用模型，与可访问标签关联', () => {
    const html = renderToString(
      <ModelPicker models={[perCall, perToken]} value={perToken.id} onChange={() => {}} />,
    )
    expect(html).toContain('role="combobox"')
    expect(html).toMatch(/for="([^"]+)"[\s\S]*id="\1"/)
    expect(html).toContain('smart-chat')
    expect(html).not.toContain('fast-chat')
    expect(html).toMatch(/^<div data-model-picker="">/)
  })

  it('未指定模型时显示第一项，已下架的选值显示占位文字', () => {
    const render = (value: string | undefined) =>
      renderToString(<ModelPicker models={[perCall]} value={value} onChange={() => {}} />)
    expect(render(undefined)).toContain('fast-chat')
    const unavailable = render('removed-model')
    expect(unavailable).toContain('data-placeholder=""')
    expect(unavailable).not.toContain('fast-chat')
  })

  it('没有可用模型时显示提示', () => {
    const html = renderToString(<ModelPicker models={[]} value={undefined} onChange={() => {}} />)
    expect(html).toContain(m.chat_ui_model_empty())
    expect(html).not.toContain('role="combobox"')
  })
})
