import { type CreditsExecutor, withCreditsTransaction } from '@product-res/credits'
import { type AiTask, aiTask, scoped } from '@product-res/db'
import { AppError } from '@product-res/shared'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  type AcceptanceFaultMode,
  type FaultAccessContext,
  parseAcceptanceFault,
} from '../fault.ts'

export type MediaFaultMode = Exclude<AcceptanceFaultMode, 'chat-before-stream' | 'chat-mid-stream'>

const modes = z.enum([
  'workers-error',
  'workers-timeout',
  'fal-callback-lost',
  'fal-callback-early',
  'fal-submit-response-lost',
  'fal-provider-error',
  'fal-timeout',
])

const faultSnapshot = z.strictObject({
  mode: modes,
  policyVersion: z.literal(1),
  authorizedAdmin: z.literal(true),
  deadlineMs: z.number().int().positive(),
  initialWaitMs: z.number().int().nonnegative(),
  barrierMs: z.number().int().nonnegative(),
})
export type MediaAcceptanceFault = z.infer<typeof faultSnapshot>

export interface MediaAcceptanceFaultProof {
  mode: MediaFaultMode
  policyVersion: 1
  injected: boolean
  realProviderCalled: boolean
  submitAttempts: number
  pollCount: number
  realRequestId?: string
  injectedAt?: string
  callbackStoredAt?: string
  callbackCheckedAt?: string
  cancellation?: {
    status: 'cancellation-requested' | 'already-terminal' | 'unconfirmed'
    providerStatus?: string
  }
}

/** 时间策略只能由版本化代码产生，调用者与后台元数据都不能调整。 */
export function mediaFaultPolicy(mode: MediaFaultMode): MediaAcceptanceFault {
  return {
    mode,
    policyVersion: 1,
    authorizedAdmin: true,
    deadlineMs: mode === 'workers-timeout' || mode === 'fal-timeout' ? 60_000 : 20 * 60_000,
    initialWaitMs: mode.startsWith('fal-') ? 5_000 : 0,
    barrierMs: mode === 'fal-callback-early' ? 10 * 60_000 : 0,
  }
}

export function createMediaFault(
  model: Parameters<typeof parseAcceptanceFault>[0],
  access?: FaultAccessContext,
): MediaAcceptanceFault | undefined {
  const fault = parseAcceptanceFault(model)
  if (!fault) return
  if (fault.mode.startsWith('chat-') || !access?.enabled || !access.platformAdmin)
    throw new AppError('MODEL_UNAVAILABLE', 'Model is not available', { status: 404 })
  return mediaFaultPolicy(fault.mode as MediaFaultMode)
}

const invalid = () =>
  new AppError('MEDIA_INPUT_INVALID', 'Invalid media fault snapshot', { status: 500 })

export function parseMediaFaultSnapshot(value: unknown): MediaAcceptanceFault {
  const parsed = faultSnapshot.safeParse(value)
  if (!parsed.success) throw invalid()
  const expected = mediaFaultPolicy(parsed.data.mode)
  if (
    Object.keys(expected).some(
      (key) => expected[key as keyof typeof expected] !== parsed.data[key as keyof typeof expected],
    )
  )
    throw invalid()
  return parsed.data
}

/** 已接受任务只读取冻结配置；专用 key 缺快照也不能回退成普通 Provider。 */
export function readMediaFault(task: Pick<AiTask, 'input' | 'modelKey' | 'kind' | 'provider'>) {
  if (!Object.hasOwn(task.input, 'acceptanceFault')) {
    if (task.modelKey.startsWith('acceptance-fault-')) throw invalid()
    return undefined
  }
  const parsed = parseMediaFaultSnapshot(task.input.acceptanceFault)
  try {
    parseAcceptanceFault({
      key: task.modelKey,
      kind: task.kind,
      provider: task.provider,
      providerModelId: String(task.input.providerModelId ?? ''),
      paramsSchema: { 'x-acceptance-fault': { mode: parsed.mode } },
    })
  } catch (error) {
    if (error instanceof AppError) throw invalid()
    throw error
  }
  return parsed
}

export function initialMediaFaultProof(fault: MediaAcceptanceFault): MediaAcceptanceFaultProof {
  return {
    mode: fault.mode,
    policyVersion: 1,
    injected: false,
    realProviderCalled: false,
    submitAttempts: 0,
    pollCount: 0,
  }
}

/** 证明与不可变配置分开，空间→任务锁下仅局部合并子树，不覆盖业务参数。 */
export async function updateMediaFaultProof(
  db: CreditsExecutor,
  task: Pick<AiTask, 'workspaceId' | 'id'>,
  patch: Partial<MediaAcceptanceFaultProof>,
): Promise<void> {
  await withCreditsTransaction(db, undefined, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`ws:${task.workspaceId}`}, 0))`,
    )
    const tenant = scoped(tx, task.workspaceId)
    const [current] = await tenant.select(aiTask, { where: eq(aiTask.id, task.id) }).for('update')
    if (!current) throw new AppError('NOT_FOUND', 'Not found', { status: 404 })
    if (!readMediaFault(current)) throw invalid()
    await tenant.updateById(aiTask, task.id, {
      input: sql`${aiTask.input} || jsonb_build_object('acceptanceFaultProof', coalesce(${aiTask.input}->'acceptanceFaultProof', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb)`,
    })
  })
}
