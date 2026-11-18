import type { CheckOutcome } from './checks.ts'
import { safeErrorMessage } from './errors.ts'
import type { Mode } from './models.ts'
import type { JudgeResult, PreparedInfo, SampleStatus } from './runner.ts'
import { idPattern, type Sample } from './sample.ts'
import type { Rubric } from './suite.ts'

/**
 * 评测后聚合门槛（design D4–D6）：模板只负责调用时机、结果校验、报告与退出码，
 * 不内置任何项目门槛数值；项目在套件的 `evaluateRun` 中用这里的辅助自行计算。
 */
export interface ModelRef {
  readonly key: string
  readonly provider: string
  readonly providerModelId: string
}

/** 本次运行范围：筛选运行时项目据此避免宣称全量门槛已达成 */
export interface RunScope {
  readonly totalSamples: number
  readonly selectedSamples: number
  readonly filtered: boolean
  readonly sampleFilter?: readonly string[]
  readonly tag?: string
}

/** 交给 `evaluateRun` 的逐样本结果：不只是通过或有分数的样本 */
export interface EvaluationResult {
  readonly id: string
  readonly tags: readonly string[]
  readonly status: SampleStatus
  readonly checks: readonly CheckOutcome[]
  /** 评委结果：各维原始分数与理由在 `criteria`，失败原因在 `error`；未运行评委时为 null */
  readonly judge: JudgeResult | null
  readonly usage: {
    readonly generation?: {
      readonly inputTokens?: number | undefined
      readonly outputTokens?: number | undefined
      /** 真实生成耗时；回放取录制值，缺失时为 undefined */
      readonly durationMs?: number | undefined
    }
  }
  readonly finishReason?: string
  readonly prepared?: PreparedInfo
  readonly error?: string
}

export interface EvaluationGroup {
  readonly promptVersion: string
  /** run：本次运行（候选或同次回放基线）；report：`--baseline-report` 读取的旧报告 */
  readonly source: 'run' | 'report'
  /** 该组使用的 prepareOutput 版本；未声明或旧报告缺字段时为 null */
  readonly prepareVersion: string | null
  /** 旧报告缺字段时为 null */
  readonly generator: ModelRef | null
  readonly judge: (ModelRef & { readonly rubricVersion: string }) | null
  readonly results: readonly EvaluationResult[]
}

export interface EvaluateRunContext {
  /** 本次选定（筛选后）的样本 */
  readonly samples: readonly Sample[]
  readonly scope: RunScope
  readonly mode: Mode
  /** 评委开启时的评分标准 */
  readonly rubric: Rubric | null
  readonly candidate: EvaluationGroup
  readonly baseline: EvaluationGroup | null
}

export type GateStatus = 'passed' | 'failed' | 'incomplete'

export interface RunGate {
  readonly id: string
  readonly status: GateStatus
  readonly detail: string
  /** 缺省 true：必需门槛 incomplete 同样以退出码 5 退出 */
  readonly required?: boolean
  /** JSON 可序列化的普通对象：均值、差值、阈值、有效 / 应有样本数等 */
  readonly metrics?: Readonly<Record<string, unknown>>
}

export interface RunAssessment {
  readonly gates: readonly RunGate[]
}

export type EvaluateRun = (ctx: EvaluateRunContext) => RunAssessment | Promise<RunAssessment>

/** 报告中的门槛结果 */
export interface AssessmentReport {
  readonly gates: readonly (RunGate & { readonly required: boolean })[]
  /** 存在 failed 或必需的 incomplete 门槛 */
  readonly failed: boolean
}

const isPlainObject = (value: object) => {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** JSON 值：字符串、有限数、布尔、null、数组与普通对象（拒绝 Date、undefined、函数、NaN、循环引用等） */
function isJsonValue(value: unknown, seen: Set<object>): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  const ok = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : isPlainObject(value) && Object.values(value).every((item) => isJsonValue(item, seen))
  seen.delete(value)
  return ok
}

/** 普通对象且每个值都是 JSON 值 */
export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    isJsonValue(value, new Set())
  )
}

const GATE_STATUSES = new Set<string>(['passed', 'failed', 'incomplete'])

function invalid(reason: string): AssessmentReport {
  return {
    gates: [{ id: 'evaluate-run', status: 'failed', detail: reason, required: true }],
    failed: true,
  }
}

/** 调用 `evaluateRun` 并校验返回；异常或不合法时记一个 `evaluate-run` 失败门槛 */
export async function runAssessment(
  evaluate: EvaluateRun,
  ctx: EvaluateRunContext,
): Promise<AssessmentReport> {
  let copy: EvaluateRunContext
  try {
    // 交给项目的是副本：hook 改动结果不会影响报告
    copy = structuredClone(ctx)
  } catch (error) {
    return invalid(`evaluateRun context could not be cloned: ${safeErrorMessage(error)}`)
  }
  let result: unknown
  try {
    result = await evaluate(copy)
  } catch (error) {
    return invalid(`evaluateRun threw: ${safeErrorMessage(error)}`)
  }
  const gates = (result as { gates?: unknown } | null)?.gates
  if (!Array.isArray(gates)) return invalid('evaluateRun must return { gates: [...] }')
  const seen = new Set<string>()
  const checked: (RunGate & { required: boolean })[] = []
  for (const [index, gate] of gates.entries()) {
    const item = gate as Partial<RunGate> | null
    const where = `gate #${index + 1}`
    if (typeof item?.id !== 'string' || !idPattern.test(item.id))
      return invalid(`${where} needs an id of letters, digits, . _ -`)
    if (seen.has(item.id)) return invalid(`duplicate gate id ${item.id}`)
    seen.add(item.id)
    if (typeof item.status !== 'string' || !GATE_STATUSES.has(item.status))
      return invalid(`gate ${item.id} status must be passed, failed or incomplete`)
    if (typeof item.detail !== 'string') return invalid(`gate ${item.id} detail must be a string`)
    if (item.required !== undefined && typeof item.required !== 'boolean')
      return invalid(`gate ${item.id} required must be true or false`)
    if (item.metrics !== undefined && !isJsonRecord(item.metrics))
      return invalid(`gate ${item.id} metrics must be a JSON-serialisable plain object`)
    checked.push({
      id: item.id,
      status: item.status,
      detail: item.detail,
      required: item.required ?? true,
      ...(item.metrics !== undefined ? { metrics: item.metrics } : {}),
    })
  }
  return {
    gates: checked,
    failed: checked.some(
      (gate) => gate.status === 'failed' || (gate.required && gate.status === 'incomplete'),
    ),
  }
}

/** 最近秩分位数：升序排序后取第 ceil(p / 100 × n) 个（至少第 1 个）；空集合返回 null */
export function percentile(values: readonly number[], p: number): number | null {
  if (!(p > 0 && p <= 100)) throw new RangeError('percentile p must be in (0, 100]')
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[rank - 1] as number
}

/** 算术平均；空集合返回 null */
export function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

export interface Collected {
  /** 按 `ids` 顺序取到的有效值（缺口已排除） */
  readonly values: number[]
  /** 样本不存在于该组，或取值不是有限数的样本 ID */
  readonly missing: string[]
  /** 应有值的个数，即 `ids.length` */
  readonly expected: number
}

/**
 * 按样本 ID 收集一个指标：以同一组 `ids` 收集候选与基线即完成按 ID 对齐。
 * `missing` 非空时项目应判 incomplete，而不是在缩小的分母上宣称达成。
 */
export function collect(
  group: EvaluationGroup | null,
  ids: readonly string[],
  pick: (result: EvaluationResult) => number | null | undefined,
): Collected {
  const byId = new Map((group?.results ?? []).map((result) => [result.id, result]))
  const values: number[] = []
  const missing: string[] = []
  for (const id of ids) {
    const result = byId.get(id)
    const value = result ? pick(result) : undefined
    if (typeof value === 'number' && Number.isFinite(value)) values.push(value)
    else missing.push(id)
  }
  return { values, missing, expected: ids.length }
}
