import { workspaceColumnOf } from '@product-res/db'
import { type SQL, sql } from 'drizzle-orm'
import { type AnyPgColumn, getTableConfig } from 'drizzle-orm/pg-core'
import { FLOWING_TRANSFER_TABLES } from './registry.ts'
import type { FlowingTransferTable, TransferBatch, TransferReference } from './types.ts'

/**
 * 由注册表推导执行所需的表元数据（SQL 列名、主键、ID 映射键）。
 * 引擎只按这里与注册表生成 SQL，不另写表清单；表名与列名都来自 schema 常量，按标识符直接拼接。
 */
export interface TableMeta {
  readonly entry: FlowingTransferTable
  readonly name: string
  /** 注册表中的位置（父先子后） */
  readonly order: number
  /** 空间列的 SQL 名 */
  readonly ws: string
  /** 主键列的 SQL 名；复合主键（cluster_signal）有多列 */
  readonly pk: readonly string[]
  /** 全部列的 SQL 名，恢复源行快照时逐列回写 */
  readonly columns: readonly string[]
  /** 列对象 → Drizzle 属性名，复制行时按属性名读写 */
  readonly jsKey: ReadonlyMap<AnyPgColumn, string>
}

const cache = new Map<string, TableMeta>()

export function tableMeta(name: string): TableMeta {
  const hit = cache.get(name)
  if (hit) return hit
  const order = FLOWING_TRANSFER_TABLES.findIndex((entry) => entry.name === name)
  const entry = FLOWING_TRANSFER_TABLES[order]
  if (!entry) throw new Error(`unknown transfer table ${name}`)
  const config = getTableConfig(entry.table)
  const ws = workspaceColumnOf(entry.table)?.column.name
  if (!ws) throw new Error(`${name} has no workspace column`)
  const composite = config.primaryKeys[0]?.columns.map((c) => c.name)
  const pk = composite ?? config.columns.filter((c) => c.primary).map((c) => c.name)
  const jsKey = new Map<AnyPgColumn, string>()
  for (const [key, column] of Object.entries(entry.table as unknown as Record<string, unknown>)) {
    if (config.columns.includes(column as never)) jsKey.set(column as AnyPgColumn, key)
  }
  const meta: TableMeta = {
    entry,
    name,
    order,
    ws,
    pk,
    columns: config.columns.map((c) => c.name),
    jsKey,
  }
  cache.set(name, meta)
  return meta
}

/** 带引号的标识符；名称只来自 schema 常量 */
export const ident = (name: string): SQL => sql.raw(`"${name}"`)
/** alias."column" */
export const col = (alias: string, name: string): SQL => sql.raw(`${alias}."${name}"`)

/**
 * ID 映射键：单列主键为 id::text；复合主键以 `|` 拼接（D7：id_map 的 id 列为 text）。
 * 日期按 ISO 文本参与拼接，与 Postgres 的 date::text 一致。
 */
export function keyOf(meta: TableMeta, alias: string): SQL {
  if (meta.pk.length === 1) return sql.raw(`${alias}."${meta.pk[0]}"::text`)
  return sql.raw(`concat_ws('|', ${meta.pk.map((c) => `${alias}."${c}"::text`).join(', ')})`)
}

/** 批次族：batch_key 冒号或井号之前的部分（direction:<id>#1 → direction） */
export function batchFamily(batchKey: string): TransferBatch {
  return batchKey.split(/[:#]/)[0] as TransferBatch
}

/** 闭包父引用：子行随父行进入闭包、继承父行的批次 */
export function closureRefs(entry: FlowingTransferTable): readonly TransferReference[] {
  return entry.references.filter((r) => r.closure)
}

export function columnName(column: AnyPgColumn): string {
  return column.name
}
