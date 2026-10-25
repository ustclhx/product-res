import { AppError } from '@product-res/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// add-beta-access-gate 2.3：withWorkspace 在成员校验后强制开通，getWorkspacePage 只校验成员并返回待开通状态。
type Server = (options: {
  next: (options?: { context?: Record<string, unknown> }) => unknown
  data: Record<string, unknown>
  context: Record<string, unknown>
}) => Promise<unknown>
type Handler = (options: { context: Record<string, unknown> }) => Promise<unknown>
interface Built {
  parents: Built[]
  serverFn?: Server
  handlerFn?: Handler
}

const mocks = vi.hoisted(() => ({
  activated: vi.fn(async () => false),
  transferring: vi.fn(async () => false),
  resolved: {
    workspace: { id: 'ws-1', name: 'Mine', slug: 'u-1', isPersonal: true },
    member: { role: 'owner' },
  },
  user: { id: 'user-1', name: 'User', email: 'user@example.test', role: 'user' },
}))

vi.mock('@tanstack/react-start', () => {
  const builder = (): Built & Record<string, unknown> => {
    const built: Built & Record<string, unknown> = { parents: [] }
    built.middleware = (parents: Built[]) => {
      built.parents = parents
      return built
    }
    built.validator = () => built
    built.inputValidator = () => built
    built.server = (fn: Server) => {
      built.serverFn = fn
      return built
    }
    built.handler = (fn: Handler) => {
      built.handlerFn = fn
      return built
    }
    return built
  }
  return { createMiddleware: builder, createServerFn: builder }
})
vi.mock('@tanstack/react-start/server', () => ({
  getRequest: () => new Request('https://app.test'),
}))
vi.mock('@tanstack/react-router', () => ({
  notFound: () => new Error('not found'),
  redirect: () => new Error('redirect'),
}))
vi.mock('./runtime.ts', () => ({ getWebRuntime: () => ({ db: {}, auth: {} }) }))
vi.mock('../features/i18n/session.server.ts', () => ({ readRequestSession: vi.fn() }))
vi.mock('../features/admin/impersonation.ts', () => ({ assertRealSession: vi.fn() }))
vi.mock('./workspace-context.ts', () => ({
  resolveDefaultWorkspace: async () => mocks.resolved,
  resolveWorkspaceBySlug: async () => mocks.resolved,
}))
vi.mock('./workspace-data.ts', () => ({
  recipientInvitation: vi.fn(),
  resolveWorkspaceMaxSeats: async () => 1,
  userWorkspaces: async () => [],
  workspaceInvitations: async () => [],
  workspaceMembers: async () => [],
}))
vi.mock('@product-res/db', async (original) => ({
  ...(await original<typeof import('@product-res/db')>()),
  isWorkspaceTransferring: mocks.transferring,
}))
vi.mock('@product-res/auth', () => ({ requireFreshSession: async () => ({ user: mocks.user }) }))
vi.mock('./account-activation.ts', async (original) => {
  const actual = await original<typeof import('./account-activation.ts')>()
  return {
    ...actual,
    isAccountActivated: mocks.activated,
    assertAccountActivated: async () => {
      if (!(await mocks.activated()))
        throw new AppError(actual.ACCOUNT_NOT_ACTIVATED, 'pending', { status: 403 })
    },
  }
})

const { withWorkspace } = (await import('./middleware.ts')) as unknown as {
  withWorkspace: Built
}
const { getWorkspacePage } = (await import(
  '../features/workspace/workspace.functions.ts'
)) as unknown as { getWorkspacePage: Built }

/** 按 parents → self 顺序执行中间件链，返回最终 context */
async function run(middleware: Built, data: Record<string, unknown> = { slug: 'u-1' }) {
  const chain: Built[] = []
  const collect = (m: Built) => {
    for (const parent of m.parents) collect(parent)
    if (!chain.includes(m)) chain.push(m)
  }
  collect(middleware)
  let context: Record<string, unknown> = {
    db: {},
    user: mocks.user,
    session: { activeOrganizationId: null },
  }
  // withSession 读取会话，测试直接注入上下文
  for (const m of chain.slice(1)) {
    if (!m.serverFn) continue
    await m.serverFn({
      data,
      context,
      next: (options) => {
        context = { ...context, ...options?.context }
        return context
      },
    })
  }
  return context
}

beforeEach(() => {
  mocks.activated.mockReset()
  mocks.transferring.mockResolvedValue(false)
})

describe('工作台准入中间件', () => {
  it('未开通时 withWorkspace 返回 403 ACCOUNT_NOT_ACTIVATED，开通后注入空间', async () => {
    mocks.activated.mockResolvedValue(false)
    await expect(run(withWorkspace)).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_ACTIVATED',
      status: 403,
    })
    mocks.activated.mockResolvedValue(true)
    expect(await run(withWorkspace)).toMatchObject({ workspace: { id: 'ws-1' } })
  })

  it('getWorkspacePage 只校验成员：未开通返回待开通状态，开通后返回布局数据', async () => {
    expect(getWorkspacePage.parents).not.toContain(withWorkspace)
    const [membership] = getWorkspacePage.parents
    if (!membership || !getWorkspacePage.handlerFn) throw new Error('getWorkspacePage not built')
    mocks.activated.mockResolvedValue(false)
    const context = await run(membership)
    expect(await getWorkspacePage.handlerFn({ context })).toEqual({
      activation: 'pending',
      user: { id: 'user-1', name: 'User', email: 'user@example.test' },
      otherSpaces: [],
    })
    mocks.activated.mockResolvedValue(true)
    expect(await getWorkspacePage.handlerFn({ context })).toMatchObject({
      activation: 'active',
      workspace: { id: 'ws-1', slug: 'u-1' },
    })
  })
})

it('流转锁合入工作台只读，非工作台功能保留原有团队只读条件', async () => {
  mocks.activated.mockResolvedValue(true)
  mocks.transferring.mockResolvedValue(true)
  expect(await run(withWorkspace)).toMatchObject({
    workspaceReadOnly: true,
    workspaceTransferring: true,
    workspaceTeamReadOnly: false,
  })
  mocks.transferring.mockResolvedValue(false)
  expect(await run(withWorkspace)).toMatchObject({
    workspaceReadOnly: false,
    workspaceTransferring: false,
  })
})
