import { type Database, workspaceTransfer } from '@product-res/db'
import { newId } from '@product-res/shared'
import { assertNoActiveTransfer, assertTransferAccess, lockTransferWorkspaces } from './access.ts'
import {
  invalid,
  isUuid,
  parseSelection,
  TRANSFER_COPY_ROW_LIMIT,
  type TransferConfig,
  transferError,
} from './common.ts'
import { buildPlan, type TransferConflictDecision } from './plan.ts'
import type { QuotaEstimate } from './quota.ts'
import { countSelectedRoots } from './start.ts'

/**
 * 选择性复制 / 移动的只读预览（design D4、D11，tasks 6.2）：对话框“预览”时调用，结果与随后发起的流转
 * 在 plan 步骤算出的闭包、冲突决定一致（同一份 buildPlan）。
 *
 * buildPlan 以 workspace_transfer_id_map 为工作表计算闭包，因此预览在一个最终回滚的事务里写入临时的
 * 流转行与 planned 映射，读出结果后整体回滚：不落库、不投递、不写审计。事务内持有与 plan 相同的锁，
 * 读取与之后的发起看到同一套权限与流转锁规则。
 */
export interface TransferPreviewInput {
  readonly kind: 'copy' | 'move'
  readonly userId: string
  readonly sourceWorkspaceId: string
  readonly targetWorkspaceId: string
  readonly selection: unknown
}

export interface TransferPreview {
  readonly kind: 'copy' | 'move'
  readonly sourceName: string
  readonly targetName: string
  /** 按根条目类型统计的、属于源空间的所选行数 */
  readonly roots: Readonly<Record<string, number>>
  /** 按表计划流转的行数（含闭包与被引用的配置） */
  readonly tables: Readonly<Record<string, number>>
  readonly total: number
  /** 与目标已有行冲突的行及其处理（重命名 / 合并 / 保留目标） */
  readonly conflicts: readonly TransferConflictDecision[]
  /** D4.5：闭包内线索引用的源空间评分版本号，目标中保留原版本号并标注来源 */
  readonly scoringVersions: readonly number[]
  readonly quota: QuotaEstimate
  /** D8：复制超过行数上限时不能发起，需要缩小范围 */
  readonly rowLimit: number
  readonly tooLarge: boolean
  /** D2：以核算方案 / 档案为根时，所属方向在目标中复制（同名时按冲突策略重命名或合并） */
  readonly directionsFollowLeads: boolean
}

class PreviewRollback extends Error {
  constructor(readonly preview: TransferPreview) {
    super('transfer preview rollback')
  }
}

export async function previewTransfer(
  db: Database,
  input: TransferPreviewInput,
  config: TransferConfig,
): Promise<TransferPreview> {
  if (!config.tenancy.dataTransfer) throw transferError('TRANSFER_DISABLED', '数据流转未开启', 403)
  if (input.kind !== 'copy' && input.kind !== 'move') invalid('只能预览复制或移动')
  if (!isUuid(input.sourceWorkspaceId) || !isUuid(input.targetWorkspaceId)) invalid('空间 id 无效')
  const selection = parseSelection(input.selection)
  try {
    await db.transaction(async (tx) => {
      const ids = [input.sourceWorkspaceId, input.targetWorkspaceId]
      // 与 plan 相同：卖家数据共享锁 → ws: 锁，避免与 eBay 账号删除交错
      await lockTransferWorkspaces(tx, ids, { sellerData: true })
      await assertTransferAccess(
        tx,
        {
          kind: input.kind,
          userId: input.userId,
          sourceWorkspaceId: input.sourceWorkspaceId,
          targetWorkspaceId: input.targetWorkspaceId,
        },
        config,
        { revoked: false },
      )
      await assertNoActiveTransfer(tx, ids)
      const roots = await countSelectedRoots(tx, input.sourceWorkspaceId, selection)
      const found = Object.values(roots).reduce((a, b) => a + b, 0)
      if (found === 0 && !selection.roots?.configPack)
        throw transferError('TRANSFER_EMPTY_SELECTION', '所选条目不在源空间中', 400)
      const [transfer] = await tx
        .insert(workspaceTransfer)
        .values({
          kind: input.kind,
          sourceWorkspaceId: input.sourceWorkspaceId,
          targetWorkspaceId: input.targetWorkspaceId,
          requestedBy: input.userId,
          idempotencyKey: `preview:${newId()}`,
          selection: selection as Record<string, unknown>,
        })
        .returning()
      if (!transfer) throw new Error('workspace_transfer insert returned no row')
      const plan = await buildPlan(tx, transfer, { enforceCopyLimit: false })
      throw new PreviewRollback({
        kind: input.kind,
        sourceName: plan.sourceName,
        targetName: plan.targetName,
        roots,
        tables: plan.tables,
        total: plan.total,
        conflicts: plan.conflicts,
        scoringVersions: plan.scoringVersions.map((s) => Number(s.version)),
        quota: plan.quota,
        rowLimit: TRANSFER_COPY_ROW_LIMIT,
        tooLarge: input.kind === 'copy' && plan.total > TRANSFER_COPY_ROW_LIMIT,
        directionsFollowLeads: Boolean(
          selection.roots?.costingScenario?.length || selection.roots?.decision?.length,
        ),
      })
    })
  } catch (error) {
    if (error instanceof PreviewRollback) return error.preview
    throw error
  }
  throw new Error('transfer preview did not roll back')
}
