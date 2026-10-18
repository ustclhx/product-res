import { describe, expect, it } from 'vitest'
import { assertModelProviderEnabled, availableMediaProviders } from './admin-model-provider.ts'

describe('admin model provider validation', () => {
  it('hides Workers AI options when the runtime lacks its binding and rejects direct submission', () => {
    expect(availableMediaProviders(['workers-ai', 'fal'], false)).toEqual(['fal'])
    expect(availableMediaProviders(['workers-ai', 'fal'], true)).toEqual(['workers-ai', 'fal'])
    for (const kind of ['text', 'image', 'video'] as const) {
      expect(() => assertModelProviderEnabled(kind, 'workers-ai', ['workers-ai'], false)).toThrow(
        expect.objectContaining({ code: 'MODEL_PROVIDER_UNAVAILABLE' }),
      )
    }
    expect(() => assertModelProviderEnabled('image', 'fal', ['fal'], false)).not.toThrow()
    expect(() => assertModelProviderEnabled('text', 'openai', [], false)).not.toThrow()
  })

  it('rejects disabled or unknown media providers before saving', () => {
    for (const kind of ['image', 'video'] as const) {
      expect(() => assertModelProviderEnabled(kind, 'fal', ['workers-ai'])).toThrow(
        expect.objectContaining({ code: 'MEDIA_PROVIDER_DISABLED' }),
      )
      expect(() => assertModelProviderEnabled(kind, 'unknown', ['fal'])).toThrow(
        expect.objectContaining({ code: 'MEDIA_PROVIDER_DISABLED' }),
      )
      expect(() => assertModelProviderEnabled(kind, 'fal', [])).toThrow(
        expect.objectContaining({ code: 'MEDIA_PROVIDER_DISABLED' }),
      )
    }
  })

  it('accepts enabled media providers and preserves text provider choices', () => {
    expect(() => assertModelProviderEnabled('image', 'workers-ai', ['workers-ai'])).not.toThrow()
    expect(() => assertModelProviderEnabled('video', 'fal', ['fal'])).not.toThrow()
    expect(() => assertModelProviderEnabled('text', 'openai', [])).not.toThrow()
  })
})
