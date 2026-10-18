import {
  CreditsError,
  type CreditsTransaction,
  capture,
  type OveragePolicy,
  release,
} from '@product-res/credits'
import {
  type AiTextUsage,
  type AiUsageCheckpoint,
  aiMessage,
  type CreditHold,
  creditHold,
  type Database,
  scoped,
} from '@product-res/db'
import { and, eq, type SQL, sql } from 'drizzle-orm'
import { actualCredits, type Pricing } from '../pricing.ts'

/**
 * 文本对话的结算（docs/06-ai.md §3，design 决策 6、7、10）：正常完成、停止、出错与超时兜底共用。
 * apps/web 的 `POST /api/ai/chat` 与停止接口、apps/jobs 的预扣超时处理器都从这里调用。
 *
 * 幂等：结算与消息状态更新在同一事务中，`@product-res/credits` 的 capture / release 以预扣状态为闸门，
 * 同一预扣只有一方能结算成功；另一方得到 `HOLD_NOT_ACTIVE`，事务回滚、消息保持先结算者写入的状态。
 */

/** 对话预扣的有效期：超时后由 `ai_message` 兜底处理器结算（specs/ai-chat「出错与结算丢失」） */
export const CHAT_HOLD_TTL_MS = 10 * 60_000
/** 用量检查点的间隔与输出 token 步长，先到者触发（design 决策 10） */
export const CHECKPOINT_INTERVAL_MS = 5_000
export const CHECKPOINT_OUTPUT_TOKENS = 200

export type ChatSettlement = Awaited<ReturnType<typeof capture>>

/** 消息 `parts` 中的文本 */
export function messageText(parts: readonly unknown[]): string {
  return parts
    .flatMap((part) =>
      typeof part === 'object' &&
      part !== null &&
      (part as { type?: unknown }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string'
        ? [(part as { text: string }).text]
        : [],
    )
    .join('')
}

const messageParts = (text: string, reasoning?: string) => [
  ...(reasoning ? [{ type: 'reasoning', text: reasoning }] : []),
  ...(text ? [{ type: 'text', text }] : []),
]

type FailedReplyRefund = 'no-visible-output' | 'all'

interface TextUsageInput extends AiTextUsage {
  /** 仅展示 reasoning 时传入；不传即不保存。 */
  readonly reasoning?: string
  readonly failedReplyRefund?: FailedReplyRefund
}

function usageCheckpoint(input: TextUsageInput, at = new Date()): AiUsageCheckpoint {
  return {
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    ...(input.reasoningTokens === undefined ? {} : { reasoningTokens: input.reasoningTokens }),
    ...(input.absorbed === undefined ? {} : { absorbed: input.absorbed }),
    ...(input.total === undefined ? {} : { total: input.total }),
    ...(input.failedReplyRefund === undefined
      ? {}
      : { failedReplyRefund: input.failedReplyRefund }),
    at: at.toISOString(),
  }
}

const mergedCheckpoint = (checkpoint: AiUsageCheckpoint) =>
  sql`coalesce(${aiMessage.usageCheckpoint}, '{}'::jsonb) || ${JSON.stringify(checkpoint)}::jsonb`

export interface CheckpointScheduleOptions {
  readonly intervalMs?: number
  readonly outputTokens?: number
  readonly now?: () => number
}

/**
 * 检查点节奏：自上次检查点起经过 `intervalMs` 且有新输出，或新增输出达到 `outputTokens` 时到期。
 * 只在收到输出时判断：没有新输出时检查点内容不变，无需重写。
 */
export function checkpointSchedule(options: CheckpointScheduleOptions = {}) {
  const intervalMs = options.intervalMs ?? CHECKPOINT_INTERVAL_MS
  const step = options.outputTokens ?? CHECKPOINT_OUTPUT_TOKENS
  const now = options.now ?? Date.now
  let lastAt = now()
  let lastTokens = 0
  return {
    /** 当前累计输出 token 数下是否应写检查点；返回 true 时同时记为已写 */
    due(outputTokens: number): boolean {
      if (outputTokens <= lastTokens) return false
      const at = now()
      if (outputTokens - lastTokens < step && at - lastAt < intervalMs) return false
      lastAt = at
      lastTokens = outputTokens
      return true
    },
  }
}

export interface UsageCheckpointInput extends TextUsageInput {
  readonly workspaceId: string
  readonly messageId: string
  /** 截至此刻已生成的内容 */
  readonly text: string
  readonly at?: Date
}

/**
 * 写入用量检查点与已生成内容；只更新仍在 streaming 的消息。
 * 返回 false 表示消息已被其他请求结束（停止接口或兜底处理器），调用方应中止生成。
 */
export async function writeUsageCheckpoint(
  db: Database,
  input: UsageCheckpointInput,
): Promise<boolean> {
  const checkpoint = usageCheckpoint(input, input.at)
  const rows = await scoped(db, input.workspaceId)
    .update(
      aiMessage,
      {
        // 普通用量与故障证明独立更新，避免并发检查点抹掉已持久化的证明。
        usageCheckpoint: mergedCheckpoint(checkpoint),
        parts: messageParts(input.text, input.reasoning),
      },
      and(eq(aiMessage.id, input.messageId), eq(aiMessage.status, 'streaming')) as SQL,
    )
    .returning({ id: aiMessage.id })
  return rows.length > 0
}

interface SettleBase {
  readonly workspaceId: string
  readonly messageId: string
  readonly holdId: string
  /** 消息上的定价快照 */
  readonly pricing: Pricing
  readonly overage: OveragePolicy
  /** 仅服务商或 Gateway 回报的完整用量为 actual；含估算的用量必须封顶。 */
  readonly usageSource: 'actual' | 'estimated'
}

export interface SettleChatInput extends SettleBase, TextUsageInput {
  readonly text: string
  readonly inputTokens: number
  readonly outputTokens: number
}

/** 同预扣已被另一方结算时返回 null；其他错误照常抛出 */
async function once<T>(
  db: Database,
  tx: CreditsTransaction | undefined,
  fn: (tx: CreditsTransaction) => Promise<T>,
): Promise<T | null> {
  if (tx) return fn(tx)
  try {
    return await db.transaction(fn)
  } catch (error) {
    if (error instanceof CreditsError && error.code === 'HOLD_NOT_ACTIVE') return null
    throw error
  }
}

/** 估算与 failed 回复均以预扣额封顶；只有正常完成的完整用量可以触发超额。 */
async function settlementAmount(
  tx: CreditsTransaction,
  input: SettleBase & { status?: 'aborted' | 'failed' },
  amount: number,
) {
  if (input.usageSource === 'actual' && input.status === undefined) return amount
  const [reservation] = await scoped(tx, input.workspaceId)
    .select(creditHold, {
      where: eq(creditHold.id, input.holdId),
      fields: { amount: creditHold.amount },
    })
    .limit(1)
  if (!reservation) throw new CreditsError('WORKSPACE_RESOURCE_NOT_FOUND')
  return Math.min(amount, reservation.amount)
}

/**
 * 正常完成时按快照计算结算额，真实用量超出预扣的部分按 `billing.overage` 处理；
 * 缺失用量时的估算以预扣额封顶。同一事务内把消息标记为 completed。
 * 消息上的 `credits` 为空间实际支付的积分（不含平台承担的超额）。
 * 预扣已被停止接口或兜底处理器结算时返回 null，不重复结算。
 */
export function settleChatMessage(
  db: Database,
  input: SettleChatInput,
): Promise<ChatSettlement | null> {
  const actualAmount = actualCredits(input.pricing, {
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
  })
  return once(db, undefined, async (tx) => {
    const settlement = await capture(tx, {
      workspaceId: input.workspaceId,
      holdId: input.holdId,
      actualAmount: await settlementAmount(tx, input, actualAmount),
      overage: input.overage,
    })
    await scoped(tx, input.workspaceId).updateById(aiMessage, input.messageId, {
      status: 'completed',
      parts: messageParts(input.text, input.reasoning),
      usageCheckpoint: mergedCheckpoint(usageCheckpoint(input)),
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      credits: settlement.captured + settlement.debited,
    })
    return settlement
  })
}

export interface SettleInterruptedInput extends SettleBase, TextUsageInput {
  /** 停止 → aborted；出错 / 结算丢失 → failed */
  readonly status: 'aborted' | 'failed'
  /** 已产生的用量（服务商未返回时按检查点或已生成文本估算） */
  readonly inputTokens: number
  readonly outputTokens: number
  /** 已生成的内容；省略时保留消息上已持久化的内容（最后一个检查点） */
  readonly text?: string
  /** 是否已有输出（按次计费 `any_output` 据此决定扣费或释放） */
  readonly hasOutput: boolean
}

/**
 * 未正常完成时的结算额（specs/ai-chat「主动停止」「出错与结算丢失」）：
 * - failed 无可见正文或开启失败全退时释放；用户主动停止维持原计费口径。
 * - 按 token：按已产生用量，不低于 `minCharge`。
 * - 按次：`chargeOn` 为 `any_output`（文本默认）且已有输出时全额，否则释放（undefined）。
 */
export function interruptedCredits(
  pricing: Pricing,
  usage: {
    inputTokens: number
    outputTokens: number
    hasOutput: boolean
    status?: 'aborted' | 'failed'
    failedReplyRefund?: FailedReplyRefund
  },
): number | undefined {
  if (usage.status === 'failed' && (!usage.hasOutput || usage.failedReplyRefund === 'all'))
    return undefined
  switch (pricing.mode) {
    case 'token':
      return actualCredits(pricing, usage)
    case 'per_call':
      return (pricing.chargeOn ?? 'any_output') === 'any_output' && usage.hasOutput
        ? actualCredits(pricing, {})
        : undefined
    case 'per_unit':
      return undefined
  }
}

/**
 * 停止、出错与兜底的结算：按 `interruptedCredits` 扣费或释放预扣，并在同一事务内把消息标记为
 * aborted / failed（保留已生成的部分内容）。传入 `tx` 时在调用方事务中执行（兜底处理器），
 * 否则自行开启事务；预扣已被另一方结算时返回 null。
 */
export function settleInterruptedChatMessage(
  db: Database,
  input: SettleInterruptedInput,
  tx?: CreditsTransaction,
): Promise<ChatSettlement | null> {
  const amount = interruptedCredits(input.pricing, input)
  return once(db, tx, async (tx) => {
    const reservation = { workspaceId: input.workspaceId, holdId: input.holdId }
    let settlement: ChatSettlement = { captured: 0, absorbed: 0, debited: 0, debt: 0 }
    if (amount === undefined) await release(tx, reservation, tx)
    else
      settlement = await capture(
        tx,
        {
          ...reservation,
          actualAmount: await settlementAmount(tx, input, amount),
          overage: input.overage,
        },
        tx,
      )
    await scoped(tx, input.workspaceId).updateById(aiMessage, input.messageId, {
      status: input.status,
      ...(input.text === undefined ? {} : { parts: messageParts(input.text, input.reasoning) }),
      usageCheckpoint: mergedCheckpoint(usageCheckpoint(input)),
      inputTokens: amount !== undefined || input.status === 'failed' ? input.inputTokens : null,
      outputTokens: amount !== undefined || input.status === 'failed' ? input.outputTokens : null,
      credits: settlement.captured + settlement.debited,
    })
    return settlement
  })
}

/**
 * 按消息上已持久化的检查点结算（停止接口跨 isolate、兜底处理器）：
 * 输出用量取最后一个检查点；没有检查点时输出为 0、输入取发起时的估算（存于 `input_tokens`）。
 */
export function settleFromCheckpoint(
  db: Database,
  message: Pick<
    typeof aiMessage.$inferSelect,
    'id' | 'workspaceId' | 'parts' | 'pricing' | 'inputTokens' | 'usageCheckpoint'
  > & { holdId: string; pricing: Pricing },
  options: { status: 'aborted' | 'failed'; overage: OveragePolicy },
  tx?: CreditsTransaction,
): Promise<ChatSettlement | null> {
  const checkpoint = message.usageCheckpoint
  const outputTokens = checkpoint?.outputTokens ?? 0
  return settleInterruptedChatMessage(
    db,
    {
      workspaceId: message.workspaceId,
      messageId: message.id,
      holdId: message.holdId,
      pricing: message.pricing,
      overage: options.overage,
      usageSource: 'estimated',
      status: options.status,
      inputTokens: checkpoint?.inputTokens ?? message.inputTokens ?? 0,
      outputTokens,
      ...(checkpoint?.reasoningTokens === undefined
        ? {}
        : { reasoningTokens: checkpoint.reasoningTokens }),
      ...(checkpoint?.absorbed === undefined ? {} : { absorbed: checkpoint.absorbed }),
      ...(checkpoint?.total === undefined ? {} : { total: checkpoint.total }),
      ...(checkpoint?.failedReplyRefund === undefined
        ? {}
        : { failedReplyRefund: checkpoint.failedReplyRefund }),
      // reasoning 已计入输出用量，但按次的输出判定仍只看正文，与同 isolate 停止一致。
      hasOutput: messageText(message.parts) !== '',
    },
    tx,
  )
}

/**
 * `ai_message` 预扣的超时兜底处理器（design 决策 7），由 apps/jobs 注册到 `registerHoldSweeper`。
 * 只访问数据库：在 hold sweep 的事务中读取消息的定价快照与检查点并结算，消息标记为 failed
 * （保留最后一个检查点的部分内容）；找不到消息或快照时释放预扣。
 */
export function chatHoldSweeper(options: { overage: OveragePolicy }) {
  return async ({
    db,
    tx,
    hold,
  }: {
    db: Database
    tx: CreditsTransaction
    hold: CreditHold
  }): Promise<void> => {
    const [message] = await scoped(tx, hold.workspaceId)
      .select(aiMessage, { where: eq(aiMessage.holdId, hold.id) })
      .limit(1)
    if (!message?.pricing) {
      await release(tx, { workspaceId: hold.workspaceId, holdId: hold.id }, tx)
      return
    }
    await settleFromCheckpoint(
      db,
      { ...message, holdId: hold.id, pricing: message.pricing as Pricing },
      { status: 'failed', overage: options.overage },
      tx,
    )
  }
}
