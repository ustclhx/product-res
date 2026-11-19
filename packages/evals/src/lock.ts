import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  promptCanonicalJson,
  promptSha256,
  renderedPromptDigest,
  renderPrompt,
} from '@product-res/ai'
import { z } from 'zod'
import { EvalConfigError } from './errors.ts'
import type { Sample } from './sample.ts'
import type { SuiteDefinition } from './suite.ts'

/**
 * 版本锁（design D2）：`prompts.lock.json` 记录每个提示词版本对每个样本的输入摘要与渲染摘要。
 * 每次运行都重新渲染比对；已有条目不一致即配置错误（锁不变），新版本与新样本只追加，已有条目从不改写。
 */
export interface LockEntry {
  readonly input: string
  readonly rendered: string
}

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const lockSchema = z.record(
  z.string(),
  z.record(z.string(), z.strictObject({ input: digest, rendered: digest })),
)

export type PromptLock = Record<string, Record<string, LockEntry>>

export const LOCK_FILE = 'prompts.lock.json'

export interface LockResult {
  /** promptVersion → sampleId → 当前渲染摘要 */
  readonly rendered: ReadonlyMap<string, ReadonlyMap<string, string>>
  /** 本次追加的条目数 */
  readonly appended: number
}

function readLock(file: string): PromptLock {
  if (!existsSync(file)) return {}
  let data: unknown
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new EvalConfigError(
      `${LOCK_FILE} is not valid JSON (${error instanceof Error ? error.message : error})`,
    )
  }
  const parsed = lockSchema.safeParse(data)
  if (!parsed.success)
    throw new EvalConfigError(
      `${LOCK_FILE} has an invalid shape: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
        .join('; ')}`,
    )
  return parsed.data
}

export interface VerifyLockOptions {
  /**
   * 冻结：任何追加都是配置错误（CI 为真或 `--frozen-lock`）。否则删掉锁条目即可
   * 让改过内容的旧版本被重新锁定，CI 无法发现。
   */
  readonly frozen?: boolean
}

export async function verifyLock(
  suite: SuiteDefinition,
  samples: readonly Sample[],
  dir: string,
  options: VerifyLockOptions = {},
): Promise<LockResult> {
  const file = join(dir, LOCK_FILE)
  const lock = readLock(file)
  const next: PromptLock = structuredClone(lock)
  const rendered = new Map<string, Map<string, string>>()
  const conflicts: string[] = []
  let appended = 0
  for (const prompt of suite.prompts) {
    const hashes = new Map<string, string>()
    rendered.set(prompt.promptVersion, hashes)
    for (const sample of samples) {
      let entry: LockEntry
      try {
        entry = {
          input: await promptSha256(promptCanonicalJson(sample.input)),
          rendered: await renderedPromptDigest(renderPrompt(prompt, sample.input)),
        }
      } catch (error) {
        throw new EvalConfigError(
          `${prompt.promptVersion} cannot render sample ${sample.id}: ${error instanceof Error ? error.message : error}`,
        )
      }
      hashes.set(sample.id, entry.rendered)
      const existing = lock[prompt.promptVersion]?.[sample.id]
      if (existing) {
        if (existing.input !== entry.input)
          conflicts.push(
            `sample ${sample.id} input changed since it was locked for ${prompt.promptVersion}; add a new sample id instead of editing an existing sample`,
          )
        else if (existing.rendered !== entry.rendered)
          conflicts.push(
            `${prompt.promptVersion} content changed for sample ${sample.id}; create a new prompt version instead of editing ${prompt.promptVersion}`,
          )
        continue
      }
      if (options.frozen) {
        conflicts.push(
          `${prompt.promptVersion} / ${sample.id} is not in ${LOCK_FILE}; the lock is frozen (CI or --frozen-lock), run the eval locally once and commit the lock`,
        )
        continue
      }
      next[prompt.promptVersion] ??= {}
      ;(next[prompt.promptVersion] as Record<string, LockEntry>)[sample.id] = entry
      appended++
    }
  }
  if (conflicts.length)
    throw new EvalConfigError(`${LOCK_FILE} conflict:\n  - ${conflicts.join('\n  - ')}`)
  if (appended) writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`)
  return { rendered, appended }
}
