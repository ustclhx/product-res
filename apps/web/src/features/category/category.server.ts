import {
  type CategoryStudy,
  type CategoryStudySnapshot,
  categoryStudy,
  categoryStudySnapshot,
  cluster,
  clusterMember,
  direction,
  ensureSelectionDefaults,
  lead,
  leadEvent,
  marketplaceProduct,
  scoped,
  scoringSetting,
  seasonalNode,
} from '@product-res/db'
import { AppError } from '@product-res/shared'
import { and, asc, desc, eq, inArray, ne, type SQL, sql } from 'drizzle-orm'
import { assertWorkbenchWriter } from '../workbench/access.ts'
import type { WorkbenchActor } from '../workbench/actor.ts'
import type { InsightAi } from './ai.ts'
import { buildSnapshot } from './snapshot.server.ts'
import type { SnapshotModules } from './types.ts'

/**
 * 品类研究（openspec/changes/add-category-insight tasks 3.1 / 3.4）：研究的增改与归档、快照生成与刷新、
 * 竞品转线索。读取要求空间成员；写入（含会调用 AI、计入用量的刷新）要求可写空间的 owner / admin。
 * 空间表一律经 scoped()；市场数据是部署级，只读。
 */

export interface CategoryActor extends WorkbenchActor {
  userId: string
}

export interface StudyInput {
  name: string
  marketplace: string
  categoryIds: string[]
  keywords: string[]
  topN: number
}

export interface StudyRow {
  id: string
  name: string
  marketplace: string
  categoryIds: string[]
  keywords: string[]
  topN: number
  status: CategoryStudy['status']
  updatedAt: string
  snapshotCount: number
  latestSnapshotAt: string | null
  latestDataAsOf: string | null
}

/** 线索备注的来源标记；核算页据此读取跟卖方式与改良点 */
export const CATEGORY_LEAD_SOURCE = 'category-insight'
/** 品类洞察转出的线索默认“同款微改良”（与 costing_scenario.mode 的取值一致） */
export const CATEGORY_LEAD_MODE = 'improved' as const

const conflict = (message: string) => new AppError('CONFLICT', message, { status: 409 })

async function studyRows(actor: WorkbenchActor, where: SQL): Promise<StudyRow[]> {
  const s = scoped(actor.db, actor.workspaceId)
  const studies = await s
    .select(categoryStudy, { where })
    .orderBy(desc(categoryStudy.updatedAt), asc(categoryStudy.name))
  if (studies.length === 0) return []
  const stats = await s
    .select(categoryStudySnapshot, {
      where: inArray(
        categoryStudySnapshot.studyId,
        studies.map((x) => x.id),
      ),
      fields: {
        studyId: categoryStudySnapshot.studyId,
        n: sql<number>`count(*)::int`,
        latestAt: sql<string | null>`max(${categoryStudySnapshot.generatedAt})`,
        latestDataAsOf: sql<string | null>`max(${categoryStudySnapshot.dataAsOf})::text`,
      },
    })
    .groupBy(categoryStudySnapshot.studyId)
  const byStudy = new Map(stats.map((r) => [r.studyId, r]))
  return studies.map((x) => {
    const st = byStudy.get(x.id)
    return {
      id: x.id,
      name: x.name,
      marketplace: x.marketplace,
      categoryIds: x.categoryIds,
      keywords: x.keywords,
      topN: x.topN,
      status: x.status,
      updatedAt: x.updatedAt.toISOString(),
      snapshotCount: st?.n ?? 0,
      latestSnapshotAt: st?.latestAt ? new Date(st.latestAt).toISOString() : null,
      latestDataAsOf: st?.latestDataAsOf ?? null,
    }
  })
}

export async function listStudies(actor: WorkbenchActor) {
  return {
    active: await studyRows(actor, eq(categoryStudy.status, 'active')),
    archived: await studyRows(actor, eq(categoryStudy.status, 'archived')),
  }
}

/** 已归档的品类报告，供选品档案库接入（档案库页面由 add-costing-decisions 提供） */
export async function listArchivedStudies(actor: WorkbenchActor): Promise<StudyRow[]> {
  return studyRows(actor, eq(categoryStudy.status, 'archived'))
}

function normalize(input: StudyInput) {
  const name = input.name.trim()
  const categoryIds = [...new Set(input.categoryIds.map((c) => c.trim()).filter(Boolean))]
  const keywords = [...new Set(input.keywords.map((k) => k.trim()).filter(Boolean))]
  if (!name) throw new AppError('INVALID_REQUEST', '请填写研究名称', { status: 400 })
  if (categoryIds.length === 0 && keywords.length === 0)
    throw new AppError('INVALID_REQUEST', '至少填写一个类目 ID 或关键词', { status: 400 })
  return { name, marketplace: input.marketplace, categoryIds, keywords, topN: input.topN }
}

export interface RefreshDeps {
  ai: InsightAi
  now?: Date
}

/** 新建研究并生成第一份快照 */
export async function createStudy(actor: CategoryActor, input: StudyInput, deps: RefreshDeps) {
  assertWorkbenchWriter(actor)
  const values = normalize(input)
  const s = scoped(actor.db, actor.workspaceId)
  if ((await s.count(categoryStudy, eq(categoryStudy.name, values.name))) > 0)
    throw conflict('已有同名研究')
  const [row] = await s
    .insert(categoryStudy, { ...values, createdBy: actor.userId })
    .returning({ id: categoryStudy.id })
  if (!row) throw new Error('insert category_study failed')
  const snapshot = await refreshStudy(actor, row.id, deps)
  return { id: row.id, snapshotId: snapshot.id }
}

export async function updateStudy(actor: CategoryActor, id: string, input: StudyInput) {
  assertWorkbenchWriter(actor)
  const values = normalize(input)
  const s = scoped(actor.db, actor.workspaceId)
  await s.findById(categoryStudy, id)
  if (
    (await s.count(
      categoryStudy,
      and(eq(categoryStudy.name, values.name), ne(categoryStudy.id, id)) as SQL,
    )) > 0
  )
    throw conflict('已有同名研究')
  await s.updateById(categoryStudy, id, values)
}

/**
 * 生成 / 刷新快照：每次新增一行，旧快照保留（spec「刷新保留历史」）。
 * 只读已有观测值；差评与竞品与上一份相同时沿用其 AI 结果。
 */
export async function refreshStudy(actor: CategoryActor, id: string, deps: RefreshDeps) {
  assertWorkbenchWriter(actor)
  const s = scoped(actor.db, actor.workspaceId)
  const study = await s.findById(categoryStudy, id)
  if (study.status === 'archived') throw conflict('已归档的研究不能刷新，请先取消归档')
  const [previous] = await s
    .select(categoryStudySnapshot, { where: eq(categoryStudySnapshot.studyId, id) })
    .orderBy(desc(categoryStudySnapshot.generatedAt))
    .limit(1)
  await ensureSelectionDefaults(actor.db, actor.workspaceId)
  const nodes = await s.select(seasonalNode, {
    fields: {
      name: seasonalNode.name,
      startMonth: seasonalNode.startMonth,
      startDay: seasonalNode.startDay,
    },
  })
  const now = deps.now ?? new Date()
  const { modules, dataAsOf } = await buildSnapshot(actor.db, study, {
    ai: deps.ai,
    now,
    nodes,
    previous: previous
      ? { id: previous.id, modules: previous.modules as unknown as SnapshotModules }
      : null,
  })
  const [row] = await s
    .insert(categoryStudySnapshot, {
      studyId: id,
      generatedAt: now,
      dataAsOf,
      modules: modules as unknown as Record<string, unknown>,
    })
    .returning()
  if (!row) throw new Error('insert category_study_snapshot failed')
  // 列表按最近更新排序
  await s.updateById(categoryStudy, id, { updatedAt: now })
  return { id: row.id, generatedAt: row.generatedAt.toISOString() }
}

export async function setStudyArchived(actor: CategoryActor, id: string, archived: boolean) {
  assertWorkbenchWriter(actor)
  await scoped(actor.db, actor.workspaceId).updateById(categoryStudy, id, {
    status: archived ? 'archived' : 'active',
  })
}

const snapshotMeta = (row: Pick<CategoryStudySnapshot, 'id' | 'generatedAt' | 'dataAsOf'>) => ({
  id: row.id,
  generatedAt: row.generatedAt.toISOString(),
  dataAsOf: row.dataAsOf,
})

/** 报告页：研究、快照列表（新 → 旧）、所选快照（默认最新）、可选方向与已转线索 */
export async function reportPage(actor: WorkbenchActor, id: string, snapshotId?: string) {
  const s = scoped(actor.db, actor.workspaceId)
  const study = await s.findById(categoryStudy, id)
  const snapshots = await s
    .select(categoryStudySnapshot, {
      where: eq(categoryStudySnapshot.studyId, id),
      fields: {
        id: categoryStudySnapshot.id,
        generatedAt: categoryStudySnapshot.generatedAt,
        dataAsOf: categoryStudySnapshot.dataAsOf,
      },
    })
    .orderBy(desc(categoryStudySnapshot.generatedAt))
  const selectedId = snapshotId ?? snapshots[0]?.id
  const [current] = selectedId
    ? await s.select(categoryStudySnapshot, {
        where: and(
          eq(categoryStudySnapshot.id, selectedId),
          eq(categoryStudySnapshot.studyId, id),
        ) as SQL,
      })
    : []
  if (snapshotId && !current) throw new AppError('NOT_FOUND', 'Not found', { status: 404 })
  const directions = (
    await s
      .select(direction, {
        where: eq(direction.enabled, true),
        fields: { id: direction.id, name: direction.name, marketplaces: direction.marketplaces },
      })
      .orderBy(asc(direction.createdAt))
  )
    .filter((d) => d.marketplaces.includes(study.marketplace))
    .map(({ id, name }) => ({ id, name }))
  return {
    study: {
      id: study.id,
      name: study.name,
      marketplace: study.marketplace,
      categoryIds: study.categoryIds,
      keywords: study.keywords,
      topN: study.topN,
      status: study.status,
    },
    snapshots: snapshots.map(snapshotMeta),
    snapshot: current
      ? { ...snapshotMeta(current), modules: current.modules as unknown as SnapshotModules }
      : null,
    directions,
    converted: await convertedLeads(actor, id),
  }
}

/** 本研究已转出的线索：商品 → 线索 */
async function convertedLeads(actor: WorkbenchActor, studyId: string) {
  const rows = await scoped(actor.db, actor.workspaceId)
    .select(leadEvent, {
      where: and(
        eq(leadEvent.kind, 'note'),
        sql`${leadEvent.payload}->>'source' = ${CATEGORY_LEAD_SOURCE}`,
        sql`${leadEvent.payload}->>'studyId' = ${studyId}`,
      ) as SQL,
      fields: { leadId: leadEvent.leadId, payload: leadEvent.payload },
    })
    .orderBy(asc(leadEvent.createdAt))
  const map: Record<string, string> = {}
  for (const r of rows)
    if (r.leadId && typeof r.payload.productId === 'string') map[r.payload.productId] = r.leadId
  return map
}

export interface ConvertInput {
  studyId: string
  snapshotId: string
  productId: string
  /** 省略时取覆盖该站点的第一个启用方向 */
  directionId?: string | undefined
  /** 改良点，写入线索备注并带入核算 */
  improvement: string
}

const todayUtc = (now: Date) => now.toISOString().slice(0, 10)

/**
 * 把竞品矩阵中的商品转为跟卖线索（spec「转线索」）：在所选方向下为该商品创建（或复用）单成员商品簇与线索，
 * 跟卖方式“同款微改良”与改良点写入 lead_event 备注。之后跟卖候选按方向读取线索即可看到。
 */
export async function convertToLead(actor: CategoryActor, input: ConvertInput, now = new Date()) {
  assertWorkbenchWriter(actor)
  const s = scoped(actor.db, actor.workspaceId)
  const study = await s.findById(categoryStudy, input.studyId)
  const snapshot = await s.findById(categoryStudySnapshot, input.snapshotId)
  const modules = snapshot.modules as unknown as SnapshotModules
  if (
    snapshot.studyId !== study.id ||
    modules.competitors.status !== 'ok' ||
    !modules.competitors.rows.some((r) => r.id === input.productId)
  )
    throw new AppError('NOT_FOUND', '该商品不在这份报告的竞品矩阵中', { status: 404 })
  const [product] = await actor.db
    .select({
      id: marketplaceProduct.id,
      title: marketplaceProduct.title,
      platformId: marketplaceProduct.platformId,
      marketplace: marketplaceProduct.marketplace,
    })
    .from(marketplaceProduct)
    .where(eq(marketplaceProduct.id, input.productId))
  if (!product || product.marketplace !== study.marketplace)
    throw new AppError('NOT_FOUND', 'Not found', { status: 404 })

  const enabled = (
    await s
      .select(direction, { where: eq(direction.enabled, true) })
      .orderBy(asc(direction.createdAt))
  ).filter((d) => d.marketplaces.includes(study.marketplace))
  const dir = input.directionId ? enabled.find((d) => d.id === input.directionId) : enabled[0]
  if (!dir)
    throw new AppError(
      'DIRECTION_REQUIRED',
      input.directionId
        ? '所选方向不存在、已停用或没有覆盖该站点'
        : '还没有覆盖该站点的启用方向，请先在“跟卖选品 · 选品方向”中新建',
      { status: 409 },
    )

  await ensureSelectionDefaults(actor.db, actor.workspaceId)
  const [setting] = await s
    .select(scoringSetting, { fields: { version: scoringSetting.version } })
    .orderBy(desc(scoringSetting.version))
    .limit(1)
  const improvement = input.improvement.trim()

  return s.transaction(async (tx) => {
    // 复用：同一方向下已包含该商品的有效簇
    const memberOf = tx.select(clusterMember, {
      where: eq(clusterMember.productId, product.id),
      fields: { clusterId: clusterMember.clusterId },
    })
    const [existing] = await tx
      .select(cluster, {
        where: and(
          eq(cluster.directionId, dir.id),
          eq(cluster.status, 'active'),
          inArray(cluster.id, memberOf),
        ) as SQL,
      })
      .orderBy(asc(cluster.createdAt))
      .limit(1)
    let clusterId = existing?.id
    if (!clusterId) {
      const [created] = await tx
        .insert(cluster, {
          directionId: dir.id,
          marketplace: study.marketplace,
          representativeProductId: product.id,
          name: product.title ?? product.platformId,
        })
        .returning({ id: cluster.id })
      clusterId = created?.id as string
      // 人工指定的单成员簇：锁定，自动归并不覆盖
      await tx.insert(clusterMember, {
        clusterId,
        productId: product.id,
        method: 'manual',
        confidence: 1,
        locked: true,
      })
    }
    const [reusedLead] = await tx
      .select(lead, { where: eq(lead.clusterId, clusterId) })
      .orderBy(desc(lead.leadOn))
      .limit(1)
    let leadId = reusedLead?.id
    if (!leadId) {
      const [created] = await tx
        .insert(lead, {
          clusterId,
          directionId: dir.id,
          leadOn: todayUtc(now),
          settingVersion: setting?.version ?? 1,
          status: 'new',
        })
        .returning({ id: lead.id })
      leadId = created?.id as string
    }
    await tx.insert(leadEvent, {
      leadId,
      clusterId,
      kind: 'note',
      actorUserId: actor.userId,
      payload: {
        source: CATEGORY_LEAD_SOURCE,
        followMode: CATEGORY_LEAD_MODE,
        improvement,
        studyId: study.id,
        snapshotId: snapshot.id,
        productId: product.id,
      },
    })
    return {
      leadId,
      clusterId,
      directionId: dir.id,
      directionName: dir.name,
      reusedCluster: Boolean(existing),
      reusedLead: Boolean(reusedLead),
    }
  })
}
