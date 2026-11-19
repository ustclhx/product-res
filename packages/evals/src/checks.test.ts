import { definePrompt } from '@product-res/ai'
import { describe, expect, it } from 'vitest'
import {
  banned,
  type Check,
  chineseVariant,
  codePointLength,
  length,
  runChecks,
  script,
  sections,
  sectionText,
} from './checks.ts'
import { SIMPLIFIED_ONLY, TRADITIONAL_ONLY } from './chinese-variant-table.ts'
import type { Sample } from './sample.ts'

const prompt = definePrompt<unknown>({
  id: 'intro',
  version: 'v1',
  system: 's',
  user: () => 'u',
  maxOutputTokens: 100,
  sections: [
    { id: 'overview', heading: '概述' },
    { id: 'advice', heading: '建议' },
    { id: 'extra', heading: /^#+\s*Extra/i, required: false },
  ],
})
const sample = (expect?: Sample['expect']): Sample => ({
  id: 's1',
  input: {},
  ...(expect ? { expect } : {}),
})
const run = (check: Check, output: string, expect?: Sample['expect']) =>
  runChecks([check], { output, sample: sample(expect), prompt }).then((outcomes) => outcomes[0])

describe('章节', () => {
  it('缺少章节时列出缺失项', async () => {
    const result = await run(sections(), '## 概述\n内容')
    expect(result).toMatchObject({ pass: false, severity: 'error' })
    expect(result?.detail).toContain('advice')
  })

  it('要求顺序时检测顺序错误，可选章节缺失不失败', async () => {
    const output = '## 建议\n多喝水\n\n## 概述\n总体不错'
    expect((await run(sections(), output))?.pass).toBe(true)
    const ordered = await run(sections({ ordered: true }), output)
    expect(ordered).toMatchObject({ pass: false })
    expect(ordered?.detail).toMatch(/order/)
    // 样本 expect 覆盖套件参数
    expect(
      (await run(sections({ ordered: true }), output, { sections: { ordered: false } }))?.pass,
    ).toBe(true)
  })

  it('章节正文到下一个同级或更高级标题为止', () => {
    const output = '# 概述\n第一段\n### 细节\n更多\n# 建议\n结束'
    expect(sectionText(output, { id: 'overview', heading: '概述' })).toBe('第一段\n### 细节\n更多')
  })
})

describe('长度', () => {
  it('按码点计数，emoji 计 1', async () => {
    expect(codePointLength('ab👋你')).toBe(4)
    expect((await run(length({ max: 4 }), 'ab👋你'))?.pass).toBe(true)
    expect((await run(length({ max: 3 }), 'ab👋你'))?.pass).toBe(false)
  })

  it('可只计某个章节的正文，样本可覆盖区间与严重级别', async () => {
    const output = '## 概述\n12345\n## 建议\n1234567890'
    expect((await run(length({ section: 'overview', min: 5, max: 5 }), output))?.pass).toBe(true)
    expect((await run(length({ section: 'advice', max: 5 }), output))?.pass).toBe(false)
    const warned = await run(length({ max: 5 }), output, { length: { severity: 'warn' } })
    expect(warned).toMatchObject({ pass: false, severity: 'warn' })
  })
})

describe('禁用词与正则', () => {
  it('大小写不敏感，报告命中附近片段；样本可追加', async () => {
    const result = await run(
      banned({ words: ['guarantee'], patterns: [/\d{3}-\d{4}/] }),
      'We GUARANTEE results. Call 555-1234 now.',
    )
    expect(result?.pass).toBe(false)
    expect(result?.detail).toContain('[GUARANTEE]')
    expect(result?.detail).toContain('[555-1234]')
    const extra = await run(banned({}), 'best ever', { banned: { words: ['best'] } })
    expect(extra?.pass).toBe(false)
  })
})

describe('文字与简繁', () => {
  it('英文输出被判为非 zh-Hans', async () => {
    const result = await run(script({ lang: 'zh-Hans' }), 'This is an English answer.')
    expect(result?.pass).toBe(false)
    expect((await run(script({ lang: 'en' }), 'This is an English answer.'))?.pass).toBe(true)
    expect((await run(script(), 'whatever'))?.pass).toBe(true)
  })

  it('简体中混入「這們」失败并列出片段，繁体中混入「们说」失败', async () => {
    const hans = await run(
      chineseVariant({ variant: 'zh-Hans' }),
      '这是我们的产品，這些人們都喜欢。',
    )
    expect(hans?.pass).toBe(false)
    expect(hans?.detail).toContain('這')
    expect(hans?.detail).toContain('們')
    expect(hans?.detail).toMatch(/\[這\]/)
    const hant = await run(
      chineseVariant({ variant: 'zh-Hant' }),
      '這是我們的產品，这些人们都说喜歡。',
    )
    expect(hant?.pass).toBe(false)
    expect(hant?.detail).toContain('们')
    expect(hant?.detail).toContain('说')
    expect(hant?.detail).toMatch(/^2 simplified-only chars/)
    expect((await run(chineseVariant({ variant: 'zh-Hans' }), '这是我们的产品。'))?.pass).toBe(true)
    // 未指定 variant 时沿用样本 expect.script.lang
    const fromLang = await run(chineseVariant(), '這個', { script: { lang: 'zh-Hans' } })
    expect(fromLang?.pass).toBe(false)
  })

  it('字表约 500 字，且没有简繁同形字', () => {
    const traditional = new Set(TRADITIONAL_ONLY)
    const simplified = new Set(SIMPLIFIED_ONLY)
    expect(traditional.size).toBeGreaterThanOrEqual(450)
    expect(simplified.size).toBeGreaterThanOrEqual(300)
    for (const char of traditional) expect(simplified.has(char)).toBe(false)
    for (const char of simplified) expect(traditional.has(char)).toBe(false)
    for (const char of '這們來會說時個過還發麼餘') expect(traditional.has(char)).toBe(true)
    for (const char of '们来说发') expect(simplified.has(char)).toBe(true)
    // 繁体文本中同样合法的字（简繁同形、Big5 收录）不进「仅简体」，「於」在通用规范汉字表中，不进「仅繁体」
    for (const char of '里斗丑于余涂云咸仆丰据筑叶冲适并极术这会个后')
      expect(simplified.has(char), char).toBe(false)
    expect(traditional.has('於')).toBe(false)
  })

  it('繁体文本中的简繁同形字不误报', async () => {
    for (const text of ['距離約三公里。', '漏斗與小丑。', '於是我們出發了。', '于是他離開了。'])
      expect((await run(chineseVariant({ variant: 'zh-Hant' }), text))?.pass, text).toBe(true)
  })
})

describe('自定义检查', () => {
  it('返回警告级失败时只进结果，异常记为失败', async () => {
    const custom: Check = {
      id: 'tone',
      run: () => ({ pass: false, severity: 'warn', detail: 'flat' }),
    }
    const broken: Check = {
      id: 'broken',
      run: () => {
        throw new Error('boom')
      },
    }
    const outcomes = await runChecks([custom, broken], { output: 'x', sample: sample(), prompt })
    expect(outcomes).toEqual([
      { id: 'tone', pass: false, severity: 'warn', detail: 'flat' },
      { id: 'broken', pass: false, severity: 'error', detail: 'check threw: boom' },
    ])
  })
})
