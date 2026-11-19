import { definePrompt } from '@product-res/ai'

/**
 * 示例提示词：中性的「产品简介撰写」。真实项目中提示词定义放在生产代码里
 * （如 `apps/web/src/features/<功能>/prompt.ts`），评测套件导入同一个定义。
 * 已发布的版本内容不可再改：改动请新建版本（如 v3），评测会对比渲染摘要。
 */
export interface ProductIntroInput {
  readonly product: string
  readonly audience: string
  readonly features: readonly string[]
  /** 输出语言：zh-Hans 或 en */
  readonly lang: 'zh-Hans' | 'en'
}

const LANGUAGE = { 'zh-Hans': 'Simplified Chinese', en: 'English' } as const

const facts = (input: ProductIntroInput) =>
  [
    `Product: ${input.product}`,
    `Audience: ${input.audience}`,
    'Key features:',
    ...input.features.map((feature) => `- ${feature}`),
    `Write in: ${LANGUAGE[input.lang]}`,
  ].join('\n')

export const productIntroV1 = definePrompt<ProductIntroInput>({
  id: 'product-intro',
  version: 'v1',
  system: [
    'You write short product introductions for an online catalog.',
    'Use two Markdown level-2 headings: "Overview" and "Highlights"',
    '(in Simplified Chinese: "概述" and "亮点").',
  ].join('\n'),
  user: facts,
  sections: [
    { id: 'overview', heading: /^##\s*(?:Overview|概述)\s*$/ },
    { id: 'highlights', heading: /^##\s*(?:Highlights|亮点)\s*$/ },
  ],
  maxOutputTokens: 500,
})

export const productIntroV2 = definePrompt<ProductIntroInput>({
  id: 'product-intro',
  version: 'v2',
  system: [
    'You write short, accurate product introductions for an online catalog.',
    'Only describe the features you are given; never invent specifications, prices or awards.',
    'Avoid superlatives and promises. Keep the whole text under 200 words.',
    'Use three Markdown level-2 headings in this order: "Overview", "Highlights", "Who it is for"',
    '(in Simplified Chinese: "概述", "亮点", "适合人群").',
  ].join('\n'),
  user: facts,
  sections: [
    { id: 'overview', heading: /^##\s*(?:Overview|概述)\s*$/ },
    { id: 'highlights', heading: /^##\s*(?:Highlights|亮点)\s*$/ },
    { id: 'audience', heading: /^##\s*(?:Who it is for|适合人群)\s*$/ },
  ],
  maxOutputTokens: 600,
  params: { temperature: 0.3 },
})
