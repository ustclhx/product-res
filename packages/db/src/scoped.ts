import { AppError } from '@product-res/shared'
import { and, count, eq, getTableColumns, type InferInsertModel, type SQL } from 'drizzle-orm'
import type {
  PgColumn,
  PgDatabase,
  PgInsertValue,
  PgQueryResultHKT,
  PgTable,
  PgTransactionConfig,
  PgUpdateSetSource,
  SelectedFields,
} from 'drizzle-orm/pg-core'
import type { TablesRelationalConfig } from 'drizzle-orm/relations'

/**
 * 租户隔离的查询入口（docs/04-auth-and-tenancy.md §3「数据隔离」）。
 *
 * `scoped(db, workspaceId)` 只暴露自动带上 `workspace_id = ?` 过滤的方法：读取只返回本空间的行，
 * 写入只影响本空间的行，插入时自动填入空间 id。按 id 访问其他空间的记录与访问不存在的记录
 * 行为相同（抛出 `NOT_FOUND`，HTTP 404），不泄露记录是否存在。
 *
 * feature 代码禁止绕过它直接查询带空间列的表，由 Biome 插件
 * `packages/db/lint/no-unscoped-workspace-query.grit` 检查。
 *
 * 方法签名刻意与 Drizzle 的 `db.select().from(t)` / `db.insert(t)` / `db.delete(t)` 不同
 * （表作为参数、写入方法至少两个参数），lint 规则据此区分两者。
 */

/** 空间列在 schema 中的属性名：业务表用 `workspaceId`，organization 插件的表用 `organizationId`。 */
type WorkspaceKey = 'workspaceId' | 'organizationId'
const WORKSPACE_COLUMNS = ['workspace_id', 'organization_id'] as const

/** 带空间列的表（`workspace_id` 或 `organization_id` → organization.id）。 */
export type WorkspaceTable = PgTable &
  ({ workspaceId: PgColumn; organizationId?: never } | { organizationId: PgColumn })
/** 带 `id` 主键列的空间表，可用 `findById` / `updateById` / `deleteById`。 */
export type WorkspaceTableWithId = WorkspaceTable & { id: PgColumn }

export type ScopedInsert<T extends WorkspaceTable> = Omit<InferInsertModel<T>, WorkspaceKey>
export type ScopedUpdate<T extends WorkspaceTable> = Omit<PgUpdateSetSource<T>, WorkspaceKey>

/** 同时接受数据库与事务（PgTransaction 继承 PgDatabase）。 */
// biome-ignore lint/suspicious/noExplicitAny: 只用到查询构建方法，不依赖具体的 schema 泛型
type AnyDatabase = PgDatabase<PgQueryResultHKT, any, TablesRelationalConfig>

export const NOT_FOUND_CODE = 'NOT_FOUND'

/** 资源不存在或属于其他空间：两种情况对外不可区分。 */
export function notFound(): AppError {
  return new AppError(NOT_FOUND_CODE, 'Not found', { status: 404 })
}

/** 返回表的空间列（属性名与列对象）；不带空间列的表返回 `undefined`。 */
export function workspaceColumnOf(table: PgTable): { key: string; column: PgColumn } | undefined {
  const columns = Object.entries(getTableColumns(table))
  for (const name of WORKSPACE_COLUMNS) {
    const entry = columns.find(([, column]) => column.name === name)
    if (entry) return { key: entry[0], column: entry[1] }
  }
  return undefined
}

function requireWorkspaceColumn(table: PgTable) {
  const ws = workspaceColumnOf(table)
  if (!ws) throw new Error('scoped(): table has no workspace_id / organization_id column')
  return ws
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// 以下构建函数只用于推导返回类型（`ReturnType<typeof fn<T>>`），保持与 Drizzle 构建器一致的链式能力。
// 泛型 T 下 Drizzle `from()` 参数的条件类型无法求值，显式给出类型参数。
const selectAll = <T extends WorkspaceTable>(db: AnyDatabase, table: T, where: SQL | undefined) =>
  db
    .select()
    .from<T>(table as never)
    .where(where)
const selectFields = <T extends WorkspaceTable, F extends SelectedFields>(
  db: AnyDatabase,
  table: T,
  fields: F,
  where: SQL | undefined,
) =>
  db
    .select(fields)
    .from<T>(table as never)
    .where(where)
const insertRows = <T extends WorkspaceTable>(
  db: AnyDatabase,
  table: T,
  rows: PgInsertValue<T>[],
) => db.insert(table).values(rows)
const updateRows = <T extends WorkspaceTable>(
  db: AnyDatabase,
  table: T,
  set: PgUpdateSetSource<T>,
  where: SQL | undefined,
) => db.update(table).set(set).where(where)
const deleteRows = <T extends WorkspaceTable>(db: AnyDatabase, table: T, where: SQL | undefined) =>
  db.delete(table).where(where)

export type ScopedSelect<T extends WorkspaceTable> = ReturnType<typeof selectAll<T>>
export type ScopedSelectFields<T extends WorkspaceTable, F extends SelectedFields> = ReturnType<
  typeof selectFields<T, F>
>
export type ScopedInsertQuery<T extends WorkspaceTable> = ReturnType<typeof insertRows<T>>
export type ScopedUpdateQuery<T extends WorkspaceTable> = ReturnType<typeof updateRows<T>>
export type ScopedDeleteQuery<T extends WorkspaceTable> = ReturnType<typeof deleteRows<T>>

export interface Scoped {
  readonly workspaceId: string

  /**
   * `select * from table where ws = ? [and where]`。返回 Drizzle 查询构建器，可继续链式调用
   * `orderBy` / `limit` / `offset` / `innerJoin` 等；`where` 已被占用，额外条件通过参数传入。
   * 连接其他空间表时，在连接条件中加上 `s.filter(otherTable)`。
   */
  select<T extends WorkspaceTable>(table: T, options?: { where?: SQL }): ScopedSelect<T>
  select<T extends WorkspaceTable, F extends SelectedFields>(
    table: T,
    options: { where?: SQL; fields: F },
  ): ScopedSelectFields<T, F>

  /** 按 id 读取本空间的一行；不存在或属于其他空间时抛出 `NOT_FOUND`（404）。 */
  findById<T extends WorkspaceTableWithId>(table: T, id: string): Promise<T['$inferSelect']>

  /** 本空间内满足条件的行数。 */
  count(table: WorkspaceTable, where?: SQL): Promise<number>

  /**
   * 插入一行或多行，自动填入空间 id。值中若带有其他空间的 id 则抛出 `NOT_FOUND`。
   * 可继续链式调用 `returning()` / `onConflictDoNothing()` 等。
   */
  insert<T extends WorkspaceTable>(
    table: T,
    values: ScopedInsert<T> | ScopedInsert<T>[],
  ): ScopedInsertQuery<T>

  /** 更新本空间内满足条件的行；不允许修改空间列。可继续链式调用 `returning()`。 */
  update<T extends WorkspaceTable>(
    table: T,
    set: ScopedUpdate<T>,
    where?: SQL,
  ): ScopedUpdateQuery<T>

  /**
   * 删除本空间内满足条件的行。`where` 必填，避免误删整个空间的数据；
   * 确实要删除本空间全部行时显式传入 `undefined`。可继续链式调用 `returning()`。
   */
  delete<T extends WorkspaceTable>(table: T, where: SQL | undefined): ScopedDeleteQuery<T>

  /** 按 id 更新本空间的一行并返回更新后的行；不存在或属于其他空间时抛出 `NOT_FOUND`。 */
  updateById<T extends WorkspaceTableWithId>(
    table: T,
    id: string,
    set: ScopedUpdate<T>,
  ): Promise<T['$inferSelect']>

  /** 按 id 删除本空间的一行并返回被删除的行；不存在或属于其他空间时抛出 `NOT_FOUND`。 */
  deleteById<T extends WorkspaceTableWithId>(table: T, id: string): Promise<T['$inferSelect']>

  /** 空间过滤条件 `table.ws = ? [and where]`，用于连接条件或子查询。 */
  filter(table: WorkspaceTable, where?: SQL): SQL

  /** 在事务中执行，回调拿到绑定同一空间的 `Scoped`（基于事务连接）。 */
  transaction<R>(fn: (tx: Scoped) => Promise<R>, config?: PgTransactionConfig): Promise<R>
}

export function scoped(db: AnyDatabase, workspaceId: string): Scoped {
  if (!UUID_RE.test(workspaceId)) throw new Error('scoped(): workspaceId must be a UUID')

  const filter = (table: WorkspaceTable, where?: SQL): SQL =>
    // and() 只有在全部参数为 undefined 时才返回 undefined，这里第一个参数始终存在
    and(eq(requireWorkspaceColumn(table).column, workspaceId), where) as SQL

  /** 写入的值里如果带了空间列，只允许等于当前空间。 */
  const assertOwnWorkspace = (table: WorkspaceTable, value: object) => {
    const { key } = requireWorkspaceColumn(table)
    const ws = (value as Record<string, unknown>)[key]
    if (ws !== undefined && ws !== workspaceId) throw notFound()
  }

  const byId = (table: WorkspaceTableWithId, id: string) => {
    // id 来自 URL 等外部输入：非法 UUID 直接视为不存在，避免数据库报 22P02 变成 500
    if (table.id.columnType === 'PgUUID' && !UUID_RE.test(id)) throw notFound()
    return filter(table, eq(table.id, id))
  }

  const one = <R>(rows: R[]): R => {
    const [row] = rows
    if (row === undefined) throw notFound()
    return row
  }

  const self: Scoped = {
    workspaceId,

    select(
      table: WorkspaceTable,
      options: { where?: SQL; fields?: SelectedFields } = {},
      // 重载的实现签名：返回类型由上面的重载声明约束
    ): never {
      const where = filter(table, options.where)
      return (
        options.fields
          ? selectFields(db, table, options.fields, where)
          : selectAll(db, table, where)
      ) as never
    },

    async findById(table, id) {
      const where = byId(table, id)
      return one(await selectAll(db, table, where).limit(1))
    },

    async count(table, where) {
      const [row] = await db.select({ n: count() }).from(table).where(filter(table, where))
      return row?.n ?? 0
    },

    insert(table, values) {
      const { key } = requireWorkspaceColumn(table)
      const rows = (Array.isArray(values) ? values : [values]).map((value) => {
        assertOwnWorkspace(table, value)
        return { ...value, [key]: workspaceId } as PgInsertValue<typeof table>
      })
      return insertRows(db, table, rows)
    },

    update(table, set, where) {
      assertOwnWorkspace(table, set)
      return updateRows(db, table, set as PgUpdateSetSource<typeof table>, filter(table, where))
    },

    delete(table, where) {
      return deleteRows(db, table, filter(table, where))
    },

    async updateById(table, id, set) {
      const where = byId(table, id)
      assertOwnWorkspace(table, set)
      const rows = await updateRows(
        db,
        table,
        set as PgUpdateSetSource<typeof table>,
        where,
      ).returning()
      return one(rows as (typeof table)['$inferSelect'][])
    },

    async deleteById(table, id) {
      const rows = await deleteRows(db, table, byId(table, id)).returning()
      return one(rows as (typeof table)['$inferSelect'][])
    },

    filter,

    transaction(fn, config) {
      return db.transaction((tx) => fn(scoped(tx, workspaceId)), config)
    },
  }
  return self
}
