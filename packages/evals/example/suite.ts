import { checks, defineSuite, z } from '../src/index.ts'
import { productIntroV1, productIntroV2 } from './prompts.ts'

/**
 * 模板示例套件（`pnpm eval:prompts --suite example`）。项目套件放在根目录
 * `evals/<suite>/suite.ts`，从 `@product-res/evals` 导入 `defineSuite` 与 `checks`。
 * 单价按公开价格保守填写（美元 / 百万 token），真实或录制模式前请按服务商当前价格核对。
 */
export default defineSuite({
  name: 'example',
  prompts: [productIntroV1, productIntroV2],
  inputSchema: z.strictObject({
    product: z.string().min(1),
    audience: z.string().min(1),
    features: z.array(z.string().min(1)).min(1),
    lang: z.enum(['zh-Hans', 'en']),
  }),
  defaultPrompt: 'product-intro@v2',
  models: {
    'deepseek-chat': {
      provider: 'deepseek',
      providerModelId: 'deepseek-chat',
      priceUsd: { inputPerMTok: 0.6, outputPerMTok: 2.2 },
      thinking: false,
    },
  },
  generator: 'deepseek-chat',
  judge: {
    model: 'deepseek-chat',
    rubric: {
      version: 'r1',
      instructions: 'Penalise any claim that is not supported by the listed features.',
      criteria: [
        {
          id: 'accuracy',
          description: 'Describes only the given features, without invented facts.',
          weight: 2,
        },
        { id: 'clarity', description: 'Clear, concise and easy to scan.', weight: 1 },
        {
          id: 'audience-fit',
          description: 'Speaks to the stated audience and their needs.',
          weight: 1,
        },
      ],
      scale: { min: 1, max: 5 },
    },
  },
  checks: [
    checks.sections({ ordered: true }),
    checks.length({ min: 60, max: 1500 }),
    checks.banned({
      words: ['guarantee', 'best in the world', '保证', '最好的'],
      patterns: [/\b1\d{10}\b/],
    }),
    checks.script(),
    checks.chineseVariant(),
  ],
  regressionThreshold: 0.05,
})
