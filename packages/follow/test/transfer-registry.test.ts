import * as db from '@product-res/db'
import { workspaceColumnOf } from '@product-res/db'
import { getTableName, is } from 'drizzle-orm'
import { type AnyPgColumn, getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import {
  FLOWING_TRANSFER_TABLES,
  STATIC_TRANSFER_TABLES,
  TRANSFER_ROOTS,
  TRANSFER_TABLES,
} from '../src/transfer/registry.ts'
import { TRANSFER_BATCH_ORDER } from '../src/transfer/types.ts'

// tasks 1.1 / 3.1：流转注册表与 schema 对照。新增空间级表或引用列而忘记登记时这里失败。

const schemaTables: PgTable[] = Object.values(db).flatMap((value: unknown) =>
  is(value, PgTable) ? [value] : [],
)
const transferTables = new Set<PgTable>([
  db.workspaceTransfer,
  db.workspaceTransferBatch,
  db.workspaceTransferIdMap,
])
const registered = new Map(TRANSFER_TABLES.map((entry) => [entry.table, entry]))
const flowingNames = new Set(FLOWING_TRANSFER_TABLES.map((entry) => entry.name))
const order = new Map(FLOWING_TRANSFER_TABLES.map((entry, i) => [entry.name, i]))

function columnsOf(table: PgTable): AnyPgColumn[] {
  return Object.values(getTableConfig(table).columns) as AnyPgColumn[]
}

function isUuidLike(column: AnyPgColumn): boolean {
  if (column.columnType === 'PgUUID') return true
  const base = (column as unknown as { baseColumn?: AnyPgColumn }).baseColumn
  return column.columnType === 'PgArray' && base?.columnType === 'PgUUID'
}

describe('流转注册表覆盖', () => {
  it('schema 中所有带空间列的表都已登记', () => {
    const missing = schemaTables
      .filter((table) => workspaceColumnOf(table) !== undefined && !registered.has(table))
      .map((table) => getTableName(table))
    expect(missing).toEqual([])
  })

  it('引用 organization 的表都已登记（流转表自身除外）', () => {
    const missing = schemaTables
      .filter((table) => !registered.has(table) && !transferTables.has(table))
      .filter((table) =>
        getTableConfig(table).foreignKeys.some(
          (fk) => fk.reference().foreignTable === db.organization,
        ),
      )
      .map((table) => getTableName(table))
    expect(missing).toEqual([])
  })

  it('引用参与流转表的外键只来自注册表中的表', () => {
    const flowing = new Set(FLOWING_TRANSFER_TABLES.map((entry) => entry.table))
    const offenders = schemaTables
      .filter((table) => !registered.has(table))
      .filter((table) =>
        getTableConfig(table).foreignKeys.some((fk) => flowing.has(fk.reference().foreignTable)),
      )
      .map((table) => getTableName(table))
    expect(offenders).toEqual([])
  })

  it('分类与 design D3 的计数一致', () => {
    expect(new Set(TRANSFER_TABLES.map((entry) => entry.name)).size).toBe(TRANSFER_TABLES.length)
    expect(TRANSFER_TABLES).toHaveLength(52)
    expect(FLOWING_TRANSFER_TABLES).toHaveLength(29)
    expect(STATIC_TRANSFER_TABLES.filter((entry) => entry.link === 'workspace')).toHaveLength(20)
    expect(
      STATIC_TRANSFER_TABLES.filter((entry) => entry.link === 'indirect').map((e) => e.name),
    ).toEqual(['credit_hold_allocation', 'apikey', 'session'])
    const upgradeOnly = FLOWING_TRANSFER_TABLES.filter(
      (entry) => entry.move.length === 0 && entry.copy.length === 0,
    ).map((entry) => entry.name)
    expect(upgradeOnly.sort()).toEqual(
      [
        'accuracy_audit',
        'accuracy_audit_item',
        'readiness_stat',
        'scoring_setting',
        'weight_suggestion',
      ].sort(),
    )
    const moveNotCopy = FLOWING_TRANSFER_TABLES.filter(
      (entry) => entry.move.length > 0 && entry.copy.length === 0,
    ).map((entry) => entry.name)
    expect(moveNotCopy).toEqual(['recommendation', 'recommendation_label'])
  })

  it('登记的表名与 schema 一致，间接表没有空间列', () => {
    for (const entry of TRANSFER_TABLES) {
      expect(getTableName(entry.table), entry.name).toBe(entry.name)
      const hasWorkspace = workspaceColumnOf(entry.table) !== undefined
      if (entry.flow === 'flowing' || entry.link === 'workspace') {
        expect(hasWorkspace, entry.name).toBe(true)
      } else expect(hasWorkspace, entry.name).toBe(false)
    }
  })

  it('根条目指向参与流转的表', () => {
    for (const root of Object.values(TRANSFER_ROOTS)) {
      const tables = 'tables' in root ? root.tables : [root.table]
      for (const name of tables) expect(flowingNames.has(name), name).toBe(true)
      if ('closureVia' in root) expect(flowingNames.has(root.closureVia)).toBe(true)
    }
  })
})

describe('引用列', () => {
  it('引用、保留与自然键的列都属于所登记的表', () => {
    for (const entry of FLOWING_TRANSFER_TABLES) {
      const own = new Set(columnsOf(entry.table))
      const columns = [
        ...entry.references.map((r) => r.column),
        ...entry.preserved.map((p) => p.column),
        ...(entry.naturalKey?.columns ?? []),
        ...(entry.naturalKey?.nullAsEmpty ?? []),
        ...(entry.conflict.kind === 'rename' ? [entry.conflict.column] : []),
        ...(entry.conflict.kind === 'merge' ? (entry.conflict.unionColumns ?? []) : []),
        ...(entry.conflict.kind === 'merge-if-equal'
          ? [...entry.conflict.compare, entry.conflict.renameColumn]
          : []),
      ]
      for (const column of columns)
        expect(own.has(column), `${entry.name}.${column.name}`).toBe(true)
      for (const column of entry.naturalKey?.nullAsEmpty ?? []) {
        expect(entry.naturalKey?.columns).toContain(column)
      }
    }
  })

  it('每个 uuid / uuid[] 列都声明为重写或保留', () => {
    for (const entry of FLOWING_TRANSFER_TABLES) {
      const declared = new Set([
        ...entry.references.map((r) => r.column),
        ...entry.preserved.map((p) => p.column),
      ])
      const workspace = workspaceColumnOf(entry.table)?.column
      const undeclared = columnsOf(entry.table)
        .filter((column) => isUuidLike(column) && !column.primary && column !== workspace)
        .filter((column) => !declared.has(column))
        .map((column) => `${entry.name}.${column.name}`)
      expect(undeclared).toEqual([])
    }
  })

  it('外键与声明一致：指向流转表的外键必须重写，其余外键只能保留', () => {
    for (const entry of FLOWING_TRANSFER_TABLES) {
      const workspace = workspaceColumnOf(entry.table)?.column
      for (const fk of getTableConfig(entry.table).foreignKeys) {
        const ref = fk.reference()
        const [column] = ref.columns as AnyPgColumn[]
        if (!column || column === workspace) continue
        const target = getTableName(ref.foreignTable)
        const label = `${entry.name}.${column.name} → ${target}`
        const declared = entry.references.find((r) => r.column === column)
        if (flowingNames.has(target)) {
          expect(declared?.kind, label).toBe('fk')
          expect(declared?.targets, label).toEqual([target])
        } else {
          expect(declared, label).toBeUndefined()
          expect(
            entry.preserved.some((p) => p.column === column),
            label,
          ).toBe(true)
        }
      }
      // 声明为 fk 的列确实有外键；其他形态的列确实没有
      const fkColumns = new Set(
        getTableConfig(entry.table).foreignKeys.flatMap((fk) => fk.reference().columns),
      )
      for (const r of entry.references) {
        expect(fkColumns.has(r.column), `${entry.name}.${r.column.name}`).toBe(r.kind === 'fk')
      }
    }
  })

  it('引用目标都是参与流转的表；闭包父行的缺失处理为 fail', () => {
    for (const entry of FLOWING_TRANSFER_TABLES) {
      for (const r of entry.references) {
        for (const target of r.targets) expect(flowingNames.has(target), target).toBe(true)
        if (r.closure) expect(r.unmapped, `${entry.name}.${r.column.name}`).toBe('fail')
        if (r.unmapped === 'set-null') expect(r.column.notNull).toBe(false)
        if (r.unmapped === 'drop-element') expect(r.kind).toBe('uuid-array')
      }
    }
  })
})

describe('唯一约束（design D4）', () => {
  it('声明的唯一约束与 schema 一致，作用域按是否含 workspace_id 判定', () => {
    for (const entry of FLOWING_TRANSFER_TABLES) {
      const config = getTableConfig(entry.table)
      const workspace = workspaceColumnOf(entry.table)?.column
      const actual = [
        ...config.indexes
          .filter((index) => index.config.unique)
          .map((index) => ({
            name: index.config.name as string,
            // 索引列是 IndexedColumn（不是列对象本身），按列名比较；表达式列（SQL）没有 name
            scope: index.config.columns.some(
              (c) => (c as { name?: string }).name === workspace?.name,
            )
              ? 'workspace'
              : 'parent',
          })),
        ...config.primaryKeys.map((pk) => ({
          name: pk.getName(),
          scope: pk.columns.some((c) => c === workspace) ? 'workspace' : 'parent',
        })),
      ]
      const sortByName = <T extends { name: string }>(xs: readonly T[]) =>
        [...xs].sort((a, b) => a.name.localeCompare(b.name))
      expect(sortByName(entry.uniques), entry.name).toEqual(sortByName(actual))
      if (entry.naturalKey?.uniqueIndex) {
        expect(entry.uniques.map((u) => u.name)).toContain(entry.naturalKey.uniqueIndex)
      }
    }
  })

  it('可能与目标冲突的唯一约束都有冲突策略，只在升级时流转的表除外', () => {
    for (const entry of FLOWING_TRANSFER_TABLES) {
      const conflicts = entry.uniques.some((u) => u.scope === 'workspace')
      const upgradeOnly = entry.move.length === 0 && entry.copy.length === 0
      if (conflicts && !upgradeOnly) {
        expect(entry.conflict.kind, entry.name).not.toBe('none')
        expect(entry.naturalKey?.uniqueIndex, entry.name).toBeDefined()
      }
      // 无唯一约束但参与配置合并的表按自然键去重（D4.8）
      if (!conflicts && entry.conflict.kind !== 'none') {
        expect(entry.naturalKey, entry.name).toBeDefined()
      }
    }
  })
})

describe('顺序', () => {
  const batchIndex = (batch: string) => TRANSFER_BATCH_ORDER.indexOf(batch as never)

  it('父先子后且批次不早于其引用的表', () => {
    for (const entry of FLOWING_TRANSFER_TABLES) {
      for (const r of entry.references) {
        for (const target of r.targets) {
          if (target === entry.name) continue
          const label = `${entry.name}.${r.column.name} → ${target}`
          expect(order.get(target), label).toBeLessThan(order.get(entry.name) as number)
          const parent = FLOWING_TRANSFER_TABLES[order.get(target) as number]
          expect(batchIndex(parent?.batch as string), label).toBeLessThanOrEqual(
            batchIndex(entry.batch),
          )
        }
      }
    }
  })

  it('引用图除自引用外无环', () => {
    const edges = new Map(
      FLOWING_TRANSFER_TABLES.map((entry) => [
        entry.name,
        entry.references.flatMap((r) => r.targets).filter((t) => t !== entry.name),
      ]),
    )
    const state = new Map<string, 'visiting' | 'done'>()
    const visit = (name: string, path: string[]): void => {
      if (state.get(name) === 'done') return
      if (state.get(name) === 'visiting') throw new Error(`cycle: ${[...path, name].join(' → ')}`)
      state.set(name, 'visiting')
      for (const next of edges.get(name) ?? []) visit(next, [...path, name])
      state.set(name, 'done')
    }
    for (const name of edges.keys()) expect(() => visit(name, [])).not.toThrow()
  })

  it('随闭包复制的行，其闭包父表也会被复制', () => {
    for (const entry of FLOWING_TRANSFER_TABLES) {
      if (!entry.copy.includes('closure')) continue
      for (const r of entry.references.filter((ref) => ref.closure)) {
        for (const target of r.targets) {
          const parent = FLOWING_TRANSFER_TABLES[order.get(target) as number]
          expect(parent?.copy.length, `${entry.name} → ${target}`).toBeGreaterThan(0)
        }
      }
    }
  })
})
