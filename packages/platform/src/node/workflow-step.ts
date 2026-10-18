import { DBOS, Error as DBOSErrors } from '@dbos-inc/dbos-sdk'
import { AppError } from '@product-res/shared'
import { withLogContext } from '@product-res/shared/log'
import {
  type JsonValue,
  NonRetryableError,
  type WorkflowStep,
  type WorkflowStepEvent,
  type WorkflowStepOptions,
} from '../workflow.ts'
import type { NodeJobEngine } from './job-engine.ts'
import { waitForNodeWorkflowEvent } from './workflow-events.ts'
import { jsonValue } from './workflow-json.ts'

interface StepFailure {
  kind: 'error' | 'app' | 'non-retryable'
  name: string
  message: string
  code: string | null
  status: number | null
}

type StepOutcome = { ok: true; value: JsonValue } | { ok: false; error: StepFailure }

function invalid(message: string): AppError {
  return new AppError('WORKFLOW_INVALID_STEP', message)
}

function milliseconds(value: number, field: string, positive = false): void {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0))
    throw invalid(`${field} must be a ${positive ? 'positive' : 'nonnegative'} safe integer`)
}

function retryDelay(options: WorkflowStepOptions, retry: number): number {
  const { delayMs = 0, backoff = 'exponential' } = options.retries ?? {}
  // 零延迟不计算巨大指数，避免 0 * Infinity 变成 NaN。
  if (delayMs === 0) return 0
  const multiplier = backoff === 'linear' ? retry : backoff === 'exponential' ? 2 ** (retry - 1) : 1
  return delayMs * multiplier
}

function serializeFailure(value: unknown): StepFailure {
  const error = value instanceof Error ? value : new Error(String(value))
  return {
    kind:
      error instanceof NonRetryableError
        ? 'non-retryable'
        : error instanceof AppError
          ? 'app'
          : 'error',
    name: error.name,
    message: error.message,
    code: 'code' in error && typeof error.code === 'string' ? error.code : null,
    status: error instanceof AppError ? error.status : null,
  }
}

function restoreFailure(failure: StepFailure): Error {
  if (failure.kind === 'app')
    return new AppError(failure.code as string, failure.message, {
      status: failure.status as number,
    })
  const error: Error =
    failure.kind === 'non-retryable'
      ? new NonRetryableError(failure.message)
      : new Error(failure.message)
  if (failure.kind === 'error') error.name = failure.name
  if (failure.code !== null) Object.assign(error, { code: failure.code })
  return error
}

export function createNodeWorkflowStep(engine: NodeJobEngine, workflowID: string): WorkflowStep {
  const names = new Set<string>()
  function reserve(name: string): void {
    if (typeof name !== 'string' || name.trim().length === 0)
      throw invalid('Step name must be nonempty')
    if (names.has(name)) throw invalid('Step names must be unique within a workflow')
    names.add(name)
  }

  function doStep<T extends JsonValue>(name: string, callback: () => Promise<T>): Promise<T>
  function doStep<T extends JsonValue>(
    name: string,
    options: WorkflowStepOptions,
    callback: () => Promise<T>,
  ): Promise<T>
  async function doStep<T extends JsonValue>(
    name: string,
    optionsOrCallback: WorkflowStepOptions | (() => Promise<T>),
    callback?: () => Promise<T>,
  ): Promise<T> {
    const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback
    const run = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback
    if (typeof run !== 'function') throw invalid('Step callback must be a function')
    if (options.timeoutMs !== undefined) milliseconds(options.timeoutMs, 'timeoutMs', true)
    const limit = options.retries?.limit ?? 0
    if (options.retries !== undefined) {
      milliseconds(limit, 'retries.limit')
      milliseconds(options.retries.delayMs, 'retries.delayMs')
      if (
        options.retries.backoff !== undefined &&
        !['constant', 'linear', 'exponential'].includes(options.retries.backoff)
      )
        throw invalid('Invalid retry backoff')
      if (limit > 0) milliseconds(retryDelay(options, limit), 'Retry delay')
    }
    reserve(name)

    // 每次失败作为成功的 JSON envelope 写检查点；原生内部重试不持久保存次数/等待。
    for (let attempt = 0; ; attempt++) {
      await engine.assertOwnership()
      let outcome: StepOutcome
      try {
        outcome = await DBOS.runStep<StepOutcome>(
          async () => {
            await engine.assertOwnership()
            let result: StepOutcome
            try {
              result = {
                ok: true,
                value: jsonValue(await withLogContext({ attempt: attempt + 1 }, run)),
              }
            } catch (error) {
              result = { ok: false, error: serializeFailure(error) }
            }
            // 失去执行权时不能把成功/业务失败写成可继续重放的检查点。
            await engine.assertOwnership()
            return result
          },
          {
            name: `workflow.do:${JSON.stringify([name, attempt])}`,
            retriesAllowed: false,
            // 原生 timeout 只丢弃结果，不能停止不合作的 callback；外部副作用仍需业务幂等。
            ...(options.timeoutMs === undefined ? {} : { timeoutMS: options.timeoutMs }),
          },
        )
      } catch (error) {
        // 固定版原生 timeout 的检查点恢复为普通 Error，但仍保留 dbosErrorCode=31。
        if (
          !(error instanceof DBOSErrors.DBOSStepTimeoutError) &&
          !(error instanceof Error && DBOSErrors.getDBOSErrorCode(error) === 31)
        )
          throw error
        outcome = {
          ok: false,
          error: serializeFailure(
            new AppError('WORKFLOW_STEP_TIMEOUT', 'Workflow step timed out', { status: 504 }),
          ),
        }
      }
      await engine.assertOwnership()
      if (outcome.ok) return outcome.value as T
      if (outcome.error.kind === 'non-retryable' || attempt >= limit)
        throw restoreFailure(outcome.error)
      // DBOS 持久保存首次调用时的唤醒时间；重启不重新计算整段退避。
      await DBOS.sleep(retryDelay(options, attempt + 1))
    }
  }

  return {
    do: doStep,
    async sleep(name, durationMs) {
      milliseconds(durationMs, 'durationMs')
      reserve(name)
      await engine.assertOwnership()
      // sleep 原生只有序号；命名 marker 同时检测重放时步骤名称/顺序变化。
      await DBOS.runStep(
        async () => {
          await engine.assertOwnership()
          return null
        },
        { name: `workflow.sleep:${JSON.stringify(name)}`, retriesAllowed: false },
      )
      await DBOS.sleep(durationMs)
      await engine.assertOwnership()
    },
    async waitForEvent<T extends JsonValue>(
      name: string,
      options: { type: string; timeoutMs: number },
    ): Promise<WorkflowStepEvent<T>> {
      milliseconds(options.timeoutMs, 'timeoutMs', true)
      reserve(name)
      await engine.assertOwnership()
      const event = await waitForNodeWorkflowEvent(engine, workflowID, name, options)
      await engine.assertOwnership()
      return event as WorkflowStepEvent<T>
    },
  }
}
