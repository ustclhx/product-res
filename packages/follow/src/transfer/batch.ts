import {
  type Database,
  type WorkspaceTransfer,
  type WorkspaceTransferCounts,
  workspaceTransferBatch,
} from '@product-res/db'
import { newId } from '@product-res/shared'
import { and, eq, type SQL, sql } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { assertTransferAccess, lockTransferWorkspaces } from './access.ts'
import {
  rows,
  type TransferConfig,
  type TransferSelection,
  type Tx,
  textList,
  transferError,
  uuidList,
} from './common.ts'
import { copyBatch } from './copy.ts'
import { batchFamily, col, ident, keyOf, type TableMeta, tableMeta } from './meta.ts'
import {
  loadTransfer,
  type TransferConflictDecision,
  type TransferPlan,
  transition,
} from './plan.ts'
import { FLOWING_TRANSFER_TABLES, transferTablesInBatch } from './registry.ts'
import type { TransferReference } from './types.ts'

/**
 * 移动批次（design D1、D4、D8，tasks 3.3 / 3.5）。每批一个事务：
 * 取锁（涉及卖家数据时先取 eBay 删除共享锁）→ 校验权限（以当前成员关系为准）→ 按注册表顺序逐表处理
 * 清单中的行 → 写 ID 映射结果与批次 done。done 的批次直接跳过，保证重试与续跑幂等。
 *
 * 升级：原地 `update … set workspace_id`，不改写任何引用（目标为空、所有行同 id 移动）。
 * 选择性移动：闭包行原地移动；含 workspace_id 唯一键的行按 plan 中的冲突决定重命名 / 合并；
 * 合并时源行先以 `to_jsonb` 快照写入 `id_map.source_row` 再删除，引用它的移动行改指目标 id；
 * 被引用的配置复制或合并到目标，源行保留。被改写的移动行同样先存快照，补偿据此逐列恢复。
 * 源行已不存在（如被 eBay 账号删除清理）记为 skipped。
 * 复制批次（tasks 3.4）在 copy.ts，经同一 runBatch 取锁、校验权限与计数。
 */

/** `id_map.source_row` 的结构：row 为源行修改 / 删除前的快照，target 为被合并修改的目标行快照 */
export interface SourceRowSnapshot {
  readonly row?: Record<string, unknown>
  readonly target?: Record<string, unknown>
}

export interface BatchResult {
  readonly batchKey: string
  readonly status: 'done' | 'skipped'
  readonly counts: WorkspaceTransferCounts
}

/** 涉及卖家数据（direction_seller、tracked_store、lead_event）的批次与 eBay 账号删除互斥 */
export const touchesSellerData = (batchKey: string) =>
  ['direction', 'store-pool'].includes(batchFamily(batchKey))

export const TIER_RANK: Record<string, number> = { hot: 0, normal: 1, cold: 2 }

export interface Context {
  readonly tx: Tx
  readonly transfer: WorkspaceTransfer
  readonly batchKey: string
  readonly selection: TransferSelection
  readonly decisions: ReadonlyMap<string, TransferConflictDecision>
  /** 合并后需要删除的源行（有子行，等批内子行移走后按子先父后删除） */
  readonly deferred: { meta: TableMeta; id: string }[]
}

export async function runBatch(
  db: Database,
  transferId: string,
  batchKey: string,
  config: TransferConfig,
): Promise<BatchResult> {
  return db.transaction(async (tx) => {
    const head = await loadTransfer(tx, transferId)
    await lockTransferWorkspaces(tx, [head.sourceWorkspaceId, head.targetWorkspaceId], {
      sellerData: touchesSellerData(batchKey),
    })
    // 先锁流转行再锁批次行（与补偿相同顺序）；进入补偿后不再执行任何批次
    const transfer = await loadTransfer(tx, transferId, { forUpdate: true })
    if (transfer.status !== 'running')
      throw transferError('TRANSFER_STATE', `流转状态为 ${transfer.status}，不能执行批次`, 409)
    const [batch] = await tx
      .select()
      .from(workspaceTransferBatch)
      .where(
        and(
          eq(workspaceTransferBatch.transferId, transferId),
          eq(workspaceTransferBatch.batchKey, batchKey),
        ),
      )
      .for('update')
    if (!batch) throw transferError('TRANSFER_BATCH_NOT_FOUND', '批次不存在', 404)
    if (batch.status !== 'pending')
      return { batchKey, status: 'skipped' as const, counts: batch.counts }
    await assertTransferAccess(
      tx,
      {
        kind: transfer.kind,
        userId: transfer.requestedBy,
        sourceWorkspaceId: transfer.sourceWorkspaceId,
        targetWorkspaceId: transfer.targetWorkspaceId,
      },
      config,
      { revoked: true },
    )
    const plan = transfer.plan as unknown as TransferPlan
    const ctx: Context = {
      tx,
      transfer,
      batchKey,
      selection: transfer.selection as TransferSelection,
      decisions: new Map(plan.conflicts.map((c) => [`${c.table}:${c.sourceId}`, c])),
      deferred: [],
    }
    if (transfer.kind === 'upgrade') await upgradeBatch(ctx)
    else if (transfer.kind === 'move') await moveBatch(ctx)
    else await copyBatch(ctx)
    const [left] = await rows(
      tx,
      sql`select table_name, source_id from workspace_transfer_id_map
        where transfer_id = ${transfer.id} and batch_key = ${batchKey} and action = 'planned' limit 1`,
    )
    if (left)
      throw new Error(`transfer batch ${batchKey} left planned rows: ${JSON.stringify(left)}`)
    const counts = await countActions(tx, transfer.id, batchKey)
    await tx
      .update(workspaceTransferBatch)
      .set({ status: 'done', counts })
      .where(eq(workspaceTransferBatch.id, batch.id))
    await transition(tx, transfer.id, ['running'], { counts: await countActions(tx, transfer.id) })
    return { batchKey, status: 'done' as const, counts }
  })
}

/** 按表、按动作计数（表名 → 动作 → 行数） */
export async function countActions(
  tx: Tx,
  transferId: string,
  batchKey?: string,
): Promise<WorkspaceTransferCounts> {
  const counts: WorkspaceTransferCounts = {}
  const filter = batchKey === undefined ? sql`true` : sql`batch_key = ${batchKey}`
  for (const r of await rows<{ table_name: string; action: string; n: number }>(
    tx,
    sql`select table_name, action, count(*)::int as n from workspace_transfer_id_map
      where transfer_id = ${transferId} and ${filter} group by table_name, action`,
  )) {
    counts[r.table_name] = { ...counts[r.table_name], [r.action]: r.n }
  }
  // 复制时映射不到、按注册表删元素 / 置空的引用（copy.ts 记在 source_row.unmapped），键为 unmapped:<列名>
  for (const r of await rows<{ table_name: string; column: string; n: number }>(
    tx,
    sql`select table_name, k as column, count(*)::int as n
      from workspace_transfer_id_map, jsonb_object_keys(source_row->'unmapped') k
      where transfer_id = ${transferId} and ${filter} and action = 'copied'
        and jsonb_typeof(source_row->'unmapped') = 'object'
      group by table_name, k`,
  )) {
    counts[r.table_name] = { ...counts[r.table_name], [`unmapped:${r.column}`]: r.n }
  }
  return counts
}

/** 本批次中某表仍为 planned 的映射行（别名 m） */
export const plannedIn = (ctx: Context, meta: TableMeta, alias = 'm') =>
  sql`${sql.raw(alias)}.transfer_id = ${ctx.transfer.id} and ${sql.raw(alias)}.table_name = ${meta.name}
    and ${sql.raw(alias)}.batch_key = ${ctx.batchKey} and ${sql.raw(alias)}.action = 'planned'`

export async function setAction(
  ctx: Context,
  meta: TableMeta,
  sourceId: string,
  action: 'moved' | 'copied' | 'merged' | 'skipped' | 'renamed' | 'updated',
  targetId: string | null,
  snapshot?: SourceRowSnapshot,
) {
  await ctx.tx.execute(sql`update workspace_transfer_id_map
    set action = ${action}, target_id = ${targetId}, updated_at = now(),
      source_row = coalesce(${snapshot ? JSON.stringify(snapshot) : null}::jsonb, source_row)
    where transfer_id = ${ctx.transfer.id} and table_name = ${meta.name} and source_id = ${sourceId}`)
}

/** 源行已不存在（被 eBay 账号删除等清理）的清单行记为 skipped */
export async function skipMissing(ctx: Context, meta: TableMeta) {
  await ctx.tx.execute(sql`update workspace_transfer_id_map m set action = 'skipped', updated_at = now()
    where ${plannedIn(ctx, meta)} and not exists (
      select 1 from ${ident(meta.name)} t
      where ${keyOf(meta, 't')} = m.source_id and t.${ident(meta.ws)} = ${ctx.transfer.sourceWorkspaceId})`)
}

export async function plannedIds(ctx: Context, meta: TableMeta): Promise<string[]> {
  return (
    await rows<{ source_id: string }>(
      ctx.tx,
      sql`select source_id from workspace_transfer_id_map m where ${plannedIn(ctx, meta)}
        order by source_id`,
    )
  ).map((r) => r.source_id)
}

/** 原地移动本批次该表剩余的 planned 行；rewrite=false 时只改空间（升级） */
async function bulkMove(ctx: Context, meta: TableMeta, rewrite: boolean) {
  const { tx, transfer } = ctx
  const refs = rewrite ? meta.entry.references : []
  const join = sql`${plannedIn(ctx, meta)} and ${keyOf(meta, 't')} = m.source_id
      and t.${ident(meta.ws)} = ${transfer.sourceWorkspaceId}`
  for (const ref of refs.filter((r) => r.unmapped === 'fail')) {
    const value = col('t', ref.column.name)
    const [broken] = await rows<{ id: string; value: string }>(
      tx,
      sql`select ${keyOf(meta, 't')} as id, ${value}::text as value
        from ${ident(meta.name)} t, workspace_transfer_id_map m where ${join}
        and ${value} is not null and ${mapped(ctx, ref, sql`${value}::text`)} is null limit 1`,
    )
    if (broken)
      throw transferError('TRANSFER_CLOSURE_INCOMPLETE', '闭包外的引用无法映射', 500, {
        table: meta.name,
        column: ref.column.name,
        ...broken,
      })
  }
  const changes = refs.map((ref) => ({ ref, expr: rewritten(ctx, ref) }))
  if (changes.length) {
    const changed = sql.join(
      changes.map((c) => sql`${col('t', c.ref.column.name)} is distinct from ${c.expr}`),
      sql` or `,
    )
    // 被改写的行先存快照，补偿逐列恢复
    await tx.execute(sql`update workspace_transfer_id_map m
      set source_row = jsonb_build_object('row', to_jsonb(t))
      from ${ident(meta.name)} t
      where ${plannedIn(ctx, meta)} and ${keyOf(meta, 't')} = m.source_id
        and t.${ident(meta.ws)} = ${transfer.sourceWorkspaceId}
        and m.source_row is null and (${changed})`)
  }
  const sets = [
    sql`${ident(meta.ws)} = ${transfer.targetWorkspaceId}`,
    ...changes.map((c) => sql`${ident(c.ref.column.name)} = ${c.expr}`),
  ]
  await tx.execute(sql`with moved as (
      update ${ident(meta.name)} t set ${sql.join(sets, sql`, `)}
      from workspace_transfer_id_map m where ${join}
      returning ${keyOf(meta, 't')} as k)
    update workspace_transfer_id_map m set action = 'moved', target_id = m.source_id, updated_at = now()
    from moved where m.transfer_id = ${transfer.id} and m.table_name = ${meta.name}
      and m.source_id = moved.k`)
}

/**
 * 引用值在本次流转中的目标 id（text）。本批次仍为 planned 的行（自引用，如 cluster.merged_into_id）
 * 随后同 id 移动，映射为自身；映射不到返回 null。
 */
function mapped(ctx: Context, ref: TransferReference, value: SQL): SQL {
  return sql`(select case when m2.action = 'planned' then m2.source_id else m2.target_id end
    from workspace_transfer_id_map m2
    where m2.transfer_id = ${ctx.transfer.id}
      and m2.table_name in (${sql.join(
        ref.targets.map((t) => sql`${t}`),
        sql`, `,
      )})
      and m2.source_id = ${value}
      and ((m2.action <> 'planned' and m2.target_id is not null)
        or (m2.action = 'planned' and m2.batch_key = ${ctx.batchKey}))
    limit 1)`
}

/** 按 D4 改写后的引用列表达式（别名 t） */
function rewritten(ctx: Context, ref: TransferReference): SQL {
  const value = col('t', ref.column.name)
  switch (ref.kind) {
    case 'uuid-array':
      // 映射不到的元素删除，合并到同一目标的元素去重，保持原顺序
      return sql`coalesce((select array_agg(z.x order by z.i) from (
          select ${mapped(ctx, ref, sql`u.v::text`)}::uuid as x, min(u.i) as i
          from unnest(${value}) with ordinality as u(v, i) group by 1) z
        where z.x is not null), '{}'::uuid[])`
    case 'text-ref':
      return sql`coalesce(${mapped(ctx, ref, value)}, ${value})`
    default: {
      const target = sql`${mapped(ctx, ref, sql`${value}::text`)}::uuid`
      return ref.unmapped === 'set-null' ? target : sql`coalesce(${target}, ${value})`
    }
  }
}

/** 源行 / 目标行的 to_jsonb 快照（与补偿时 jsonb_populate_record 对应） */
export async function snapshotOf(ctx: Context, meta: TableMeta, id: string) {
  const [row] = await rows<{ j: Record<string, unknown> }>(
    ctx.tx,
    sql`select to_jsonb(t) as j from ${ident(meta.name)} t where ${keyOf(meta, 't')} = ${id}`,
  )
  return row?.j
}

async function deleteRow(ctx: Context, meta: TableMeta, id: string) {
  await ctx.tx.execute(sql`delete from ${ident(meta.name)} t where ${keyOf(meta, 't')} = ${id}`)
}

async function upgradeBatch(ctx: Context) {
  const family = batchFamily(ctx.batchKey)
  if (family === 'validation') {
    // 抽检批次前断言目标没有本次流转之外的 accuracy_audit，避免 (workspace_id, week_of) 冲突
    const [hit] = await rows(
      ctx.tx,
      sql`select 1 from accuracy_audit a where a.workspace_id = ${ctx.transfer.targetWorkspaceId}
        and not exists (select 1 from workspace_transfer_id_map m
          where m.transfer_id = ${ctx.transfer.id} and m.table_name = 'accuracy_audit'
            and m.source_id = a.id::text and m.action = 'moved') limit 1`,
    )
    if (hit)
      throw transferError('TRANSFER_TARGET_NOT_EMPTY', '目标空间已有准确性抽检记录', 409, {
        table: 'accuracy_audit',
      })
  }
  for (const entry of transferTablesInBatch(family)) {
    const meta = tableMeta(entry.name)
    await skipMissing(ctx, meta)
    await bulkMove(ctx, meta, false)
  }
}

async function moveBatch(ctx: Context) {
  const family = batchFamily(ctx.batchKey)
  if (family === 'direction') await planLateDirectionSellers(ctx)
  for (const entry of transferTablesInBatch(family)) {
    const meta = tableMeta(entry.name)
    if ((await plannedIds(ctx, meta)).length === 0) continue
    await skipMissing(ctx, meta)
    if (family === 'config') await copyOrMergeConfig(ctx, meta)
    else if (meta.name === 'direction') await moveDirections(ctx, meta)
    else {
      if (meta.name === 'direction_seller') await dedupeDirectionSellers(ctx, meta)
      if (meta.name === 'risk_finding') await collapseRefCollisions(ctx, meta)
      if (meta.name === 'tracked_store' || meta.name === 'tracked_product')
        await mergeTracked(ctx, meta)
      const renamed = meta.name === 'category_study' ? await applyRenames(ctx, meta) : []
      await bulkMove(ctx, meta, true)
      for (const id of renamed) await setAction(ctx, meta, id, 'renamed', id)
    }
  }
  // 合并后的源行在子行改指目标后删除（子先父后）；删除会级联的、不在清单中的子行先存快照
  for (const { meta, id } of [...ctx.deferred].reverse()) {
    await snapshotCascadeChildren(ctx, meta, id)
    await deleteRow(ctx, meta, id)
  }
}

/**
 * 计划之后才加入根方向的对标店铺（如推荐任务写入）同样随方向流转，避免方向合并删除源方向时被级联删除。
 */
async function planLateDirectionSellers(ctx: Context) {
  const roots = ctx.selection.roots?.direction ?? []
  if (roots.length === 0) return
  await ctx.tx.execute(sql`insert into workspace_transfer_id_map
      (transfer_id, table_name, source_id, action, batch_key, updated_at)
    select ${ctx.transfer.id}, 'direction_seller', s.id::text, 'planned', ${ctx.batchKey}, now()
    from direction_seller s
    where s.workspace_id = ${ctx.transfer.sourceWorkspaceId} and s.direction_id = any(${uuidList(roots)})
      and s.direction_id::text in (select source_id from workspace_transfer_id_map
        where transfer_id = ${ctx.transfer.id} and table_name = 'direction'
          and batch_key = ${ctx.batchKey} and action = 'planned')
    on conflict do nothing`)
}

/**
 * 删除合并源行前，把经外键引用它、但不在清单中的子行（如派生的 readiness_stat）快照为
 * merged（target 为空）；删除级联掉这些行，补偿时与源行一起按父先子后重新插入。
 */
async function snapshotCascadeChildren(ctx: Context, parent: TableMeta, id: string) {
  for (const entry of FLOWING_TRANSFER_TABLES) {
    for (const ref of entry.references) {
      if (ref.kind !== 'fk' || !ref.targets.includes(parent.name)) continue
      const child = tableMeta(entry.name)
      await ctx.tx.execute(sql`insert into workspace_transfer_id_map
          (transfer_id, table_name, source_id, action, batch_key, source_row, updated_at)
        select ${ctx.transfer.id}, ${child.name}, ${keyOf(child, 'c')}, 'merged', ${ctx.batchKey},
          jsonb_build_object('row', to_jsonb(c)), now()
        from ${ident(child.name)} c where ${col('c', ref.column.name)} = ${id}
        on conflict do nothing`)
    }
  }
}

/**
 * risk_finding.ref 改写后可能撞 (cluster_id, kind, ref) 唯一键：源空间两条自然键相同的风险规则
 * 合并到目标同一条规则。同组只保留第一条（按 id），其余记为 merged 并保存快照后删除，补偿时恢复。
 */
async function collapseRefCollisions(ctx: Context, meta: TableMeta) {
  const ref = meta.entry.references.find((r) => r.kind === 'text-ref')
  if (!ref) return
  const dups = await rows<{ id: string; keep: string; r: Record<string, unknown> }>(
    ctx.tx,
    sql`select z.id, z.keep, z.r from (
        select t.id::text as id, to_jsonb(t) as r,
          first_value(t.id::text) over (
            partition by t.cluster_id, t.kind, ${rewritten(ctx, ref)} order by t.id) as keep
        from risk_finding t, workspace_transfer_id_map m
        where ${plannedIn(ctx, meta)} and t.id::text = m.source_id
          and t.workspace_id = ${ctx.transfer.sourceWorkspaceId}) z
      where z.id <> z.keep`,
  )
  for (const d of dups) {
    await setAction(ctx, meta, d.id, 'merged', d.keep, { row: d.r })
    await deleteRow(ctx, meta, d.id)
  }
}

/**
 * 移走根方向后，源空间中未流转的店铺 direction_ids 去掉这些方向（跨表引用只在同一空间内成立）；
 * 原行快照记为 updated（target 为空，不参与引用映射），补偿逐列恢复。
 */
async function detachSourceStores(ctx: Context, directionIds: readonly string[]) {
  if (directionIds.length === 0) return
  const ids = uuidList(directionIds)
  const src = ctx.transfer.sourceWorkspaceId
  await ctx.tx.execute(sql`insert into workspace_transfer_id_map
      (transfer_id, table_name, source_id, action, batch_key, source_row, updated_at)
    select ${ctx.transfer.id}, 'tracked_store', s.id::text, 'updated', ${ctx.batchKey},
      jsonb_build_object('row', to_jsonb(s)), now()
    from tracked_store s
    where s.workspace_id = ${src} and s.direction_ids && ${ids}
    on conflict do nothing`)
  await ctx.tx.execute(sql`update tracked_store s
    set direction_ids = array(select u.x from unnest(s.direction_ids) with ordinality as u(x, i)
      where not u.x = any(${ids}) order by u.i)
    where s.workspace_id = ${src} and s.direction_ids && ${ids}
      and exists (select 1 from workspace_transfer_id_map m
        where m.transfer_id = ${ctx.transfer.id} and m.table_name = 'tracked_store'
          and m.source_id = s.id::text and m.action = 'updated')`)
}

/** 重命名决定：先存快照再改名，随后与其他行一起原地移动 */
async function applyRenames(ctx: Context, meta: TableMeta): Promise<string[]> {
  const renamed: string[] = []
  for (const id of await plannedIds(ctx, meta)) {
    const decision = ctx.decisions.get(`${meta.name}:${id}`)
    if (decision?.action !== 'rename' || !decision.newName) continue
    const row = await snapshotOf(ctx, meta, id)
    await ctx.tx.execute(sql`update workspace_transfer_id_map set source_row = ${JSON.stringify({
      row,
    })}::jsonb where transfer_id = ${ctx.transfer.id} and table_name = ${meta.name}
      and source_id = ${id}`)
    await ctx.tx.execute(
      sql`update ${ident(meta.name)} set name = ${decision.newName} where id = ${id}`,
    )
    renamed.push(id)
  }
  return renamed
}

/** 按 Drizzle 属性名读取一行（复制用） */
async function readRow(ctx: Context, meta: TableMeta, id: string) {
  const table = meta.entry.table
  const pk = getTableConfig(table).columns.find((c) => c.primary)
  if (!pk) throw new Error(`${meta.name} has no single-column primary key`)
  const [row] = await ctx.tx
    .select()
    .from(table as never)
    .where(eq(pk, id))
  return row as Record<string, unknown> | undefined
}

/** 当前已落地的映射（复制时在 JS 中改写引用） */
async function lookupMapped(ctx: Context, targets: readonly string[], ids: readonly string[]) {
  if (ids.length === 0) return new Map<string, string>()
  const found = await rows<{ source_id: string; target_id: string }>(
    ctx.tx,
    sql`select source_id, target_id from workspace_transfer_id_map
      where transfer_id = ${ctx.transfer.id}
        and table_name in (${sql.join(
          targets.map((t) => sql`${t}`),
          sql`, `,
        )})
        and source_id in (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})
        and action <> 'planned' and target_id is not null`,
  )
  return new Map(found.map((r) => [r.source_id, r.target_id]))
}

/**
 * 复制一行到目标空间（新 UUIDv7），按注册表改写引用。被引用配置与线索根的方向使用；
 * 复制批次（tasks 3.4）复用同一实现。
 */
export async function copyRow(
  ctx: Context,
  meta: TableMeta,
  id: string,
  overrides: Record<string, unknown> = {},
): Promise<string | undefined> {
  const row = await readRow(ctx, meta, id)
  if (!row) return undefined
  const values: Record<string, unknown> = { ...row, ...overrides }
  const pk = getTableConfig(meta.entry.table).columns.find((c) => c.primary)
  const pkKey = pk ? meta.jsKey.get(pk) : undefined
  const wsKey = [...meta.jsKey].find(([c]) => c.name === meta.ws)?.[1]
  if (!pkKey || !wsKey) throw new Error(`${meta.name} cannot be copied`)
  const newRowId = newId()
  values[pkKey] = newRowId
  values[wsKey] = ctx.transfer.targetWorkspaceId
  for (const ref of meta.entry.references) {
    const key = meta.jsKey.get(ref.column)
    if (!key) continue
    const current = values[key]
    if (ref.kind === 'uuid-array') {
      const list = (current as string[] | null) ?? []
      const map = await lookupMapped(ctx, ref.targets, list)
      values[key] = [...new Set(list.flatMap((v) => (map.has(v) ? [map.get(v) as string] : [])))]
    } else if (typeof current === 'string') {
      const target = (await lookupMapped(ctx, ref.targets, [current])).get(current)
      if (target) values[key] = target
      else if (ref.unmapped === 'set-null') values[key] = null
      else if (ref.unmapped === 'fail')
        throw transferError('TRANSFER_CLOSURE_INCOMPLETE', '闭包外的引用无法映射', 500, {
          table: meta.name,
          column: ref.column.name,
          id,
        })
    }
  }
  await ctx.tx.insert(meta.entry.table as never).values(values as never)
  return newRowId
}

/**
 * 被引用的配置（选择性移动）：按 plan 的冲突决定合并到目标已有行（源行保留）、保留目标（cost_param），
 * 或复制到目标（logistics_profile 同名不同计费时以新名称复制）。
 */
async function copyOrMergeConfig(ctx: Context, meta: TableMeta) {
  for (const id of await plannedIds(ctx, meta)) {
    const decision = ctx.decisions.get(`${meta.name}:${id}`)
    if (decision?.action === 'merge' && decision.targetId)
      await setAction(ctx, meta, id, 'merged', decision.targetId)
    else if (decision?.action === 'keep-target' && decision.targetId)
      await setAction(ctx, meta, id, 'skipped', decision.targetId)
    else {
      const copied = await copyRow(
        ctx,
        meta,
        id,
        decision?.action === 'rename' ? { name: decision.newName } : {},
      )
      await setAction(ctx, meta, id, copied ? 'copied' : 'skipped', copied ?? null)
    }
  }
}

export const unionList = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])]

/**
 * 方向（D2、D4.1）。根方向原地移动：同名默认重命名，可选合并（簇挂到目标方向、对标店铺去重、
 * 站点 / 类目 / 关键词取并集，源方向在子行移走后删除）。线索根的方向不随簇移动：在目标中复制一份，
 * 或合并到目标同名方向，源方向保留。
 */
async function moveDirections(ctx: Context, meta: TableMeta) {
  const roots = new Set(ctx.selection.roots?.direction ?? [])
  const renamed: string[] = []
  for (const id of await plannedIds(ctx, meta)) {
    const decision = ctx.decisions.get(`direction:${id}`)
    const isRoot = roots.has(id)
    if (decision?.action === 'merge' && decision.targetId) {
      const targetBefore = await snapshotOf(ctx, meta, decision.targetId)
      const [s, t] = await rows<{
        id: string
        marketplaces: string[]
        category_ids: string[]
        keywords: string[]
      }>(
        ctx.tx,
        sql`select id::text as id, to_jsonb(marketplaces) as marketplaces,
            to_jsonb(category_ids) as category_ids, to_jsonb(keywords) as keywords from direction
          where id in (${id}, ${decision.targetId}) order by (id = ${id}) desc`,
      )
      if (!s || !t) throw new Error('direction merge rows missing')
      await ctx.tx.execute(sql`update direction set
          marketplaces = ${textList(unionList(t.marketplaces, s.marketplaces))},
          category_ids = ${textList(unionList(t.category_ids, s.category_ids))},
          keywords = ${textList(unionList(t.keywords, s.keywords))}
        where id = ${decision.targetId}`)
      const row = isRoot ? await snapshotOf(ctx, meta, id) : undefined
      await setAction(ctx, meta, id, 'merged', decision.targetId, {
        ...(row ? { row } : {}),
        ...(targetBefore ? { target: targetBefore } : {}),
      })
      if (isRoot) ctx.deferred.push({ meta, id })
    } else if (!isRoot) {
      const copied = await copyRow(
        ctx,
        meta,
        id,
        decision?.action === 'rename' ? { name: decision.newName } : {},
      )
      await setAction(ctx, meta, id, copied ? 'copied' : 'skipped', copied ?? null)
    } else if (decision?.action === 'rename') renamed.push(id)
  }
  if (renamed.length) await applyRenames(ctx, meta)
  await bulkMove(ctx, meta, true)
  for (const id of renamed) await setAction(ctx, meta, id, 'renamed', id)
  const gone = await rows<{ source_id: string }>(
    ctx.tx,
    sql`select source_id from workspace_transfer_id_map
      where transfer_id = ${ctx.transfer.id} and table_name = 'direction'
        and batch_key = ${ctx.batchKey} and action in ('moved', 'renamed', 'merged')`,
  )
  await detachSourceStores(
    ctx,
    gone.map((g) => g.source_id).filter((id) => roots.has(id)),
  )
}

/** 方向合并时对标店铺按 (marketplace, seller_platform_id) 去重：目标已有的保留目标（含 rejected） */
async function dedupeDirectionSellers(ctx: Context, meta: TableMeta) {
  const dups = await rows<{ sid: string; gid: string; r: Record<string, unknown> }>(
    ctx.tx,
    sql`select s.id::text as sid, g.id::text as gid, to_jsonb(s) as r
      from workspace_transfer_id_map m
      join direction_seller s on s.id::text = m.source_id
      join workspace_transfer_id_map dm on dm.transfer_id = m.transfer_id
        and dm.table_name = 'direction' and dm.source_id = s.direction_id::text
        and dm.action = 'merged'
      join direction_seller g on g.direction_id = dm.target_id::uuid
        and g.marketplace = s.marketplace and g.seller_platform_id = s.seller_platform_id
      where ${plannedIn(ctx, meta)}`,
  )
  for (const d of dups) {
    await setAction(ctx, meta, d.sid, 'merged', d.gid, { row: d.r })
    await deleteRow(ctx, meta, d.sid)
  }
}

/**
 * 店铺与追踪商品（D4.2）：目标已有同一店铺 / 商品时保留目标行并删除源行；店铺的 direction_ids
 * 并入映射后的方向，追踪商品的 tier 取更热的档位并把 tier_reason 记为 transfer。
 */
async function mergeTracked(ctx: Context, meta: TableMeta) {
  for (const id of await plannedIds(ctx, meta)) {
    const decision = ctx.decisions.get(`${meta.name}:${id}`)
    if (decision?.action !== 'merge' || !decision.targetId) continue
    const row = await snapshotOf(ctx, meta, id)
    const targetBefore = await snapshotOf(ctx, meta, decision.targetId)
    if (!row || !targetBefore) throw new Error(`${meta.name} merge rows missing`)
    let changed = false
    if (meta.name === 'tracked_store') {
      const ref = meta.entry.references[0] as TransferReference
      const source = (row.direction_ids as string[]) ?? []
      const map = await lookupMapped(ctx, ref.targets, source)
      const current = (targetBefore.direction_ids as string[]) ?? []
      const next = unionList(
        current,
        source.flatMap((v) => (map.has(v) ? [map.get(v) as string] : [])),
      )
      if (next.length !== current.length) {
        changed = true
        await ctx.tx.execute(
          sql`update tracked_store set direction_ids = ${uuidList(next)}
            where id = ${decision.targetId}`,
        )
      }
    } else {
      const tier = String(row.tier)
      if ((TIER_RANK[tier] ?? 9) < (TIER_RANK[String(targetBefore.tier)] ?? 9)) {
        changed = true
        await ctx.tx.execute(sql`update tracked_product set tier = ${tier},
            tier_reason = 'transfer', tier_changed_at = now()
          where id = ${decision.targetId}`)
      }
    }
    await setAction(ctx, meta, id, 'merged', decision.targetId, {
      row,
      ...(changed ? { target: targetBefore } : {}),
    })
    await deleteRow(ctx, meta, id)
  }
}
