import type { DefinedPrompt, PromptSection } from '@product-res/ai'
import { z } from 'zod'
import { SIMPLIFIED_ONLY, TRADITIONAL_ONLY } from './chinese-variant-table.ts'
import type { Sample } from './sample.ts'

/**
 * 确定性检查（design D7）。套件可混用内置检查与项目自定义检查；
 * `severity: 'warn'` 的失败只进报告，不影响退出码。
 */
export type Severity = 'error' | 'warn'

export interface CheckResult {
  readonly pass: boolean
  readonly detail?: string
  readonly severity?: Severity
}

export interface CheckContext {
  readonly output: string
  readonly sample: Sample
  // biome-ignore lint/suspicious/noExplicitAny: 检查对任意输入类型的提示词通用
  readonly prompt: DefinedPrompt<any>
  /** 该样本 `expect[check.id]`，没有时为 undefined */
  readonly expect: Readonly<Record<string, unknown>> | undefined
}

export interface Check {
  readonly id: string
  /** 缺省 'error'；样本的 `expect[id].severity` 与结果中的 severity 依次覆盖 */
  readonly severity?: Severity
  /** 校验样本 `expect[id]`；加载套件时执行，不合法即配置错误 */
  readonly expectSchema?: z.ZodType
  run(ctx: CheckContext): CheckResult | Promise<CheckResult>
}

export interface CheckOutcome {
  readonly id: string
  readonly pass: boolean
  readonly severity: Severity
  readonly detail?: string
}

export async function runChecks(
  checks: readonly Check[],
  ctx: Omit<CheckContext, 'expect'>,
): Promise<CheckOutcome[]> {
  const outcomes: CheckOutcome[] = []
  for (const check of checks) {
    const expect = ctx.sample.expect?.[check.id]
    let result: CheckResult
    try {
      result = await check.run({ ...ctx, expect })
    } catch (error) {
      result = {
        pass: false,
        detail: `check threw: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    const severity =
      result.severity ?? (expect?.severity as Severity | undefined) ?? check.severity ?? 'error'
    outcomes.push({
      id: check.id,
      pass: result.pass,
      severity,
      ...(result.detail ? { detail: result.detail } : {}),
    })
  }
  return outcomes
}

const severitySchema = z.enum(['error', 'warn']).optional()

/** 按码点计数：一个 emoji 计 1 */
export const codePointLength = (text: string) => {
  let count = 0
  for (const _ of text) count++
  return count
}

/** 命中位置附近的片段，便于在报告中定位 */
export function snippet(text: string, index: number, length: number, radius = 12): string {
  const chars = [...text.slice(0, index)]
  const before = chars.slice(-radius).join('')
  const match = text.slice(index, index + length)
  const after = [...text.slice(index + length)].slice(0, radius).join('')
  return `…${before}[${match}]${after}…`.replace(/\s+/g, ' ')
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/

interface FoundSection {
  readonly line: number
  readonly level: number | undefined
}

function findSection(lines: readonly string[], section: PromptSection): FoundSection | undefined {
  for (const [line, text] of lines.entries()) {
    const heading = HEADING.exec(text.trim())
    if (typeof section.heading === 'string') {
      if (heading && heading[2] === section.heading.trim())
        return { line, level: heading[1]?.length }
    } else {
      const pattern = new RegExp(section.heading.source, section.heading.flags.replace(/[gy]/g, ''))
      if (pattern.test(text.trim())) return { line, level: heading?.[1]?.length }
    }
  }
  return undefined
}

/** 章节正文：标题之后到下一个同级或更高级标题之前（正则标题无级别时到下一个任意标题） */
export function sectionText(output: string, section: PromptSection): string | undefined {
  const lines = output.split(/\r?\n/)
  const found = findSection(lines, section)
  if (!found) return undefined
  const body: string[] = []
  for (const text of lines.slice(found.line + 1)) {
    const heading = HEADING.exec(text.trim())
    if (heading && (found.level === undefined || (heading[1]?.length ?? 7) <= found.level)) break
    body.push(text)
  }
  return body.join('\n').trim()
}

function merge<T extends object>(
  options: T,
  expect: Readonly<Record<string, unknown>> | undefined,
) {
  return { ...options, ...(expect ?? {}) } as T
}

const sectionsExpect = z.looseObject({ ordered: z.boolean().optional(), severity: severitySchema })

/** 期望章节齐全（按提示词定义的 `sections`），可要求顺序 */
export function sections(
  options: { id?: string; ordered?: boolean; severity?: Severity } = {},
): Check {
  return {
    id: options.id ?? 'sections',
    ...(options.severity ? { severity: options.severity } : {}),
    expectSchema: sectionsExpect,
    run({ output, prompt, expect }) {
      const { ordered } = merge({ ordered: options.ordered ?? false }, expect)
      const lines = output.split(/\r?\n/)
      const expected = (prompt.sections ?? []) as readonly PromptSection[]
      const missing: string[] = []
      const positions: { id: string; line: number }[] = []
      for (const section of expected) {
        const found = findSection(lines, section)
        if (found) positions.push({ id: section.id, line: found.line })
        else if (section.required !== false) missing.push(section.id)
      }
      if (missing.length) return { pass: false, detail: `missing sections: ${missing.join(', ')}` }
      if (ordered)
        for (let i = 1; i < positions.length; i++) {
          const previous = positions[i - 1]
          const current = positions[i]
          if (previous && current && current.line < previous.line)
            return {
              pass: false,
              detail: `section order: ${current.id} appears before ${previous.id}`,
            }
        }
      return { pass: true }
    },
  }
}

const lengthExpect = z.looseObject({
  min: z.number().int().nonnegative().optional(),
  max: z.number().int().positive().optional(),
  section: z.string().optional(),
  severity: severitySchema,
})

/** 字符数区间（按码点）；`section` 为提示词章节 ID 时只计该章节正文 */
export function length(options: {
  id?: string
  min?: number
  max?: number
  section?: string
  severity?: Severity
}): Check {
  return {
    id: options.id ?? 'length',
    ...(options.severity ? { severity: options.severity } : {}),
    expectSchema: lengthExpect,
    run({ output, prompt, expect }) {
      const params = merge({ min: options.min, max: options.max, section: options.section }, expect)
      let text = output.trim()
      if (params.section) {
        const section = prompt.sections?.find((item) => item.id === params.section)
        if (!section) return { pass: false, detail: `prompt has no section ${params.section}` }
        const body = sectionText(output, section)
        if (body === undefined) return { pass: false, detail: `section ${params.section} missing` }
        text = body
      }
      const count = codePointLength(text)
      const where = params.section ? `section ${params.section}` : 'output'
      if (params.min !== undefined && count < params.min)
        return { pass: false, detail: `${where} has ${count} chars, below ${params.min}` }
      if (params.max !== undefined && count > params.max)
        return { pass: false, detail: `${where} has ${count} chars, above ${params.max}` }
      return { pass: true, detail: `${where} has ${count} chars` }
    },
  }
}

const bannedExpect = z.looseObject({
  words: z.array(z.string().min(1)).optional(),
  patterns: z.array(z.string().min(1)).optional(),
  severity: severitySchema,
})

/** 禁用词（大小写不敏感）与正则；样本 `expect` 中的词与正则追加到套件列表 */
export function banned(options: {
  id?: string
  words?: readonly string[]
  patterns?: readonly (string | RegExp)[]
  severity?: Severity
}): Check {
  return {
    id: options.id ?? 'banned',
    ...(options.severity ? { severity: options.severity } : {}),
    expectSchema: bannedExpect,
    run({ output, expect }) {
      const extra = bannedExpect.parse(expect ?? {})
      const hits: string[] = []
      const lower = output.toLowerCase()
      for (const word of [...(options.words ?? []), ...(extra.words ?? [])]) {
        const index = lower.indexOf(word.toLowerCase())
        if (index >= 0) hits.push(`"${word}" ${snippet(output, index, word.length)}`)
      }
      for (const pattern of [...(options.patterns ?? []), ...(extra.patterns ?? [])]) {
        const regex =
          typeof pattern === 'string'
            ? new RegExp(pattern, 'u')
            : new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''))
        const match = regex.exec(output)
        if (match) hits.push(`/${regex.source}/ ${snippet(output, match.index, match[0].length)}`)
      }
      return hits.length ? { pass: false, detail: hits.join('; ') } : { pass: true }
    },
  }
}

export type ScriptLang = 'zh' | 'zh-Hans' | 'zh-Hant' | 'en' | 'ja' | 'ko'
const SCRIPT_LANGS = ['zh', 'zh-Hans', 'zh-Hant', 'en', 'ja', 'ko'] as const

const SCRIPTS = {
  han: /\p{Script=Han}/u,
  latin: /\p{Script=Latin}/u,
  kana: /[\p{Script=Hiragana}\p{Script=Katakana}]/u,
  hangul: /\p{Script=Hangul}/u,
} as const
type ScriptName = keyof typeof SCRIPTS

const LANG_SCRIPTS: Record<ScriptLang, readonly ScriptName[]> = {
  zh: ['han'],
  'zh-Hans': ['han'],
  'zh-Hant': ['han'],
  en: ['latin'],
  ja: ['han', 'kana'],
  ko: ['hangul'],
}

/** 统计汉字、拉丁、假名、谚文的字符数（其他字符如数字、标点不计） */
export function scriptCounts(text: string): Record<ScriptName, number> {
  const counts: Record<ScriptName, number> = { han: 0, latin: 0, kana: 0, hangul: 0 }
  for (const char of text)
    for (const name of Object.keys(SCRIPTS) as ScriptName[])
      if (SCRIPTS[name].test(char)) {
        counts[name]++
        break
      }
  return counts
}

const scriptExpect = z.looseObject({
  lang: z.enum(SCRIPT_LANGS).optional(),
  minRatio: z.number().min(0).max(1).optional(),
  severity: severitySchema,
})

/**
 * 期望语言的文字占比：如 `zh-Hans` 要求汉字占比 ≥ minRatio（缺省 0.6），`en` 要求拉丁字母占比。
 * 套件与样本都没有给出 `lang` 时跳过（通过）。
 */
export function script(
  options: { id?: string; lang?: ScriptLang; minRatio?: number; severity?: Severity } = {},
): Check {
  return {
    id: options.id ?? 'script',
    ...(options.severity ? { severity: options.severity } : {}),
    expectSchema: scriptExpect,
    run({ output, expect }) {
      const params = merge({ lang: options.lang, minRatio: options.minRatio ?? 0.6 }, expect)
      if (!params.lang) return { pass: true, detail: 'no lang expected; skipped' }
      const counts = scriptCounts(output)
      const total = Object.values(counts).reduce((sum, value) => sum + value, 0)
      if (total === 0) return { pass: false, detail: 'output has no letters' }
      const matched = LANG_SCRIPTS[params.lang].reduce((sum, name) => sum + counts[name], 0)
      const ratio = matched / total
      const detail = `${params.lang} ratio ${ratio.toFixed(2)} (min ${params.minRatio})`
      return { pass: ratio >= params.minRatio, detail }
    },
  }
}

const TRADITIONAL_SET = new Set(TRADITIONAL_ONLY)
const SIMPLIFIED_SET = new Set(SIMPLIFIED_ONLY)

const variantExpect = z.looseObject({
  variant: z.enum(['zh-Hans', 'zh-Hant']).optional(),
  maxCount: z.number().int().nonnegative().optional(),
  severity: severitySchema,
})

/**
 * 简繁误用：`zh-Hans` 输出中「仅繁体」常用字数超过 maxCount（缺省 0）即失败，`zh-Hant` 反之。
 * 没有给出 `variant` 时沿用样本 `expect.script.lang`；都不是 zh-Hans / zh-Hant 时跳过。
 */
export function chineseVariant(
  options: {
    id?: string
    variant?: 'zh-Hans' | 'zh-Hant'
    maxCount?: number
    severity?: Severity
  } = {},
): Check {
  return {
    id: options.id ?? 'chinese-variant',
    ...(options.severity ? { severity: options.severity } : {}),
    expectSchema: variantExpect,
    run({ output, sample, expect }) {
      const params = merge({ variant: options.variant, maxCount: options.maxCount ?? 0 }, expect)
      const lang = sample.expect?.script?.lang
      const variant =
        params.variant ?? (lang === 'zh-Hans' || lang === 'zh-Hant' ? lang : undefined)
      if (!variant) return { pass: true, detail: 'no Chinese variant expected; skipped' }
      const wrong = variant === 'zh-Hans' ? TRADITIONAL_SET : SIMPLIFIED_SET
      const hits = new Map<string, number>()
      let count = 0
      let index = 0
      for (const char of output) {
        if (wrong.has(char)) {
          count++
          if (!hits.has(char)) hits.set(char, index)
        }
        index += char.length
      }
      if (count <= params.maxCount) return { pass: true }
      const label = variant === 'zh-Hans' ? 'traditional-only' : 'simplified-only'
      const listed = [...hits]
        .slice(0, 10)
        .map(([char, at]) => `${char} ${snippet(output, at, char.length)}`)
      return {
        pass: false,
        detail: `${count} ${label} chars in ${variant} output: ${listed.join('; ')}`,
      }
    },
  }
}

/** 内置检查的工厂集合，套件中以 `checks.sections()` 等方式组合 */
export const checks = { sections, length, banned, script, chineseVariant }
