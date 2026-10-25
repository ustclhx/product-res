import {
  type Database,
  type WorkspaceTransfer,
  workspaceTransfer,
  workspaceTransferBatch,
} from '@product-res/db'
import { and, eq, inArray, type SQL, sql } from 'drizzle-orm'
import { assertTransferAccess, lockTransferWorkspaces } from './access.ts'
import {
  type DirectionConflictStrategy,
  directionStrategy,
  rows,
  TRANSFER_COPY_ROW_LIMIT,
  TRANSFER_SUB_BATCH_ROWS,
  type TransferConfig,
  type TransferSelection,
  type Tx,
  transferError,
  uuidList,
} from './common.ts'
import { batchFamily, closureRefs, col, ident, keyOf, type TableMeta, tableMeta } from './meta.ts'
import { estimateQuota, type QuotaEstimate } from './quota.ts'
import { FLOWING_TRANSFER_TABLES, TRANSFER_ROOTS } from './registry.ts'
import { type FlowingTransferTable, TRANSFER_BATCH_ORDER } from './types.ts'

/**
 * plan 步骤（design D2、D4、D4.5、D8、D9 与「决定」，tasks 3.2）。
 *
 * 一个事务内：取锁并校验权限 → 按注册表计算闭包，写 `id_map(planned)` → 冲突预览（与批次执行共用
 * 同一份决定，预览即执行）→ 按表行数、评分版本快照、外部额度增量估算、目标权益校验 → 写批次列表与 plan，
 * 状态 pending → running。流转锁（D8）使两个空间只读，READ COMMITTED 下取锁后的读取即一致快照；
 * eBay 账号删除以全局锁互斥。
 */

/** 冲突决定：只列出与目标已有行冲突的行；其余行按默认动作（闭包行移动、被引用配置复制） */
export interface TransferConflictDecision {
  readonly table: string
  readonly sourceId: string
  readonly label: string
  /** 店铺所在站点：eBay 账号删除按此清理预览中的卖家标识 */
  readonly marketplace?: string
  readonly action: 'rename' | 'merge' | 'keep-target'
  /** merge / keep-target：目标空间已有行 */
  readonly targetId?: string
  /** rename：落地时的新名称 */
  readonly newName?: string
}

export interface TransferPlanBatch {
  readonly key: string
  readonly seq: number
  readonly rows: number
}

/** D9：目标套餐限额校验结果（entitlements 目前没有方向 / 追踪商品等数量限额，接口预留） */
export interface EntitlementViolation {
  readonly limit: string
  readonly allowed: number
  readonly requested: number
}

export type TransferEntitlementCheck = (
  tx: Tx,
  input: { readonly targetWorkspaceId: string; readonly tables: Readonly<Record<string, number>> },
) => Promise<readonly EntitlementViolation[]>

export interface TransferPlan {
  readonly version: 1
  readonly kind: WorkspaceTransfer['kind']
  readonly sourceName: string
  readonly targetName: string
  /** 按表计划流转的行数 */
  readonly tables: Readonly<Record<string, number>>
  readonly total: number
  readonly batches: readonly TransferPlanBatch[]
  readonly conflicts: readonly TransferConflictDecision[]
  /** D4.5：闭包内线索 / 推荐引用的源空间评分设置版本的完整快照 */
  readonly scoringVersions: readonly Record<string, unknown>[]
  readonly quota: QuotaEstimate
  readonly entitlements: { readonly checked: boolean; readonly violations: EntitlementViolation[] }
}

export interface PlanOptions {
  readonly checkEntitlements?: TransferEntitlementCheck
}

/**
 * forUpdate：锁住流转行。状态迁移（plan、批次、完成、补偿）都在行锁下读取并按期望状态条件更新，
 * 避免并发的 beginCompensation 被覆盖回 running / completed。
 */
export async function loadTransfer(
  tx: Tx,
  transferId: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<WorkspaceTransfer> {
  const query = tx.select().from(workspaceTransfer).where(eq(workspaceTransfer.id, transferId))
  const [transfer] = options.forUpdate ? await query.for('update') : await query
  if (!transfer) throw transferError('TRANSFER_NOT_FOUND', '流转记录不存在', 404)
  return transfer
}

export async function planTransfer(
  db: Database,
  transferId: string,
  config: TransferConfig,
  options: PlanOptions = {},
): Promise<TransferPlan> {
  return db.transaction(async (tx) => {
    const before = await loadTransfer(tx, transferId)
    if (before.plan) return before.plan as unknown as TransferPlan
    await lockTransferWorkspaces(tx, [before.sourceWorkspaceId, before.targetWorkspaceId], {
      sellerData: true,
    })
    const transfer = await loadTransfer(tx, transferId, { forUpdate: true })
    // 重试的 plan 步骤在锁内再判一次：另一个执行者可能已经写入
    if (transfer.plan) return transfer.plan as unknown as TransferPlan
    if (transfer.status !== 'pending')
      throw transferError('TRANSFER_STATE', `流转状态为 ${transfer.status}，不能计划`, 409)
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
    const selection = transfer.selection as TransferSelection
    let conflicts: TransferConflictDecision[] = []
    if (transfer.kind === 'upgrade') {
      await assertTargetEmpty(tx, transfer)
      await planUpgrade(tx, transfer)
    } else {
      await planSelectiveClosure(tx, transfer, selection)
      conflicts = await resolveConflicts(tx, transfer, selection)
    }
    const tables = Object.fromEntries(
      (
        await rows<{ table_name: string; n: number }>(
          tx,
          sql`select table_name, count(*)::int as n from workspace_transfer_id_map
            where transfer_id = ${transfer.id} group by table_name`,
        )
      ).map((r) => [r.table_name, r.n]),
    )
    const total = Object.values(tables).reduce((a, b) => a + b, 0)
    assertCopyWithinLimit(transfer.kind, total)
    if (transfer.kind === 'upgrade') await splitOversizedBatches(tx, transfer.id)
    const batches = await writeBatches(tx, transfer.id)
    const violations = [
      ...((await options.checkEntitlements?.(tx, {
        targetWorkspaceId: transfer.targetWorkspaceId,
        tables,
      })) ?? []),
    ]
    if (violations.length)
      throw transferError('TRANSFER_ENTITLEMENT_EXCEEDED', '超出目标空间套餐限额', 403, {
        violations,
      })
    const names = await rows<{ id: string; name: string }>(
      tx,
      sql`select id, name from organization
        where id in (${transfer.sourceWorkspaceId}, ${transfer.targetWorkspaceId})`,
    )
    const nameOf = (id: string) => names.find((n) => n.id === id)?.name ?? ''
    const plan: TransferPlan = {
      version: 1,
      kind: transfer.kind,
      sourceName: nameOf(transfer.sourceWorkspaceId),
      targetName: nameOf(transfer.targetWorkspaceId),
      tables,
      total,
      batches,
      conflicts,
      scoringVersions: transfer.kind !== 'upgrade' ? await scoringSnapshot(tx, transfer) : [],
      quota:
        transfer.kind !== 'upgrade'
          ? await estimateQuota(tx, transfer, conflicts)
          : { additionalBrowseCallsPerDay: 0, threshold: 0, exceeds: false },
      entitlements: { checked: options.checkEntitlements !== undefined, violations },
    }
    await transition(tx, transfer.id, ['pending'], {
      plan: plan as unknown as Record<string, unknown>,
      status: 'running',
      startedAt: new Date(),
    })
    return plan
  })
}

/** 按期望状态条件更新流转行；状态已被并发改变（如进入补偿）时放弃本步，抛不可重试的 TRANSFER_STATE */
export async function transition(
  tx: Tx,
  transferId: string,
  expected: readonly WorkspaceTransfer['status'][],
  values: Partial<typeof workspaceTransfer.$inferInsert>,
): Promise<void> {
  const updated = await tx
    .update(workspaceTransfer)
    .set(values)
    .where(
      and(eq(workspaceTransfer.id, transferId), inArray(workspaceTransfer.status, [...expected])),
    )
    .returning({ id: workspaceTransfer.id })
  if (updated.length === 0) throw transferError('TRANSFER_STATE', '流转状态已变化，放弃本步', 409)
}

/** D8：超过阈值只允许升级与移动，复制要求缩小范围 */
export function assertCopyWithinLimit(kind: WorkspaceTransfer['kind'], total: number) {
  if (kind === 'copy' && total > TRANSFER_COPY_ROW_LIMIT)
    throw transferError('TRANSFER_TOO_LARGE', '复制范围过大，请缩小选择', 400, { total })
}

/** 升级开始时目标所有可流转表为 0 行（D1）：目标在流转锁中，工作台不写预置数据 */
async function assertTargetEmpty(tx: Tx, transfer: WorkspaceTransfer) {
  for (const entry of FLOWING_TRANSFER_TABLES) {
    const meta = tableMeta(entry.name)
    const [hit] = await rows(
      tx,
      sql`select 1 from ${ident(meta.name)} where ${ident(meta.ws)} = ${transfer.targetWorkspaceId} limit 1`,
    )
    if (hit)
      throw transferError('TRANSFER_TARGET_NOT_EMPTY', '升级的目标空间已有业务数据', 409, {
        table: meta.name,
      })
  }
}

/**
 * 写入 planned 行：`filter` 与 `batchKey` 都以别名 t 引用源表；batchKey 为空的行不写入。
 * 已在清单中的行（同一行经多条路径进入闭包）保持第一次写入的批次。
 */
async function planRows(
  tx: Tx,
  transfer: WorkspaceTransfer,
  meta: TableMeta,
  filter: SQL,
  batchKey: SQL,
) {
  await tx.execute(sql`insert into workspace_transfer_id_map
      (transfer_id, table_name, source_id, action, batch_key, updated_at)
    select ${transfer.id}, ${meta.name}, x.k, 'planned', x.bk, now() from (
      select ${keyOf(meta, 't')} as k, (${batchKey})::text as bk
      from ${ident(meta.name)} t
      where t.${ident(meta.ws)} = ${transfer.sourceWorkspaceId} and (${filter})
    ) x where x.bk is not null
    on conflict do nothing`)
}

/** 闭包父行在 ID 映射中的批次键（只继承同一批次族的父行，如验证批次的准备度不继承方向批次） */
function inheritedKey(transfer: WorkspaceTransfer, meta: TableMeta, fallback: SQL | null): SQL {
  const parents = closureRefs(meta.entry).flatMap((r) =>
    r.targets
      .filter((target) => tableMeta(target).entry.batch === meta.entry.batch)
      .map(
        (target) =>
          sql`(select m.batch_key from workspace_transfer_id_map m
            where m.transfer_id = ${transfer.id} and m.table_name = ${target}
              and m.source_id = ${col('t', r.column.name)}::text)`,
      ),
  )
  const parts = fallback ? [...parents, fallback] : parents
  if (parts.length === 0) return sql`null`
  return sql`coalesce(${sql.join(parts, sql`, `)})`
}

/** 闭包父行已在清单中（任一闭包引用命中） */
function hasPlannedParent(transfer: WorkspaceTransfer, meta: TableMeta): SQL {
  const checks = closureRefs(meta.entry).flatMap((r) =>
    r.targets.map(
      (target) =>
        sql`exists (select 1 from workspace_transfer_id_map m
          where m.transfer_id = ${transfer.id} and m.table_name = ${target}
            and m.source_id = ${col('t', r.column.name)}::text)`,
    ),
  )
  return checks.length ? sql`(${sql.join(checks, sql` or `)})` : sql`false`
}

const directionKey = (column: string) => sql`'direction:' || ${col('t', column)}::text`

/** 升级：源空间全部可流转行（D3“移动”列），方向闭包每方向一批 */
async function planUpgrade(tx: Tx, transfer: WorkspaceTransfer) {
  for (const entry of FLOWING_TRANSFER_TABLES) {
    const meta = tableMeta(entry.name)
    let key: SQL
    if (entry.name === 'direction') key = directionKey('id')
    else if (entry.batch === 'direction')
      // 没有方向可归属的行（如线索与簇都为空的事件）放在方向批次之后的 direction:none
      key = inheritedKey(transfer, meta, sql`'direction:none'`)
    else key = inheritedKey(transfer, meta, sql`${entry.batch}`)
    await planRows(tx, transfer, meta, sql`true`, key)
  }
}

/**
 * 选择性移动 / 复制的闭包（D2）。触发方式按操作取注册表的 move 或 copy 列
 * （复制不带影子验证样本，D4.6）：
 * 1. 根条目：方向、店铺、追踪商品、品类研究；核算方案 / 档案以线索所在的整个簇为根
 *    （含 merged_into_id 相连的簇），簇所属方向不随簇移动；
 * 2. 按注册表的闭包引用向下展开（父先子后）；
 * 3. 线索根的方向：在目标中复制或合并（源行保留）；
 * 4. 被闭包引用的配置（seasonal_node、supplier、logistics_profile、risk_rule）：复制或合并，源行保留；
 *    配置包整表；线索根另带整份 cost_param。
 */
async function planSelectiveClosure(
  tx: Tx,
  transfer: WorkspaceTransfer,
  selection: TransferSelection,
) {
  const triggers = (entry: FlowingTransferTable) =>
    transfer.kind === 'copy' ? entry.copy : entry.move
  const roots = selection.roots ?? {}
  const src = transfer.sourceWorkspaceId
  if (roots.direction?.length)
    await planRows(
      tx,
      transfer,
      tableMeta('direction'),
      sql`t.id = any(${uuidList(roots.direction)})`,
      directionKey('id'),
    )
  const leadRoots = [
    ...(roots.costingScenario?.length
      ? await rows<{ id: string }>(
          tx,
          sql`select lead_id as id from costing_scenario
            where workspace_id = ${src} and id = any(${uuidList(roots.costingScenario)})`,
        )
      : []),
    ...(roots.decision?.length
      ? await rows<{ id: string }>(
          tx,
          sql`select lead_id as id from decision
            where workspace_id = ${src} and id = any(${uuidList(roots.decision)})`,
        )
      : []),
  ].map((r) => r.id)
  if (leadRoots.length) {
    let clusters = (
      await rows<{ id: string }>(
        tx,
        sql`select distinct cluster_id as id from lead
          where workspace_id = ${src} and id = any(${uuidList(leadRoots)})`,
      )
    ).map((r) => r.id)
    // 合并关系相连的簇一起流转，避免 merged_into_id 跨空间（合并只发生在同一方向内）
    for (;;) {
      const next = (
        await rows<{ id: string }>(
          tx,
          sql`select id from cluster where workspace_id = ${src} and (
            id = any(${uuidList(clusters)}) or merged_into_id = any(${uuidList(clusters)})
            or id in (select merged_into_id from cluster where id = any(${uuidList(clusters)})))`,
        )
      ).map((r) => r.id)
      if (next.length === clusters.length) break
      clusters = next
    }
    await planRows(
      tx,
      transfer,
      tableMeta('cluster'),
      sql`t.id = any(${uuidList(clusters)})`,
      directionKey('direction_id'),
    )
  }
  const simpleRoots: [keyof typeof roots, string][] = [
    ['store', 'tracked_store'],
    ['trackedProduct', 'tracked_product'],
    ['categoryStudy', 'category_study'],
  ]
  for (const [root, table] of simpleRoots) {
    const ids = roots[root] as readonly string[] | undefined
    if (!ids?.length) continue
    const meta = tableMeta(table)
    await planRows(tx, transfer, meta, sql`t.id = any(${uuidList(ids)})`, sql`${meta.entry.batch}`)
  }
  // 闭包展开：只沿“随根流转”的表（触发方式含 closure）向下，方向本身只来自根条目
  for (const entry of FLOWING_TRANSFER_TABLES) {
    if (!triggers(entry).includes('closure') || entry.name === 'direction') continue
    if (closureRefs(entry).length === 0) continue
    const meta = tableMeta(entry.name)
    await planRows(
      tx,
      transfer,
      meta,
      hasPlannedParent(transfer, meta),
      inheritedKey(transfer, meta, null),
    )
  }
  // 线索根：簇所属的方向按 D4.1 在目标中复制或合并，与簇同批
  if (leadRoots.length)
    await planRows(
      tx,
      transfer,
      tableMeta('direction'),
      sql`t.id in (select c.direction_id from cluster c join workspace_transfer_id_map m
        on m.transfer_id = ${transfer.id} and m.table_name = 'cluster' and m.source_id = c.id::text)`,
      directionKey('id'),
    )
  // 被闭包引用的配置
  for (const entry of FLOWING_TRANSFER_TABLES) {
    for (const ref of entry.references) {
      if (ref.kind === 'jsonb-key') continue
      for (const target of ref.targets) {
        const targetMeta = tableMeta(target)
        if (!triggers(targetMeta.entry).includes('referenced')) continue
        const meta = tableMeta(entry.name)
        const value = col('r', ref.column.name)
        const values = ref.kind === 'uuid-array' ? sql`unnest(${value})::text` : sql`${value}::text`
        await planRows(
          tx,
          transfer,
          targetMeta,
          sql`t.id::text in (select ${values} from ${ident(meta.name)} r
            join workspace_transfer_id_map m on m.transfer_id = ${transfer.id}
              and m.table_name = ${meta.name} and m.source_id = ${keyOf(meta, 'r')})`,
          sql`'config'`,
        )
      }
    }
  }
  const pack = roots.configPack ? [...TRANSFER_ROOTS.configPack.tables] : []
  if (leadRoots.length) pack.push('cost_param')
  for (const table of new Set(pack))
    await planRows(tx, transfer, tableMeta(table), sql`true`, sql`'config'`)
}

/** 冲突预览的标签：名称、卖家、商品、规则说明或平台类目 */
function labelOf(meta: TableMeta): SQL {
  switch (meta.name) {
    case 'tracked_store':
      return sql`s.seller_key`
    case 'tracked_product':
      return sql`coalesce((select p.title from marketplace_product p where p.id = s.product_id), s.product_id::text)`
    case 'risk_rule':
      return sql`s.description`
    case 'cost_param':
      return sql`s.platform || ':' || coalesce(s.category_id, '*')`
    default:
      return sql`s.name`
  }
}

interface NaturalMatch {
  source_id: string
  target_id: string
  label: string
  marketplace: string | null
  equal: boolean
}

/** 按注册表的自然键在目标空间查找同一行（多行命中时取最小 id，确定性） */
async function naturalMatches(
  tx: Tx,
  transfer: WorkspaceTransfer,
  meta: TableMeta,
): Promise<NaturalMatch[]> {
  const key = meta.entry.naturalKey
  if (!key) return []
  const nullable = new Set(key.nullAsEmpty ?? [])
  const eqs = key.columns.map((c) =>
    nullable.has(c)
      ? sql`coalesce(${col('s', c.name)}, '') = coalesce(${col('g', c.name)}, '')`
      : sql`${col('s', c.name)} = ${col('g', c.name)}`,
  )
  const conflict = meta.entry.conflict
  const equal =
    conflict.kind === 'merge-if-equal'
      ? sql.join(
          conflict.compare.map(
            (c) => sql`${col('s', c.name)} is not distinct from ${col('g', c.name)}`,
          ),
          sql` and `,
        )
      : sql`true`
  const marketplace = meta.columns.includes('marketplace') ? sql`s.marketplace` : sql`null`
  return rows<NaturalMatch>(
    tx,
    sql`select distinct on (s.id) s.id::text as source_id, g.id::text as target_id,
        ${labelOf(meta)} as label, ${marketplace} as marketplace, (${equal}) as equal
      from ${ident(meta.name)} s
      join workspace_transfer_id_map m on m.transfer_id = ${transfer.id}
        and m.table_name = ${meta.name} and m.source_id = s.id::text and m.action = 'planned'
      join ${ident(meta.name)} g on g.${ident(meta.ws)} = ${transfer.targetWorkspaceId}
        and ${sql.join(eqs, sql` and `)}
      where s.${ident(meta.ws)} = ${transfer.sourceWorkspaceId}
      order by s.id, g.id`,
  )
}

/** 重命名：名称（来自 <源空间名>），再冲突追加序号 */
function renameIn(name: string, sourceName: string, taken: Set<string>): string {
  const base = `${name}（来自 ${sourceName}）`
  let candidate = base
  for (let n = 2; taken.has(candidate); n++) candidate = `${base} ${n}`
  taken.add(candidate)
  return candidate
}

/**
 * 冲突决定（D4）。预览与执行共用：批次按这里的决定落地，因此重命名的新名称在计划时一次确定
 * （同名避让同时考虑目标已有名称与本次流入的其他行）。
 */
async function resolveConflicts(
  tx: Tx,
  transfer: WorkspaceTransfer,
  selection: TransferSelection,
): Promise<TransferConflictDecision[]> {
  const [source] = await rows<{ name: string }>(
    tx,
    sql`select name from organization where id = ${transfer.sourceWorkspaceId}`,
  )
  const sourceName = source?.name ?? ''
  const out: TransferConflictDecision[] = []
  for (const entry of FLOWING_TRANSFER_TABLES) {
    if (entry.conflict.kind === 'none') continue
    const meta = tableMeta(entry.name)
    const matches = await naturalMatches(tx, transfer, meta)
    if (matches.length === 0) continue
    const conflict = entry.conflict
    const decide = (
      m: NaturalMatch,
      action: TransferConflictDecision['action'],
      newName?: string,
    ) =>
      out.push({
        table: meta.name,
        sourceId: m.source_id,
        label: m.label,
        ...(m.marketplace ? { marketplace: m.marketplace } : {}),
        action,
        ...(action === 'rename' && newName !== undefined ? { newName } : { targetId: m.target_id }),
      })
    if (conflict.kind === 'merge') for (const m of matches) decide(m, 'merge')
    else if (conflict.kind === 'keep-target') for (const m of matches) decide(m, 'keep-target')
    else {
      const renameColumn = conflict.kind === 'rename' ? conflict.column : conflict.renameColumn
      // 名称占用：目标已有 + 源空间全部名称（重命名先在源空间改名再移动，新名称不能撞源空间唯一索引）
      const taken = new Set(
        (
          await rows<{ name: string }>(
            tx,
            sql`select ${col('t', renameColumn.name)} as name from ${ident(meta.name)} t
              where t.${ident(meta.ws)} = ${transfer.targetWorkspaceId}
              union all
              select ${col('t', renameColumn.name)} from ${ident(meta.name)} t
              where t.${ident(meta.ws)} = ${transfer.sourceWorkspaceId}`,
          )
        ).map((r) => r.name),
      )
      for (const m of matches) {
        const strategy: DirectionConflictStrategy | 'merge-if-equal' =
          conflict.kind === 'rename'
            ? meta.name === 'direction'
              ? directionStrategy(selection, m.source_id)
              : 'rename'
            : 'merge-if-equal'
        if (strategy === 'merge' || (strategy === 'merge-if-equal' && m.equal)) decide(m, 'merge')
        else decide(m, 'rename', renameIn(m.label, sourceName, taken))
      }
    }
  }
  return out
}

/** 评分版本快照（D4.5）：线索与推荐保留源空间的 setting_version，流转记录写入对应设置的完整快照 */
async function scoringSnapshot(tx: Tx, transfer: WorkspaceTransfer) {
  return rows<Record<string, unknown>>(
    tx,
    sql`select s.version, s.weights, s.reverse_dimensions as "reverseDimensions",
        s.veto_threshold as "vetoThreshold", s.min_dimensions as "minDimensions",
        s.hard_gates as "hardGates", s.margin_floor_bp as "marginFloorBp",
        s.effective_at as "effectiveAt"
      from scoring_setting s
      where s.workspace_id = ${transfer.sourceWorkspaceId} and s.version in (
        select l.setting_version from lead l join workspace_transfer_id_map m
          on m.transfer_id = ${transfer.id} and m.table_name = 'lead' and m.source_id = l.id::text
        union
        select r.setting_version from recommendation r join workspace_transfer_id_map m
          on m.transfer_id = ${transfer.id} and m.table_name = 'recommendation'
            and m.source_id = r.id::text)
      order by s.version`,
  )
}

const tableOrder = sql.raw(
  `case table_name ${FLOWING_TRANSFER_TABLES.map((e, i) => `when '${e.name}' then ${i}`).join(' ')} end`,
)

/** 单批超过上限时按“注册表顺序 + 主键”切成子批（只用于升级：纯原地更新，没有批内合并） */
async function splitOversizedBatches(tx: Tx, transferId: string) {
  await tx.execute(sql`with ranked as (
      select table_name, source_id, batch_key,
        (row_number() over (partition by batch_key order by ${tableOrder}, source_id) - 1)
          / ${TRANSFER_SUB_BATCH_ROWS} as part,
        count(*) over (partition by batch_key) as n
      from workspace_transfer_id_map where transfer_id = ${transferId})
    update workspace_transfer_id_map m set batch_key = r.batch_key || '#' || r.part
    from ranked r
    where r.n > ${TRANSFER_SUB_BATCH_ROWS} and m.transfer_id = ${transferId}
      and m.table_name = r.table_name and m.source_id = r.source_id`)
}

/** 批次顺序（D8）：配置 → 方向（每方向一批）→ 店铺池 → 追踪商品 → 品类研究 → 验证 / 抽检 */
export function compareBatchKeys(a: string, b: string): number {
  const family = (key: string) => TRANSFER_BATCH_ORDER.indexOf(batchFamily(key))
  const [baseA = '', partA = '0'] = a.split('#')
  const [baseB = '', partB = '0'] = b.split('#')
  return (
    family(a) - family(b) ||
    (baseA < baseB ? -1 : baseA > baseB ? 1 : 0) ||
    Number(partA) - Number(partB)
  )
}

async function writeBatches(tx: Tx, transferId: string): Promise<TransferPlanBatch[]> {
  const counts = await rows<{ batch_key: string; n: number }>(
    tx,
    sql`select batch_key, count(*)::int as n from workspace_transfer_id_map
      where transfer_id = ${transferId} group by batch_key`,
  )
  const batches = counts
    .sort((a, b) => compareBatchKeys(a.batch_key, b.batch_key))
    .map((c, i) => ({ key: c.batch_key, seq: i + 1, rows: c.n }))
  if (batches.length)
    await tx
      .insert(workspaceTransferBatch)
      .values(batches.map((b) => ({ transferId, seq: b.seq, batchKey: b.key })))
  return batches
}
