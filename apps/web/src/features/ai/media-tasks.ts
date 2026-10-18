import {
  createMediaFault,
  createTaskMediaProvider,
  dbModelStore,
  estimateCredits,
  type FaultAccessContext,
  getMediaProviderDefinition,
  initialMediaFaultProof,
  isSyncMediaProvider,
  MEDIA_HOLD_SWEEP_BUFFER_MS,
  MEDIA_TASK_TTL_MS,
  type MediaProviderEnv,
  type MediaWebhook,
  readMediaFault,
  requireAvailableModel,
  settleMediaTask,
  type TaskMediaProvider,
  validateMediaParams,
  verifyMediaCallbackSignature,
} from '@product-res/ai'
import { type AuthContextSource, requireFreshSession } from '@product-res/auth'
import type { AiFaultInjectionEnv } from '@product-res/config'
import { CreditsError, hold, lockWorkspaceCredits } from '@product-res/credits'
import {
  type AiTask,
  aiTask,
  type Database,
  file,
  member,
  notFound,
  organization,
  scoped,
} from '@product-res/db'
import { type Entitlements, getEntitlements, requireEntitlement } from '@product-res/entitlements'
import {
  type Capability,
  type RateLimiter,
  requireCapability,
  type Workflow,
} from '@product-res/platform'
import { AppError, MEDIA_DONE_EVENT, newId, toErrorResponse } from '@product-res/shared'
import { log, setLogContext } from '@product-res/shared/log'
import { getStorageUsage } from '@product-res/storage'
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import { z } from 'zod'
import { templateConfig } from '../../server/template-config.ts'
import type { ResolvedWorkspace } from '../../server/workspace-context.ts'
import { sessionFaultAccess } from './fault-access.ts'

export interface MediaHttpEnv extends MediaProviderEnv, AiFaultInjectionEnv {
  APP_URL?: string | undefined
}
export interface MediaHttpDeps {
  db: Database
  auth: AuthContextSource
  env: MediaHttpEnv
  workflow: Capability<Workflow<{ taskId: string }>>
  rateLimiter: RateLimiter
  providerFactory?: (env: MediaHttpEnv, task: AiTask) => TaskMediaProvider
  entitlements?: (
    db: Database | Parameters<Parameters<Database['transaction']>[0]>[0],
    workspaceId: string,
  ) => Promise<Entitlements>
}

const workspaceInput = z.object({ workspaceId: z.uuid() })
const submitInput = workspaceInput
  .extend({
    modelKey: z.string().min(1).max(128),
    params: z.record(z.string(), z.unknown()),
  })
  .strict()
const terminal = (task: AiTask) => !['queued', 'running'].includes(task.status)
const invalid = () => new AppError('INVALID_REQUEST', 'Invalid media task request')

function taskProvider(deps: MediaHttpDeps | WorkspaceMediaDeps, task: AiTask): TaskMediaProvider {
  return deps.providerFactory
    ? deps.providerFactory(deps.env, task)
    : createTaskMediaProvider(deps.env, task, templateConfig.ai.mediaProviders)
}

function requireSubmissionProvider(providerId: string, kind: string, deps: WorkspaceMediaDeps) {
  const definition = getMediaProviderDefinition(providerId)
  if (
    !definition ||
    !templateConfig.ai.mediaProviders.some((id) => id === providerId) ||
    !definition.supportedKinds.some((supported) => supported === kind)
  )
    throw new AppError('MODEL_UNAVAILABLE', 'Media provider is not enabled', { status: 404 })
  // 测试与自托管调用可注入 Provider；生产入口始终按真实密钥 / 绑定检查。
  if (!deps.providerFactory && !definition.isConfigured(deps.env))
    throw new AppError('AI_PROVIDER_NOT_CONFIGURED', 'Media provider is not configured', {
      status: 503,
    })
  if (!definition.synchronous && !deps.env.MEDIA_WEBHOOK_SECRET)
    throw new AppError('MEDIA_WEBHOOK_NOT_CONFIGURED', 'Media callback is not configured', {
      status: 503,
    })
}

async function response(action: () => Promise<Response>) {
  try {
    const result = await action()
    result.headers.set('cache-control', 'no-store')
    return result
  } catch (error) {
    let mapped = error
    if (
      error instanceof CreditsError &&
      ['CREDIT_DEBT', 'INSUFFICIENT_CREDITS'].includes(error.code)
    )
      mapped = new AppError(
        error.code,
        error.code === 'CREDIT_DEBT' ? 'Workspace has unpaid credit debt' : 'Insufficient credits',
        { status: 402 },
      )
    if (!(mapped instanceof AppError)) log.error('ai.media.request_failed', { error: mapped })
    const result = toErrorResponse(mapped)
    return Response.json(result.body, {
      status: result.status,
      headers: { 'cache-control': 'no-store' },
    })
  }
}

async function context(request: Request, workspaceId: string, deps: MediaHttpDeps, write = false) {
  const fresh = await requireFreshSession({
    auth: deps.auth,
    db: deps.db,
    headers: request.headers,
  })
  const workspace = await deps.db.query.organization.findFirst({
    where: eq(organization.id, workspaceId),
  })
  if (!workspace || workspace.deletedAt) throw notFound()
  const [membership] = await scoped(deps.db, workspaceId)
    .select(member, { where: eq(member.userId, fresh.user.id) })
    .limit(1)
  if (!membership) throw notFound()
  if (write && !templateConfig.tenancy.multiTenant && !workspace.isPersonal)
    throw new AppError('WORKSPACE_READ_ONLY', 'Team workspace writes are disabled', { status: 403 })
  setLogContext({ workspaceId, userId: fresh.user.id })
  return { ...fresh, workspace, member: membership }
}

const entitlements = (
  deps: Pick<MediaHttpDeps, 'entitlements'>,
  db: Parameters<NonNullable<MediaHttpDeps['entitlements']>>[0],
  workspaceId: string,
) =>
  deps.entitlements
    ? deps.entitlements(db, workspaceId)
    : getEntitlements(db, workspaceId, {
        pastDueGraceDays: templateConfig.billing.pastDueGraceDays,
      })

export function handleMediaSubmit(request: Request, deps: MediaHttpDeps): Promise<Response> {
  return response(async () => {
    const parsed = submitInput.safeParse(await request.json().catch(() => undefined))
    if (!parsed.success) throw invalid()
    const input = parsed.data
    // jobs 不绑定站点 URL；由请求入口冻结可信服务端 origin，供回调签名使用。
    const callbackOrigin = new URL(deps.env.APP_URL ?? request.url).origin
    const resolved = await context(request, input.workspaceId, deps, true)
    const task = await submitWorkspaceMedia(input, resolved, {
      ...deps,
      callbackOrigin,
      faultAccess: sessionFaultAccess(resolved, deps.env),
    })
    return Response.json({ taskId: task.id, status: task.status }, { status: 202 })
  })
}

export type WorkspaceMediaDeps = Omit<MediaHttpDeps, 'auth' | 'rateLimiter'> & {
  rateLimiter?: RateLimiter | undefined
  callbackOrigin: string
  /** API key 入口不提供此授权，即使 key 由平台管理员创建。 */
  faultAccess?: FaultAccessContext
}

/** 入口已解析空间及成员；计费、配额和任务创建由站内与公开 API 共用。 */
export async function submitWorkspaceMedia(
  input: { modelKey: string; params: Record<string, unknown> },
  resolved: ResolvedWorkspace,
  deps: WorkspaceMediaDeps,
): Promise<AiTask> {
  const workflow = requireCapability(deps.workflow, 'Media workflow')
  const callbackOrigin = deps.callbackOrigin
  if (
    deps.rateLimiter &&
    !(await deps.rateLimiter.limit('ai', `ai:${resolved.workspace.id}:${resolved.member.userId}`))
      .success
  )
    throw new AppError('RATE_LIMITED', 'Too many requests, please try again later', {
      status: 429,
    })
  const modelRow = await deps.db.query.aiModel.findFirst({
    where: (model, { eq }) => eq(model.key, input.modelKey),
  })
  if (!modelRow) throw new AppError('MODEL_UNAVAILABLE', 'Model is not available', { status: 404 })
  requireSubmissionProvider(modelRow.provider, modelRow.kind, deps)
  const task = await deps.db.transaction(async (tx) => {
    // 与 billing 回收器统一为 ws → credits → task，防止锁顺序反转。
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`ws:${resolved.workspace.id}`}, 0))`,
    )
    await lockWorkspaceCredits(tx, resolved.workspace.id)
    const current = await entitlements(deps, tx, resolved.workspace.id)
    const model = await requireAvailableModel(
      {
        store: dbModelStore(tx as unknown as Database),
        workersAi: Boolean(deps.env.AI),
        faultAccess: deps.faultAccess,
      },
      current,
      modelRow.id,
    )
    if (model.kind === 'text' || !templateConfig.ai[model.kind])
      throw new AppError('MODEL_UNAVAILABLE', 'Model is not available', { status: 404 })
    requireSubmissionProvider(model.provider, model.kind, deps)
    if (model.pricing.mode === 'token')
      throw new AppError('MEDIA_PRICING_INVALID', 'Media model pricing is not supported', {
        status: 503,
      })
    const validated = validateMediaParams(model.paramsSchema, input.params, model.kind)
    const acceptanceFault = createMediaFault(model, deps.faultAccess)
    if (acceptanceFault?.mode.startsWith('fal-')) {
      if (
        (validated.params.image_size !== undefined && validated.params.image_size !== 'square') ||
        (validated.params.num_images !== undefined && validated.params.num_images !== 1)
      )
        throw new AppError('INVALID_PARAMS', 'Acceptance media requires one square image')
      validated.params = { ...validated.params, image_size: 'square', num_images: 1 }
      validated.unitsLimit = 1
    }
    const tenant = scoped(tx, resolved.workspace.id)
    const [workspace] = await tx
      .select({ id: organization.id })
      .from(organization)
      .where(and(eq(organization.id, resolved.workspace.id), isNull(organization.deletedAt)))
    if (!workspace) throw notFound()
    requireEntitlement(current, {
      limit: 'maxConcurrentTasks',
      value: (await tenant.count(aiTask, inArray(aiTask.status, ['queued', 'running']))) + 1,
    })
    const storageBytes = Math.floor(current.features.storageGb * 1024 ** 3)
    if ((await getStorageUsage(tx, resolved.workspace.id)) >= storageBytes)
      throw new AppError('STORAGE_QUOTA_EXCEEDED', 'Workspace storage quota is full', {
        status: 403,
      })
    for (const name of validated.fileParams) {
      const uploaded = await tenant.findById(file, validated.params[name] as string)
      if (uploaded.status !== 'ready' || uploaded.deletedAt)
        throw new AppError('FILE_NOT_READY', 'Input file is not confirmed')
    }
    const taskId = newId()
    const amount = estimateCredits(model.pricing, {
      params: validated.params,
      units: validated.unitsLimit,
    })
    const [created] = await tenant
      .insert(aiTask, {
        id: taskId,
        userId: resolved.member.userId,
        kind: model.kind,
        modelKey: model.key,
        provider: model.provider,
        pricing: model.pricing,
        providerRequestKey: taskId,
        workflowInstanceId: taskId,
        deadlineAt: new Date(Date.now() + (acceptanceFault?.deadlineMs ?? MEDIA_TASK_TTL_MS)),
        input: {
          ...validated,
          providerModelId: model.providerModelId,
          storageBytes,
          callbackOrigin,
          ...(acceptanceFault
            ? {
                acceptanceFault,
                acceptanceFaultProof: initialMediaFaultProof(acceptanceFault),
              }
            : {}),
        },
      })
      .returning()
    if (!created) throw new Error('Media task insert returned no row')
    const reservation = await hold(tx, {
      workspaceId: resolved.workspace.id,
      userId: resolved.member.userId,
      amount,
      refType: 'ai_task',
      refId: taskId,
      expiresAt: new Date(created.deadlineAt.getTime() + MEDIA_HOLD_SWEEP_BUFFER_MS),
    })
    return tenant.updateById(aiTask, taskId, { holdId: reservation.id })
  })
  try {
    await workflow.create({ id: task.id, params: { taskId: task.id } })
  } catch {
    await settleMediaTask(deps.db, {
      workspaceId: task.workspaceId,
      taskId: task.id,
      outcome: 'failed',
      error: { code: 'MEDIA_WORKFLOW_START_FAILED', message: 'Media task could not start' },
    })
    throw new AppError(
      'MEDIA_WORKFLOW_START_FAILED',
      'Media task could not start; credits were returned',
      { status: 503 },
    )
  }
  return task
}

export function getWorkspaceMediaTask(
  resolved: ResolvedWorkspace,
  taskId: string,
  deps: Pick<MediaHttpDeps, 'db'>,
): Promise<AiTask> {
  return scoped(deps.db, resolved.workspace.id).findById(aiTask, taskId)
}

function publicTask(task: AiTask, userId: string) {
  const output = task.output as { files?: Record<string, unknown>[] } | null
  return {
    id: task.id,
    workspaceId: task.workspaceId,
    userId: task.userId,
    kind: task.kind,
    modelKey: task.modelKey,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    deadlineAt: task.deadlineAt,
    creditsCharged: task.creditsCharged,
    errorCode: task.errorCode,
    errorMessage: task.errorMessage,
    params: task.input.params,
    files: (output?.files ?? []).map((item) => ({
      id: item.id,
      mime: item.mime,
      size: item.size,
      width: item.width ?? null,
      height: item.height ?? null,
      duration: item.duration ?? null,
      downloadUrl: `/api/files/${encodeURIComponent(String(item.id))}?workspaceId=${task.workspaceId}`,
    })),
    canCancel: task.userId === userId && !terminal(task),
  }
}

export function handleMediaList(request: Request, deps: MediaHttpDeps): Promise<Response> {
  return response(async () => {
    const query = Object.fromEntries(new URL(request.url).searchParams)
    const parsed = workspaceInput
      .extend({
        cursor: z.uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      })
      .safeParse(query)
    if (!parsed.success) throw invalid()
    const { user } = await context(request, parsed.data.workspaceId, deps)
    const rows = await scoped(deps.db, parsed.data.workspaceId)
      .select(aiTask, parsed.data.cursor ? { where: lt(aiTask.id, parsed.data.cursor) } : {})
      .orderBy(desc(aiTask.id))
      .limit(parsed.data.limit + 1)
    const more = rows.length > parsed.data.limit
    const page = rows.slice(0, parsed.data.limit)
    return Response.json({
      items: page.map((task) => publicTask(task, user.id)),
      nextCursor: more ? page.at(-1)?.id : null,
    })
  })
}

export function handleMediaDetail(
  request: Request,
  taskId: string,
  deps: MediaHttpDeps,
): Promise<Response> {
  return response(async () => {
    const parsed = workspaceInput.safeParse(Object.fromEntries(new URL(request.url).searchParams))
    if (!parsed.success) throw notFound()
    const resolved = await context(request, parsed.data.workspaceId, deps)
    const task = await getWorkspaceMediaTask(resolved, taskId, deps)
    return Response.json({ task: publicTask(task, resolved.member.userId) })
  })
}

/** 取消失败只记录异常类名与平台/业务错误码，不记录上游正文或参数。 */
function cancelErrorFields(error: unknown) {
  const message = error instanceof Error ? error.message : ''
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    errorCode:
      error instanceof AppError
        ? error.code
        : typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            typeof error.code === 'string'
          ? error.code
          : // Workflow 绑定错误形如 "(instance.cannot_terminate) ..."，只取括号内代码
            /\((instance\.[a-z_]+)\)/.exec(message)?.[1],
  }
}

export function handleMediaCancel(
  request: Request,
  taskId: string,
  deps: MediaHttpDeps,
): Promise<Response> {
  return response(async () => {
    const parsed = workspaceInput.safeParse(await request.json().catch(() => undefined))
    if (!parsed.success) throw invalid()
    const { user } = await context(request, parsed.data.workspaceId, deps, true)
    const initial = await scoped(deps.db, parsed.data.workspaceId).findById(aiTask, taskId)
    if (initial.userId !== user.id) throw notFound()
    if (terminal(initial) && initial.errorCode !== 'MEDIA_CANCEL_PENDING')
      return Response.json({ taskId, status: initial.status, cancellationPending: false })
    const task = await settleMediaTask(deps.db, {
      workspaceId: initial.workspaceId,
      taskId,
      outcome: 'canceled',
      error: {
        code: 'MEDIA_CANCEL_PENDING',
        message: 'Credits returned; external cancellation needs retry',
      },
    })
    if (task.status !== 'canceled')
      return Response.json({ taskId, status: task.status, cancellationPending: false })
    let pending = false
    const markPending = (operation: 'provider' | 'workflow', error: unknown) => {
      pending = true
      log.warn('ai.media.cancel_pending', { taskId, operation, ...cancelErrorFields(error) })
    }
    // 积分释放已持久化；外部取消失败记可重试标记，同一取消接口重试不会再次退款。
    for (const [operation, action] of [
      [
        'provider',
        async () => {
          if (task.providerJobId) {
            const provider = taskProvider(deps, task)
            if (!isSyncMediaProvider(provider)) await provider.cancel?.(task.providerJobId)
          }
        },
      ],
      [
        'workflow',
        async () => {
          if (task.workflowInstanceId) {
            const instance = await requireCapability(deps.workflow, 'Media workflow').get(
              task.workflowInstanceId,
            )
            if (
              ['queued', 'running', 'paused', 'waiting'].includes((await instance.status()).status)
            )
              await instance.terminate()
          }
        },
      ],
    ] as const) {
      try {
        await action()
      } catch (error) {
        markPending(operation, error)
      }
    }
    // 提交可能在取消期间才返回 jobId，不能据旧快照清除恢复标记。
    const latest = await scoped(deps.db, task.workspaceId).findById(aiTask, task.id)
    if (latest.providerJobId && latest.providerJobId !== task.providerJobId) {
      try {
        const provider = taskProvider(deps, latest)
        if (!isSyncMediaProvider(provider)) await provider.cancel?.(latest.providerJobId)
      } catch (error) {
        markPending('provider', error)
      }
    }
    if (latest.output?.submissionAttempted && !latest.providerJobId) pending = true
    await scoped(deps.db, task.workspaceId).updateById(aiTask, task.id, {
      errorCode: pending ? 'MEDIA_CANCEL_PENDING' : null,
      errorMessage: pending ? 'Credits returned; external cancellation needs retry' : null,
    })
    return Response.json(
      { taskId, status: task.status, cancellationPending: pending },
      { status: pending ? 202 : 200 },
    )
  })
}

export function handleMediaWebhook(
  request: Request,
  providerId: string,
  deps: MediaHttpDeps,
): Promise<Response> {
  return response(async () => {
    const definition = getMediaProviderDefinition(providerId)
    if (!definition || definition.synchronous) throw notFound()
    const url = new URL(request.url)
    const taskId = url.searchParams.get('task')
    if (!taskId || !z.uuid().safeParse(taskId).success) throw invalid()
    if (!deps.env.MEDIA_WEBHOOK_SECRET)
      throw new AppError('MEDIA_WEBHOOK_NOT_CONFIGURED', 'Media callback is not configured', {
        status: 503,
      })
    if (
      !(await verifyMediaCallbackSignature(
        deps.env.MEDIA_WEBHOOK_SECRET,
        taskId,
        url.searchParams.get('sig') ?? '',
      ))
    )
      throw new AppError('MEDIA_WEBHOOK_INVALID', 'Invalid media callback signature')
    // 已验任务专属签名后，先定位空间，再让 scoped 执行所有业务写入。
    // biome-ignore lint/plugin: 任务专属 HMAC 已通过，仅按其 taskId 定位租户，后续业务访问全部 scoped。
    const located = await deps.db.query.aiTask.findFirst({ where: eq(aiTask.id, taskId) })
    if (!located || located.provider !== providerId) throw notFound()
    const provider = taskProvider(deps, located)
    if (isSyncMediaProvider(provider)) throw notFound()
    const payload: MediaWebhook = await provider.parseWebhook(request, await request.text())
    const fault = readMediaFault(located)
    // 故障失败/轮询模式只接收验签证据，不能被真实成功回调抢先恢复成功。
    if (fault && fault.mode !== 'fal-callback-early') return Response.json({ ok: true })
    await deps.db.transaction(async (tx) => {
      if (fault)
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`ws:${located.workspaceId}`}, 0))`,
        )
      const tenant = scoped(tx, located.workspaceId)
      const [task] = await tenant.select(aiTask, { where: eq(aiTask.id, taskId) }).for('update')
      if (!task) throw notFound()
      if (task.providerJobId && task.providerJobId !== payload.jobId)
        throw new AppError('MEDIA_WEBHOOK_INVALID', 'Callback does not match the task job')
      await tenant.update(
        aiTask,
        {
          callbackPayload: payload,
          ...(fault && !task.callbackPayload
            ? {
                input: sql`${aiTask.input} || jsonb_build_object('acceptanceFaultProof', coalesce(${aiTask.input}->'acceptanceFaultProof', '{}'::jsonb) || jsonb_build_object('callbackStoredAt', now()))`,
              }
            : {}),
        },
        and(eq(aiTask.id, taskId), isNull(aiTask.callbackPayload)),
      )
    })
    try {
      if (located.workflowInstanceId)
        await (
          await requireCapability(deps.workflow, 'Media workflow').get(located.workflowInstanceId)
        ).sendEvent({
          type: MEDIA_DONE_EVENT,
          payload: { taskId },
        })
    } catch {
      log.warn('ai.media.callback_event_failed', { taskId })
    }
    return Response.json({ ok: true })
  })
}
