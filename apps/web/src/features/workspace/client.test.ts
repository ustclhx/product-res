import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { baseLocale, locales, overwriteGetLocale } from '../../paraglide/runtime.js'
import { activateWorkspace, workspaceAction } from './client.ts'

const locale = locales.find((locale) => String(locale) === 'en') ?? baseLocale
beforeEach(() => overwriteGetLocale(() => locale))
afterEach(() => {
  vi.unstubAllGlobals()
  overwriteGetLocale(() => baseLocale)
})

describe('workspace actions', () => {
  it('renders the business error code instead of exposing backend text', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ code: 'SEATS_FULL', message: 'internal detail' }, { status: 403 }),
        ),
    )
    await expect(
      workspaceAction('invite-member', { email: 'member@example.com' }, z.unknown()),
    ).rejects.toThrow(
      String(locale) === 'zh'
        ? '所有席位已占用，请让所有者提高上限或移除成员。'
        : 'All seats are in use. Ask the owner to increase the limit or remove a member.',
    )
  })
  it('does not navigate when activation is rejected', async () => {
    const assign = vi.fn()
    vi.stubGlobal('window', { location: { assign } })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ code: 'SESSION_REQUIRED' }, { status: 401 })),
    )
    await expect(activateWorkspace({ id: 'team-id', slug: 'team' })).rejects.toThrow(
      String(locale) === 'zh'
        ? '会话已过期，请重新登录。'
        : 'Your session has expired. Sign in again.',
    )
    expect(assign).not.toHaveBeenCalled()
  })
})
