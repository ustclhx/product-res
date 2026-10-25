import {
  accuracyAudit,
  accuracyAuditItem,
  brandEntry,
  categoryStudy,
  categoryStudySnapshot,
  cluster,
  clusterMember,
  clusterSignal,
  costingScenario,
  costParam,
  type Database,
  decision,
  direction,
  directionSeller,
  followOutcome,
  lead,
  leadEvent,
  logisticsProfile,
  member,
  organization,
  readinessStat,
  recommendation,
  recommendationLabel,
  riskFinding,
  riskRule,
  scoringSetting,
  seasonalNode,
  session,
  supplier,
  supplierQuote,
  trackedProduct,
  trackedStore,
  user,
  weightSuggestion,
} from '@product-res/db'
import { newId } from '@product-res/shared'
import { sql } from 'drizzle-orm'
import { FLOWING_TRANSFER_TABLES } from '../src/transfer/registry.ts'
import { insertProduct } from './helpers.ts'

// add-workspace-data-transfer 集成测试的数据构造与比对工具。

export const config = {
  tenancy: { multiTenant: true, dataTransfer: true, maxWorkspacesPerUser: 5 },
} as const

export interface Created {
  users: string[]
  workspaces: string[]
  products: string[]
}

export async function createUser(db: Database, created: Created, label: string): Promise<string> {
  const id = newId()
  await db.insert(user).values({ id, name: label, email: `${label}-${id}@test.invalid` })
  created.users.push(id)
  return id
}

export async function createSession(db: Database, userId: string, workspaceId: string) {
  const id = newId()
  await db.insert(session).values({
    id,
    userId,
    token: `t-${id}`,
    expiresAt: new Date(Date.now() + 86400_000),
    activeOrganizationId: workspaceId,
  })
  return id
}

export async function createTeam(
  db: Database,
  created: Created,
  name: string,
  members: readonly { userId: string; role: 'owner' | 'admin' | 'member' }[],
): Promise<string> {
  const id = newId()
  await db.insert(organization).values({ id, name, slug: `t-${id.slice(-12)}`, isPersonal: false })
  for (const m of members)
    await db
      .insert(member)
      .values({ id: newId(), organizationId: id, userId: m.userId, role: m.role })
  created.workspaces.push(id)
  return id
}

export interface Seeded {
  node: string
  rule: string
  supplier: string
  profile: string
  direction: string
  seller: string
  cluster: string
  mergedCluster: string
  lead: string
  quote: string
  scenario: string
  decision: string
  recommendation: string
  store: string
  trackedProduct: string
  study: string
  product: string
}

export interface SeedOptions {
  readonly tag: string
  readonly directionName?: string
  readonly nodeName?: string
  readonly profileName?: string
  readonly sellerKey?: string
  readonly product?: string
  readonly tier?: 'hot' | 'normal' | 'cold'
  /** 方向合并会级联删除源方向的准备度统计，合并用例不写 */
  readonly readiness?: boolean
  /** 只在升级时流转的表（抽检、权重建议、评分设置） */
  readonly upgradeOnly?: boolean
}

/** 一个空间的完整选品数据：每张参与流转的表至少一行（upgradeOnly=false 时除只在升级流转的表） */
export async function seedWorkspace(
  db: Database,
  created: Created,
  ws: string,
  options: SeedOptions,
): Promise<Seeded> {
  const { tag } = options
  const product =
    options.product ??
    (await insertProduct(db, {
      marketplace: 'ebay-us',
      platformId: `v1|${tag}|${newId().slice(-6)}|0`,
      title: `Pumpkin ${tag}`,
      firstSeenOn: '2031-01-01',
    }))
  if (!options.product) created.products.push(product)
  const [node] = await db
    .insert(seasonalNode)
    .values({
      workspaceId: ws,
      name: options.nodeName ?? 'Halloween',
      startMonth: 9,
      startDay: 1,
      salesDays: 60,
    })
    .returning()
  await db.insert(brandEntry).values({ workspaceId: ws, name: 'Acme', kind: 'brand' })
  const [rule] = await db
    .insert(riskRule)
    .values({
      workspaceId: ws,
      kind: 'hazmat',
      match: { attributes: ['battery'] },
      level: 'high',
      description: 'battery',
    })
    .returning()
  const [sup] = await db
    .insert(supplier)
    .values({ workspaceId: ws, name: 'Yiwu Co', platform: '1688' })
    .returning()
  const [profile] = await db
    .insert(logisticsProfile)
    .values({
      workspaceId: ws,
      name: options.profileName ?? 'Air',
      platform: 'ebay',
      type: 'ebay-direct',
      transitDays: 10,
    })
    .returning()
  await db.insert(costParam).values({ workspaceId: ws, platform: 'ebay', commissionRate: 0.13 })
  const [dir] = await db
    .insert(direction)
    .values({
      workspaceId: ws,
      name: options.directionName ?? '万圣节装饰',
      marketplaces: ['ebay-us'],
      categoryIds: [`cat-${tag}`],
      keywords: ['pumpkin'],
      nodeIds: [node?.id as string],
    })
    .returning()
  const directionId = dir?.id as string
  const sellerKey = options.sellerKey ?? `seller_${tag}`
  const [seller] = await db
    .insert(directionSeller)
    .values({
      workspaceId: ws,
      directionId,
      marketplace: 'ebay-us',
      sellerPlatformId: sellerKey,
      status: 'accepted',
    })
    .returning()
  const [c1] = await db
    .insert(cluster)
    .values({ workspaceId: ws, directionId, marketplace: 'ebay-us', name: 'Pumpkin lamp' })
    .returning()
  const clusterId = c1?.id as string
  const [c2] = await db
    .insert(cluster)
    .values({
      workspaceId: ws,
      directionId,
      marketplace: 'ebay-us',
      name: 'Pumpkin lamp dup',
      status: 'merged',
      mergedIntoId: clusterId,
    })
    .returning()
  await db
    .insert(clusterMember)
    .values({ workspaceId: ws, clusterId, productId: product, method: 'gtin', confidence: 1 })
  await db.insert(clusterSignal).values({
    workspaceId: ws,
    clusterId,
    observedOn: '2031-01-02',
    dimension: 'market-demand',
    score: 50,
  })
  const [ld] = await db
    .insert(lead)
    .values({ workspaceId: ws, clusterId, directionId, leadOn: '2031-01-02', settingVersion: 1 })
    .returning()
  const leadId = ld?.id as string
  await db
    .insert(leadEvent)
    .values({ workspaceId: ws, leadId, clusterId, kind: 'note', payload: { text: 'hi' } })
  await db
    .insert(riskFinding)
    .values({ workspaceId: ws, clusterId, kind: 'hazmat', ref: rule?.id as string, level: 'high' })
  const [quote] = await db
    .insert(supplierQuote)
    .values({
      workspaceId: ws,
      supplierId: sup?.id as string,
      clusterId,
      tiers: [{ minQty: 1, unitPriceMinor: 100 }],
      currency: 'CNY',
      confidence: 'public',
      quotedOn: '2031-01-02',
    })
    .returning()
  const [scenario] = await db
    .insert(costingScenario)
    .values({
      workspaceId: ws,
      leadId,
      quoteId: quote?.id as string,
      profileId: profile?.id as string,
      mode: 'same-source',
      plannedQty: 100,
      result: { status: 'ok' },
    })
    .returning()
  const [dec] = await db
    .insert(decision)
    .values({
      workspaceId: ws,
      leadId,
      kind: 'follow',
      scenarioId: scenario?.id as string,
      snapshot: { score: 50 },
    })
    .returning()
  await db
    .insert(followOutcome)
    .values({ workspaceId: ws, decisionId: dec?.id as string, actualUnits: 3 })
  const [rec] = await db
    .insert(recommendation)
    .values({
      workspaceId: ws,
      leadId,
      clusterId,
      directionId,
      frozenOn: '2031-01-02',
      marketplace: 'ebay-us',
      signalType: 'market-demand',
      score: 50,
      grade: 'recommend',
      settingVersion: 1,
      inputs: {},
      sampleKind: 'shadow',
    })
    .returning()
  await db.insert(recommendationLabel).values({
    workspaceId: ws,
    recommendationId: rec?.id as string,
    windowDays: 30,
    outcome: 'hit',
  })
  const [store] = await db
    .insert(trackedStore)
    .values({
      workspaceId: ws,
      platform: 'ebay',
      marketplace: 'ebay-us',
      sellerKey,
      kind: 'benchmark',
      directionIds: [directionId],
    })
    .returning()
  const [tp] = await db
    .insert(trackedProduct)
    .values({
      workspaceId: ws,
      productId: product,
      tier: options.tier ?? 'normal',
      origin: 'store',
      originRef: store?.id as string,
      lastSnapshotOn: '2031-01-02',
    })
    .returning()
  const [study] = await db
    .insert(categoryStudy)
    .values({ workspaceId: ws, name: 'Lamps', marketplace: 'ebay-us' })
    .returning()
  await db
    .insert(categoryStudySnapshot)
    .values({ workspaceId: ws, studyId: study?.id as string, modules: {} })
  if (options.readiness ?? true)
    await db.insert(readinessStat).values({
      workspaceId: ws,
      marketplace: 'ebay-us',
      directionId,
      signalType: 'market-demand',
      computedOn: '2031-01-03',
      level: 'cold-start',
    })
  if (options.upgradeOnly) {
    await db.insert(scoringSetting).values({
      workspaceId: ws,
      version: 1,
      weights: {
        'market-demand': 1,
        'growth-season': 1,
        'peer-spread': 1,
        profit: 1,
        competition: 1,
        'supply-timing': 1,
        compliance: 1,
      },
      reverseDimensions: [],
      vetoThreshold: 30,
      minDimensions: 3,
      hardGates: { compliance: true, timing: true, margin: true },
      marginFloorBp: 1500,
    })
    await db.insert(weightSuggestion).values({
      workspaceId: ws,
      sampleCount: 10,
      suggestedWeights: {} as never,
      currentWeights: {} as never,
      metrics: {},
    })
    const [audit] = await db
      .insert(accuracyAudit)
      .values({ workspaceId: ws, weekOf: '2031-01-06', seed: 's', sampleSize: 1 })
      .returning()
    await db
      .insert(accuracyAuditItem)
      .values({ workspaceId: ws, auditId: audit?.id as string, productId: product })
  }
  return {
    node: node?.id as string,
    rule: rule?.id as string,
    supplier: sup?.id as string,
    profile: profile?.id as string,
    direction: directionId,
    seller: seller?.id as string,
    cluster: clusterId,
    mergedCluster: c2?.id as string,
    lead: leadId,
    quote: quote?.id as string,
    scenario: scenario?.id as string,
    decision: dec?.id as string,
    recommendation: rec?.id as string,
    store: store?.id as string,
    trackedProduct: tp?.id as string,
    study: study?.id as string,
    product,
  }
}

/** 每张参与流转的表在某空间中的行数 */
export async function tableCounts(db: Database, ws: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const entry of FLOWING_TRANSFER_TABLES) {
    const rows = (await db.execute(
      sql`select count(*)::int as n from ${sql.raw(`"${entry.name}"`)} where workspace_id = ${ws}`,
    )) as unknown as { n: number }[]
    out[entry.name] = rows[0]?.n ?? 0
  }
  return out
}

/** 两个空间中全部可流转行的 to_jsonb 快照（按表、按行排序），用于补偿前后逐行比对 */
export async function snapshotRows(db: Database, workspaces: readonly string[]) {
  const out: Record<string, unknown[]> = {}
  for (const entry of FLOWING_TRANSFER_TABLES) {
    const rows = (await db.execute(
      sql`select to_jsonb(t) as j from ${sql.raw(`"${entry.name}"`)} t
        where workspace_id in (${sql.join(
          workspaces.map((w) => sql`${w}`),
          sql`, `,
        )}) order by to_jsonb(t)::text`,
    )) as unknown as { j: unknown }[]
    out[entry.name] = rows.map((r) => r.j)
  }
  return out
}

/** 尽力清理：业务行按注册表逆序删除；审计只追加，残留的空间与用户保留 */
export async function cleanupCreated(db: Database, created: Created) {
  const attempt = async (query: ReturnType<typeof sql>) => {
    try {
      await db.execute(query)
    } catch {
      // 审计等只追加的引用会阻止删除空间 / 用户，测试库是隔离的，残留可接受
    }
  }
  const ws = created.workspaces
  if (ws.length) {
    const list = sql.join(
      ws.map((w) => sql`${w}`),
      sql`, `,
    )
    await attempt(
      sql`delete from workspace_transfer where source_workspace_id in (${list}) or target_workspace_id in (${list})`,
    )
    for (const entry of [...FLOWING_TRANSFER_TABLES].reverse())
      await attempt(sql`delete from ${sql.raw(`"${entry.name}"`)} where workspace_id in (${list})`)
  }
  if (created.users.length) {
    const users = sql.join(
      created.users.map((u) => sql`${u}`),
      sql`, `,
    )
    await attempt(sql`delete from session where user_id in (${users})`)
    await attempt(sql`delete from member where user_id in (${users})`)
  }
  for (const w of ws) await attempt(sql`delete from organization where id = ${w}`)
  for (const u of created.users) await attempt(sql`delete from "user" where id = ${u}`)
  if (created.products.length) {
    const products = sql.join(
      created.products.map((p) => sql`${p}`),
      sql`, `,
    )
    await attempt(sql`delete from marketplace_product where id in (${products})`)
  }
}
