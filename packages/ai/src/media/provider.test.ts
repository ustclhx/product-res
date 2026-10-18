import { expectTypeOf, it } from 'vitest'
import type {
  MediaProvider,
  MediaResult,
  MediaStatus,
  MediaSubmitInput,
  MediaWebhook,
} from './provider.ts'

function narrow(status: MediaStatus, webhook: MediaWebhook) {
  if (status.status === 'succeeded') expectTypeOf(status.result).toEqualTypeOf<MediaResult>()
  if (status.status === 'failed') expectTypeOf(status.error.code).toEqualTypeOf<string>()
  if (webhook.result) expectTypeOf(webhook.error).toEqualTypeOf<undefined>()
}

function invalidContracts() {
  // @ts-expect-error 稳定幂等键是提交契约必填项。
  const submit: MediaSubmitInput = { modelId: 'image-model', params: {} }
  // @ts-expect-error 成功必须包含结果。
  const success: MediaStatus = { status: 'succeeded' }
  // @ts-expect-error 同一回调不能既成功又失败。
  const webhook: MediaWebhook = {
    jobId: 'job',
    result: { outputs: [] },
    error: { code: 'error', message: 'failed' },
  }
  return [submit, success, webhook]
}
void narrow
void invalidContracts

it('媒体契约支持异步、同步结果、能力标记与已验签回调', () => {
  expectTypeOf<MediaProvider['submit']>().returns.toEqualTypeOf<
    Promise<{ jobId: string; sync?: MediaResult }>
  >()
  expectTypeOf<MediaProvider['getStatus']>().returns.toEqualTypeOf<Promise<MediaStatus>>()
  expectTypeOf<MediaProvider['parseWebhook']>().returns.toEqualTypeOf<Promise<MediaWebhook>>()
  expectTypeOf<MediaProvider['capabilities']['idempotentSubmit']>().toEqualTypeOf<boolean>()
  expectTypeOf<NonNullable<MediaProvider['cancel']>>().returns.toEqualTypeOf<Promise<void>>()
})
