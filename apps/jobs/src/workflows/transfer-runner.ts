import { type Database, workspaceTransfer } from '@product-res/db'
import {
  beginCompensation,
  compensateBatch,
  completeCompensation,
  finalizeTransfer,
  listTransferBatches,
  NON_RETRYABLE_TRANSFER_ERRORS,
  planTransfer,
  runBatch,
  type TransferConfig,
} from '@product-res/follow/transfer'
import type { KeyValueStore, WorkflowStep, WorkflowStepOptions } from '@product-res/platform'
import { AppError } from '@product-res/shared'
import { log, setLogContext } from '@product-res/shared/log'
import { eq } from 'drizzle-orm'
import { type JobObserver, logJobObserver } from '../observer.ts'

/**
 * 跨空间数据流转 Workflow（openspec/changes/add-workspace-data-transfer design D8，tasks 4.1）。
 *
 * 步骤：plan → 每批 batch:<key> → finalize；不可重试错误（NON_RETRYABLE_TRANSFER_ERRORS）、
 * 步骤重试耗尽或总超时进入补偿：beginCompensation → 逐批 compensate:<key>（seq 逆序）→
 * compensate:complete。用户取消由 web 把状态置为 compensating，下一批次 / finalize 抛
 * TRANSFER_STATE（不可重试），本流程随之转入补偿路径；不依赖 sendEvent。
 *
 * 重放确定性：Node 引擎按步骤序号重放，分支只依据已持久化的步骤结果（含超时判断），
 * 不在步骤之外读时钟或数据库。引擎函数各自幂等（批次 done 跳过、状态条件迁移），
 * 因此“重试续跑”另起的实例与原实例并发执行也安全。
 */

export type { WorkspaceTransferWorkflowParams as WorkspaceTransferParams } from '@product-res/follow/transfer'
export type WorkspaceTransferResult = {
  transferId: string
  status: 'completed' | 'compensated' | 'missing'
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
/** 可重试错误在步骤重试耗尽后转入补偿时的错误码（原错误码不可得时） */
export const TRANSFER_STEP_FAILED_CODE = 'TRANSFER_STEP_FAILED'

const RETRY: WorkflowStepOptions = {
  retries: { limit: 5, delayMs: 5_000, backoff: 'exponential' },
  timeoutMs: 600_000,
}
// web 在提交事务前投递实例时，记录可能尚未可见：短暂重试后仍不存在视为已回滚
const LOAD_RETRY: WorkflowStepOptions = {
  retries: { limit: 4, delayMs: 2_000, backoff: 'exponential' },
  timeoutMs: 30_000,
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

  const startedAt = await step.do('start', async () => now())
  let head: Awaited<ReturnType<typeof listHead>>[number]
  try {
    head = await step.do('load', LOAD_RETRY, async () => {
      const [found] = await listHead(db, transferId)
      if (!found)
        throw new AppError('TRANSFER_NOT_FOUND', 'Transfer record not visible yet', { status: 404 })
      return found
    })
  } catch (error) {
    if (codeOf(error) !== 'TRANSFER_NOT_FOUND') throw error
    log.warn('transfer.workflow.missing', { transferId })
    return { transferId, status: 'missing' }
  }
  setLogContext({ workspaceId: head.source, userId: head.requestedBy })
  observer.tagContext()

  const invalidate = async (name: string, tokens: readonly string[]) => {
    try {
      await step.do(name, RETRY, async () => {
        await invalidateSessions(deps.cache, tokens)
        return null
      })
    } catch (error) {
      // 流转已提交；KV 副本最迟按 TTL 过期，失效失败不改变流转结果
      observer.captureException(error)
      log.warn('transfer.workflow.session_cache_failed', { transferId })
    }
  }

  if (head.status === 'completed' || head.status === 'compensated') {
    // 前一实例在迁移后、失效会话前中断：迁移结果原样返回 token，重新失效即可
    const tokens = await step.do('resume:tokens', RETRY, async () =>
      head.status === 'completed'
        ? [...(await finalizeTransfer(db, transferId)).sessionTokens]
        : [...(await completeCompensation(db, transferId)).sessionTokens],
    )
    await invalidate('sessions', tokens)
    return { transferId, status: head.status }
  }

  let failure: string | null = null
  if (head.status === 'pending' || head.status === 'running') {
    let result: Outcome<string[]>
    try {
      result = await forward(transferId, step, deps, startedAt, now, timeoutMs)
    } catch (error) {
      // 可重试错误在步骤重试耗尽后仍失败：补偿回滚，避免两个空间长期停在只读
      observer.captureException(error)
      result = { ok: false, code: codeOf(error) ?? TRANSFER_STEP_FAILED_CODE }
    }
    if (result.ok) {
      await invalidate('sessions', result.value)
      return { transferId, status: 'completed' }
    }
    failure = result.code
    log.warn('transfer.workflow.compensating', { transferId, errorCode: failure })
  }

  // compensating（取消或上一实例已进入补偿）或前进路径失败
  const begun = await step.do('compensate:begin', RETRY, async () =>
    json(await guarded(() => beginCompensation(db, transferId, failure ?? 'TRANSFER_RESUMED'))),
  )
  if (!(begun as Outcome<string>).ok) {
    // completed / cancelled 不能回滚：finalize 已在并发实例中提交
    const tokens = await step.do('resume:tokens', RETRY, async () => [
      ...(await finalizeTransfer(db, transferId)).sessionTokens,
    ])
    await invalidate('sessions', tokens)
    return { transferId, status: 'completed' }
  }
  const undone = new Set<string>()
  for (let round = 0; ; round++) {
    // 每轮重新列出 done 批次：补偿开始前已在执行的批次（并发实例）可能在上一轮列出之后才提交
    const keys = await step.do(`compensate:list:${round}`, RETRY, async () =>
      (await listTransferBatches(db, transferId))
        .filter((batch) => batch.status === 'done' && !undone.has(batch.key))
        .sort((a, b) => b.seq - a.seq)
        .map((batch) => batch.key),
    )
    if (keys.length === 0) break
    for (const key of keys) {
      await step.do(`compensate:${key}`, RETRY, async () => compensateBatch(db, transferId, key))
      undone.add(key)
    }
  }
  const result = await step.do('compensate:complete', RETRY, async () => {
    const done = await completeCompensation(db, transferId)
    const [final] = await listHead(db, transferId)
    return { tokens: [...done.sessionTokens], errorCode: final?.errorCode ?? failure }
  })
  await invalidate('sessions', result.tokens)
  return {
    transferId,
    status: 'compensated',
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
  }
}

/** 前进路径；成功时返回 finalize 切换过活跃空间的会话 token，否则为转入补偿的错误码 */
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
  return (await step.do('finalize', RETRY, async () =>
    json(await guarded(async () => [...(await finalizeTransfer(db, transferId)).sessionTokens])),
  )) as Outcome<string[]>
}

function listHead(db: Database, transferId: string) {
  return db
    .select({
      status: workspaceTransfer.status,
      source: workspaceTransfer.sourceWorkspaceId,
      target: workspaceTransfer.targetWorkspaceId,
      requestedBy: workspaceTransfer.requestedBy,
      errorCode: workspaceTransfer.errorCode,
    })
    .from(workspaceTransfer)
    .where(eq(workspaceTransfer.id, transferId))
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
