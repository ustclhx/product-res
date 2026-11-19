/**
 * 版本化提示词的定义（docs/06-ai.md「提示词版本与评测」，specs/prompt-evals）。
 *
 * 生产代码与评测套件导入同一个定义，评测测的就是线上用的提示词。定义模块应保持纯函数
 * （不导入数据库或 app 别名），评测命令行才能直接加载。版本不可变：内容一改就新建版本，
 * 评测按「每个样本的渲染结果摘要」发现同一版本内容被改动（不对函数源码做摘要，
 * 否则会漏掉被导入的辅助函数的改动）。
 */

/** 期望章节：字符串按整行匹配 Markdown 标题，正则用于自定义匹配 */
export interface PromptSection {
  readonly id: string
  readonly heading: string | RegExp
  /** 缺省为 true；false 时缺失只作提示 */
  readonly required?: boolean
}

export interface PromptParams {
  readonly temperature?: number
  readonly topP?: number
}

export interface PromptDefinition<I> {
  /** 小写字母、数字与短横线，如 `report` */
  readonly id: string
  /** 如 `v4`；同一 id 下唯一，发布后内容不可再改 */
  readonly version: string
  readonly system: string | ((input: I) => string)
  readonly user: (input: I) => string
  readonly sections?: readonly PromptSection[]
  readonly maxOutputTokens: number
  readonly params?: PromptParams
}

export type DefinedPrompt<I> = Readonly<PromptDefinition<I>> & {
  /** `<id>@<version>`，生成记录与日志保存此值 */
  readonly promptVersion: string
}

/** 期望章节的可序列化形式：正则写成 `/source/flags`，进入渲染摘要 */
export interface RenderedSection {
  readonly id: string
  readonly heading: string
  readonly regex: boolean
  readonly required: boolean
}

export interface RenderedPrompt {
  readonly system: string
  readonly user: string
  readonly params: PromptParams
  readonly maxOutputTokens: number
  /** 期望章节也影响评测结果（检查与评委），改章节同样要新建版本 */
  readonly sections: readonly RenderedSection[]
}

const PROMPT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
// 版本会出现在录制路径中，只允许不含路径分隔符与 `@` 的短标识。
const PROMPT_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function definePrompt<I>(def: PromptDefinition<I>): DefinedPrompt<I> {
  if (!PROMPT_ID.test(def.id))
    throw new TypeError(`Invalid prompt id "${def.id}": use lowercase letters, digits and dashes`)
  if (!PROMPT_VERSION.test(def.version))
    throw new TypeError(
      `Invalid prompt version "${def.version}" for ${def.id}: use letters, digits, ".", "_" or "-"`,
    )
  if (!Number.isInteger(def.maxOutputTokens) || def.maxOutputTokens <= 0)
    throw new TypeError(`maxOutputTokens of ${def.id}@${def.version} must be a positive integer`)
  return Object.freeze({
    ...def,
    ...(def.sections ? { sections: Object.freeze([...def.sections]) } : {}),
    ...(def.params ? { params: Object.freeze({ ...def.params }) } : {}),
    promptVersion: `${def.id}@${def.version}`,
  })
}

export function renderPrompt<I>(def: PromptDefinition<I>, input: I): RenderedPrompt {
  const params: { temperature?: number; topP?: number } = {}
  if (def.params?.temperature !== undefined) params.temperature = def.params.temperature
  if (def.params?.topP !== undefined) params.topP = def.params.topP
  return {
    system: typeof def.system === 'function' ? def.system(input) : def.system,
    user: def.user(input),
    params,
    maxOutputTokens: def.maxOutputTokens,
    sections: (def.sections ?? []).map((section) => ({
      id: section.id,
      heading:
        typeof section.heading === 'string'
          ? section.heading
          : `/${section.heading.source}/${section.heading.flags}`,
      regex: typeof section.heading !== 'string',
      required: section.required !== false,
    })),
  }
}

/** 规范化 JSON：对象键排序、省略 undefined，使摘要与键顺序无关 */
export function promptCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value))
      throw new TypeError('promptCanonicalJson does not accept non-finite numbers')
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) return `[${value.map((item) => promptCanonicalJson(item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined && typeof item !== 'function')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${promptCanonicalJson(item)}`).join(',')}}`
}

/** `sha256:<hex>`；用 Web Crypto，Workers 与 Node 都可用 */
export async function promptSha256(text: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
  )
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return `sha256:${hex}`
}

/** 渲染结果（system、user、params、maxOutputTokens、sections）的摘要，即评测锁文件中的 `rendered` */
export function renderedPromptDigest(rendered: RenderedPrompt): Promise<string> {
  return promptSha256(
    promptCanonicalJson({
      system: rendered.system,
      user: rendered.user,
      params: rendered.params,
      maxOutputTokens: rendered.maxOutputTokens,
      sections: rendered.sections,
    }),
  )
}
