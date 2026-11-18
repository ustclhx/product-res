import { AsyncLocalStorage } from 'node:async_hooks'
import type { MediaProviderEnv, TextModelEnv } from '@product-res/ai'
import type { Auth, parseAuthEnv } from '@product-res/auth'
import type { PaymentRuntimeEnv } from '@product-res/billing'
import type { AiFaultInjectionEnv } from '@product-res/config'
import type { Database } from '@product-res/db'
import type { EmailQueueMessage } from '@product-res/email/queue'
import type { ReplayMessage, StoreRoundMessage } from '@product-res/follow'
import type { WorkspaceTransferWorkflowParams } from '@product-res/follow/transfer'
import type {
  BackgroundTasks,
  Capability,
  KeyValueStore,
  QueueProducer,
  RateLimiter,
  RequestMetadata,
  TaskHealth,
  Workflow,
} from '@product-res/platform'
import { AppError } from '@product-res/shared'
import type { Storage } from '@product-res/storage'
import type { AuthUiEnv } from '../features/auth/options.ts'
import type { ShareCardRenderer } from '../features/share-cards/renderer.ts'

/** 分享卡片边缘缓存（Cloudflare Cache API）；自托管不装配，由对象存储加 HTTP 缓存头承担。 */
export interface ShareCardEdgeCache {
  match(url: string): Promise<Response | undefined>
  put(url: string, response: Response): Promise<void>
}

/** AI 模块按目标注入；文件签名留在目标入口，不让公开 API 依赖 R2 类型。 */
export interface WebAiRuntime {
  readonly config: TextModelEnv & Omit<MediaProviderEnv, 'AI'> & AiFaultInjectionEnv
  readonly workersAi: Capability<NonNullable<MediaProviderEnv['AI']>>
  readonly background: BackgroundTasks
  readonly workflow: Capability<Workflow<{ taskId: string }>>
  readonly downloadFile: Capability<
    (input: { workspaceId: string; fileId: string }) => Promise<string>
  >
}

/** 请求资源由目标入口装配；业务只读取标量与中立能力，不访问原始 bindings。 */
export interface WebRuntime {
  readonly config: ReturnType<typeof parseAuthEnv> &
    AuthUiEnv &
    PaymentRuntimeEnv & {
      readonly PLAUSIBLE_DOMAIN?: string | undefined
      readonly PLAUSIBLE_HOST?: string | undefined
      readonly PLAUSIBLE_SITES?: string | undefined
      readonly INDEXNOW_KEY?: string | undefined
      /** 组件预览页 /dev/ui 开关，仅 `true` 时开放（features/ui-preview） */
      readonly UI_PREVIEW?: string | undefined
    } & AiFaultInjectionEnv
  readonly db: Database
  /** 公开读取保留目标自身的缓存策略，不拥有连接池。 */
  readonly publicDb: Database
  readonly auth: Auth
  readonly cache: KeyValueStore
  readonly rateLimiter: RateLimiter
  readonly requestMeta: RequestMetadata
  readonly health?: { cache(): Promise<void>; tasks: TaskHealth }
  /** 目标入口注入观测；C 尚未接入时使用共享日志。 */
  readonly observability?: {
    readonly enabled: boolean
    captureError(error: unknown): void
  }
  readonly emailQueue: Capability<QueueProducer<EmailQueueMessage>>
  readonly eventsQueue: Capability<QueueProducer<unknown>>
  /** Keepa 历史回放队列（add-shadow-validation 4.1）；目前只有 Node 入口装配，未装配时回放入口报告不可用。 */
  readonly selectionReplayQueue?: Capability<QueueProducer<ReplayMessage>>
  /** 店铺追踪“立即跑一轮”队列（add-accuracy-store-tracking 3.3）；只有 Node 入口装配 */
  readonly storeTrackingQueue?: Capability<QueueProducer<StoreRoundMessage>>
  /** 跨空间数据流转 Workflow（add-workspace-data-transfer 4.1）；未装配时发起入口报告不可用 */
  readonly transferWorkflow?: Capability<Workflow<WorkspaceTransferWorkflowParams>>
  /** C 接入前 Node 不装配文件能力；在任何文件副作用之前拒绝。 */
  readonly files?: Capability<Storage>
  /** 未装配的目标明确报告 unavailable；认证等独立模块不要求 AI 能力。 */
  readonly ai?: Capability<WebAiRuntime>
  /** 分享卡片渲染器加载函数：目标入口用动态 import() 提供，首页与其他路由不加载 satori / resvg。 */
  readonly shareCardRenderer?: Capability<() => Promise<ShareCardRenderer>>
  readonly shareCardCache?: Capability<ShareCardEdgeCache>
  /** 后台认证写入需借用事务 facade 与延后提交的缓存。 */
  createAuth(db: Database, cache?: KeyValueStore): Auth
  handleAuthRequest(request: Request): Promise<Response>
}

const storage = new AsyncLocalStorage<WebRuntime>()

export function withWebRuntime<T>(runtime: WebRuntime, handle: () => T): T {
  return storage.run(runtime, handle)
}

export function getWebRuntime(): WebRuntime {
  const runtime = storage.getStore()
  if (!runtime)
    throw new AppError('RUNTIME_UNAVAILABLE', 'Request runtime is unavailable', { status: 503 })
  return runtime
}
