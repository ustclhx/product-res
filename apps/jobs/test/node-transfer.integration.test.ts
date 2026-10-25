import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensurePersonalWorkspace } from '@product-res/auth'
import { defineTemplateConfig } from '@product-res/config'
import { createDb, organization, session, workspaceTransfer } from '@product-res/db'
import {
  WORKSPACE_TRANSFER_WORKFLOW,
  type WorkspaceTransferWorkflowParams,
} from '@product-res/follow/transfer'
import {
  createNodeJobEngine,
  createNodeWorkflow,
  type NodeJobEngine,
} from '@product-res/platform/node'
import { newId } from '@product-res/shared'
import { eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type Created,
  cleanupCreated,
  createSession,
  createUser,
  seedWorkspace,
  snapshotRows,
  tableCounts,
} from '../../../packages/follow/test/transfer-helpers.ts'
import { startWorkspaceUpgrade } from '../../web/src/features/transfer/transfer.server.ts'
import { createNodeTransferWorkflowClient } from '../../web/src/node/transfer-workflow.ts'
import {
  createNodeTransferHandler,
  createNodeTransferWorkflowHttpHandler,
  transferInstanceGuard,
} from '../src/node/transfer.ts'

// add-workspace-data-transfer 4.1：在真实 Node DBOS 引擎上端到端运行流转 Workflow。
// web 入口（事务内投递）→ web 的 Node 客户端 → jobs 内部接口 → DBOS Workflow → 引擎。
const databaseUrl = process.env.TEST_JOB_DATABASE_URL
const migratorUrl = process.env.MIGRATION_DATABASE_URL
if (!databaseUrl || !migratorUrl) throw new Error('Node transfer integration requires isolated PG')
const db = createDb(databaseUrl, { max: 5 })
const secret = 'node-transfer-fixture-secret-at-least-32-chars'
const template = defineTemplateConfig({
  app: { name: 'Fixture', url: 'https://product.ezarouter.cc', supportEmail: 'hxl15380@gmail.com' },
  tenancy: { multiTenant: true, dataTransfer: true },
  credits: { enabled: true, requireGrantForAccess: false },
})
const created: Created = { users: [], workspaces: [], products: [] }
const deleted: string[] = []
let engine: NodeJobEngine
let server: Server
let directory: string
let jobsUrl: string

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'transfer-node-'))
  let workflow: ReturnType<typeof createNodeWorkflow<WorkspaceTransferWorkflowParams>> | undefined
  engine = await createNodeJobEngine({
    database: db,
    databaseUrl,
    executorId: `transfer-${newId()}`,
    applicationVersion: 'transfer-integration-v1',
    ownershipDirectory: directory,
    nativePoolMax: 3,
    shutdownTimeoutMs: 1_000,
    register(engine) {
      workflow = createNodeWorkflow({
        engine,
        name: WORKSPACE_TRANSFER_WORKFLOW,
        handler: createNodeTransferHandler(engine.database, {
          cache: { delete: async (key) => void deleted.push(key) },
          template,
        }),
      })
    },
    stopReceiving() {
      workflow?.stopReceiving()
    },
  })
  if (!workflow) throw new Error('Transfer workflow was not registered')
  const handler = createNodeTransferWorkflowHttpHandler({
    workflow: { available: true, value: workflow },
    secret,
    accepts: transferInstanceGuard(db),
  })
  server = createServer((request, response) => void handler(request, response))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  jobsUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 60_000)

afterAll(async () => {
  server?.closeAllConnections()
  server?.close()
  await engine?.close()
  await cleanupCreated(db, created)
  await db.close()
  if (directory) await rm(directory, { recursive: true, force: true })
}, 60_000)

async function upgrade() {
  const t = newId().slice(-8)
  const userId = await createUser(db, created, `nt${t}`)
  await ensurePersonalWorkspace(db, { id: userId })
  created.workspaces.push(userId)
  await seedWorkspace(db, created, userId, { tag: t, upgradeOnly: true })
  const sessionId = await createSession(db, userId, userId)
  return {
    t,
    userId,
    sessionId,
    counts: await tableCounts(db, userId),
    before: await snapshotRows(db, [userId]),
    start: async () => {
      const started = await startWorkspaceUpgrade(
        {
          db,
          workflow: {
            available: true,
            value: createNodeTransferWorkflowClient({ jobsUrl, secret }),
          },
          config: template,
        },
        { userId, sessionId, workspace: { id: userId, isPersonal: true }, role: 'owner' },
        { name: 'Team', slug: `nt-${t}`, idempotencyKey: `k-${t}` },
      )
      created.workspaces.push(started.targetWorkspaceId)
      return started
    },
  }
}

async function settled(transferId: string) {
  const deadline = Date.now() + 45_000
  for (;;) {
    const [row] = await db
      .select()
      .from(workspaceTransfer)
      .where(eq(workspaceTransfer.id, transferId))
    if (row && ['completed', 'compensated'].includes(row.status)) return row
    if (Date.now() > deadline) throw new Error(`transfer stuck in ${row?.status}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

describe('Node DBOS 流转 Workflow', () => {
  it('升级成功：全部数据移到新团队空间，会话切换并失效缓存', async () => {
    const f = await upgrade()
    const started = await f.start()
    const row = await settled(started.transferId)
    expect(row).toMatchObject({ status: 'completed', workflowInstanceId: started.transferId })
    expect(await tableCounts(db, started.targetWorkspaceId)).toEqual(f.counts)
    expect(Object.values(await tableCounts(db, f.userId)).every((n) => n === 0)).toBe(true)
    const [s] = await db.select().from(session).where(eq(session.id, f.sessionId))
    expect(s?.activeOrganizationId).toBe(started.targetWorkspaceId)
    // 会话缓存失效在完成之后的步骤里，稍等
    const deadline = Date.now() + 10_000
    while (!deleted.includes(`auth:t-${f.sessionId}`) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100))
    expect(deleted).toContain(`auth:t-${f.sessionId}`)
  }, 60_000)

  it('批次不可重试失败：逆序补偿，个人空间逐行恢复，新空间软删', async () => {
    const f = await upgrade()
    // plan 把状态改为 running 的同一事务里，在目标空间写入一条抽检：验证批次因目标非空失败
    const migrator = postgres(migratorUrl, { max: 1 })
    const fn = `transfer_block_${f.t}`
    try {
      await migrator.unsafe(`create function ${fn}() returns trigger language plpgsql as $$
        begin
          insert into accuracy_audit (id, workspace_id, week_of, seed, sample_size)
            values (gen_random_uuid(), new.target_workspace_id, '2031-02-03', 'x', 1);
          return new;
        end $$`)
      await migrator.unsafe(`create trigger ${fn} after update of status on workspace_transfer
        for each row when (old.status = 'pending' and new.status = 'running'
          and new.source_workspace_id = '${f.userId}') execute function ${fn}()`)
      const started = await f.start()
      const row = await settled(started.transferId)
      expect(row).toMatchObject({ status: 'compensated', errorCode: 'TRANSFER_TARGET_NOT_EMPTY' })
      expect(await snapshotRows(db, [f.userId])).toEqual(f.before)
      const [team] = await db
        .select()
        .from(organization)
        .where(eq(organization.id, started.targetWorkspaceId))
      expect(team?.deletedAt).not.toBeNull()
      await db.execute(
        sql`delete from accuracy_audit where workspace_id = ${started.targetWorkspaceId}`,
      )
    } finally {
      await migrator.unsafe(`drop trigger if exists ${fn} on workspace_transfer`)
      await migrator.unsafe(`drop function if exists ${fn}()`)
      await migrator.end()
    }
  }, 60_000)
})
