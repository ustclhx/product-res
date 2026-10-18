import { type AiFaultInjectionEnv, isAiFaultInjectionEnabled } from '@product-res/config'
import { type AiUsageCheckpoint, aiMessage, type Database, scoped } from '@product-res/db'
import { AppError } from '@product-res/shared'
import { type LanguageModel, wrapLanguageModel } from 'ai'
import { and, eq, type SQL, sql } from 'drizzle-orm'
import { estimateTextTokens } from './budget.ts'
import { getTextProviderCapabilities } from './capabilities.ts'

export type TextFaultProof = NonNullable<AiUsageCheckpoint['acceptanceFaultProof']>
export type TextFaultMode = TextFaultProof['mode']
export const TEXT_FAULT_OUTPUT_TOKENS = 200
export const TEXT_FAULT_MAX_OUTPUT_TOKENS = 1024

const faultError = () =>
  new AppError('ACCEPTANCE_FAULT_INJECTED', 'Acceptance text stream interrupted', { status: 503 })

/** 只替换证明子树；普通用量检查点和最终结算都会保留它。 */
export async function writeTextFaultProof(
  db: Database,
  input: { workspaceId: string; messageId: string; proof: TextFaultProof },
): Promise<boolean> {
  const rows = await scoped(db, input.workspaceId)
    .update(
      aiMessage,
      {
        usageCheckpoint: sql`coalesce(${aiMessage.usageCheckpoint}, '{}'::jsonb) || ${JSON.stringify({ acceptanceFaultProof: input.proof })}::jsonb`,
      },
      and(eq(aiMessage.id, input.messageId), eq(aiMessage.status, 'streaming')) as SQL,
    )
    .returning({ id: aiMessage.id })
  return rows.length > 0
}

/** 包装实际 doStream；模型工厂仍正常构造，流前故障在 hold 创建后才执行。 */
export function wrapTextFaultModel(
  model: LanguageModel,
  options: {
    mode: TextFaultMode
    env: AiFaultInjectionEnv
    tokensPerChar: number
    writeProof: (proof: TextFaultProof) => Promise<boolean>
  },
): ReturnType<typeof wrapLanguageModel> {
  if (typeof model === 'string' || !['v2', 'v3', 'v4'].includes(model.specificationVersion))
    throw new AppError('ACCEPTANCE_FAULT_INVALID', 'Acceptance text model is invalid', {
      status: 503,
    })
  const mode = options.mode
  const checkGate = () => {
    if (!isAiFaultInjectionEnabled(options.env))
      throw new AppError('MODEL_UNAVAILABLE', 'Model is not available', { status: 404 })
  }
  const save = async (proof: TextFaultProof) => {
    if (!(await options.writeProof(proof)))
      throw new AppError('ACCEPTANCE_FAULT_PROOF_FAILED', 'Acceptance proof was not persisted', {
        status: 503,
      })
  }
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v4',
      // 故障模型关闭思考，让真实正文到达注入阈值；映射与普通调用共用 Provider 能力。
      transformParams: async ({ params }) =>
        getTextProviderCapabilities(model.provider).applyThinking(params, false),
      wrapGenerate: async () => {
        throw new AppError('ACCEPTANCE_FAULT_INVALID', 'Acceptance model requires streaming', {
          status: 503,
        })
      },
      wrapStream: async ({ doStream }) => {
        checkGate()
        const proof: TextFaultProof = {
          mode,
          policyVersion: 1,
          phase: mode === 'chat-before-stream' ? 'before-stream' : 'mid-stream',
          injected: false,
          realProviderCalled: false,
          upstreamCalls: 0,
        }
        if (mode === 'chat-before-stream') {
          await save({ ...proof, injected: true, injectedAt: new Date().toISOString() })
          throw faultError()
        }
        await save(proof)
        // 证明写入可能经历数据库往返；真实调用前重新检查在途闸门。
        checkGate()
        const calledProof = { ...proof, realProviderCalled: true, upstreamCalls: 1 }
        const upstream = await Promise.resolve()
          .then(doStream)
          .catch(async (error: unknown) => {
            // 自然失败仍是真实调用，但不能认证为故障注入。
            await save(calledProof)
            throw error
          })
        const reader = upstream.stream.getReader()
        try {
          await save(calledProof)
        } catch (error) {
          await reader.cancel(error)
          throw error
        }
        let text = ''
        let inject = false
        let stopped = false
        let upstreamFailed = false
        const cancel = async (reason: unknown) => {
          stopped = true
          await reader.cancel(reason)
        }
        return {
          ...upstream,
          stream: new ReadableStream(
            {
              async pull(controller) {
                try {
                  if (inject) {
                    checkGate()
                    const error = faultError()
                    await save({
                      ...proof,
                      realProviderCalled: true,
                      upstreamCalls: 1,
                      injected: true,
                      injectedAt: new Date().toISOString(),
                      outputTokens: estimateTextTokens(text, options.tokensPerChar),
                    })
                    // 取消 reader 而非业务 AbortController，故障不应成为用户 stop。
                    controller.error(error)
                    await cancel(error)
                    return
                  }
                  const next = await reader.read()
                  if (next.done) {
                    stopped = true
                    controller.close()
                    return
                  }
                  controller.enqueue(next.value)
                  if (next.value.type === 'error') upstreamFailed = true
                  if (next.value.type === 'text-delta') {
                    text += next.value.delta
                    inject =
                      !upstreamFailed &&
                      estimateTextTokens(text, options.tokensPerChar) >= TEXT_FAULT_OUTPUT_TOKENS
                  }
                } catch (error) {
                  controller.error(error)
                  if (!stopped) await cancel(error)
                }
              },
              cancel,
            },
            { highWaterMark: 0 },
          ),
        }
      },
    },
  })
}
