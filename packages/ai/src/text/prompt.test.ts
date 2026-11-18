import { describe, expect, it } from 'vitest'
import {
  definePrompt,
  promptCanonicalJson,
  promptSha256,
  renderedPromptDigest,
  renderPrompt,
} from './prompt.ts'

const base = {
  id: 'report',
  version: 'v3',
  system: 'You write reports.',
  user: (input: { topic: string }) => `Topic: ${input.topic}`,
  maxOutputTokens: 800,
}

describe('definePrompt', () => {
  it('拒绝非法 id 与版本', () => {
    for (const id of ['Report', 'report_v', '-report', 'report-', '', 'a b'])
      expect(() => definePrompt({ ...base, id })).toThrow(/Invalid prompt id/)
    for (const version of ['', ' ', 'v/1', 'v@1', '.v1'])
      expect(() => definePrompt({ ...base, version })).toThrow(/Invalid prompt version/)
    expect(() => definePrompt({ ...base, maxOutputTokens: 0 })).toThrow(/maxOutputTokens/)
  })

  it('附加 <id>@<version> 并冻结定义', () => {
    const prompt = definePrompt({ ...base, sections: [{ id: 'a', heading: 'A' }] })
    expect(prompt.promptVersion).toBe('report@v3')
    expect(Object.isFrozen(prompt)).toBe(true)
    expect(Object.isFrozen(prompt.sections)).toBe(true)
  })
})

describe('renderPrompt', () => {
  it('支持字符串与函数式 system', () => {
    expect(renderPrompt(definePrompt(base), { topic: 'x' })).toEqual({
      system: 'You write reports.',
      user: 'Topic: x',
      params: {},
      maxOutputTokens: 800,
      sections: [],
    })
    const fn = definePrompt({
      ...base,
      system: (input: { topic: string }) => `About ${input.topic}`,
    })
    expect(renderPrompt(fn, { topic: 'y' }).system).toBe('About y')
  })
})

describe('渲染摘要', () => {
  it('相同输入摘要稳定，键顺序不影响摘要', async () => {
    const prompt = definePrompt({ ...base, params: { temperature: 0.2, topP: 0.9 } })
    const a = await renderedPromptDigest(renderPrompt(prompt, { topic: 'x' }))
    const b = await renderedPromptDigest(renderPrompt(prompt, { topic: 'x' }))
    expect(a).toBe(b)
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/)
    const reordered = await renderedPromptDigest({
      maxOutputTokens: 800,
      params: { topP: 0.9, temperature: 0.2 },
      user: 'Topic: x',
      system: 'You write reports.',
      sections: [],
    })
    expect(reordered).toBe(a)
    expect(promptCanonicalJson({ b: 1, a: { d: undefined, c: [2, 1] } })).toBe(
      '{"a":{"c":[2,1]},"b":1}',
    )
  })

  it('期望章节变化会改变摘要', async () => {
    const plain = await renderedPromptDigest(renderPrompt(definePrompt(base), { topic: 'x' }))
    const withSection = definePrompt({ ...base, sections: [{ id: 'a', heading: /^## A$/i }] })
    const rendered = renderPrompt(withSection, { topic: 'x' })
    expect(rendered.sections).toEqual([
      { id: 'a', heading: '/^## A$/i', regex: true, required: true },
    ])
    expect(await renderedPromptDigest(rendered)).not.toBe(plain)
  })

  it('params 或输入变化会改变摘要', async () => {
    const plain = await renderedPromptDigest(renderPrompt(definePrompt(base), { topic: 'x' }))
    const warm = await renderedPromptDigest(
      renderPrompt(definePrompt({ ...base, params: { temperature: 0.7 } }), { topic: 'x' }),
    )
    const other = await renderedPromptDigest(renderPrompt(definePrompt(base), { topic: 'z' }))
    expect(warm).not.toBe(plain)
    expect(other).not.toBe(plain)
  })

  it('promptSha256 与标准值一致', async () => {
    expect(await promptSha256('abc')).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})
