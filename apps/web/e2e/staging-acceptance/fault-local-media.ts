import { env } from 'cloudflare:workers'
import { createFalMediaProvider, readMediaTaskInput, type TaskMediaProvider } from '@product-res/ai'
import type { AiTask } from '@product-res/db'
import type { JsonValue, Workflow, WorkflowInstance, WorkflowStep } from '@product-res/platform'
import { AppError } from '@product-res/shared'
import { persistMediaOutputs } from '@product-res/storage'
import { createCloudflareMediaCopier } from '@product-res/storage/cloudflare'
import { runMediaTask } from '../../../jobs/src/workflows/media-runner.ts'
import { handleMediaWebhook, type MediaHttpDeps } from '../../src/features/ai/media-tasks.ts'
import type { WebRuntime } from '../../src/server/runtime.ts'

const faultEnv = { SENTRY_ENVIRONMENT: 'staging', AI_FAULT_INJECTION: 'enabled' } as const
const secret = 'fault-local-only-fixture'
const externalKeys = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
  'PAYPAL_WEBHOOK_ID',
  'SENTRY_DSN',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'DEEPSEEK_API_KEY',
  'AI_GATEWAY_TOKEN',
  'AI_GATEWAY_ACCOUNT_ID',
  'AI_GATEWAY_ID',
  'RESEND_API_KEY',
]
export function localBindings<T extends object>(bindings: T): T {
  return {
    ...bindings,
    ...Object.fromEntries(externalKeys.map((key) => [key, ''])),
    ...faultEnv,
    FAL_KEY: 'local-fake',
    MEDIA_WEBHOOK_SECRET: secret,
  }
}
const bytes = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPZkAAAAASUVORK5CYII=',
  ),
  (char) => char.charCodeAt(0),
)
const imageUrl = 'https://v3.fal.media/files/local-fault.png'
const result = { images: [{ url: imageUrl, content_type: 'image/png', width: 1, height: 1 }] }
let keys: Promise<CryptoKeyPair> | undefined
const localKeys = () => {
  // workerd 不允许模块顶层执行异步 IO，密钥只在本地回调请求中生成。
  keys ??= crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as Promise<CryptoKeyPair>
  return keys
}
const base64url = (value: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(value)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
const hex = (value: ArrayBuffer) =>
  Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('')

async function signedCallback(url: string, jobId: string, deps: MediaHttpDeps) {
  const body = JSON.stringify({ request_id: jobId, status: 'OK', payload: result })
  const timestamp = String(Math.floor(Date.now() / 1000))
  const user = 'local-fault-user'
  const encoder = new TextEncoder()
  const hash = hex(await crypto.subtle.digest('SHA-256', encoder.encode(body)))
  const signature = hex(
    await crypto.subtle.sign(
      'Ed25519',
      (await localKeys()).privateKey,
      encoder.encode([jobId, user, timestamp, hash].join('\n')),
    ),
  )
  const request = new Request(url, {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      'x-fal-webhook-request-id': jobId,
      'x-fal-webhook-user-id': user,
      'x-fal-webhook-timestamp': timestamp,
      'x-fal-webhook-signature': signature,
    },
  })
  const response = await handleMediaWebhook(request, 'fal', deps)
  if (!response.ok) throw new Error('Local signed webhook was rejected')
}

// 原 Provider 仍执行提交、状态解析、取消与验签；夹具只替换网络传输，模式由生产 wrapper 注入。
function localProvider(task: AiTask, deps: MediaHttpDeps): TaskMediaProvider {
  const input = readMediaTaskInput(task)
  if (task.provider === 'workers-ai')
    return {
      id: 'workers-ai',
      capabilities: { synchronous: true, idempotentSubmit: true },
      async run() {
        return {
          outputs: [{ body: bytes, mime: 'image/png', width: 1, height: 1 }],
          usage: { images: 1 },
        }
      },
    }
  if (task.provider !== 'fal' || input.providerModelId !== 'fal-ai/flux/schnell')
    throw new AppError('AI_PROVIDER_NOT_CONFIGURED', 'Unknown local media provider')
  const jobId = `local_${task.id.replaceAll('-', '_')}`
  const fakeFetch: typeof fetch = async (request, init) => {
    const url = new URL(
      typeof request === 'string' ? request : request instanceof URL ? request : request.url,
    )
    const method = init?.method ?? 'GET'
    if (url.toString() === 'https://rest.fal.ai/.well-known/jwks.json')
      return Response.json({
        keys: [
          { x: base64url(await crypto.subtle.exportKey('raw', (await localKeys()).publicKey)) },
        ],
      })
    if (url.origin !== 'https://queue.fal.run')
      throw new Error('External local fixture request rejected')
    if (method === 'POST' && url.pathname === '/fal-ai/flux/schnell') {
      const callback = url.searchParams.get('fal_webhook')
      if (callback) await signedCallback(callback, jobId, deps)
      return Response.json({ request_id: jobId })
    }
    const path = `/fal-ai/flux/requests/${jobId}`
    if (method === 'GET' && url.pathname === `${path}/status`)
      return Response.json({ request_id: jobId, status: 'COMPLETED' })
    if (method === 'GET' && url.pathname === path) return Response.json(result)
    if (method === 'PUT' && url.pathname === `${path}/cancel`)
      return new Response(null, { status: 202 })
    throw new Error('Unknown local fal request rejected')
  }
  return createFalMediaProvider({
    apiKey: 'local-fake',
    modelId: input.providerModelId,
    fetch: fakeFetch,
  })
}

function localWorkflow(deps: MediaHttpDeps): Workflow<{ taskId: string }> {
  const instance = (id: string): WorkflowInstance => ({
    id,
    status: async () => ({ status: 'completed' }),
    terminate: async () => {},
    sendEvent: async () => {},
  })
  return {
    get: async (id) => instance(id),
    async create({ params }) {
      const step: WorkflowStep = {
        do: async <T extends JsonValue>(
          _name: string,
          options: unknown,
          callback?: () => Promise<T>,
        ): Promise<T> => {
          const action = typeof options === 'function' ? (options as () => Promise<T>) : callback
          if (!action) throw new Error('Missing local step callback')
          return action()
        },
        sleep: async (_name, ms) => {
          await new Promise((resolve) => setTimeout(resolve, ms))
        },
        waitForEvent: async (_name, options) => {
          await new Promise((resolve) => setTimeout(resolve, options.timeoutMs))
          throw new Error('Local workflow event timeout')
        },
      }
      await runMediaTask(params.taskId, step, {
        db: deps.db,
        provider: (task) => localProvider(task, deps),
        params: async (task) => readMediaTaskInput(task).params,
        callbackOrigin: deps.env.APP_URL ?? 'http://localhost',
        callbackSecret: secret,
        faultEnv,
        persist: (task, output) =>
          persistMediaOutputs({
            db: deps.db,
            storage: env.FILES,
            copyOutput: createCloudflareMediaCopier(env.FILES, {
              fetch: async (request) => {
                const url =
                  typeof request === 'string'
                    ? request
                    : request instanceof URL
                      ? request.toString()
                      : request.url
                if (url !== imageUrl) throw new Error('External local image request rejected')
                return new Response(bytes, {
                  headers: { 'Content-Type': 'image/png', 'Content-Length': String(bytes.length) },
                })
              },
            }),
            task,
            result: output,
            limits: {
              maxFileBytes: 1024,
              storageBytes: 1024 ** 3,
              allowedMimeTypes: ['image/png'],
              allowedHosts: ['v3.fal.media'],
            },
          }),
      })
      return instance(params.taskId)
    },
  }
}

export function localHttpDeps<T extends MediaHttpDeps>(real: T): T {
  const deps = {
    ...real,
    env: { ...real.env, ...faultEnv, MEDIA_WEBHOOK_SECRET: secret, FAL_KEY: 'local-fake' },
    providerFactory: (_env: unknown, task: AiTask) => localProvider(task, deps),
  }
  return { ...deps, workflow: { available: true, value: localWorkflow(deps) } }
}

// getter 保留请求原有 DB、auth、R2 和 cache；任务健康只报告本地夹具，不访问 jobs。
export function localWebRuntime(runtime: WebRuntime): WebRuntime {
  if (!runtime.ai?.available) throw new Error('Local fault runtime requires AI composition')
  const realAi = runtime.ai.value
  const ai = {
    ...realAi,
    config: {
      ...faultEnv,
      AI_TEXT_EGRESS: 'direct' as const,
      DEEPSEEK_API_KEY: 'local-fake',
      FAL_KEY: 'local-fake',
      MEDIA_WEBHOOK_SECRET: secret,
    },
    workersAi: { available: true as const, value: { run: async () => bytes } },
  }
  const local = Object.create(runtime) as WebRuntime
  Object.defineProperties(local, {
    config: {
      value: {
        ...runtime.config,
        ...faultEnv,
        ...Object.fromEntries(externalKeys.map((key) => [key, ''])),
      },
    },
    ai: { value: { available: true, value: ai } },
    health: {
      value: {
        cache: async () => {
          await runtime.cache.get('fault-local-health')
        },
        tasks: {
          queue: async () => ({ status: 'up' }),
          scheduler: async () => ({ status: 'up', lastCronAt: new Date().toISOString() }),
        },
      },
    },
  })
  return local
}
