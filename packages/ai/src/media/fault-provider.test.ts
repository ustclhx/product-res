import { describe, expect, it, vi } from 'vitest'
import type { MediaAcceptanceFault, MediaAcceptanceFaultProof } from './fault.ts'
import { wrapMediaFaultProvider } from './fault-provider.ts'
import {
  isSyncMediaProvider,
  type MediaProvider,
  type MediaSubmitInput,
  type SyncMediaProvider,
} from './provider.ts'

const result = { outputs: [{ url: 'https://example.test/image.png', mime: 'image/png' }] }
const input = {
  modelId: 'fal-ai/flux/schnell',
  params: { prompt: 'test' },
  webhookUrl: 'https://example.test/callback',
  idempotencyKey: 'key',
}
const fault = (mode: MediaAcceptanceFault['mode']): MediaAcceptanceFault => ({
  mode,
  policyVersion: 1,
  authorizedAdmin: true,
  deadlineMs: 1_200_000,
  initialWaitMs: 5_000,
  barrierMs: 0,
})
const upstream = () =>
  ({
    id: 'fal',
    capabilities: { idempotentSubmit: false },
    submit: vi.fn(async (_input: MediaSubmitInput) => ({ jobId: 'real-job' })),
    getStatus: vi.fn(async () => ({ status: 'succeeded' as const, result })),
    parseWebhook: vi.fn(async () => ({ jobId: 'real-job', result })),
    cancel: vi.fn(async () => {}),
  }) satisfies MediaProvider

function asyncWrapper(
  mode: MediaAcceptanceFault['mode'],
  original = upstream(),
  proof = vi.fn(async (_patch: Partial<MediaAcceptanceFaultProof>) => {}),
) {
  const wrapped = wrapMediaFaultProvider(original, fault(mode), { proof, now: () => 1_000 })
  if (isSyncMediaProvider(wrapped)) throw new Error('Expected async provider')
  return { wrapped, original, proof }
}

describe('media acceptance fault wrapper', () => {
  it('Workers error records synthetic injection without invoking inference', async () => {
    const original: SyncMediaProvider = {
      id: 'workers-ai',
      capabilities: { synchronous: true, idempotentSubmit: false },
      run: vi.fn(),
    }
    const proof = vi.fn(async () => {})
    const wrapped = wrapMediaFaultProvider(original, fault('workers-error'), { proof })
    if (!isSyncMediaProvider(wrapped)) throw new Error('Expected sync provider')
    await expect(wrapped.run(input)).rejects.toMatchObject({
      code: 'WORKERS_AI_GENERATION_FAILED',
      details: { retryable: false },
    })
    expect(original.run).not.toHaveBeenCalled()
    expect(proof).toHaveBeenCalledWith(
      expect.objectContaining({ injected: true, realProviderCalled: false }),
    )
  })

  it.each(['fal-callback-lost', 'fal-callback-early'] as const)(
    '%s uses one real submission with only early retaining callback',
    async (mode) => {
      const { wrapped, original, proof } = asyncWrapper(mode)
      await expect(wrapped.submit(input)).resolves.toEqual({ jobId: 'real-job' })
      expect(original.submit).toHaveBeenCalledOnce()
      expect(original.submit.mock.calls[0]?.[0]).toEqual(
        mode === 'fal-callback-early'
          ? input
          : { modelId: input.modelId, params: input.params, idempotencyKey: input.idempotencyKey },
      )
      expect(proof).toHaveBeenCalledWith({ realRequestId: 'real-job' })
      expect(proof.mock.calls.some(([patch]) => patch.injected)).toBe(mode === 'fal-callback-lost')
      await expect(wrapped.getStatus('real-job')).resolves.toEqual({ status: 'succeeded', result })
    },
  )

  it('response loss preserves real ID before throwing ambiguous submission failure', async () => {
    const { wrapped, original, proof } = asyncWrapper('fal-submit-response-lost')
    await expect(wrapped.submit(input)).rejects.toMatchObject({
      code: 'FAL_NETWORK_ERROR',
      submissionOutcome: 'ambiguous',
    })
    expect(original.submit).toHaveBeenCalledOnce()
    expect(original.submit.mock.calls[0]?.[0]).not.toHaveProperty('webhookUrl')
    expect(proof.mock.calls.map(([patch]) => patch)).toEqual([
      { realProviderCalled: true },
      { realRequestId: 'real-job' },
      { injected: true, injectedAt: new Date(1_000).toISOString() },
    ])
  })

  it.each(['fal-provider-error', 'fal-timeout'] as const)(
    '%s queries real job before masking its outcome',
    async (mode) => {
      const { wrapped, original, proof } = asyncWrapper(mode)
      await wrapped.submit(input)
      expect(proof.mock.calls.some(([patch]) => patch.injected)).toBe(false)
      const status = await wrapped.getStatus('real-job')
      expect(original.getStatus).toHaveBeenCalledWith('real-job')
      expect(status.status).toBe(mode === 'fal-timeout' ? 'queued' : 'failed')
      expect(proof).toHaveBeenCalledWith({
        injected: true,
        injectedAt: new Date(1_000).toISOString(),
      })
    },
  )

  it('natural upstream failure or proof write failure cannot claim injected success', async () => {
    const original = upstream()
    original.getStatus.mockRejectedValueOnce(new Error('natural upstream failure'))
    const { wrapped, proof } = asyncWrapper('fal-provider-error', original)
    await expect(wrapped.getStatus('real-job')).rejects.toThrow('natural upstream failure')
    expect(proof).not.toHaveBeenCalled()
    proof.mockRejectedValueOnce(new Error('proof unavailable'))
    await expect(wrapped.getStatus('real-job')).rejects.toThrow('proof unavailable')
  })
})
