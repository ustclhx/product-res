import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type AvailableModel, defaultLanguageModelFactory, type TextModelEnv } from '@product-res/ai'
import type { LanguageModel } from 'ai'
import { z } from 'zod'
import { EvalConfigError, TEXT_ENV_KEYS } from './errors.ts'
import type { ModelSpec } from './suite.ts'

/**
 * 模式与模型构造（design D5、D6）：
 * - 回放（默认）只读录制，不访问网络；录制缺失记 `no-recording`，与当前渲染不符记 `stale-recording`；
 * - 真实 / 录制模式按套件声明拼出 `AvailableModel` 交给 `defaultLanguageModelFactory`，
 *   与线上走同一套出口（direct / gateway），密钥只在请求头中，不进录制与报告。
 */
export type Mode = 'replay' | 'live' | 'record'

/** `CI` 为真（非空且不是 false / 0）时拒绝真实调用，不提供绕过开关 */
export function isCi(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env.CI?.trim().toLowerCase()
  return Boolean(value) && value !== 'false' && value !== '0'
}

export function assertModeAllowed(
  mode: Mode,
  budgetUsd: number | undefined,
  env: Readonly<Record<string, string | undefined>>,
) {
  if (mode === 'replay') return
  if (isCi(env))
    throw new EvalConfigError(
      `--${mode} is refused when CI is set; real model evals need a dedicated manual workflow`,
    )
  if (budgetUsd === undefined) throw new EvalConfigError(`--${mode} requires --budget-usd <usd>`)
}

/** 只取文本模型出口需要的变量；这些值只交给模型工厂，不进入报告或录制 */
export function textModelEnv(env: Readonly<Record<string, string | undefined>>): TextModelEnv {
  const picked: Record<string, string> = {}
  for (const key of TEXT_ENV_KEYS) {
    const value = env[key]
    if (value !== undefined) picked[key] = value
  }
  return picked as TextModelEnv
}

/** 按套件声明拼出 AvailableModel 形状；计费与注册表字段填中性值（命令行不读数据库） */
export function availableModel(key: string, spec: ModelSpec): AvailableModel {
  return {
    id: key,
    key,
    kind: 'text',
    provider: spec.provider,
    providerModelId: spec.providerModelId,
    pricing: { mode: 'token', inputPer1k: 0, outputPer1k: 0 },
    tags: [],
    paramsSchema: null,
    sort: 0,
  }
}

export type ModelFor = (key: string, spec: ModelSpec) => LanguageModel

export function liveModelFactory(env: Readonly<Record<string, string | undefined>>): ModelFor {
  const modelEnv = textModelEnv(env)
  return (key, spec) => defaultLanguageModelFactory(availableModel(key, spec), modelEnv)
}

const usageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
})
const modelSchema = z.strictObject({
  key: z.string(),
  provider: z.string(),
  providerModelId: z.string(),
})
const common = {
  promptVersion: z.string(),
  model: modelSchema,
  output: z.string(),
  finishReason: z.string(),
  usage: usageSchema,
  recordedAt: z.string(),
  /** recorded：真实模型；constructed：按约定手写（示例套件） */
  source: z.enum(['recorded', 'constructed']),
}

/** 录制只保存这些字段：不含请求头、端点 URL、密钥或原始响应 */
export const generationRecordingSchema = z.strictObject({
  kind: z.literal('generation'),
  renderedHash: z.string(),
  ...common,
  /** 真实生成耗时（毫秒）；回放读取此值，旧录制缺省 */
  durationMs: z.number().int().nonnegative().optional(),
})
export const judgeRecordingSchema = z.strictObject({
  kind: z.literal('judge'),
  rubricVersion: z.string(),
  /** 被评正文（套件声明 prepareOutput 时为转换后正文）的摘要；与当前不符时视为过期 */
  outputHash: z.string(),
  /** 录制时的 prepareOutput 版本；未声明转换时缺省 */
  prepareVersion: z.string().optional(),
  ...common,
})
export type GenerationRecording = z.infer<typeof generationRecordingSchema>
export type JudgeRecording = z.infer<typeof judgeRecordingSchema>

export function generationRecordingPath(
  dir: string,
  promptVersion: string,
  modelKey: string,
  sampleId: string,
) {
  return join(dir, 'recordings', promptVersion, modelKey, `${sampleId}.json`)
}

export function judgeRecordingPath(
  dir: string,
  promptVersion: string,
  modelKey: string,
  sampleId: string,
  judgeKey: string,
) {
  return join(dir, 'recordings', promptVersion, modelKey, `${sampleId}.judge.${judgeKey}.json`)
}

export type ReadResult<T> =
  | { readonly ok: true; readonly recording: T }
  | { readonly ok: false; readonly reason: string }

export function readRecording<T>(path: string, schema: z.ZodType<T>): ReadResult<T> {
  if (!existsSync(path)) return { ok: false, reason: 'recording not found' }
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.success
      ? { ok: true, recording: parsed.data }
      : { ok: false, reason: 'recording does not match the recording schema' }
  } catch {
    return { ok: false, reason: 'recording is not valid JSON' }
  }
}

export function writeRecording(path: string, recording: GenerationRecording | JudgeRecording) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(recording, null, 2)}\n`)
}

/** 模型字段：只记录键、Provider 与模型 ID */
export const modelRef = (key: string, spec: ModelSpec) => ({
  key,
  provider: spec.provider,
  providerModelId: spec.providerModelId,
})
