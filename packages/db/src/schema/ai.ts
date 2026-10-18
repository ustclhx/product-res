import { newId } from '@product-res/shared'
import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { creditHold } from './credits.ts'
import { organization } from './tenancy.ts'

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}

/**
 * 计费方式的 JSON 形态（docs/06-ai.md §2）。db 层不依赖 @product-res/ai，
 * 读取后一律经 `parsePricing` 校验为 `Pricing` 再使用。
 */
export type AiPricingJson = { mode: 'per_call' | 'token' | 'per_unit' } & Record<string, unknown>

/** 文本输出用量已包含 reasoning；absorbed 为平台承担的废弃 attempt 用量。 */
export interface AiTextUsage {
  inputTokens: number
  outputTokens: number
  reasoningTokens?: number
  absorbed?: { inputTokens: number; outputTokens: number; reasoningTokens?: number }
  /** 所有上游 attempt 的累计成本用量，与用户结算用量分开。 */
  total?: { inputTokens: number; outputTokens: number; reasoningTokens: number }
}

/** 生成过程中定期写入的累计用量估算，结算丢失时兜底按它结算（docs/06-ai.md §3） */
export interface AiUsageCheckpoint extends AiTextUsage {
  /** 发起回复时的模板策略快照，避免在途配置改变结算口径。 */
  failedReplyRefund?: 'no-visible-output' | 'all'
  /** ISO 时间 */
  at: string
  /** 验收包装器的最小执行证明；不包含提示词或输出正文。 */
  acceptanceFaultProof?: {
    mode: 'chat-before-stream' | 'chat-mid-stream'
    policyVersion: 1
    phase: 'pending' | 'before-stream' | 'mid-stream'
    injected: boolean
    realProviderCalled: boolean
    upstreamCalls: number
    injectedAt?: string
    outputTokens?: number
  }
}

/**
 * 模型注册表（docs/03-data-model.md §5）：后台可编辑，经 KV 缓存。
 * `min_plan_features` 为模型标签，与 `plan.features.models` 中的 key / 标签匹配决定可见性。
 */
export const aiModel = pgTable(
  'ai_model',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    key: text('key').notNull().unique(),
    kind: text('kind', { enum: ['text', 'image', 'video'] }).notNull(),
    provider: text('provider').notNull(),
    providerModelId: text('provider_model_id').notNull(),
    pricing: jsonb('pricing').$type<AiPricingJson>().notNull(),
    minPlanFeatures: jsonb('min_plan_features').$type<string[]>().notNull().default([]),
    paramsSchema: jsonb('params_schema').$type<Record<string, unknown>>(),
    enabled: boolean('enabled').notNull().default(true),
    sort: integer('sort').notNull().default(0),
    ...timestamps,
  },
  (t) => [index('ai_model_enabled_sort_idx').on(t.enabled, t.sort)],
)

/** 文本对话；只对创建者可见，查询在 scoped(ws) 之上再加 user_id 过滤 */
export const aiConversation = pgTable(
  'ai_conversation',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    title: text('title').notNull().default(''),
    modelKey: text('model_key').notNull(),
    archived: boolean('archived').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    index('ai_conversation_workspace_id_id_idx').on(t.workspaceId, t.id.desc()),
    index('ai_conversation_workspace_user_id_idx').on(t.workspaceId, t.userId, t.id.desc()),
  ],
)

/**
 * 对话消息：`parts` 兼容 AI SDK UIMessage；assistant 消息的 `pricing` 为发起时的定价快照，
 * 预扣与结算只读这份快照（docs/06-ai.md §2「定价快照」）。
 */
export const aiMessage = pgTable(
  'ai_message',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => aiConversation.id, { onDelete: 'restrict' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    role: text('role', { enum: ['user', 'assistant', 'system', 'tool'] }).notNull(),
    parts: jsonb('parts').$type<unknown[]>().notNull().default([]),
    modelKey: text('model_key'),
    pricing: jsonb('pricing').$type<AiPricingJson>(),
    status: text('status', { enum: ['streaming', 'completed', 'aborted', 'failed'] })
      .notNull()
      .default('completed'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    usageCheckpoint: jsonb('usage_checkpoint').$type<AiUsageCheckpoint>(),
    credits: integer('credits'),
    holdId: uuid('hold_id').references(() => creditHold.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (t) => [
    index('ai_message_workspace_id_id_idx').on(t.workspaceId, t.id.desc()),
    index('ai_message_conversation_id_id_idx').on(t.conversationId, t.id),
    check(
      'ai_message_usage_nonnegative',
      sql`coalesce(${t.inputTokens}, 0) >= 0 and coalesce(${t.outputTokens}, 0) >= 0 and coalesce(${t.credits}, 0) >= 0`,
    ),
  ],
)

/** 图片与视频任务；定价快照用于整个异步链路的预扣与结算。 */
export const aiTask = pgTable(
  'ai_task',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    kind: text('kind', { enum: ['image', 'video'] }).notNull(),
    modelKey: text('model_key').notNull(),
    pricing: jsonb('pricing').$type<AiPricingJson>().notNull(),
    status: text('status', { enum: ['queued', 'running', 'succeeded', 'failed', 'canceled'] })
      .notNull()
      .default('queued'),
    input: jsonb('input').$type<Record<string, unknown>>().notNull(),
    output: jsonb('output').$type<Record<string, unknown>>(),
    provider: text('provider').notNull(),
    providerJobId: text('provider_job_id'),
    providerRequestKey: text('provider_request_key').notNull(),
    callbackPayload: jsonb('callback_payload').$type<Record<string, unknown>>(),
    workflowInstanceId: text('workflow_instance_id'),
    holdId: uuid('hold_id').references(() => creditHold.id, { onDelete: 'restrict' }),
    creditsCharged: integer('credits_charged').notNull().default(0),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [
    index('ai_task_workspace_id_id_idx').on(t.workspaceId, t.id.desc()),
    index('ai_task_status_updated_at_idx').on(t.status, t.updatedAt),
    check('ai_task_kind_valid', sql`${t.kind} in ('image', 'video')`),
    check(
      'ai_task_status_valid',
      sql`${t.status} in ('queued', 'running', 'succeeded', 'failed', 'canceled')`,
    ),
    check('ai_task_credits_charged_nonnegative', sql`${t.creditsCharged} >= 0`),
  ],
)

export type AiModel = typeof aiModel.$inferSelect
export type NewAiModel = typeof aiModel.$inferInsert
export type AiConversation = typeof aiConversation.$inferSelect
export type AiMessage = typeof aiMessage.$inferSelect
export type AiTask = typeof aiTask.$inferSelect
export type NewAiTask = typeof aiTask.$inferInsert
