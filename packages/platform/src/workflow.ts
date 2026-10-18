/** 跨步骤只持久化 JSON，流、二进制、数据库对象不能作为步骤结果。 */
export type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue }
export type WorkflowStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'terminated'

export interface WorkflowState<R extends JsonValue = JsonValue> {
  readonly status: WorkflowStatus
  readonly output?: R
  readonly error?: { name: string; message: string }
}
export interface WorkflowInstance<R extends JsonValue = JsonValue> {
  readonly id: string
  status(): Promise<WorkflowState<R>>
  terminate(): Promise<void>
  sendEvent(event: { type: string; payload: JsonValue }): Promise<void>
}
/** P/R 必须可 JSON 序列化；稳定业务 ID（媒体 task.id）由调用方提供。 */
export interface Workflow<P extends JsonValue = JsonValue, R extends JsonValue = JsonValue> {
  create(options: { id?: string; params: P }): Promise<WorkflowInstance<R>>
  get(id: string): Promise<WorkflowInstance<R>>
}

export interface WorkflowStepOptions {
  retries?: { limit: number; delayMs: number; backoff?: 'constant' | 'linear' | 'exponential' }
  timeoutMs?: number
}
export interface WorkflowStepEvent<T> {
  readonly type: string
  readonly payload: Readonly<T>
  readonly timestamp: Date
}
export interface WorkflowStep {
  do<T extends JsonValue>(name: string, callback: () => Promise<T>): Promise<T>
  do<T extends JsonValue>(
    name: string,
    options: WorkflowStepOptions,
    callback: () => Promise<T>,
  ): Promise<T>
  sleep(name: string, durationMs: number): Promise<void>
  waitForEvent<T extends JsonValue = JsonValue>(
    name: string,
    options: { type: string; timeoutMs: number },
  ): Promise<WorkflowStepEvent<T>>
}

/** 两目标共享的不可重试信号，由目标 adapter 转换为引擎异常。 */
export class NonRetryableError extends Error {
  override readonly name = 'NonRetryableError'
}
