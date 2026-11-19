import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import {
  type DefinedPrompt,
  getTextProviderCapabilities,
  promptSha256,
  type RenderedPrompt,
  renderPrompt,
  resolveTextThinking,
} from '@product-res/ai'
import { generateText, type LanguageModel } from 'ai'
import { z } from 'zod'
import {
  type AssessmentReport,
  type EvaluationGroup,
  type EvaluationResult,
  isJsonRecord,
  type RunScope,
  runAssessment,
} from './assess.ts'
import {
  BudgetLedger,
  type CallEstimate,
  estimateCall,
  type Price,
  requirePrice,
  settledUsd,
  type Usage,
} from './budget.ts'
import { type CheckOutcome, runChecks } from './checks.ts'
import { EvalConfigError, EXIT, registerSecretValues, safeErrorMessage } from './errors.ts'
import { judgeMessages, judgeSchemaText, judgeSettings, runJudge } from './judge.ts'
import { verifyLock } from './lock.ts'
import { fixedModel } from './mock.ts'
import {
  assertModeAllowed,
  type GenerationRecording,
  generationRecordingPath,
  generationRecordingSchema,
  isCi,
  type JudgeRecording,
  judgeRecordingPath,
  judgeRecordingSchema,
  liveModelFactory,
  type Mode,
  type ModelFor,
  modelRef,
  readRecording,
  writeRecording,
} from './models.ts'
import { writeReport } from './report.ts'
import type { Sample } from './sample.ts'
import {
  defaultPromptVersion,
  findPrompt,
  type LoadedSuite,
  loadSuite,
  type ModelSpec,
  type PrepareOutput,
  REPO_ROOT,
} from './suite.ts'

export const DEFAULT_REGRESSION_THRESHOLD = 0.05
export const MAX_CONCURRENCY = 4

export interface RunOptions {
  readonly suite: string
  readonly mode?: Mode
  readonly prompt?: string
  readonly model?: string
  readonly judgeModel?: string
  readonly samples?: readonly string[]
  readonly tag?: string
  readonly noJudge?: boolean
  readonly concurrency?: number
  readonly budgetUsd?: number
  readonly baseline?: string
  readonly baselineReport?: string
  readonly maxRegression?: number
  /** 版本锁只校验、不追加；CI 为真时总是冻结 */
  readonly frozenLock?: boolean
}

export interface RunDeps {
  readonly root?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  /** 真实 / 录制模式的模型构造；缺省走 `defaultLanguageModelFactory`，单测注入模拟模型 */
  readonly modelFor?: ModelFor
  readonly now?: () => Date
  readonly gitCommit?: string | null
}

export type SampleStatus =
  | 'passed'
  | 'failed'
  | 'no-recording'
  | 'stale-recording'
  | 'generation-error'
  | 'prepare-error'
  | 'judge-error'
  | 'skipped-budget'

export interface CallUsage {
  readonly inputTokens?: number | undefined
  readonly outputTokens?: number | undefined
  /** 调用前的输入估算，用于报告估算与实际用量的比值 */
  readonly estimatedInputTokens: number
  /** 调用耗时（毫秒）：真实 / 录制模式实测，回放生成取录制值；缺失时不出现 */
  readonly durationMs?: number
}

/** 被评正文转换的证据（design D2）：仅套件声明 prepareOutput 时出现 */
export interface PreparedInfo {
  readonly version: string
  readonly rawSha256: string
  readonly outputSha256: string
  readonly rawChars: number
  readonly outputChars: number
  readonly changed: boolean
  readonly annotations?: Readonly<Record<string, unknown>>
}

export interface JudgeResult {
  readonly status: 'scored' | 'judge-error' | 'no-recording' | 'stale-recording' | 'skipped-budget'
  readonly model: string
  readonly score?: number
  readonly criteria?: Readonly<Record<string, { score: number; reason: string }>>
  readonly summary?: string
  readonly error?: string
}

export interface SampleResult {
  readonly id: string
  readonly tags: readonly string[]
  readonly status: SampleStatus
  readonly renderedHash: string
  readonly finishReason?: string
  /** 被评正文的字符数（码点）；未声明转换时即原文 */
  readonly outputChars?: number
  readonly prepared?: PreparedInfo
  readonly checks: readonly CheckOutcome[]
  readonly judge: JudgeResult | null
  readonly usage: { readonly generation?: CallUsage; readonly judge?: CallUsage }
  /** 真实 / 录制模式的实际费用（缺失用量按估算） */
  readonly costUsd: number
  /** 回放模式：按录制用量估算真实运行费用；缺单价时为 null */
  readonly estimatedCostUsd: number | null
  readonly error?: string
}

export interface BaselineComparison {
  readonly kind: 'prompt' | 'report'
  readonly promptVersion: string
  readonly source?: string
  readonly threshold: number
  readonly comparedSamples: number
  /** 两侧都有分数、实际参与平均分对比的样本数；少于 comparedSamples 时回退判定只覆盖部分样本 */
  readonly scoredPairs: number
  /** 同次回放基线中失败的样本（如评委录制过期、转换错误），这些样本不参与平均分对比 */
  readonly baselineFailures: readonly { readonly id: string; readonly status: SampleStatus }[]
  readonly baselineAverage: number | null
  readonly currentAverage: number | null
  readonly delta: number | null
  readonly regressed: boolean
  readonly samples: readonly {
    readonly id: string
    readonly baselineScore: number | null
    readonly score: number | null
    readonly delta: number | null
    readonly regressed: boolean
    readonly checksChanged: readonly { id: string; before: boolean; after: boolean }[]
  }[]
}

export interface Report {
  readonly suite: string
  readonly mode: Mode
  readonly createdAt: string
  readonly gitCommit: string | null
  readonly prompt: {
    readonly promptVersion: string
    readonly renderedHashes: Readonly<Record<string, string>>
  }
  readonly generator: { key: string; provider: string; providerModelId: string }
  readonly judge: {
    key: string
    provider: string
    providerModelId: string
    rubricVersion: string
  } | null
  readonly budget: {
    readonly limitUsd: number | null
    readonly spentUsd: number
    readonly exhausted: boolean
  }
  readonly scope: RunScope
  /** 套件声明 prepareOutput 时的转换版本 */
  readonly prepareVersion: string | null
  readonly samples: readonly SampleResult[]
  readonly summary: {
    readonly total: number
    readonly passed: number
    readonly failed: number
    readonly skippedBudget: number
    readonly passRate: number
    readonly averageScore: number | null
    readonly scoredSamples: number
    /** 评委开启时应有的评分数（选定样本数），否则 0 */
    readonly expectedScores: number
    readonly warnings: number
    readonly costUsd: number
    readonly estimatedLiveCostUsd: number | null
    /** 实际输入 token / 调用前估算，便于调整 tokensPerChar */
    readonly inputTokenRatio: number | null
  }
  readonly baseline: BaselineComparison | null
  /** 套件声明 evaluateRun 时的门槛结果，否则为 null */
  readonly assessment: AssessmentReport | null
  readonly exitCode: number
}

export interface RunResult {
  readonly exitCode: number
  readonly report: Report
  readonly reportDir: string
}

interface Context {
  readonly loaded: LoadedSuite
  // biome-ignore lint/suspicious/noExplicitAny: 套件内提示词的输入类型由项目决定
  readonly prompt: DefinedPrompt<any>
  readonly mode: Mode
  readonly generatorKey: string
  readonly judgeKey: string | null
  readonly hashes: ReadonlyMap<string, string>
  readonly ledger: BudgetLedger | null
  readonly modelFor: ModelFor | null
  readonly now: () => Date
  /** 声明 prepareOutput 时收集原文与被评正文，写入报告目录 */
  readonly texts: Map<string, { readonly raw: string; readonly output?: string }>
  stopped: boolean
}

const spec = (ctx: Context, key: string) => ctx.loaded.suite.models[key] as ModelSpec

function priceOf(model: ModelSpec): Price | undefined {
  return model.priceUsd
}

function replayEstimate(model: ModelSpec, estimate: CallEstimate, usage: Usage): number | null {
  const price = priceOf(model)
  return price ? settledUsd(price, estimate, usage) : null
}

/**
 * 生成调用的 thinking 参数：与线上模型行 `x-text.thinking` 同一语义。
 * 未声明时不改请求（Provider 默认）；声明后经 resolveTextThinking 计算，Provider 可控时下发开 / 关。
 */
function generationThinking(model: ModelSpec) {
  if (model.thinking === undefined) return {}
  const thinking = resolveTextThinking(model.provider, model.thinking, model.thinking)
  return thinking === undefined
    ? {}
    : getTextProviderCapabilities(model.provider).applyThinking({}, thinking)
}

async function generate(
  model: LanguageModel,
  rendered: RenderedPrompt,
  spec: ModelSpec,
): Promise<{ text: string; finishReason: string; usage: Usage }> {
  const result = await generateText({
    ...generationThinking(spec),
    model,
    // AI SDK 7 以 instructions 传入 system 文本（system 参数已弃用）；回放与真实模式走同一形状
    instructions: rendered.system,
    prompt: rendered.user,
    maxOutputTokens: rendered.maxOutputTokens,
    ...(rendered.params.temperature !== undefined
      ? { temperature: rendered.params.temperature }
      : {}),
    ...(rendered.params.topP !== undefined ? { topP: rendered.params.topP } : {}),
    // 重试会产生预算外的费用；失败即记为生成错误
    maxRetries: 0,
  })
  return {
    text: result.text,
    finishReason: result.finishReason,
    usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
  }
}

async function runSample(ctx: Context, sample: Sample): Promise<SampleResult> {
  const { loaded, prompt, mode } = ctx
  const generatorSpec = spec(ctx, ctx.generatorKey)
  const renderedHash = ctx.hashes.get(sample.id) as string
  const base = {
    id: sample.id,
    tags: sample.tags ?? [],
    renderedHash,
    checks: [] as CheckOutcome[],
    judge: null,
  }
  if (ctx.stopped)
    return { ...base, status: 'skipped-budget', usage: {}, costUsd: 0, estimatedCostUsd: null }
  const rendered = renderPrompt(prompt, sample.input)
  const estimate = estimateCall(
    generatorSpec,
    [rendered.system, rendered.user],
    rendered.maxOutputTokens,
  )
  let costUsd = 0
  let estimatedCostUsd: number | null = null
  let output: { text: string; finishReason: string; usage: Usage }
  let durationMs: number | undefined

  // 1. 生成
  if (mode === 'replay') {
    const path = generationRecordingPath(
      loaded.dir,
      prompt.promptVersion,
      ctx.generatorKey,
      sample.id,
    )
    const read = readRecording(path, generationRecordingSchema)
    if (!read.ok)
      return {
        ...base,
        status: 'no-recording',
        usage: {},
        costUsd: 0,
        estimatedCostUsd: null,
        error: read.reason,
      }
    if (read.recording.renderedHash !== renderedHash)
      return {
        ...base,
        status: 'stale-recording',
        usage: {},
        costUsd: 0,
        estimatedCostUsd: null,
        error: 'recording was made from a different rendering of this prompt version',
      }
    output = await generate(
      fixedModel({
        text: read.recording.output,
        finishReason: read.recording.finishReason,
        usage: read.recording.usage,
      }),
      rendered,
      generatorSpec,
    )
    // 回放读取录制的真实生成耗时，不用本机回放耗时代替
    durationMs = read.recording.durationMs
    estimatedCostUsd = replayEstimate(generatorSpec, estimate, output.usage)
  } else {
    const price = requirePrice(ctx.generatorKey, generatorSpec)
    const reservation = ctx.ledger?.reserve(estimate.usd)
    if (!reservation) {
      ctx.stopped = true
      return { ...base, status: 'skipped-budget', usage: {}, costUsd: 0, estimatedCostUsd: null }
    }
    const started = performance.now()
    try {
      output = await generate(
        (ctx.modelFor as ModelFor)(ctx.generatorKey, generatorSpec),
        rendered,
        generatorSpec,
      )
      durationMs = Math.round(performance.now() - started)
    } catch (error) {
      // 失败的请求也可能计费：按预留额记账
      ctx.ledger?.settle(reservation)
      return {
        ...base,
        status: 'generation-error',
        usage: { generation: { estimatedInputTokens: estimate.inputTokens } },
        costUsd: reservation.usd,
        estimatedCostUsd: null,
        error: safeErrorMessage(error),
      }
    }
    costUsd = settledUsd(price, estimate, output.usage)
    ctx.ledger?.settle(reservation, costUsd)
    if (mode === 'record')
      writeRecording(
        generationRecordingPath(loaded.dir, prompt.promptVersion, ctx.generatorKey, sample.id),
        {
          kind: 'generation',
          promptVersion: prompt.promptVersion,
          renderedHash,
          model: modelRef(ctx.generatorKey, generatorSpec),
          output: output.text,
          finishReason: output.finishReason,
          usage: definedUsage(output.usage),
          recordedAt: ctx.now().toISOString(),
          source: 'recorded',
          durationMs,
        } satisfies GenerationRecording,
      )
  }
  const generationUsage: CallUsage = {
    ...definedUsage(output.usage),
    estimatedInputTokens: estimate.inputTokens,
    ...(durationMs !== undefined ? { durationMs } : {}),
  }

  // 2. 被评正文转换（三种模式同一路径；失败不回退为原文）
  const hook = loaded.suite.prepareOutput
  let evaluated = output.text
  let prepared: PreparedInfo | undefined
  if (hook) {
    const result = await prepareOutput(hook, output.text, sample, prompt)
    // 转换失败时也保留原文（真实模式没有录制，否则无从排查）
    if (!result.ok) ctx.texts.set(sample.id, { raw: output.text })
    if (!result.ok)
      return {
        ...base,
        status: 'prepare-error',
        finishReason: output.finishReason,
        usage: { generation: generationUsage },
        costUsd,
        estimatedCostUsd,
        error: result.error,
      }
    evaluated = result.output
    prepared = {
      version: hook.version,
      rawSha256: await promptSha256(output.text),
      outputSha256: await promptSha256(evaluated),
      rawChars: [...output.text].length,
      outputChars: [...evaluated].length,
      changed: evaluated !== output.text,
      ...(result.annotations !== undefined ? { annotations: result.annotations } : {}),
    }
    ctx.texts.set(sample.id, { raw: output.text, output: evaluated })
  }

  // 3. 确定性检查
  const checks = await runChecks(loaded.suite.checks ?? [], {
    output: evaluated,
    sample,
    prompt,
  })
  const checksFailed = checks.some((check) => !check.pass && check.severity === 'error')
  const generated = {
    ...base,
    finishReason: output.finishReason,
    outputChars: [...evaluated].length,
    ...(prepared ? { prepared } : {}),
    checks,
  }

  // 4. 评委（有 error 级检查失败时仍评分，便于对比）
  const judgeConfig = loaded.suite.judge
  if (!ctx.judgeKey || !judgeConfig)
    return {
      ...generated,
      status: checksFailed ? 'failed' : 'passed',
      usage: { generation: generationUsage },
      costUsd,
      estimatedCostUsd,
    }
  const judgeKey = ctx.judgeKey
  const judgeSpec = spec(ctx, judgeKey)
  const { rubric } = judgeConfig
  const messages = judgeMessages({ rubric, sampleInput: sample.input, prompt, output: evaluated })
  // 回放与真实模式按同一评委设置构造请求；thinking 由评委模型的 Provider 决定是否下发
  const settings = judgeSettings(judgeSpec.provider, judgeConfig)
  const judgeEstimate = estimateCall(
    judgeSpec,
    // 结构化输出的 JSON schema 也随请求发送，计入输入估算；输出上限已含 reasoning token
    [messages.system, messages.user, judgeSchemaText(rubric)],
    settings.maxOutputTokens,
  )
  // 评委录制绑定被评正文与转换版本：任一变化都使旧录制过期
  const outputHash = await promptSha256(evaluated)
  const judgePath = judgeRecordingPath(
    loaded.dir,
    prompt.promptVersion,
    ctx.generatorKey,
    sample.id,
    judgeKey,
  )
  let judgeModel: LanguageModel
  let reservation: { usd: number } | null = null
  if (mode === 'replay') {
    const read = readRecording(judgePath, judgeRecordingSchema)
    const stale =
      read.ok &&
      (read.recording.rubricVersion !== rubric.version ||
        read.recording.outputHash !== outputHash ||
        read.recording.prepareVersion !== hook?.version)
    if (!read.ok || stale)
      return {
        ...generated,
        status: read.ok ? 'stale-recording' : 'no-recording',
        judge: {
          status: read.ok ? 'stale-recording' : 'no-recording',
          model: judgeKey,
          error: read.ok
            ? 'judge recording was made for a different output, rubric version or prepareOutput version'
            : read.reason,
        },
        usage: { generation: generationUsage },
        costUsd,
        estimatedCostUsd,
      }
    judgeModel = fixedModel({
      text: read.recording.output,
      finishReason: read.recording.finishReason,
      usage: read.recording.usage,
    })
  } else {
    requirePrice(judgeKey, judgeSpec)
    reservation = ctx.ledger?.reserve(judgeEstimate.usd) ?? null
    if (!reservation) {
      ctx.stopped = true
      return {
        ...generated,
        status: 'skipped-budget',
        judge: { status: 'skipped-budget', model: judgeKey },
        usage: { generation: generationUsage },
        costUsd,
        estimatedCostUsd,
      }
    }
    judgeModel = (ctx.modelFor as ModelFor)(judgeKey, judgeSpec)
  }
  const judgeStarted = performance.now()
  const call = await runJudge(judgeModel, rubric, messages, settings)
  // 回放的评委耗时没有意义，只在真实 / 录制模式记录
  const judgeDuration = reservation ? Math.round(performance.now() - judgeStarted) : undefined
  let judgeCost = 0
  if (reservation) {
    judgeCost = call.callFailed
      ? reservation.usd
      : settledUsd(judgeSpec.priceUsd as Price, judgeEstimate, call.usage)
    ctx.ledger?.settle(reservation, judgeCost)
  } else {
    const replayCost = replayEstimate(judgeSpec, judgeEstimate, call.usage)
    estimatedCostUsd =
      estimatedCostUsd === null || replayCost === null ? null : estimatedCostUsd + replayCost
  }
  if (mode === 'record' && !call.callFailed && call.text !== undefined)
    writeRecording(judgePath, {
      kind: 'judge',
      promptVersion: prompt.promptVersion,
      rubricVersion: rubric.version,
      outputHash,
      ...(hook ? { prepareVersion: hook.version } : {}),
      model: modelRef(judgeKey, judgeSpec),
      output: call.text,
      finishReason: call.finishReason ?? 'other',
      usage: definedUsage(call.usage),
      recordedAt: ctx.now().toISOString(),
      source: 'recorded',
    } satisfies JudgeRecording)
  const judge: JudgeResult = call.outcome.ok
    ? {
        status: 'scored',
        model: judgeKey,
        score: call.outcome.score,
        criteria: call.outcome.criteria,
        summary: call.outcome.summary,
      }
    : { status: 'judge-error', model: judgeKey, error: call.outcome.error }
  return {
    ...generated,
    status: !call.outcome.ok ? 'judge-error' : checksFailed ? 'failed' : 'passed',
    judge,
    usage: {
      generation: generationUsage,
      judge: {
        ...definedUsage(call.usage),
        estimatedInputTokens: judgeEstimate.inputTokens,
        ...(judgeDuration !== undefined ? { durationMs: judgeDuration } : {}),
      },
    },
    costUsd: costUsd + judgeCost,
    estimatedCostUsd,
  }
}

type Prepared =
  | { readonly ok: true; readonly output: string; readonly annotations?: Record<string, unknown> }
  | { readonly ok: false; readonly error: string }

async function prepareOnce(
  hook: PrepareOutput,
  rawOutput: string,
  sample: Sample,
  prompt: DefinedPrompt<unknown>,
): Promise<Prepared> {
  // 每次传入样本副本，hook 改动样本不会影响第二次执行或后续检查
  const result = (await hook.run({ rawOutput, sample: structuredClone(sample), prompt })) as {
    output?: unknown
    annotations?: unknown
  } | null
  if (typeof result?.output !== 'string')
    return { ok: false, error: 'prepareOutput must return { output: string }' }
  if (result.annotations !== undefined && !isJsonRecord(result.annotations))
    return {
      ok: false,
      error: 'prepareOutput annotations must be a JSON-serialisable plain object',
    }
  return {
    ok: true,
    output: result.output,
    ...(result.annotations !== undefined
      ? { annotations: result.annotations as Record<string, unknown> }
      : {}),
  }
}

/** 执行两次并比对，拦住依赖时间或随机数的实现（design D1） */
async function prepareOutput(
  hook: PrepareOutput,
  rawOutput: string,
  sample: Sample,
  prompt: DefinedPrompt<unknown>,
): Promise<Prepared> {
  try {
    const first = await prepareOnce(hook, rawOutput, sample, prompt)
    if (!first.ok) return first
    const second = await prepareOnce(hook, rawOutput, sample, prompt)
    if (
      !second.ok ||
      second.output !== first.output ||
      JSON.stringify(second.annotations) !== JSON.stringify(first.annotations)
    )
      return {
        ok: false,
        error: 'prepareOutput is not repeatable: two runs on the same input differ',
      }
    return first
  } catch (error) {
    return { ok: false, error: `prepareOutput threw: ${safeErrorMessage(error)}` }
  }
}

function definedUsage(usage: Usage): { inputTokens?: number; outputTokens?: number } {
  return {
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
  }
}

async function runSamples(
  ctx: Context,
  samples: readonly Sample[],
  concurrency: number,
): Promise<SampleResult[]> {
  const results: SampleResult[] = new Array(samples.length)
  let next = 0
  const worker = async () => {
    while (next < samples.length) {
      const index = next++
      results[index] = await runSample(ctx, samples[index] as Sample)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, samples.length) }, worker))
  return results
}

const isFailure = (sample: SampleResult) =>
  sample.status === 'failed' ||
  sample.status === 'no-recording' ||
  sample.status === 'stale-recording' ||
  sample.status === 'generation-error' ||
  sample.status === 'prepare-error' ||
  sample.status === 'judge-error' ||
  sample.checks.some((check) => !check.pass && check.severity === 'error')

const average = (values: readonly number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null

interface BaselineSample {
  readonly id: string
  readonly score: number | null
  readonly checks: readonly { id: string; pass: boolean }[]
}

export function compareBaseline(
  current: readonly SampleResult[],
  baseline: readonly BaselineSample[],
  meta: {
    kind: 'prompt' | 'report'
    promptVersion: string
    source?: string
    threshold: number
    baselineFailures?: readonly { id: string; status: SampleStatus }[]
  },
): BaselineComparison {
  const byId = new Map(baseline.map((sample) => [sample.id, sample]))
  const samples = current.flatMap((sample) => {
    const before = byId.get(sample.id)
    if (!before) return []
    const score = sample.judge?.score ?? null
    const delta = score !== null && before.score !== null ? score - before.score : null
    const beforeChecks = new Map(before.checks.map((check) => [check.id, check.pass]))
    return [
      {
        id: sample.id,
        baselineScore: before.score,
        score,
        delta,
        regressed: delta !== null && -delta > meta.threshold,
        checksChanged: sample.checks.flatMap((check) => {
          const was = beforeChecks.get(check.id)
          return was !== undefined && was !== check.pass
            ? [{ id: check.id, before: was, after: check.pass }]
            : []
        }),
      },
    ]
  })
  const scored = samples.filter((sample) => sample.delta !== null)
  const baselineAverage = average(scored.map((sample) => sample.baselineScore as number))
  const currentAverage = average(scored.map((sample) => sample.score as number))
  const delta =
    baselineAverage !== null && currentAverage !== null ? currentAverage - baselineAverage : null
  return {
    ...meta,
    baselineFailures: meta.baselineFailures ?? [],
    comparedSamples: samples.length,
    scoredPairs: scored.length,
    baselineAverage,
    currentAverage,
    delta,
    // 浮点误差内的相等不算回退
    regressed: delta !== null && -delta - meta.threshold > 1e-9,
    samples,
  }
}

const modelRefSchema = z.looseObject({
  key: z.string(),
  provider: z.string(),
  providerModelId: z.string(),
})
const reportSchema = z.looseObject({
  suite: z.string(),
  prompt: z.looseObject({ promptVersion: z.string() }),
  generator: modelRefSchema.optional(),
  prepareVersion: z.string().nullable().optional(),
  judge: modelRefSchema.extend({ rubricVersion: z.string() }).nullable().optional(),
  samples: z.array(
    z.looseObject({
      id: z.string(),
      judge: z.looseObject({ score: z.number().optional() }).nullable().optional(),
      checks: z.array(z.looseObject({ id: z.string(), pass: z.boolean() })),
    }),
  ),
})

/** 旧报告的样本宽松读取为 EvaluationResult：缺字段保持缺省，交由项目判 incomplete */
function reportResult(sample: Record<string, unknown>): EvaluationResult {
  const usage = sample.usage as { generation?: Record<string, unknown> } | undefined
  const generation = usage?.generation
  const num = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined
  return {
    id: sample.id as string,
    tags: Array.isArray(sample.tags) ? (sample.tags as string[]) : [],
    status: (typeof sample.status === 'string' ? sample.status : 'failed') as SampleStatus,
    checks: sample.checks as CheckOutcome[],
    judge: (sample.judge as JudgeResult | null | undefined) ?? null,
    usage: generation
      ? {
          generation: {
            inputTokens: num(generation.inputTokens),
            outputTokens: num(generation.outputTokens),
            durationMs: num(generation.durationMs),
          },
        }
      : {},
    ...(typeof sample.finishReason === 'string' ? { finishReason: sample.finishReason } : {}),
    ...(sample.prepared ? { prepared: sample.prepared as PreparedInfo } : {}),
    ...(typeof sample.error === 'string' ? { error: sample.error } : {}),
  }
}

/** 本次运行结果交给 evaluateRun 的稳定子集 */
function runResult(sample: SampleResult): EvaluationResult {
  const generation = sample.usage.generation
  return {
    id: sample.id,
    tags: sample.tags,
    status: sample.status,
    checks: sample.checks,
    judge: sample.judge,
    usage: generation
      ? {
          generation: {
            inputTokens: generation.inputTokens,
            outputTokens: generation.outputTokens,
            durationMs: generation.durationMs,
          },
        }
      : {},
    ...(sample.finishReason !== undefined ? { finishReason: sample.finishReason } : {}),
    ...(sample.prepared ? { prepared: sample.prepared } : {}),
    ...(sample.error !== undefined ? { error: sample.error } : {}),
  }
}

function readBaselineReport(path: string, suite: string, selected: ReadonlySet<string>) {
  if (!existsSync(path)) throw new EvalConfigError(`--baseline-report ${path} not found`)
  let parsed: z.infer<typeof reportSchema>
  try {
    parsed = reportSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    throw new EvalConfigError(`--baseline-report ${path} is not a prompt eval report.json`)
  }
  if (parsed.suite !== suite)
    throw new EvalConfigError(`--baseline-report is for suite ${parsed.suite}, not ${suite}`)
  return {
    promptVersion: parsed.prompt.promptVersion,
    samples: parsed.samples.map((sample) => ({
      id: sample.id,
      score: sample.judge?.score ?? null,
      checks: sample.checks,
    })),
    group: {
      promptVersion: parsed.prompt.promptVersion,
      source: 'report',
      generator: parsed.generator
        ? {
            key: parsed.generator.key,
            provider: parsed.generator.provider,
            providerModelId: parsed.generator.providerModelId,
          }
        : null,
      judge: parsed.judge
        ? {
            key: parsed.judge.key,
            provider: parsed.judge.provider,
            providerModelId: parsed.judge.providerModelId,
            rubricVersion: parsed.judge.rubricVersion,
          }
        : null,
      prepareVersion: typeof parsed.prepareVersion === 'string' ? parsed.prepareVersion : null,
      // 只交选定范围内的样本，与候选组同一口径
      results: parsed.samples
        .filter((sample) => selected.has(sample.id))
        .map((sample) => reportResult(sample)),
    } satisfies EvaluationGroup,
  }
}

function gitCommit(root: string): string | null {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() || null : null
}

/**
 * 运行一次评测：配置错误抛出 `EvalConfigError`（不写报告，退出码 2），
 * 其余情况写出报告并返回退出码（design D9）。
 */
export async function runEval(options: RunOptions, deps: RunDeps = {}): Promise<RunResult> {
  const root = deps.root ?? REPO_ROOT
  const env = deps.env ?? process.env
  const mode = options.mode ?? 'replay'
  const now = deps.now ?? (() => new Date())
  registerSecretValues(env)
  assertModeAllowed(mode, options.budgetUsd, env)
  const concurrency = options.concurrency ?? 1
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY)
    throw new EvalConfigError(`--concurrency must be an integer from 1 to ${MAX_CONCURRENCY}`)
  const threshold = options.maxRegression
  if (threshold !== undefined && !(threshold >= 0 && threshold <= 1))
    throw new EvalConfigError('--max-regression must be between 0 and 1')
  if (options.baseline && options.baselineReport)
    throw new EvalConfigError('use either --baseline or --baseline-report, not both')

  const loaded = await loadSuite(options.suite, root)
  const { suite } = loaded
  const prompt = findPrompt(suite, options.prompt ?? defaultPromptVersion(suite))
  const generatorKey = options.model ?? suite.generator
  if (!suite.models[generatorKey])
    throw new EvalConfigError(
      `unknown model ${generatorKey}; suite models: ${Object.keys(suite.models).join(', ')}`,
    )
  let judgeKey: string | null = null
  if (suite.judge && !options.noJudge) {
    judgeKey = options.judgeModel ?? suite.judge.model
    if (!suite.models[judgeKey]) throw new EvalConfigError(`unknown judge model ${judgeKey}`)
  } else if (options.judgeModel && !suite.judge)
    throw new EvalConfigError(`suite ${suite.name} has no judge`)

  let samples = loaded.samples
  if (options.samples?.length) {
    const ids = new Set(loaded.samples.map((sample) => sample.id))
    const unknown = options.samples.filter((id) => !ids.has(id))
    if (unknown.length) throw new EvalConfigError(`unknown samples: ${unknown.join(', ')}`)
    const wanted = new Set(options.samples)
    samples = samples.filter((sample) => wanted.has(sample.id))
  }
  if (options.tag)
    samples = samples.filter((sample) => sample.tags?.includes(options.tag as string))
  if (samples.length === 0) throw new EvalConfigError('no samples selected')

  // 版本锁覆盖套件内全部版本与样本（含回放），在任何调用前完成
  const lock = await verifyLock(suite, loaded.samples, loaded.dir, {
    frozen: Boolean(options.frozenLock) || isCi(env),
  })

  let baselinePrompt: DefinedPrompt<unknown> | null = null
  let baselineReport: ReturnType<typeof readBaselineReport> | null = null
  if (options.baseline) {
    baselinePrompt = findPrompt(suite, options.baseline)
    if (baselinePrompt.promptVersion === prompt.promptVersion)
      throw new EvalConfigError('--baseline must differ from the evaluated prompt version')
    // 基线以回放运行，录制必须齐全；缺失时在任何调用前报错
    const missing = samples.filter((sample) => {
      const generation = generationRecordingPath(
        loaded.dir,
        options.baseline as string,
        generatorKey,
        sample.id,
      )
      const judge =
        judgeKey &&
        judgeRecordingPath(
          loaded.dir,
          options.baseline as string,
          generatorKey,
          sample.id,
          judgeKey,
        )
      return !existsSync(generation) || (judge && !existsSync(judge))
    })
    if (missing.length)
      throw new EvalConfigError(
        `baseline ${options.baseline} has no recordings for ${generatorKey}: ${missing
          .map((sample) => sample.id)
          .join(', ')}; record it first or use --baseline-report`,
      )
  }
  if (options.baselineReport)
    baselineReport = readBaselineReport(
      options.baselineReport,
      suite.name,
      new Set(samples.map((sample) => sample.id)),
    )

  let ledger: BudgetLedger | null = null
  let modelFor: ModelFor | null = null
  if (mode !== 'replay') {
    requirePrice(generatorKey, suite.models[generatorKey] as ModelSpec)
    if (judgeKey) requirePrice(judgeKey, suite.models[judgeKey] as ModelSpec)
    ledger = new BudgetLedger(options.budgetUsd as number)
    modelFor = deps.modelFor ?? liveModelFactory(env)
  }

  const context = (target: DefinedPrompt<unknown>, targetMode: Mode): Context => ({
    loaded,
    prompt: target,
    mode: targetMode,
    generatorKey,
    judgeKey,
    hashes: lock.rendered.get(target.promptVersion) as ReadonlyMap<string, string>,
    ledger: targetMode === 'replay' ? null : ledger,
    modelFor: targetMode === 'replay' ? null : modelFor,
    now,
    texts: new Map(),
    stopped: false,
  })

  const generatorRef = modelRef(generatorKey, suite.models[generatorKey] as ModelSpec)
  const judgeRef =
    judgeKey && suite.judge
      ? {
          ...modelRef(judgeKey, suite.models[judgeKey] as ModelSpec),
          rubricVersion: suite.judge.rubric.version,
        }
      : null
  const runGroup = (
    target: DefinedPrompt<unknown>,
    results: readonly SampleResult[],
  ): EvaluationGroup => ({
    promptVersion: target.promptVersion,
    source: 'run',
    prepareVersion: suite.prepareOutput?.version ?? null,
    generator: generatorRef,
    judge: judgeRef,
    results: results.map(runResult),
  })
  const scope: RunScope = {
    totalSamples: loaded.samples.length,
    selectedSamples: samples.length,
    filtered: samples.length !== loaded.samples.length,
    ...(options.samples?.length ? { sampleFilter: [...options.samples] } : {}),
    ...(options.tag ? { tag: options.tag } : {}),
  }

  const resolvedThreshold = threshold ?? suite.regressionThreshold ?? DEFAULT_REGRESSION_THRESHOLD
  let baseline: BaselineComparison | null = null
  if (baselinePrompt) {
    const before = await runSamples(context(baselinePrompt, 'replay'), samples, concurrency)
    const currentContext = context(prompt, mode)
    const current = await runSamples(currentContext, samples, concurrency)
    baseline = compareBaseline(
      current,
      before.map((sample) => ({
        id: sample.id,
        score: sample.judge?.score ?? null,
        checks: sample.checks,
      })),
      {
        kind: 'prompt',
        promptVersion: baselinePrompt.promptVersion,
        threshold: resolvedThreshold,
        baselineFailures: before
          .filter(isFailure)
          .map((sample) => ({ id: sample.id, status: sample.status })),
      },
    )
    return finish(current, baseline, runGroup(baselinePrompt, before), currentContext.texts)
  }
  const currentContext = context(prompt, mode)
  const current = await runSamples(currentContext, samples, concurrency)
  if (baselineReport)
    baseline = compareBaseline(current, baselineReport.samples, {
      kind: 'report',
      promptVersion: baselineReport.promptVersion,
      source: options.baselineReport as string,
      threshold: resolvedThreshold,
    })
  return finish(current, baseline, baselineReport?.group ?? null, currentContext.texts)

  async function finish(
    results: SampleResult[],
    comparison: BaselineComparison | null,
    baselineGroup: EvaluationGroup | null,
    texts: Context['texts'],
  ): Promise<RunResult> {
    // 评测后判定：拿到全部结果（不只是通过或有分数的样本）后调用一次
    const assessment = suite.evaluateRun
      ? await runAssessment(suite.evaluateRun, {
          samples,
          scope,
          mode,
          rubric: judgeKey && suite.judge ? suite.judge.rubric : null,
          candidate: runGroup(prompt, results),
          baseline: baselineGroup,
        })
      : null
    const failed = results.filter(isFailure).length
    const skippedBudget = results.filter((sample) => sample.status === 'skipped-budget').length
    const scores = results.flatMap((sample) =>
      sample.judge?.score !== undefined ? [sample.judge.score] : [],
    )
    const codes = [
      failed ? EXIT.failed : 0,
      skippedBudget ? EXIT.budget : 0,
      comparison?.regressed ? EXIT.regression : 0,
      // 门槛码排在最后：不掩盖检查 / 生成失败、预算触顶与回退
      assessment?.failed ? EXIT.gates : 0,
    ].filter(Boolean)
    const exitCode = codes.length ? Math.min(...codes) : EXIT.ok
    const calls = results.flatMap((sample) =>
      [sample.usage.generation, sample.usage.judge].filter(
        (usage): usage is CallUsage => usage?.inputTokens !== undefined,
      ),
    )
    const estimatedInput = calls.reduce((sum, call) => sum + call.estimatedInputTokens, 0)
    const estimates = results
      .filter((sample) => sample.status !== 'skipped-budget')
      .map((sample) => sample.estimatedCostUsd)
    const report: Report = {
      suite: suite.name,
      mode,
      createdAt: now().toISOString(),
      gitCommit: deps.gitCommit !== undefined ? deps.gitCommit : gitCommit(root),
      prompt: {
        promptVersion: prompt.promptVersion,
        renderedHashes: Object.fromEntries(
          samples.map((sample) => [
            sample.id,
            lock.rendered.get(prompt.promptVersion)?.get(sample.id) as string,
          ]),
        ),
      },
      generator: generatorRef,
      judge: judgeRef,
      budget: {
        limitUsd: ledger?.limitUsd ?? null,
        spentUsd: ledger?.spent ?? 0,
        exhausted: ledger?.exhausted ?? false,
      },
      scope,
      prepareVersion: suite.prepareOutput?.version ?? null,
      samples: results,
      summary: {
        total: results.length,
        passed: results.filter((sample) => sample.status === 'passed').length,
        failed,
        skippedBudget,
        passRate: results.length
          ? results.filter((sample) => sample.status === 'passed').length / results.length
          : 0,
        averageScore: average(scores),
        scoredSamples: scores.length,
        expectedScores: judgeKey ? results.length : 0,
        warnings: results.reduce(
          (sum, sample) =>
            sum + sample.checks.filter((check) => !check.pass && check.severity === 'warn').length,
          0,
        ),
        costUsd: results.reduce((sum, sample) => sum + sample.costUsd, 0),
        estimatedLiveCostUsd:
          mode === 'replay' && estimates.length && estimates.every((value) => value !== null)
            ? estimates.reduce((sum: number, value) => sum + (value as number), 0)
            : null,
        inputTokenRatio: estimatedInput
          ? calls.reduce((sum, call) => sum + (call.inputTokens as number), 0) / estimatedInput
          : null,
      },
      baseline: comparison,
      assessment,
      exitCode,
    }
    const reportDir = writeReport(report, { root, env, now: now() }, texts)
    return { exitCode, report, reportDir }
  }
}
