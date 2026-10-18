import type { WorkflowStep as CloudflareStep, WorkflowStepConfig } from 'cloudflare:workers'
import { NonRetryableError as CloudflareNonRetryableError } from 'cloudflare:workflows'
import { AppError } from '@product-res/shared'
import {
  type JsonValue,
  NonRetryableError,
  type WorkflowInstance as PlatformInstance,
  type Workflow as PlatformWorkflow,
  type WorkflowState,
  type WorkflowStep,
  type WorkflowStepEvent,
  type WorkflowStepOptions,
} from '../index.ts'

function normalizeState<R extends JsonValue>(state: InstanceStatus): WorkflowState<R> {
  if (state.status === 'unknown')
    throw new AppError('WORKFLOW_NOT_FOUND', 'Workflow instance not found', { status: 404 })
  const status =
    state.status === 'complete'
      ? 'completed'
      : state.status === 'errored'
        ? 'failed'
        : state.status === 'waitingForPause' || state.status === 'rollingBack'
          ? 'running'
          : state.status
  return {
    status,
    ...(state.output === undefined ? {} : { output: state.output as R }),
    ...(state.error === undefined ? {} : { error: state.error }),
  }
}

function adaptInstance<R extends JsonValue>(instance: WorkflowInstance): PlatformInstance<R> {
  return {
    id: instance.id,
    status: async () => normalizeState<R>(await instance.status()),
    async terminate() {
      try {
        await instance.terminate()
      } catch (error) {
        // 先查状态再 terminate 之间实例可能自行结束；CF 对终态实例抛
        // instance.cannot_terminate，而 Node（DBOS）对终态取消是空操作。复查确认已是
        // 终态才视为完成，否则原样抛出，不吞掉真实失败。
        const state = await instance.status().catch(() => null)
        if (state && ['complete', 'errored', 'terminated'].includes(state.status)) return
        throw error
      }
    },
    async sendEvent(event) {
      const { status } = normalizeState(await instance.status())
      if (status === 'completed' || status === 'failed' || status === 'terminated')
        throw new AppError('WORKFLOW_TERMINAL', 'Workflow instance is terminal', { status: 409 })
      // 状态检查与发送之间仍可能结束；绑定的错误原样传播，不吞掉竞态。
      await instance.sendEvent(event)
    },
  }
}

export function createCloudflareWorkflow<P extends JsonValue, R extends JsonValue = JsonValue>(
  binding: Pick<Workflow<P>, 'create' | 'get'>,
): PlatformWorkflow<P, R> {
  return {
    create: async (options) => adaptInstance<R>(await binding.create(options)),
    async get(id) {
      const instance = await binding.get(id)
      // CF get 可返回不存在的 handle；在中立边界明确拒绝缺失实例。
      normalizeState(await instance.status())
      return adaptInstance<R>(instance)
    },
  }
}

export function createCloudflareWorkflowStep(step: CloudflareStep): WorkflowStep {
  // Workers 的 Rpc.Serializable<JsonValue> 递归展开超过 TS 深度；此处只收窄 JSON 子集，
  // 不改变绑定调用或允许流/二进制跨步骤。保留 receiver，避免抽出原生方法丢失 this。
  const jsonStep = step as unknown as {
    do(name: string, callback: () => Promise<JsonValue>): Promise<JsonValue>
    do(
      name: string,
      config: WorkflowStepConfig,
      callback: () => Promise<JsonValue>,
    ): Promise<JsonValue>
    waitForEvent(
      name: string,
      options: { type: string; timeout: number },
    ): Promise<WorkflowStepEvent<JsonValue>>
  }
  // CF 引擎把 step 内抛出的错误经 RPC 复制后再拒绝 do()：只保留 name/message，丢失共享
  // NonRetryableError 的实例身份与业务 code。本次 do 内由回调抛出的原错误在同一 isolate 中，
  // 拒绝时据此还原为共享错误（与 Node adapter 一致），引擎拒绝作为 cause 保留供观测关联。
  function call<T extends JsonValue>(
    start: (callback: () => Promise<JsonValue>) => Promise<JsonValue>,
    callback: () => Promise<T>,
  ): Promise<T> {
    let thrown: NonRetryableError | undefined
    const run = async (): Promise<JsonValue> => {
      thrown = undefined
      try {
        return await callback()
      } catch (error) {
        if (!(error instanceof NonRetryableError)) throw error
        thrown = error
        throw new CloudflareNonRetryableError(error.message)
      }
    }
    return start(run).catch((rejection: unknown) => {
      // 重放时引擎可能不再执行回调，此时没有原错误可还原，按原拒绝传播。
      if (!thrown) throw rejection
      const restored = new NonRetryableError(thrown.message, { cause: rejection })
      if ('code' in thrown && typeof thrown.code === 'string')
        Object.assign(restored, { code: thrown.code })
      throw restored
    }) as Promise<T>
  }
  function doStep<T extends JsonValue>(name: string, callback: () => Promise<T>): Promise<T>
  function doStep<T extends JsonValue>(
    name: string,
    options: WorkflowStepOptions,
    callback: () => Promise<T>,
  ): Promise<T>
  function doStep<T extends JsonValue>(
    name: string,
    optionsOrCallback: WorkflowStepOptions | (() => Promise<T>),
    callback?: () => Promise<T>,
  ): Promise<T> {
    if (typeof optionsOrCallback === 'function')
      return call((run) => jsonStep.do(name, run), optionsOrCallback)
    const { retries, timeoutMs } = optionsOrCallback
    const config = {
      ...(retries === undefined
        ? {}
        : {
            retries: {
              limit: retries.limit,
              delay: retries.delayMs,
              ...(retries.backoff === undefined ? {} : { backoff: retries.backoff }),
            },
          }),
      ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
    }
    return call((run) => jsonStep.do(name, config, run), callback as () => Promise<T>)
  }
  return {
    do: doStep,
    sleep: (name, durationMs) => step.sleep(name, durationMs),
    waitForEvent: <T extends JsonValue>(
      name: string,
      options: { type: string; timeoutMs: number },
    ) =>
      jsonStep.waitForEvent(name, {
        type: options.type,
        timeout: options.timeoutMs,
      }) as Promise<WorkflowStepEvent<T>>,
  }
}
