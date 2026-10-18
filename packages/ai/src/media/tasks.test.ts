import type { AiTask } from '@product-res/db'
import { log } from '@product-res/shared/log'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MediaResult } from './provider.ts'
import { mediaTaskCredits } from './tasks.ts'

const task: Pick<AiTask, 'id' | 'workspaceId' | 'kind' | 'pricing' | 'input'> = {
  id: 'task',
  workspaceId: 'workspace',
  kind: 'video',
  pricing: { mode: 'per_unit', unit: 'second', perUnit: 3 },
  input: { params: { resolution: '1080p' }, unitsLimit: 5 },
}
const result: MediaResult = { outputs: [{ url: 'https://example.test/video', mime: 'video/mp4' }] }

afterEach(() => vi.restoreAllMocks())

describe('media task snapshot pricing', () => {
  it('charges successful per-call output with the frozen parameter multiplier', () => {
    expect(
      mediaTaskCredits(
        {
          ...task,
          pricing: { mode: 'per_call', credits: 4, multipliers: { resolution: { '1080p': 2 } } },
        },
        result,
      ),
    ).toBe(8)
  })

  it('caps reported units at the requested limit and records the anomaly', () => {
    const warning = vi.spyOn(log, 'warn').mockImplementation(() => {})
    expect(mediaTaskCredits(task, { ...result, usage: { seconds: 6 } })).toBe(15)
    expect(warning).toHaveBeenCalledWith('ai.media.usage_exceeds_limit', {
      taskId: 'task',
      workspaceId: 'workspace',
      unit: 'second',
      reportedUnits: 6,
      unitsLimit: 5,
    })
  })

  it('uses actual output duration when aggregate usage is missing and refuses unknown duration', () => {
    expect(
      mediaTaskCredits(task, {
        outputs: [{ url: 'https://example.test/video', mime: 'video/mp4', durationSec: 2.5 }],
      }),
    ).toBe(8)
    expect(() => mediaTaskCredits(task, result)).toThrow(
      expect.objectContaining({ code: 'MEDIA_USAGE_MISSING' }),
    )
  })

  it('counts actual image outputs when image usage is missing', () => {
    expect(
      mediaTaskCredits(
        { ...task, kind: 'image', pricing: { mode: 'per_unit', unit: 'image', perUnit: 4 } },
        result,
      ),
    ).toBe(4)
  })
})
