import type { BudgetSpec, ProbeReceipt, SourceConnector } from '@product-res/datasources'
import { validateSafetyLine } from '@product-res/datasources'
import type { Database } from '@product-res/db'
import { dataSource } from '@product-res/db/schema'
import { AppError } from '@product-res/shared'
import { eq } from 'drizzle-orm'

/** data_source.config 中团队可调的部分 */
export interface SourceConfig {
  readonly safetyLine?: number
  readonly hardCap?: number
  /** 同步频率：每日 / 每周等档位，由调度读取 */
  readonly schedule?: string
  readonly monthlyAllocation?: BudgetSpec['monthlyAllocation']
}

export type SourceRow = typeof dataSource.$inferSelect

/** 为注册表中的每个数据源补一行状态（默认停用），已有的不改 */
export async function ensureSources(db: Database, connectors: readonly SourceConnector[]) {
  if (connectors.length === 0) return
  await db
    .insert(dataSource)
    .values(connectors.map((c) => ({ id: c.id })))
    .onConflictDoNothing()
}

export async function listSources(db: Database) {
  return db.select().from(dataSource)
}

export async function getSource(db: Database, id: string) {
  const [row] = await db.select().from(dataSource).where(eq(dataSource.id, id))
  return row
}

/** 连接器默认预算叠加团队配置；安全线不超过硬上限，免费接口的硬上限不可调高 */
export function effectiveBudget(
  connector: SourceConnector,
  config: SourceConfig | undefined,
): BudgetSpec {
  const base = connector.budget
  const hardCap =
    config?.hardCap !== undefined && (base.hardCapEditable || config.hardCap <= base.hardCap)
      ? config.hardCap
      : base.hardCap
  const safetyLine = Math.min(config?.safetyLine ?? base.safetyLine, hardCap)
  return {
    ...base,
    hardCap,
    safetyLine,
    ...(config?.monthlyAllocation ? { monthlyAllocation: config.monthlyAllocation } : {}),
  }
}

export async function setSourceEnabled(db: Database, id: string, enabled: boolean) {
  const [row] = await db
    .update(dataSource)
    .set({ enabled, ...(enabled ? { pausedReason: null, pausedUntil: null } : {}) })
    .where(eq(dataSource.id, id))
    .returning()
  if (!row) throw new AppError('NOT_FOUND', 'Data source not found', { status: 404 })
  return row
}

/** 修改配置只影响之后的同步；安全线超过硬上限时拒绝 */
export async function updateSourceConfig(
  db: Database,
  connector: SourceConnector,
  patch: SourceConfig,
) {
  const current = await getSource(db, connector.id)
  if (!current) throw new AppError('NOT_FOUND', 'Data source not found', { status: 404 })
  const merged = { ...(current.config as SourceConfig), ...patch }
  const { safetyLine: _ignored, ...withoutSafety } = merged
  const budget = effectiveBudget(connector, withoutSafety)
  if (
    patch.hardCap !== undefined &&
    !connector.budget.hardCapEditable &&
    patch.hardCap > connector.budget.hardCap
  )
    throw new AppError('INVALID_BUDGET', `硬上限不能超过 ${connector.budget.hardCap}`, {
      status: 400,
    })
  if (merged.safetyLine !== undefined) {
    const error = validateSafetyLine(budget, merged.safetyLine)
    if (error) throw new AppError('INVALID_BUDGET', error, { status: 400 })
  }
  const [row] = await db
    .update(dataSource)
    .set({ config: merged as Record<string, unknown> })
    .where(eq(dataSource.id, connector.id))
    .returning()
  return row as SourceRow
}

/** 保存核验回执；凭据有效时解除“凭据失效”的暂停 */
export async function saveProbe(db: Database, receipt: ProbeReceipt) {
  const current = await getSource(db, receipt.sourceId)
  const clearAuthPause = receipt.credentials === 'valid' && current?.pausedReason === 'auth'
  await db
    .update(dataSource)
    .set({
      lastProbe: receipt as unknown as Record<string, unknown>,
      ...(clearAuthPause ? { pausedReason: null, pausedUntil: null } : {}),
    })
    .where(eq(dataSource.id, receipt.sourceId))
}

/** 暂停数据源的定时任务；until 为空表示需要人工处理（如重新核验凭据） */
export async function pauseSource(db: Database, id: string, reason: string, until: Date | null) {
  await db
    .update(dataSource)
    .set({ pausedReason: reason, pausedUntil: until })
    .where(eq(dataSource.id, id))
}

export function isPaused(row: Pick<SourceRow, 'pausedReason' | 'pausedUntil'>, now: Date) {
  if (!row.pausedReason) return false
  return row.pausedUntil === null || row.pausedUntil > now
}

/** 凭据状态：页面只显示状态，不显示值 */
export function credentialStatus(
  connector: SourceConnector,
  secret: (name: string) => string | undefined,
  row: SourceRow | undefined,
): 'missing' | 'unverified' | 'valid' | 'invalid' {
  if (connector.secrets.some((name) => !secret(name))) return 'missing'
  const probe = row?.lastProbe as ProbeReceipt | null | undefined
  if (!probe) return 'unverified'
  return probe.credentials === 'valid' ? 'valid' : 'invalid'
}
