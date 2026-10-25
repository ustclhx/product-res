import type { Database } from './client.ts'
import {
  type ScoringHardGates,
  SELECTION_DIMENSIONS,
  type SelectionDimension,
  scoringSetting,
  seasonalNode,
} from './schema/selection.ts'
import { scoped } from './scoped.ts'
import { isWorkspaceTransferring } from './transfer.ts'

/**
 * 跟卖选品的空间级预置数据（openspec/changes/add-follow-selection tasks 2.1）。
 *
 * 预置数据按空间写入，不放进迁移：迁移执行时空间还不存在，且每个空间可以独立增删改。
 * 首次打开方向页或设置页时调用 `ensureSelectionDefaults`。
 */

/** 美国常见销售节点；日期为每年的起卖日，按星期计算的节点取近似日期 */
export const DEFAULT_US_NODES: ReadonlyArray<{
  name: string
  startMonth: number
  startDay: number
  salesDays: number
  keywords: string[]
}> = [
  { name: '情人节', startMonth: 1, startDay: 15, salesDays: 30, keywords: ['valentines day gift'] },
  { name: '母亲节', startMonth: 4, startDay: 10, salesDays: 32, keywords: ['mothers day gift'] },
  { name: '父亲节', startMonth: 5, startDay: 20, salesDays: 32, keywords: ['fathers day gift'] },
  { name: '独立日', startMonth: 6, startDay: 10, salesDays: 25, keywords: ['4th of july'] },
  { name: 'Prime Day', startMonth: 7, startDay: 1, salesDays: 20, keywords: ['prime day deals'] },
  {
    name: '返校季',
    startMonth: 7,
    startDay: 15,
    salesDays: 45,
    keywords: ['back to school supplies'],
  },
  { name: '万圣节', startMonth: 9, startDay: 15, salesDays: 47, keywords: ['halloween decor'] },
  {
    name: '黑五/网一',
    startMonth: 11,
    startDay: 1,
    salesDays: 32,
    keywords: ['black friday deals', 'cyber monday deals'],
  },
  { name: '圣诞', startMonth: 11, startDay: 15, salesDays: 41, keywords: ['christmas gifts'] },
]

/** 默认评分设置（design D5）：等权起步，竞争强度与供应时效为反向维度 */
export const DEFAULT_SCORING_SETTING: {
  weights: Record<SelectionDimension, number>
  reverseDimensions: SelectionDimension[]
  vetoThreshold: number
  minDimensions: number
  hardGates: ScoringHardGates
  marginFloorBp: number
} = {
  weights: Object.fromEntries(SELECTION_DIMENSIONS.map((d) => [d, 1])) as Record<
    SelectionDimension,
    number
  >,
  reverseDimensions: ['competition', 'supply-timing'],
  vetoThreshold: 30,
  minDimensions: 4,
  hardGates: { compliance: true, timing: true, margin: true },
  marginFloorBp: 1500,
}

/**
 * 空间第一次使用选品功能时写入默认评分设置（版本 1）与美国节点；幂等，可并发调用。
 *
 * 以“版本 1 的评分设置是否由本次插入”作为是否已初始化的标记：唯一索引保证并发时只有一个请求插入成功，
 * 只有它写入节点。这样团队删掉全部预置节点后不会在下次访问时被重新加回。
 */
export async function ensureSelectionDefaults(
  db: Database,
  workspaceId: string,
): Promise<{ seeded: boolean }> {
  if (await isWorkspaceTransferring(db, workspaceId)) return { seeded: false }
  return scoped(db, workspaceId).transaction(async (s) => {
    const inserted = await s
      .insert(scoringSetting, { version: 1, ...DEFAULT_SCORING_SETTING })
      .onConflictDoNothing()
      .returning({ id: scoringSetting.id })
    if (inserted.length === 0) return { seeded: false }
    await s
      .insert(
        seasonalNode,
        DEFAULT_US_NODES.map((node) => ({ ...node, preset: true })),
      )
      .onConflictDoNothing()
    return { seeded: true }
  })
}
