import type { DatabaseAccess, KeyValueStore } from '@product-res/platform'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@product-res/auth', () => ({
  purgeDeletedPersonalWorkspaceShareCards: vi.fn(),
  cleanupExpiredWorkspaces: vi.fn(),
  purgeDeletedUserAiContent: vi.fn(),
}))

import {
  cleanupExpiredWorkspaces,
  purgeDeletedPersonalWorkspaceShareCards,
  purgeDeletedUserAiContent,
} from '@product-res/auth'
import { runWorkspaceCleanup } from '../src/cron/workspace-cleanup.ts'

afterEach(() => vi.resetAllMocks())
describe('workspace cleanup cron isolation', () => {
  it('runs every cleanup step even when both preceding steps fail', async () => {
    vi.mocked(purgeDeletedPersonalWorkspaceShareCards).mockRejectedValue(new Error('secret'))
    vi.mocked(cleanupExpiredWorkspaces).mockRejectedValue(new Error('secret'))
    vi.mocked(purgeDeletedUserAiContent).mockRejectedValue(new Error('secret'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const info = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await runWorkspaceCleanup({
        db: { business: () => ({}) } as unknown as DatabaseAccess,
        cache: {} as KeyValueStore,
        shareCards: {
          list: async () => ({ keys: [] }),
          get: async () => null,
          put: async () => {},
          delete: async () => {},
        },
      })
      expect(purgeDeletedUserAiContent).toHaveBeenCalledOnce()
      expect(error).toHaveBeenCalledTimes(3)
      expect(JSON.stringify(error.mock.calls)).not.toContain('secret')
    } finally {
      error.mockRestore()
      info.mockRestore()
    }
  })
})
