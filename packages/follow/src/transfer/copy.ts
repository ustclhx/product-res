import { newId } from '@product-res/shared'
import { type SQL, sql } from 'drizzle-orm'
import {
  type Context,
  plannedIds,
  plannedIn,
  setAction,
  skipMissing,
  snapshotOf,
  TIER_RANK,
  unionList,
} from './batch.ts'
import { rows, textList, transferError, uuidList } from './common.ts'
import { batchFamily, col, ident, keyOf, type TableMeta, tableMeta } from './meta.ts'
import { transferTablesInBatch } from './registry.ts'
import type { TransferReference } from './types.ts'

/**
 * 复制批次（design D1、D4、D8，tasks 3.4）。由 batch.ts 的 runBatch 分派，沿用同一套取锁
 * （涉及卖家数据的批次先取 eBay 删除共享锁）、权限校验、done 跳过与计数。
 *
 * 按注册表顺序（父先子后）逐表处理本批次清单中的行，源空间不做任何修改：
 * 1. 冲突（plan 的决定）：合并 → `merged` 并映射到目标已有行；保留目标 → `skipped`（target_id 为目标行）；
 *    合并会修改目标行（方向数组并集、店铺 direction_ids 并集、追踪商品升档）时先把目标行快照写入
 *    `source_row.target`，补偿据此恢复；重命名在插入时改名，仍记为 `copied`。
 * 2. 其余行以 `newId()` 生成新 id，`(transfer_id, table_name, source_id) → target_id` 记为 `copied`；
 *    复合主键表（cluster_signal）的 target_id 为改写后的拼接键。
 * 3. 一条 `insert … select` 落地：外键、uuid[]、origin_ref、merged_into_id、risk_finding.ref 按 ID 映射
 *    重写；映射不到时按注册表 unmapped 策略（fail 报错、drop-element 删元素、set-null 置空、keep 保留），
 *    删除 / 置空的原值记在 `source_row.unmapped`，计入 counts 的 `unmapped:<列名>`。
 *    其他列（含 jsonb 快照、setting_version、追踪商品的快照相位 last_snapshot_on / tier /
 *    tier_changed_at / tier_reason）原样保留。
 * 补偿由 lifecycle.ts 统一处理：子先父后删除 `copied` 的目标行，从 `source_row.target` 恢复被合并修改的目标行。
 */
export async function copyBatch(ctx: Context): Promise<void> {
  for (const entry of transferTablesInBatch(batchFamily(ctx.batchKey))) {
    const meta = tableMeta(entry.name)
    if ((await plannedIds(ctx, meta)).length === 0) continue
    await skipMissing(ctx, meta)
    await applyConflicts(ctx, meta)
    if (meta.name === 'direction_seller') await dedupeSellers(ctx, meta)
    await assignTargets(ctx, meta)
    if (meta.name === 'risk_finding') await collapseRefCollisions(ctx, meta)
    await insertCopies(ctx, meta)
  }
}

/** 本批次中某表已分配新 id、待插入的映射行（别名 m） */
const copiedIn = (ctx: Context, meta: TableMeta) =>
  sql`m.transfer_id = ${ctx.transfer.id} and m.table_name = ${meta.name}
    and m.batch_key = ${ctx.batchKey} and m.action = 'copied'`

/** 引用值（text）在本次流转中已落地的目标 id；映射不到返回 null */
function mappedTarget(ctx: Context, ref: TransferReference, value: SQL): SQL {
  return sql`(select m2.target_id from workspace_transfer_id_map m2
    where m2.transfer_id = ${ctx.transfer.id}
      and m2.table_name in (${sql.join(
        ref.targets.map((t) => sql`${t}`),
        sql`, `,
      )})
      and m2.source_id = ${value} and m2.action <> 'planned' and m2.target_id is not null
    limit 1)`
}

/** 改写后的引用列表达式（别名 t 为源行） */
function rewrittenRef(ctx: Context, ref: TransferReference): SQL {
  const value = col('t', ref.column.name)
  switch (ref.kind) {
    case 'uuid-array':
      // 映射不到的元素删除，映射到同一目标的元素去重，保持原顺序
      return sql`coalesce((select array_agg(z.x order by z.i) from (
          select ${mappedTarget(ctx, ref, sql`u.v::text`)}::uuid as x, min(u.i) as i
          from unnest(${value}) with ordinality as u(v, i) group by 1) z
        where z.x is not null), '{}'::uuid[])`
    case 'text-ref':
      return sql`coalesce(${mappedTarget(ctx, ref, value)}, ${value})`
    default: {
      const target = sql`${mappedTarget(ctx, ref, sql`${value}::text`)}::uuid`
      // fail 在插入前已检查；keep 映射不到时保留原值
      return ref.unmapped === 'keep' ? sql`coalesce(${target}, ${value})` : target
    }
  }
}

/** 删除 / 置空时记录的原值；keep / fail 不记录 */
function unmappedValue(ctx: Context, ref: TransferReference): SQL | undefined {
  const value = col('t', ref.column.name)
  if (ref.unmapped === 'drop-element')
    return sql`(select jsonb_agg(u.v order by u.i) from unnest(${value}) with ordinality as u(v, i)
      where ${mappedTarget(ctx, ref, sql`u.v::text`)} is null)`
  if (ref.unmapped === 'set-null')
    return sql`case when ${value} is not null and ${mappedTarget(ctx, ref, sql`${value}::text`)} is null
      then to_jsonb(${value}) end`
  return undefined
}

async function applyConflicts(ctx: Context, meta: TableMeta) {
  for (const id of await plannedIds(ctx, meta)) {
    const decision = ctx.decisions.get(`${meta.name}:${id}`)
    if (!decision?.targetId) continue
    if (decision.action === 'keep-target')
      await setAction(ctx, meta, id, 'skipped', decision.targetId)
    else if (decision.action === 'merge') {
      if (meta.name === 'direction') await mergeDirection(ctx, meta, id, decision.targetId)
      else if (meta.name === 'tracked_store' || meta.name === 'tracked_product')
        await mergeTracked(ctx, meta, id, decision.targetId)
      else await setAction(ctx, meta, id, 'merged', decision.targetId)
    }
  }
}

/** 方向合并（D4.1）：站点 / 类目 / 关键词取并集，目标行先快照；簇与对标店铺随后改指目标方向 */
async function mergeDirection(ctx: Context, meta: TableMeta, id: string, targetId: string) {
  const targetBefore = await snapshotOf(ctx, meta, targetId)
  const source = await snapshotOf(ctx, meta, id)
  if (!source || !targetBefore) throw new Error('direction merge rows missing')
  const list = (row: Record<string, unknown>, key: string) => (row[key] as string[] | null) ?? []
  const next = {
    marketplaces: unionList(list(targetBefore, 'marketplaces'), list(source, 'marketplaces')),
    category_ids: unionList(list(targetBefore, 'category_ids'), list(source, 'category_ids')),
    keywords: unionList(list(targetBefore, 'keywords'), list(source, 'keywords')),
  }
  const changed = Object.entries(next).some(
    ([key, value]) => value.length !== list(targetBefore, key).length,
  )
  if (changed)
    await ctx.tx.execute(sql`update direction set marketplaces = ${textList(next.marketplaces)},
        category_ids = ${textList(next.category_ids)}, keywords = ${textList(next.keywords)}
      where id = ${targetId}`)
  await setAction(ctx, meta, id, 'merged', targetId, changed ? { target: targetBefore } : undefined)
}

/**
 * 店铺与追踪商品（D4.2）：目标已有时保留目标行（源行不动）；店铺 direction_ids 并入映射后的方向，
 * 追踪商品 tier 取更热的档位并把 tier_reason 记为 transfer（目标的 last_snapshot_on 不变）。
 */
async function mergeTracked(ctx: Context, meta: TableMeta, id: string, targetId: string) {
  const row = await snapshotOf(ctx, meta, id)
  const targetBefore = await snapshotOf(ctx, meta, targetId)
  if (!row || !targetBefore) throw new Error(`${meta.name} merge rows missing`)
  let changed = false
  if (meta.name === 'tracked_store') {
    const source = (row.direction_ids as string[] | null) ?? []
    const mapped = source.length
      ? await rows<{ target_id: string }>(
          ctx.tx,
          sql`select m.target_id from unnest(${uuidList(source)}) with ordinality as u(v, i)
            join workspace_transfer_id_map m on m.transfer_id = ${ctx.transfer.id}
              and m.table_name = 'direction' and m.source_id = u.v::text
              and m.action <> 'planned' and m.target_id is not null
            order by u.i`,
        )
      : []
    const current = (targetBefore.direction_ids as string[] | null) ?? []
    const next = unionList(
      current,
      mapped.map((m) => m.target_id),
    )
    if (next.length !== current.length) {
      changed = true
      await ctx.tx.execute(
        sql`update tracked_store set direction_ids = ${uuidList(next)} where id = ${targetId}`,
      )
    }
  } else {
    const tier = String(row.tier)
    if ((TIER_RANK[tier] ?? 9) < (TIER_RANK[String(targetBefore.tier)] ?? 9)) {
      changed = true
      await ctx.tx.execute(sql`update tracked_product set tier = ${tier},
          tier_reason = 'transfer', tier_changed_at = now()
        where id = ${targetId}`)
    }
  }
  await setAction(ctx, meta, id, 'merged', targetId, changed ? { target: targetBefore } : undefined)
}

/**
 * 对标店铺：所属方向合并到目标方向时，按 (marketplace, seller_platform_id) 去重，
 * 目标方向已有的映射到目标行（目标 rejected 保持 rejected）。
 */
async function dedupeSellers(ctx: Context, meta: TableMeta) {
  await ctx.tx.execute(sql`update workspace_transfer_id_map m
    set action = 'merged', target_id = g.id::text, updated_at = now()
    from direction_seller s
    join workspace_transfer_id_map dm on dm.transfer_id = ${ctx.transfer.id}
      and dm.table_name = 'direction' and dm.source_id = s.direction_id::text and dm.action = 'merged'
    join direction_seller g on g.direction_id = dm.target_id::uuid
      and g.marketplace = s.marketplace and g.seller_platform_id = s.seller_platform_id
    where ${plannedIn(ctx, meta)} and s.id::text = m.source_id`)
}

/** 改写后的主键（单列主键为预先分配的新 id；复合主键为改写后的拼接键） */
function pkExpr(ctx: Context, meta: TableMeta, name: string): SQL {
  const ref = meta.entry.references.find((r) => r.column.name === name)
  return ref ? rewrittenRef(ctx, ref) : col('t', name)
}

/** 剩余的 planned 行分配目标 id 并记为 copied */
async function assignTargets(ctx: Context, meta: TableMeta) {
  if (meta.pk.length === 1) {
    const ids = await plannedIds(ctx, meta)
    if (ids.length === 0) return
    const targets = ids.map(() => newId())
    await ctx.tx.execute(sql`update workspace_transfer_id_map m
      set action = 'copied', target_id = x.t, updated_at = now()
      from unnest(${textList(ids)}, ${textList(targets)}) as x(s, t)
      where ${plannedIn(ctx, meta)} and m.source_id = x.s`)
    return
  }
  const key = sql.join(
    meta.pk.map((name) => sql`(${pkExpr(ctx, meta, name)})::text`),
    sql`, `,
  )
  await ctx.tx.execute(sql`update workspace_transfer_id_map m
    set action = 'copied', target_id = concat_ws('|', ${key}), updated_at = now()
    from ${ident(meta.name)} t
    where ${plannedIn(ctx, meta)} and ${keyOf(meta, 't')} = m.source_id
      and t.${ident(meta.ws)} = ${ctx.transfer.sourceWorkspaceId}`)
}

/**
 * risk_finding.ref 改写后可能撞 (cluster_id, kind, ref) 唯一键：源空间两条自然键相同的风险规则
 * 合并到目标同一条规则。同组只复制第一条（按 id），其余记为 merged 并映射到该副本。
 */
async function collapseRefCollisions(ctx: Context, meta: TableMeta) {
  const ref = meta.entry.references.find((r) => r.kind === 'text-ref')
  if (!ref) return
  await ctx.tx.execute(sql`with z as (
      select m.source_id,
        first_value(m.target_id) over (
          partition by t.cluster_id, t.kind, ${rewrittenRef(ctx, ref)} order by t.id) as keep,
        row_number() over (
          partition by t.cluster_id, t.kind, ${rewrittenRef(ctx, ref)} order by t.id) as rn
      from risk_finding t join workspace_transfer_id_map m on ${copiedIn(ctx, meta)}
        and t.id::text = m.source_id
      where t.workspace_id = ${ctx.transfer.sourceWorkspaceId})
    update workspace_transfer_id_map m set action = 'merged', target_id = z.keep, updated_at = now()
    from z where z.rn > 1 and ${copiedIn(ctx, meta)} and m.source_id = z.source_id`)
}

async function insertCopies(ctx: Context, meta: TableMeta) {
  const { tx, transfer } = ctx
  const from = sql`from ${ident(meta.name)} t
    join workspace_transfer_id_map m on ${copiedIn(ctx, meta)} and ${keyOf(meta, 't')} = m.source_id`
  const where = sql`where t.${ident(meta.ws)} = ${transfer.sourceWorkspaceId}`
  const refs = meta.entry.references
  // 闭包保证 fail 引用一定映射得到；映射不到即实现错误，不能留下指向源空间的引用
  for (const ref of refs.filter((r) => r.unmapped === 'fail')) {
    const value = col('t', ref.column.name)
    const [broken] = await rows<{ id: string; value: string }>(
      tx,
      sql`select m.source_id as id, ${value}::text as value ${from} ${where}
        and ${value} is not null and ${mappedTarget(ctx, ref, sql`${value}::text`)} is null limit 1`,
    )
    if (broken)
      throw transferError('TRANSFER_CLOSURE_INCOMPLETE', '闭包外的引用无法映射', 500, {
        table: meta.name,
        column: ref.column.name,
        ...broken,
      })
  }
  const unmapped = refs.flatMap((ref) => {
    const value = unmappedValue(ctx, ref)
    return value ? [sql`${ref.column.name}::text, ${value}`] : []
  })
  if (unmapped.length)
    await tx.execute(sql`update workspace_transfer_id_map m
      set source_row = jsonb_build_object('unmapped', u.j)
      from (select m.source_id, jsonb_strip_nulls(jsonb_build_object(${sql.join(unmapped, sql`, `)})) as j
        ${from} ${where}) u
      where ${copiedIn(ctx, meta)} and m.source_id = u.source_id and u.j <> '{}'::jsonb`)
  // 重命名决定（D4.1 / D4.3）：新名称在 plan 中确定
  const renames = [...ctx.decisions.values()].filter(
    (d) => d.table === meta.name && d.action === 'rename' && d.newName !== undefined,
  )
  const conflict = meta.entry.conflict
  const renameColumn =
    conflict.kind === 'rename'
      ? conflict.column.name
      : conflict.kind === 'merge-if-equal'
        ? conflict.renameColumn.name
        : undefined
  const refByColumn = new Map(refs.map((r) => [r.column.name, r]))
  const values = meta.columns.map((name) => {
    if (meta.pk.length === 1 && name === meta.pk[0]) return sql`m.target_id::uuid`
    if (name === meta.ws) return sql`${transfer.targetWorkspaceId}::uuid`
    const ref = refByColumn.get(name)
    if (ref) return rewrittenRef(ctx, ref)
    if (name === renameColumn && renames.length) return sql`coalesce(r.name, ${col('t', name)})`
    return col('t', name)
  })
  const renameJoin = renames.length
    ? sql`left join unnest(${textList(renames.map((d) => d.sourceId))},
        ${textList(renames.map((d) => d.newName as string))}) as r(source_id, name)
        on r.source_id = m.source_id`
    : sql``
  await tx.execute(sql`insert into ${ident(meta.name)} (${sql.join(
    meta.columns.map((c) => ident(c)),
    sql`, `,
  )})
    select ${sql.join(values, sql`, `)} ${from} ${renameJoin} ${where}`)
}
