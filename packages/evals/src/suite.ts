import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DefinedPrompt } from '@product-res/ai'
import type { z } from 'zod'
import type { EvaluateRun } from './assess.ts'
import type { Check } from './checks.ts'
import { EvalConfigError } from './errors.ts'
import { idPattern, parseSamples, type Sample } from './sample.ts'

/** 模型声明（design D4）：单价为美元 / 百万 token，真实与录制模式必填 */
export interface ModelSpec {
  readonly provider: string
  readonly providerModelId: string
  readonly priceUsd?: { readonly inputPerMTok: number; readonly outputPerMTok: number }
  /** 输入 token 估算系数，缺省 1（与 @product-res/ai 的保守估算一致） */
  readonly tokensPerChar?: number
  /**
   * 与线上模型行 `x-text.thinking` 同一语义：缺省不改请求（Provider 默认）；
   * true / false 在 Provider 可控时显式下发开启 / 关闭。只作用于生成调用，评委用 `judge.thinking`。
   */
  readonly thinking?: boolean
}

/** 评分标准（design D8） */
export interface Rubric {
  readonly version: string
  readonly instructions?: string
  readonly criteria: readonly {
    readonly id: string
    readonly description: string
    readonly weight?: number
  }[]
  readonly scale: { readonly min: number; readonly max: number }
}

/** 被评正文转换的结果（design D1）：annotations 限 JSON 可序列化的普通对象 */
export interface PreparedOutput {
  readonly output: string
  readonly annotations?: Readonly<Record<string, unknown>>
}

/**
 * 被评正文转换（design D1）：在确定性检查与评委之前，把模型原文转换为被评正文。
 * 必须是无网络副作用、结果可重复的纯函数；`version` 变化会使旧评委录制过期。
 */
export interface PrepareOutput {
  readonly version: string
  run(ctx: {
    readonly rawOutput: string
    readonly sample: Sample
    // biome-ignore lint/suspicious/noExplicitAny: 转换对任意输入类型的提示词通用
    readonly prompt: DefinedPrompt<any>
  }): PreparedOutput | Promise<PreparedOutput>
}

export interface SuiteDefinition {
  readonly name: string
  // biome-ignore lint/suspicious/noExplicitAny: 套件内的提示词共享样本输入，类型由项目决定
  readonly prompts: readonly DefinedPrompt<any>[]
  /** 可选：样本 `input` 的 Zod schema，加载时逐个校验，不符即配置错误 */
  readonly inputSchema?: z.ZodType
  /** 缺省取 prompts 的最后一个 */
  readonly defaultPrompt?: string
  readonly models: Readonly<Record<string, ModelSpec>>
  readonly generator: string
  readonly judge?: {
    readonly model: string
    readonly rubric: Rubric
    /** 评委输出上限（含推理模型的 reasoning token），缺省 4096 */
    readonly maxOutputTokens?: number
    /** 评委是否开启 thinking；缺省 false，Provider 可控时显式下发关闭 */
    readonly thinking?: boolean
  }
  readonly checks?: readonly Check[]
  /** 平均总分下降超过此值判为回退，缺省 0.05 */
  readonly regressionThreshold?: number
  /** 可选：检查与评委之前的被评正文转换 */
  readonly prepareOutput?: PrepareOutput
  /** 可选：候选与基线全部完成后的聚合门槛判定（design D4） */
  readonly evaluateRun?: EvaluateRun
}

const SUITE_MARK = Symbol.for('saas.evals.suite')

export type Suite = SuiteDefinition & { readonly [SUITE_MARK]: true }

function fail(name: string, message: string): never {
  throw new EvalConfigError(`suite ${name}: ${message}`)
}

export function defineSuite(def: SuiteDefinition): Suite {
  const name = def.name
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name))
    fail(name, 'name must be lowercase letters, digits, - or _')
  if (def.prompts.length === 0) fail(name, 'prompts must not be empty')
  const versions = new Set<string>()
  for (const prompt of def.prompts) {
    if (versions.has(prompt.promptVersion))
      fail(name, `duplicate prompt version ${prompt.promptVersion}`)
    versions.add(prompt.promptVersion)
  }
  if (def.defaultPrompt && !versions.has(def.defaultPrompt))
    fail(name, `defaultPrompt ${def.defaultPrompt} is not in prompts`)
  for (const [key, model] of Object.entries(def.models)) {
    if (!idPattern.test(key)) fail(name, `invalid model key ${key}`)
    if (!model.provider || !model.providerModelId)
      fail(name, `model ${key} needs provider and providerModelId`)
    const price = model.priceUsd
    if (
      price &&
      ![price.inputPerMTok, price.outputPerMTok].every(
        (value) => Number.isFinite(value) && value >= 0,
      )
    )
      fail(name, `model ${key} has an invalid priceUsd`)
    if (
      model.tokensPerChar !== undefined &&
      !(Number.isFinite(model.tokensPerChar) && model.tokensPerChar > 0)
    )
      fail(name, `model ${key} has an invalid tokensPerChar`)
    if (model.thinking !== undefined && typeof model.thinking !== 'boolean')
      fail(name, `model ${key} thinking must be true or false`)
  }
  if (!def.models[def.generator]) fail(name, `generator ${def.generator} is not in models`)
  if (def.judge) {
    if (!def.models[def.judge.model]) fail(name, `judge model ${def.judge.model} is not in models`)
    const { rubric } = def.judge
    const max = def.judge.maxOutputTokens
    if (max !== undefined && !(Number.isInteger(max) && max > 0))
      fail(name, 'judge.maxOutputTokens must be a positive integer')
    if (!rubric.version) fail(name, 'rubric.version is required')
    if (rubric.criteria.length === 0) fail(name, 'rubric.criteria must not be empty')
    const ids = new Set<string>()
    for (const criterion of rubric.criteria) {
      if (!idPattern.test(criterion.id) || ids.has(criterion.id))
        fail(name, `invalid or duplicate criterion id ${criterion.id}`)
      ids.add(criterion.id)
      if (criterion.weight !== undefined && !(criterion.weight > 0))
        fail(name, `criterion ${criterion.id} weight must be positive`)
    }
    if (!(Number.isFinite(rubric.scale.min) && rubric.scale.max > rubric.scale.min))
      fail(name, 'rubric.scale must have min < max')
  }
  const checkIds = new Set<string>()
  for (const check of def.checks ?? []) {
    if (!idPattern.test(check.id) || checkIds.has(check.id))
      fail(name, `invalid or duplicate check id ${check.id}`)
    checkIds.add(check.id)
  }
  if (def.prepareOutput !== undefined) {
    if (!idPattern.test(def.prepareOutput.version ?? ''))
      fail(name, 'prepareOutput.version must be a short id (letters, digits, . _ -)')
    if (typeof def.prepareOutput.run !== 'function')
      fail(name, 'prepareOutput.run must be a function')
  }
  if (def.evaluateRun !== undefined && typeof def.evaluateRun !== 'function')
    fail(name, 'evaluateRun must be a function')
  if (
    def.regressionThreshold !== undefined &&
    !(def.regressionThreshold >= 0 && def.regressionThreshold <= 1)
  )
    fail(name, 'regressionThreshold must be between 0 and 1')
  return Object.freeze({ ...def, [SUITE_MARK]: true as const })
}

export const isSuite = (value: unknown): value is Suite =>
  typeof value === 'object' && value !== null && SUITE_MARK in value

/** 默认提示词版本：`defaultPrompt`，缺省为最后一个 */
export function defaultPromptVersion(suite: SuiteDefinition): string {
  return suite.defaultPrompt ?? (suite.prompts.at(-1)?.promptVersion as string)
}

export function findPrompt(suite: SuiteDefinition, promptVersion: string) {
  const prompt = suite.prompts.find((item) => item.promptVersion === promptVersion)
  if (!prompt)
    throw new EvalConfigError(
      `unknown prompt version ${promptVersion}; suite ${suite.name} has ${suite.prompts
        .map((item) => item.promptVersion)
        .join(', ')}`,
    )
  return prompt
}

/** 仓库根目录：本文件位于 packages/evals/src */
export const REPO_ROOT = resolve(import.meta.dirname, '../../..')

/**
 * 套件目录（design D12）：`example` 指向模板自带的 `packages/evals/example/`，
 * 其他名字指向项目自有的根目录 `evals/<name>/`。
 */
export function suiteDir(name: string, root = REPO_ROOT): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name))
    throw new EvalConfigError(`invalid suite name ${JSON.stringify(name)}`)
  return name === 'example' ? join(root, 'packages/evals/example') : join(root, 'evals', name)
}

export interface LoadedSuite {
  readonly suite: Suite
  readonly samples: readonly Sample[]
  readonly dir: string
}

/** 读取套件与样本；套件不存在、默认导出不是 defineSuite 结果或样本不合法时为配置错误 */
export async function loadSuite(name: string, root = REPO_ROOT): Promise<LoadedSuite> {
  const dir = suiteDir(name, root)
  const file = join(dir, 'suite.ts')
  if (!existsSync(file))
    throw new EvalConfigError(
      `suite ${name} not found: expected ${name === 'example' ? file : `evals/${name}/suite.ts`}`,
    )
  const module = (await import(pathToFileURL(file).href)) as { default?: unknown }
  if (!isSuite(module.default))
    throw new EvalConfigError(`suite ${name}: suite.ts must export default defineSuite({...})`)
  const samplesFile = join(dir, 'samples.json')
  if (!existsSync(samplesFile)) throw new EvalConfigError(`suite ${name}: samples.json not found`)
  let data: unknown
  try {
    data = JSON.parse(readFileSync(samplesFile, 'utf8'))
  } catch (error) {
    throw new EvalConfigError(
      `suite ${name}: samples.json is not valid JSON (${error instanceof Error ? error.message : error})`,
    )
  }
  const samples = parseSamples(data, `suite ${name} samples.json`)
  validateExpect(module.default, samples)
  validateInputs(module.default, samples)
  return { suite: module.default, samples, dir }
}

/** 样本 `expect` 只能引用套件中的检查，参数按检查的 schema 校验 */
export function validateExpect(suite: SuiteDefinition, samples: readonly Sample[]) {
  const byId = new Map((suite.checks ?? []).map((check) => [check.id, check]))
  for (const sample of samples)
    for (const [id, params] of Object.entries(sample.expect ?? {})) {
      const check = byId.get(id)
      if (!check)
        throw new EvalConfigError(`sample ${sample.id}: expect.${id} has no matching check`)
      const parsed = check.expectSchema?.safeParse(params)
      if (parsed && !parsed.success)
        throw new EvalConfigError(
          `sample ${sample.id}: expect.${id} is invalid (${parsed.error.issues
            .map((issue) => `${issue.path.join('.')} ${issue.message}`)
            .join('; ')})`,
        )
    }
}

/** 套件声明了 `inputSchema` 时，样本输入必须符合它 */
export function validateInputs(suite: SuiteDefinition, samples: readonly Sample[]) {
  if (!suite.inputSchema) return
  for (const sample of samples) {
    const parsed = suite.inputSchema.safeParse(sample.input)
    if (!parsed.success)
      throw new EvalConfigError(
        `sample ${sample.id}: input does not match the suite inputSchema (${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
          .join('; ')})`,
      )
  }
}
