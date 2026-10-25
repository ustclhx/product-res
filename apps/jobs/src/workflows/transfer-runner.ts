import type { Database } from '@product-res/db'
import {
  beginCompensation,
  compensateBatch,
  completeCompensation,
  finalizeTransfer,
  listTransferBatches,
  loadTransferAfterStart,
  NON_RETRYABLE_TRANSFER_ERRORS,
  planTransfer,
  refreshAfterMove,
  runBatch,
  type TransferConfig,
} from '@product-res/follow/transfer'
import type { KeyValueStore, WorkflowStep, WorkflowStepOptions } from '@product-res/platform'
import { AppError } from '@product-res/shared'
import { log, setLogContext } from '@product-res/shared/log'
import { type JobObserver, logJobObserver } from '../observer.ts'

/**
 * 跨空间数据流转 Workflow（openspec/changes/add-workspace-data-transfer design D8，tasks 4.1）。
 *
 * 步骤：load → plan → 每批 batch:<key> → finalize → refresh（move 的准备度重算）→ sessions。
 *
 * 进入补偿的只有业务失败：引擎的不可重试错误（NON_RETRYABLE_TRANSFER_ERRORS，作为步骤结果持久化）
 * 与本实例总超时（判断在批次步骤内，随结果持久化）。用户取消由 web 把状态置为 compensating，
 * 下一批次 / finalize 返回 TRANSFER_STATE 随之转入补偿。步骤重试耗尽后仍抛出的错误
 * （数据库 / 网络故障、执行权丢失、引擎关停、编程错误等）原样抛出，流转保持进行中，
 * 由“重试续跑”另起的实例从未完成的步骤接手；全部批次完成后 finalize 的故障同样只续跑、不回滚。
 *
 * 补偿：compensate:begin → compensate:list:<n> → compensate:<key>（seq 逆序）→ compensate:complete。
 *
 * 重放确定性：Node 引擎按步骤序号重放，分支只依据已持久化的步骤结果，不在步骤之外读时钟或数据库。
 */

export type { WorkspaceTransferWorkflowParams as WorkspaceTransferParams } from '@product-res/follow/transfer'
export type WorkspaceTransferResult = {
  transferId: string
  status: string
  errorCode?: string
}

export interface TransferRunnerDeps {
  readonly db: Database
  readonly config: TransferConfig
  /** 认证 KV（与删除流程同一 `auth:` 键）；未装配时只依赖 cookieCache 过期 */
  readonly cache?: Pick<KeyValueStore, 'delete'> | undefined
  readonly observer?: JobObserver
  readonly now?: () => number
  /** 本实例的总超时，默认 30 分钟；从实例第一个步骤起算，续跑实例重新计时 */
  readonly timeoutMs?: number
}

export const TRANSFER_WORKFLOW_TIMEOUT_MS = 30 * 60_000
export const TRANSFER_TIMEOUT_CODE = 'TRANSFER_TIMEOUT'

const RETRY: WorkflowStepOptions = {
  retries: { limit: 5, delayMs: 5_000, backoff: 'exponential' },
  timeoutMs: 600_000,
}

type Outcome<T> = { ok: true; value: T } | { ok: false; code: string }

const codeOf = (error: unknown): string | null =>
  error instanceof AppError
    ? error.code
    : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : null

/** 不可重试的业务错误作为步骤结果返回（持久化，重放时同一分支）；其余错误抛出交给步骤重试 */
async function guarded<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    const code = codeOf(error)
    if (code && NON_RETRYABLE_TRANSFER_ERRORS.has(code)) return { ok: false, code }
    throw error
  }
}

const json = <T>(value: T) => value as never

export async function runWorkspaceTransfer(
  transferId: string,
  step: WorkflowStep,
  deps: TransferRunnerDeps,
): Promise<WorkspaceTransferResult> {
  const { db } = deps
  const observer = deps.observer ?? logJobObserver
  const now = deps.now ?? Date.now
  const timeoutMs = deps.timeoutMs ?? TRANSFER_WORKFLOW_TIMEOUT_MS

  // 流转已提交：派生统计与会话缓存失败只记录（KV 副本按 TTL 过期，准备度每周重算）
  const bestEffort = async (name: string, run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      observer.captureException(error)
      log.warn('transfer.workflow.after_failed', { transferId, step: name })
    }
  }
  const invalidate = (tokens: readonly string[]) =>
    bestEffort('sessions', () =>
      step.do('sessions', RETRY, async () => {
        await invalidateSessions(deps.cache, tokens)
        return null
      }),
    )
  const afterCompletion = async (tokens?: readonly string[]) => {
    const sessionTokens =
      tokens ??
      (await step.do('resume:tokens', RETRY, async () => [
        ...(await finalizeTransfer(db, transferId)).sessionTokens,
      ]))
    await bestEffort('refresh', () =>
      step.do('refresh', RETRY, async () => refreshAfterMove(db, transferId)),
    )
    await invalidate(sessionTokens)
    return { transferId, status: 'completed' }
  }

  const startedAt = await step.do('start', async () => now())
  // 先等发起事务结束（holdTransferStart），读到的不存在即发起事务已回滚
  const head = (await step.do('load', RETRY, async () =>
    json(await loadTransferAfterStart(db, transferId)),
  )) as { status: string; source: string; requestedBy: string } | null
  if (!head) {
    log.warn('transfer.workflow.missing', { transferId })
    return { transferId, status: 'missing' }
  }
  setLogContext({ workspaceId: head.source, userId: head.requestedBy })
  observer.tagContext()

  if (head.status === 'completed') return afterCompletion()
  if (head.status === 'compensated') {
    const tokens = await step.do('resume:tokens', RETRY, async () => [
      ...(await completeCompensation(db, transferId)).sessionTokens,
    ])
    await invalidate(tokens)
    return { transferId, status: 'compensated' }
  }

  let failure: string | null = null
  if (head.status === 'pending' || head.status === 'running') {
    const result = await forward(transferId, step, deps, startedAt, now, timeoutMs)
    if (result.ok) return afterCompletion(result.value)
    failure = result.code
    log.warn('transfer.workflow.compensating', { transferId, errorCode: failure })
  } else if (head.status !== 'compensating') {
    // failed / cancelled 等不由本流程推进的状态
    return { transferId, status: head.status }
  }

  // compensating（取消或上一实例已进入补偿）或前进路径的业务失败
  const begun = (await step.do('compensate:begin', RETRY, async () =>
    json(await guarded(() => beginCompensation(db, transferId, failure ?? 'TRANSFER_RESUMED'))),
  )) as Outcome<string>
  if (!begun.ok) {
    // 不能回滚：并发实例已完成（completed）或流转处于其他终态，按实际状态收尾
    const status = await step.do('compensate:state', RETRY, async () => {
      const current = await loadTransferAfterStart(db, transferId)
      return current?.status ?? 'missing'
    })
    if (status === 'completed') return afterCompletion()
    return { transferId, status }
  }
  const undone = new Set<string>()
  let finished = false
  for (let round = 0; !finished; round++) {
    // 每轮重新列出 done 批次：补偿开始前已在执行的批次可能在上一轮列出之后才提交
    const keys = await step.do(`compensate:list:${round}`, RETRY, async () =>
      (await listTransferBatches(db, transferId))
        .filter((batch) => batch.status === 'done' && !undone.has(batch.key))
        .sort((a, b) => b.seq - a.seq)
        .map((batch) => batch.key),
    )
    if (keys.length === 0) break
    for (const key of keys) {
      const outcome = await step.do(`compensate:${key}`, RETRY, async () =>
        alreadyCompensated(db, transferId, () => compensateBatch(db, transferId, key)),
      )
      undone.add(key)
      // 另一实例已完成补偿：不再重试报错，直接收尾
      if (outcome === 'finished') {
        finished = true
        break
      }
    }
  }
  const result = await step.do('compensate:complete', RETRY, async () => {
    const done = await completeCompensation(db, transferId)
    const current = await loadTransferAfterStart(db, transferId)
    return { tokens: [...done.sessionTokens], errorCode: current?.errorCode ?? failure }
  })
  await invalidate(result.tokens)
  return {
    transferId,
    status: 'compensated',
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
  }
}

/** compensateBatch 遇到 TRANSFER_STATE 且流转已 compensated（并发实例完成）时返回 finished */
async function alreadyCompensated(
  db: Database,
  transferId: string,
  run: () => Promise<string>,
): Promise<string> {
  try {
    return await run()
  } catch (error) {
    if (codeOf(error) !== 'TRANSFER_STATE') throw error
    const current = await loadTransferAfterStart(db, transferId)
    if (current?.status === 'compensated') return 'finished'
    throw error
  }
}

/** 前进路径；成功时返回 finalize 切换过活跃空间的会话 token，否则为转入补偿的业务错误码 */
async function forward(
  transferId: string,
  step: WorkflowStep,
  deps: TransferRunnerDeps,
  startedAt: number,
  now: () => number,
  timeoutMs: number,
): Promise<Outcome<string[]>> {
  const { db, config } = deps
  const expired = () => now() - startedAt > timeoutMs
  const plan = (await step.do('plan', RETRY, async () =>
    json(
      await guarded(async () => {
        await planTransfer(db, transferId, config)
        return null
      }),
    ),
  )) as Outcome<null>
  if (!plan.ok) return plan
  const batches = await step.do('batches', RETRY, async () =>
    (await listTransferBatches(db, transferId)).map((batch) => batch.key),
  )
  for (const key of batches) {
    const outcome = (await step.do(`batch:${key}`, RETRY, async () => {
      // 超时判断放在步骤内，结果随步骤持久化，重放时走同一分支
      if (expired()) return json({ ok: false, code: TRANSFER_TIMEOUT_CODE })
      return json(
        await guarded(async () => {
          await runBatch(db, transferId, key, config)
          return null
        }),
      )
    })) as Outcome<null>
    if (!outcome.ok) return outcome
  }
  const finalized = (await step.do('finalize', RETRY, async () =>
    json(await guarded(async () => [...(await finalizeTransfer(db, transferId)).sessionTokens])),
  )) as Outcome<string[]>
  // 全部批次已完成：只有用户在此之前取消（状态已是 compensating）才转补偿，其他错误续跑而不回滚
  if (!finalized.ok && finalized.code !== 'TRANSFER_STATE')
    throw new AppError(finalized.code, 'Transfer finalize failed', { status: 409 })
  return finalized
}

/** 与删除流程相同的 `auth:<token>` 键；KV 未命中时 Better Auth 回退查库，读到新的活跃空间 */
export async function invalidateSessions(
  cache: Pick<KeyValueStore, 'delete'> | undefined,
  tokens: readonly string[],
): Promise<void> {
  if (!cache || tokens.length === 0) return
  const results = await Promise.allSettled(tokens.map((token) => cache.delete(`auth:${token}`)))
  if (results.some((result) => result.status === 'rejected'))
    throw new AppError('TRANSFER_SESSION_CACHE_FAILED', 'Session cache invalidation failed', {
      status: 503,
    })
}
