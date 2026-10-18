import { keepCitedSuggestions, type NegativeReviewInput } from '@product-res/insight'
import { z } from 'zod'
import type { CitationRef, PainTheme, Suggestion } from './types.ts'

/**
 * 差评痛点归纳与差异化建议（tasks 3.3）的纯逻辑：组装提示词、解析模型输出、校验引用。
 * 评论与竞品在提示词中用短别名（R1 / P1）代替，既省 token，也便于识别模型编造的 ID。
 */

export interface AiPrompt {
  system: string
  user: string
}

/** 文本模型调用；由 ai-runtime.server.ts 实现（经 packages/ai 预扣、结算并写用量），测试注入模拟 */
export interface InsightAi {
  resolve(): Promise<
    | { ok: true; modelKey: string; generate(prompt: AiPrompt): Promise<string> }
    | { ok: false; reason: string }
  >
}

export interface CompetitorInput {
  id: string
  title: string | null
  brand: string | null
  price: number | null
  rating: number | null
  salesMonthly: number | null
}

export interface InsightPrompt {
  prompt: AiPrompt
  aliases: Map<string, CitationRef>
  reviewCount: number
}

const SYSTEM = [
  '你是跨境电商品牌选品分析师。只依据用户给出的差评与竞品信息作答，不要编造数据。',
  '只输出一个 JSON 对象，不要输出解释或 Markdown 代码块，格式：',
  '{"themes":[{"label":"痛点主题（中文，不超过 8 个字）","reviewIds":["R1"]}],',
  '"suggestions":[{"title":"改良方向（中文，不超过 16 个字）","detail":"一句话说明怎么改、解决哪个痛点","citations":["R1","P1"]}]}',
  '要求：themes 3–8 个，每条差评最多归入一个主题；suggestions 3–5 条，',
  '每条 citations 至少引用一条差评（R 开头）或竞品（P 开头），只能使用给出的 ID。',
].join('\n')

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

export function buildInsightPrompt(
  reviews: readonly NegativeReviewInput[],
  competitors: readonly CompetitorInput[],
): InsightPrompt {
  const aliases = new Map<string, CitationRef>()
  const reviewLines = reviews.map((r, i) => {
    const alias = `R${i + 1}`
    aliases.set(alias, { kind: 'review', id: r.id })
    return `${alias} [${r.rating}星] ${oneLine(r.title)} | ${oneLine(r.body)}`
  })
  const productLines = competitors.map((p, i) => {
    const alias = `P${i + 1}`
    aliases.set(alias, { kind: 'product', id: p.id })
    const facts = [
      p.brand ? `品牌 ${p.brand}` : null,
      p.price !== null ? `价格 ${p.price}` : null,
      p.rating !== null ? `评分 ${p.rating}` : null,
      p.salesMonthly !== null ? `月销量估算 ${Math.round(p.salesMonthly)}` : null,
    ].filter(Boolean)
    return `${alias} ${oneLine(p.title ?? '（无标题）')}${facts.length ? ` | ${facts.join('，')}` : ''}`
  })
  return {
    prompt: {
      system: SYSTEM,
      user: `差评（评分 ≤ 3）：\n${reviewLines.join('\n')}\n\n头部竞品（标题即卖点）：\n${productLines.join('\n') || '（无）'}`,
    },
    aliases,
    reviewCount: reviews.length,
  }
}

const outputSchema = z.object({
  themes: z
    .array(z.object({ label: z.string().min(1).max(60), reviewIds: z.array(z.string()) }))
    .max(20)
    .default([]),
  suggestions: z
    .array(
      z.object({
        title: z.string().min(1).max(120),
        detail: z.string().max(600).default(''),
        citations: z.array(z.string()).default([]),
      }),
    )
    .max(20)
    .default([]),
})

export class InsightOutputError extends Error {}

/** 取出模型回复中的 JSON 对象：容忍代码块包裹和前后多余文字 */
function extractJson(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new InsightOutputError('AI 返回的不是 JSON')
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    throw new InsightOutputError('AI 返回的 JSON 无法解析')
  }
}

export interface ParsedInsight {
  themes: PainTheme[]
  suggestions: Suggestion[]
  /** 因没有有效引用被丢弃的建议数 */
  dropped: number
}

/**
 * 解析并校验：主题只保留给出的差评 ID，占比按差评数计算（不采信模型自报的比例）；
 * 建议经 keepCitedSuggestions 丢弃没有任何有效引用的条目，引用映射回真实 ID。
 */
export function parseInsightOutput(text: string, input: InsightPrompt): ParsedInsight {
  const parsed = outputSchema.safeParse(extractJson(text))
  if (!parsed.success) throw new InsightOutputError('AI 返回的结构不符合要求')
  const reviewAliases = new Set(
    [...input.aliases].filter(([, ref]) => ref.kind === 'review').map(([alias]) => alias),
  )
  const assigned = new Set<string>()
  const themes: PainTheme[] = []
  for (const t of parsed.data.themes) {
    // 每条差评只计入第一个主题，避免占比合计超过 100%
    const ids = [...new Set(t.reviewIds.map((id) => id.trim().toUpperCase()))].filter(
      (id) => reviewAliases.has(id) && !assigned.has(id),
    )
    if (ids.length === 0) continue
    for (const id of ids) assigned.add(id)
    themes.push({
      label: t.label.trim(),
      reviewCount: ids.length,
      share: input.reviewCount > 0 ? ids.length / input.reviewCount : 0,
      reviewIds: ids.slice(0, 3).map((id) => input.aliases.get(id)?.id as string),
    })
  }
  themes.sort((a, b) => b.reviewCount - a.reviewCount)

  const normalized = parsed.data.suggestions.map((s) => ({
    ...s,
    citations: s.citations.map((c) => c.trim().toUpperCase()),
  }))
  const { kept, dropped } = keepCitedSuggestions(normalized, new Set(input.aliases.keys()))
  const suggestions = kept.slice(0, 5).map((s) => ({
    title: s.title.trim(),
    detail: s.detail.trim(),
    citations: s.citations.map((alias) => input.aliases.get(alias) as CitationRef),
  }))
  return { themes: themes.slice(0, 8), suggestions, dropped: dropped.length }
}

/** 输入指纹：同一批差评与竞品（按 ID）得到同一指纹，刷新时据此沿用上一份 AI 结果 */
export async function insightFingerprint(
  reviewIds: readonly string[],
  productIds: readonly string[],
): Promise<string> {
  const text = `${[...reviewIds].sort().join(',')}|${[...productIds].sort().join(',')}`
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
