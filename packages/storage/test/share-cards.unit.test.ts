import { describe, expect, it, vi } from 'vitest'
import { createShareCardInvalidator, type ShareCardObjects } from '../src/share-cards.ts'

function fixture(indexes: number) {
  const keys = new Set<string>()
  for (let index = 0; index < indexes; index++) {
    const token = String(index).padStart(3, '0')
    keys.add(`share-cards/ws/workspace/report/${token}`)
    keys.add(`share-cards/img/report/${token}/1.png`)
  }
  const objects: ShareCardObjects = {
    async list({ prefix, cursor, limit = 7 }) {
      const page = [...keys]
        .filter((key) => key.startsWith(prefix) && (!cursor || key > cursor))
        .sort()
      const result = page.slice(0, limit)
      return { keys: result, ...(page.length > limit ? { cursor: result.at(-1) ?? '' } : {}) }
    },
    get: async () => null,
    put: async (key) => {
      keys.add(key)
    },
    async delete(key) {
      keys.delete(key)
    },
  }
  const put = vi.fn(async () => {})
  // 撤销墓碑永不删除，单独计数。
  const live = () => [...keys].filter((key) => !key.startsWith('share-cards/revoked/')).length
  const tombstones = () => keys.size - live()
  return { keys, live, tombstones, put, invalidator: createShareCardInvalidator(objects, { put }) }
}

describe('workspace share card cleanup', () => {
  it('limits synchronous work to 20 indexes and completes the remainder on the next run', async () => {
    const { live, tombstones, put, invalidator } = fixture(23)
    expect(await invalidator.cleanupWorkspaceShareCards('workspace', { maxIndexes: 20 })).toEqual({
      invalidated: 20,
      complete: false,
    })
    expect(put).toHaveBeenCalledTimes(20)
    expect(live()).toBe(6)
    expect(tombstones()).toBe(20)
    expect(await invalidator.cleanupWorkspaceShareCards('workspace')).toEqual({
      invalidated: 3,
      complete: true,
    })
    expect(live()).toBe(0)
    expect(tombstones()).toBe(23)
  })

  it('removes malformed indexes without logging their token or blocking valid shares', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { keys, live, invalidator } = fixture(1)
      keys.add('share-cards/ws/workspace/report/secret/extra')
      keys.add('share-cards/ws/workspace/report/..')
      keys.add('share-cards/ws/workspace/REPORT/secret')
      expect(await invalidator.cleanupWorkspaceShareCards('workspace')).toEqual({
        invalidated: 1,
        complete: true,
      })
      expect(live()).toBe(0)
      expect(warning).toHaveBeenCalledTimes(3)
      expect(JSON.stringify(warning.mock.calls)).not.toContain('secret')
    } finally {
      warning.mockRestore()
    }
  })
})
