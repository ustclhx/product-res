import type { Marketplace } from '@product-res/datasources'
import { METRICS } from '@product-res/datasources'
import {
  cluster,
  clusterMember,
  clusterSignal,
  direction,
  lead,
  leadEvent,
  marketplaceKeyword,
  marketplaceProduct,
  riskFinding,
  scoped,
  scoringSetting,
  seasonalNode,
} from '@product-res/db'
import {
  listSources,
  type MetricPoint,
  normalizePhrase,
  readMetrics,
} from '@product-res/marketdata'
import { patentSearchLink } from '@product-res/risk'
import {
  addDays,
  CONFIDENCE_LABELS,
  DEFAULT_SCORING_SETTINGS,
  type DimensionId,
} from '@product-res/selection'
import { and, asc, count, desc, eq, inArray, like, ne, type SQL, sql } from 'drizzle-orm'
import { webConnectors } from '../data-center/registry.server.ts'
import type { WorkbenchActor } from '../workbench/actor.ts'
import {
  allDimensions,
  attention,
  CANDIDATE_PAGE_SIZE,
  type CandidateSearch,
  displayGrade,
  externalSources,
  hitSignals,
  type Platform,
  parseConfidence,
  parseEvidence,
  parseGates,
  parseSignalInputs,
  platformOfMarketplace,
  type SignalSource,
  uiReadiness,
} from './candidates.ts'
import { marketplaceLabel } from './marketplaces.ts'

/**
 * 跟卖候选列表与商品簇详情的读取（specs/follow-candidates）。空间数据经 scoped()，
 * 市场数据（商品、观测值）是部署级共享表，经 packages/marketdata 读取。返回值全部可序列化。
 */

const RISK_LABELS: Record<string, string> = {
  brand: '品牌',
  vero: 'VeRO',
  'brand-registry': '品牌备案',
  'design-patent': '外观专利',
  'image-copyright': '图片版权',
  'restricted-category': '受限类目',
  certification: '认证',
  hazmat: '危险品',
  'shipping-ban': '禁运',
}
const riskLabel = (kind: string) => RISK_LABELS[kind] ?? kind
const RISK_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2, info: 3 }

const metricLabel = (metric: string) =>
  (METRICS as Record<string, { label: string }>)[metric]?.label ?? metric

/** 数据源 ID → 显示名（连接器标签；内部来源用中文名） */
function sourceLabels(): Record<string, string> {
  const labels: Record<string, string> = {
    manual: '人工填写',
    'selection-config': '选品配置',
    'risk-rules': '风险规则',
  }
  for (const c of webConnectors().all()) labels[c.id] = c.label
  return labels
}

const latest = (points: readonly MetricPoint[] | undefined) => points?.at(-1) ?? null

function dateOnly(d: Date) {
  return d.toISOString().slice(0, 10)
}

/** 本簇最新一天的线索（同一簇按日期只保留最新） */
const isLatestLead = sql`${lead.leadOn} = (select max(l2.lead_on) from lead l2 where l2.cluster_id = ${lead.clusterId})`

// ---------- 候选列表 ----------

export async function candidatesPage(actor: WorkbenchActor, search: CandidateSearch) {
  const { db, workspaceId } = actor
  const s = scoped(db, workspaceId)
  const directions = await s
    .select(direction, {
      fields: {
        id: direction.id,
        name: direction.name,
        marketplaces: direction.marketplaces,
        enabled: direction.enabled,
      },
    })
    .orderBy(asc(direction.createdAt))
  const platformDirections = directions.filter((d) =>
    d.marketplaces.some((m) => platformOfMarketplace(m) === search.platform),
  )
  const activeClusters = s.select(cluster, {
    where: and(
      eq(cluster.status, 'active'),
      like(cluster.marketplace, `${search.platform}-%`),
    ) as SQL,
    fields: { id: cluster.id },
  })
  const where = and(
    isLatestLead,
    inArray(lead.clusterId, activeClusters),
    ...(search.direction ? [eq(lead.directionId, search.direction)] : []),
  ) as SQL
  const [leadRows, [total]] = await Promise.all([
    s
      .select(lead, {
        where,
        fields: {
          leadId: lead.id,
          clusterId: lead.clusterId,
          directionId: lead.directionId,
          leadOn: lead.leadOn,
          score: lead.score,
          confidence: lead.confidence,
          confidenceDetail: lead.confidenceDetail,
          gates: lead.gates,
          vetoed: lead.vetoed,
          latestDecisionOn: lead.latestDecisionOn,
          settingVersion: lead.settingVersion,
          followMode: lead.followMode,
        },
      })
      // 排序键 = 综合分 × 置信度（design D6）；没有综合分的排在最后
      .orderBy(
        sql`coalesce(${lead.score} * ${lead.confidence}, -1) desc`,
        sql`${lead.score} desc nulls last`,
        asc(lead.clusterId),
      )
      .limit(CANDIDATE_PAGE_SIZE)
      .offset(search.offset),
    s.select(lead, { where, fields: { n: count() } }),
  ])
  const clusterRows = leadRows.length
    ? await s.select(cluster, {
        where: inArray(
          cluster.id,
          leadRows.map((r) => r.clusterId),
        ),
      })
    : []
  const clusterById = new Map(clusterRows.map((c) => [c.id, c]))
  const rows = leadRows.flatMap((r) => {
    const c = clusterById.get(r.clusterId)
    return c
      ? [
          {
            ...r,
            clusterName: c.name,
            marketplace: c.marketplace,
            representativeProductId: c.representativeProductId,
          },
        ]
      : []
  })

  const clusterIds = rows.map((r) => r.clusterId)
  const [members, signals, risks, settings] = await Promise.all([
    clusterIds.length
      ? s.select(clusterMember, {
          where: inArray(clusterMember.clusterId, clusterIds),
          fields: {
            clusterId: clusterMember.clusterId,
            productId: clusterMember.productId,
            confidence: clusterMember.confidence,
          },
        })
      : [],
    clusterIds.length
      ? s.select(clusterSignal, {
          where: inArray(clusterSignal.clusterId, clusterIds),
          fields: {
            clusterId: clusterSignal.clusterId,
            observedOn: clusterSignal.observedOn,
            dimension: clusterSignal.dimension,
            score: clusterSignal.score,
            inputs: clusterSignal.inputs,
          },
        })
      : [],
    clusterIds.length
      ? s.select(riskFinding, { where: inArray(riskFinding.clusterId, clusterIds) })
      : [],
    s.select(scoringSetting, {
      fields: { version: scoringSetting.version, reversed: scoringSetting.reverseDimensions },
    }),
  ])
  const reversedOf = new Map(settings.map((v) => [v.version, v.reversed]))

  // 代表商品缺失时用归并置信度最高的成员
  const productOf = new Map<string, string>()
  const memberCount = new Map<string, number>()
  for (const m of [...members].sort((a, b) => b.confidence - a.confidence)) {
    memberCount.set(m.clusterId, (memberCount.get(m.clusterId) ?? 0) + 1)
    if (!productOf.has(m.clusterId)) productOf.set(m.clusterId, m.productId)
  }
  for (const r of rows)
    if (r.representativeProductId) productOf.set(r.clusterId, r.representativeProductId)
  const productIdList = [...new Set(productOf.values())]
  const products = productIdList.length
    ? await db
        .select({
          id: marketplaceProduct.id,
          platformId: marketplaceProduct.platformId,
          title: marketplaceProduct.title,
          imageUrl: marketplaceProduct.imageUrl,
          categoryId: marketplaceProduct.categoryId,
        })
        .from(marketplaceProduct)
        .where(inArray(marketplaceProduct.id, productIdList))
    : []
  const productById = new Map(products.map((p) => [p.id, p]))
  const today = dateOnly(new Date())
  const metrics = productIdList.length
    ? await readMetrics(db, {
        entityType: 'product',
        entityIds: productIdList,
        metrics: search.platform === 'amazon' ? ['price', 'bsr'] : ['price'],
        marketplace: (rows[0]?.marketplace ?? 'amazon-us') as Marketplace,
        from: addDays(today, -30),
      })
    : new Map<string, Map<string, MetricPoint[]>>()

  const labels = sourceLabels()
  const directionName = new Map(directions.map((d) => [d.id, d.name]))
  const items = rows.map((r) => {
    const own = signals.filter((x) => x.clusterId === r.clusterId && x.observedOn === r.leadOn)
    const parsed = own.map((x) => ({ ...x, parsed: parseSignalInputs(x.inputs) }))
    const confidence = parseConfidence(r.confidenceDetail)
    const gates = parseGates(r.gates)
    const productId = productOf.get(r.clusterId)
    const product = productId ? productById.get(productId) : undefined
    const series = productId ? metrics.get(productId) : undefined
    const price = latest(series?.get('price'))
    const bsr = latest(series?.get('bsr'))
    const clusterRisks = risks
      .filter((f) => f.clusterId === r.clusterId && f.level !== 'info')
      .sort(
        (a, b) =>
          Number(b.veto) - Number(a.veto) ||
          (RISK_ORDER[a.level] ?? 9) - (RISK_ORDER[b.level] ?? 9),
      )
    return {
      leadId: r.leadId,
      clusterId: r.clusterId,
      name: product?.title ?? r.clusterName,
      platformId: product?.platformId ?? null,
      imageUrl: product?.imageUrl ?? null,
      categoryId: product?.categoryId ?? null,
      marketplace: r.marketplace,
      marketplaceLabel: marketplaceLabel(r.marketplace),
      directionName: directionName.get(r.directionId) ?? '',
      memberCount: memberCount.get(r.clusterId) ?? 0,
      leadOn: r.leadOn,
      score: r.score,
      confidence: r.confidence,
      readiness: uiReadiness(confidence.readiness),
      grade: displayGrade({
        score: r.score,
        gatesPassed: gates.passed,
        vetoed: r.vetoed,
        readiness: confidence.readiness,
      }),
      gateReasons: gates.reasons,
      attention: attention(r.score, r.confidence),
      followMode: r.followMode,
      signals: hitSignals(
        parsed.map((x) => ({ dimension: x.dimension as DimensionId, score: x.score })),
        reversedOf.get(r.settingVersion) ?? DEFAULT_SCORING_SETTINGS.reversed,
      ),
      risks: clusterRisks.map((f) => ({
        kind: f.kind,
        label: riskLabel(f.kind),
        level: f.level,
        veto: f.veto,
      })),
      price: price ? { value: price.primary.value, currency: price.primary.currency } : null,
      bsr: bsr ? bsr.primary.value : null,
      latestDecisionOn: r.latestDecisionOn,
      sources: externalSources(parsed.flatMap((x) => x.parsed.sources)).map((x) => ({
        ...x,
        label: labels[x.sourceId] ?? x.sourceId,
      })),
    }
  })

  // 空状态：说明下一步该配置什么（方向、数据源），不放示例数据
  const enabledSources = items.length
    ? null
    : (await listSources(db)).filter((x) => x.enabled).length
  return {
    search,
    items,
    total: total?.n ?? 0,
    directions: platformDirections.map((d) => ({ id: d.id, name: d.name, enabled: d.enabled })),
    setup:
      enabledSources === null
        ? null
        : {
            directions: directions.length,
            platformDirections: platformDirections.length,
            enabledSources,
          },
  }
}

// ---------- 商品簇详情 ----------

/** 来源对比展示的指标（按平台），只显示有观测的 */
const COMPARE_METRICS: Record<Platform, string[]> = {
  amazon: [
    'price',
    'buybox_price',
    'sales_estimate_monthly',
    'bsr',
    'seller_count',
    'review_count',
    'rating',
  ],
  ebay: [
    'price',
    'shipping_price',
    'sold_quantity_total',
    'sold_quantity_daily',
    'available_quantity',
    'review_count',
  ],
}
const SERIES_DAYS = 90
const MAX_SERIES_MEMBERS = 6

function sourceValues(point: MetricPoint, labels: Record<string, string>) {
  return {
    observedOn: point.observedOn,
    primarySourceId: point.primary.sourceId,
    dispersion: point.dispersion,
    values: point.values.map((v) => ({
      sourceId: v.sourceId,
      label: labels[v.sourceId] ?? v.sourceId,
      value: v.value,
      currency: v.currency,
      method: v.method,
      fetchedAt: v.fetchedAt.toISOString(),
    })),
  }
}
export type MetricView = ReturnType<typeof sourceValues> & { metric: string; label: string }

/** eBay 没有直接的日销量时，用累计已售的相邻差分（按间隔天数折算） */
function dailyFromTotal(points: readonly MetricPoint[]): Array<[string, number]> {
  const out: Array<[string, number]> = []
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1] as MetricPoint
    const cur = points[i] as MetricPoint
    const days = Math.max(
      1,
      Math.round((Date.parse(cur.observedOn) - Date.parse(prev.observedOn)) / 86_400_000),
    )
    const delta = cur.primary.value - prev.primary.value
    if (delta >= 0) out.push([cur.observedOn, Math.round((delta / days) * 10) / 10])
  }
  return out
}

export async function clusterDetail(actor: WorkbenchActor, clusterId: string, canWrite: boolean) {
  const { db, workspaceId } = actor
  const s = scoped(db, workspaceId)
  const c = await s.findById(cluster, clusterId)
  const platform = platformOfMarketplace(c.marketplace) ?? 'amazon'
  const marketplace = c.marketplace as Marketplace
  const [dir, memberRows, [leadRow], risks, events] = await Promise.all([
    s.findById(direction, c.directionId),
    s.select(clusterMember, { where: eq(clusterMember.clusterId, c.id) }),
    s
      .select(lead, { where: eq(lead.clusterId, c.id) })
      .orderBy(desc(lead.leadOn))
      .limit(1),
    s.select(riskFinding, { where: eq(riskFinding.clusterId, c.id) }),
    s
      .select(leadEvent, { where: eq(leadEvent.clusterId, c.id) })
      .orderBy(desc(leadEvent.createdAt))
      .limit(20),
  ])
  const productIdList = memberRows.map((m) => m.productId)
  const products = productIdList.length
    ? await db
        .select()
        .from(marketplaceProduct)
        .where(inArray(marketplaceProduct.id, productIdList))
    : []
  const productById = new Map(products.map((p) => [p.id, p]))
  const members = memberRows
    .map((m) => {
      const p = productById.get(m.productId)
      return {
        id: m.id,
        productId: m.productId,
        platformId: p?.platformId ?? '',
        title: p?.title ?? p?.platformId ?? '',
        imageUrl: p?.imageUrl ?? null,
        url: p?.url ?? null,
        sellerId: p?.sellerId ?? null,
        brand: p?.brand ?? null,
        method: m.method,
        confidence: m.confidence,
        locked: m.locked,
        isRepresentative: m.productId === c.representativeProductId,
      }
    })
    .sort(
      (a, b) =>
        Number(b.isRepresentative) - Number(a.isRepresentative) || b.confidence - a.confidence,
    )
  const rep = members[0] ?? null
  const repProduct = rep ? productById.get(rep.productId) : undefined

  const [signalRows, settingRow] = await Promise.all([
    leadRow
      ? s.select(clusterSignal, {
          where: and(
            eq(clusterSignal.clusterId, c.id),
            eq(clusterSignal.observedOn, leadRow.leadOn),
          ) as SQL,
        })
      : [],
    leadRow
      ? s
          .select(scoringSetting, { where: eq(scoringSetting.version, leadRow.settingVersion) })
          .limit(1)
      : [],
  ])
  const reversed = new Set<string>(
    settingRow[0]?.reverseDimensions ?? DEFAULT_SCORING_SETTINGS.reversed,
  )
  const dimensions = allDimensions(signalRows).map(({ dimension, label, row }) => {
    const parsed = parseSignalInputs(row?.inputs)
    return {
      dimension,
      label,
      score: row?.score ?? null,
      reversed: reversed.has(dimension),
      reason: parsed.reason,
      sources: parsed.sources,
      computedAt: row?.computedAt.toISOString() ?? null,
    }
  })

  const confidence = parseConfidence(leadRow?.confidenceDetail)
  const gates = parseGates(leadRow?.gates)

  // 市场数据：成员价格 / 销量曲线与来源对比
  const today = dateOnly(new Date())
  const seriesMembers = members.slice(0, MAX_SERIES_MEMBERS)
  const salesMetric = platform === 'amazon' ? 'sales_estimate_monthly' : 'sold_quantity_total'
  const metricData = await readMetrics(db, {
    entityType: 'product',
    entityIds: members.map((m) => m.productId),
    metrics: [...new Set([...COMPARE_METRICS[platform], salesMetric])],
    marketplace,
    from: addDays(today, -SERIES_DAYS),
  })
  const labels = sourceLabels()
  const memberLabel = (m: (typeof members)[number]) =>
    m.platformId ? `${m.platformId}${m.sellerId ? ` · ${m.sellerId}` : ''}` : m.title
  const priceSeries = seriesMembers
    .map((m) => ({
      name: memberLabel(m),
      points: (metricData.get(m.productId)?.get('price') ?? []).map(
        (p) => [p.observedOn, p.primary.value] as [string, number],
      ),
    }))
    .filter((x) => x.points.length > 0)
  const salesSeries = seriesMembers
    .map((m) => {
      const points = metricData.get(m.productId)?.get(salesMetric) ?? []
      const daily = metricData.get(m.productId)?.get('sold_quantity_daily') ?? []
      return {
        name: memberLabel(m),
        points:
          platform === 'amazon'
            ? points.map((p) => [p.observedOn, p.primary.value] as [string, number])
            : daily.length > 0
              ? daily.map((p) => [p.observedOn, p.primary.value] as [string, number])
              : dailyFromTotal(points),
      }
    })
    .filter((x) => x.points.length > 0)

  const compare = members.map((m) => ({
    productId: m.productId,
    label: memberLabel(m),
    metrics: COMPARE_METRICS[platform].flatMap((metric): MetricView[] => {
      const point = latest(metricData.get(m.productId)?.get(metric))
      return point ? [{ metric, label: metricLabel(metric), ...sourceValues(point, labels) }] : []
    }),
  }))
  const headlineOf = (metric: string): MetricView | null => {
    const point = rep ? latest(metricData.get(rep.productId)?.get(metric)) : null
    return point ? { metric, label: metricLabel(metric), ...sourceValues(point, labels) } : null
  }

  const season = await seasonCurve(actor, dir.nodeIds, marketplace)
  const mergeTargets = await s
    .select(cluster, {
      where: and(
        eq(cluster.directionId, c.directionId),
        eq(cluster.marketplace, c.marketplace),
        eq(cluster.status, 'active'),
        ne(cluster.id, c.id),
      ) as SQL,
      fields: { id: cluster.id, name: cluster.name },
    })
    .orderBy(asc(cluster.name))
    .limit(200)

  return {
    canWrite,
    cluster: {
      id: c.id,
      name: repProduct?.title ?? c.name,
      clusterName: c.name,
      marketplace: c.marketplace,
      marketplaceLabel: marketplaceLabel(c.marketplace),
      platform,
      status: c.status,
      mergedIntoId: c.mergedIntoId,
      directionId: dir.id,
      directionName: dir.name,
      imageUrl: repProduct?.imageUrl ?? null,
      url: repProduct?.url ?? null,
      platformId: repProduct?.platformId ?? null,
      categoryId: repProduct?.categoryId ?? null,
      brand: repProduct?.brand ?? null,
    },
    lead: leadRow
      ? {
          id: leadRow.id,
          leadOn: leadRow.leadOn,
          score: leadRow.score,
          confidence: leadRow.confidence,
          readiness: uiReadiness(confidence.readiness),
          grade: displayGrade({
            score: leadRow.score,
            gatesPassed: gates.passed,
            vetoed: leadRow.vetoed,
            readiness: confidence.readiness,
          }),
          gateReasons: gates.reasons,
          vetoed: leadRow.vetoed,
          attention: attention(leadRow.score, leadRow.confidence),
          latestDecisionOn: leadRow.latestDecisionOn,
          settingVersion: leadRow.settingVersion,
          status: leadRow.status,
        }
      : null,
    dimensions,
    confidence: {
      items: confidence.items.map((i) => ({ ...i, label: CONFIDENCE_LABELS[i.id] })),
      unverifiedMetrics: confidence.unverifiedMetrics.map((m) => ({
        metric: m,
        label: metricLabel(m),
      })),
    },
    risks: risks
      .map((f) => {
        const evidence = parseEvidence(f.evidence)
        return {
          id: f.id,
          kind: f.kind,
          label: riskLabel(f.kind),
          level: f.level,
          veto: f.veto,
          basis: evidence.basis ?? f.ref,
          // 外观专利：流水线未存链接时按代表商品标题生成 Google Patents 检索链接
          link:
            evidence.link ??
            (f.kind === 'design-patent' ? patentSearchLink(repProduct?.title ?? c.name) : null),
          detectedAt: f.detectedAt.toISOString(),
        }
      })
      .sort(
        (a, b) =>
          Number(b.veto) - Number(a.veto) ||
          (RISK_ORDER[a.level] ?? 9) - (RISK_ORDER[b.level] ?? 9),
      ),
    headline: {
      price: headlineOf('price'),
      sales: headlineOf(salesMetric),
      bsr: platform === 'amazon' ? headlineOf('bsr') : null,
    },
    series: {
      price: priceSeries,
      sales: {
        label: platform === 'amazon' ? '月销量估算' : '日销量（累计已售差分）',
        series: salesSeries,
      },
    },
    season,
    compare,
    members,
    mergeTargets,
    sourceLabels: labels,
    events: events.map((e) => ({
      id: e.id,
      kind: e.kind,
      summary: eventSummary(e.kind, e.payload, c.id),
      createdAt: e.createdAt.toISOString(),
    })),
  }
}

/** 线索事件的一句话说明（payload 是 JSON，不直接下发） */
function eventSummary(kind: string, payload: Record<string, unknown>, clusterId: string) {
  const ids = Array.isArray(payload.productIds) ? payload.productIds.length : 0
  if (kind === 'split')
    return payload.fromClusterId === clusterId ? '拆出 1 个成员为新簇' : '从原簇拆分而来'
  if (kind === 'merge')
    return payload.intoClusterId === clusterId ? `并入另一簇的 ${ids} 个成员` : '已合并到其他商品簇'
  if (kind === 'status') return `状态变为 ${String(payload.to ?? payload.status ?? '')}`
  return typeof payload.note === 'string' ? payload.note : '备注'
}

/**
 * 季节曲线：方向关联节点的关键词在本站点（或 global）的 search_trend_index，
 * 按年分别画出 1–12 月均值，叠加节点的销售窗口。没有节点或没有趋势数据时返回 null。
 */
async function seasonCurve(
  actor: WorkbenchActor,
  nodeIds: readonly string[],
  marketplace: Marketplace,
) {
  if (nodeIds.length === 0) return null
  const { db } = actor
  const s = scoped(db, actor.workspaceId)
  const nodes = await s.select(seasonalNode, { where: inArray(seasonalNode.id, [...nodeIds]) })
  const phrases = [...new Set(nodes.flatMap((n) => n.keywords.map(normalizePhrase)))]
  const windows = nodes.map((n) => ({
    name: n.name,
    startMonth: n.startMonth,
    startDay: n.startDay,
    salesDays: n.salesDays,
  }))
  if (phrases.length === 0) return { keywords: [], years: [], windows }
  const keywords = await db
    .select({ id: marketplaceKeyword.id, phrase: marketplaceKeyword.phrase })
    .from(marketplaceKeyword)
    .where(
      and(
        inArray(marketplaceKeyword.phrase, phrases),
        inArray(marketplaceKeyword.marketplace, [marketplace, 'global']),
      ),
    )
  const data = await readMetrics(db, {
    entityType: 'keyword',
    entityIds: keywords.map((k) => k.id),
    metrics: ['search_trend_index'],
    marketplace,
  })
  // 年 → 月 → 各关键词各观测的值
  const buckets = new Map<number, Map<number, number[]>>()
  for (const series of data.values()) {
    for (const p of series.get('search_trend_index') ?? []) {
      const year = Number(p.observedOn.slice(0, 4))
      const month = Number(p.observedOn.slice(5, 7))
      const byMonth = buckets.get(year) ?? new Map<number, number[]>()
      byMonth.set(month, [...(byMonth.get(month) ?? []), p.primary.value])
      buckets.set(year, byMonth)
    }
  }
  const years = [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([year, byMonth]) => ({
      year,
      months: Array.from({ length: 12 }, (_, i) => {
        const values = byMonth.get(i + 1)
        return values?.length
          ? Math.round((values.reduce((x, y) => x + y, 0) / values.length) * 10) / 10
          : null
      }),
    }))
  const found = new Set(keywords.filter((k) => data.has(k.id)).map((k) => k.phrase))
  return { keywords: phrases.filter((p) => found.has(p)), years, windows }
}

export type CandidatesData = Awaited<ReturnType<typeof candidatesPage>>
export type CandidateItem = CandidatesData['items'][number]
export type ClusterDetailData = Awaited<ReturnType<typeof clusterDetail>>
export type { SignalSource }
