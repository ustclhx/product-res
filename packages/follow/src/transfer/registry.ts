import {
  accuracyAudit,
  accuracyAuditItem,
  aiConversation,
  aiMessage,
  aiTask,
  apikey,
  auditLog,
  billingCompensation,
  billingCustomer,
  brandEntry,
  categoryStudy,
  categoryStudySnapshot,
  cluster,
  clusterMember,
  clusterSignal,
  costingScenario,
  costParam,
  creditDebt,
  creditGrant,
  creditHold,
  creditHoldAllocation,
  creditLedger,
  decision,
  direction,
  directionSeller,
  file,
  followOutcome,
  invitation,
  lead,
  leadEvent,
  logisticsProfile,
  member,
  notification,
  payment,
  paymentRefund,
  purchase,
  readinessStat,
  recommendation,
  recommendationLabel,
  refundRequest,
  riskFinding,
  riskRule,
  scoringSetting,
  seasonalNode,
  session,
  subscription,
  supplier,
  supplierQuote,
  trackedProduct,
  trackedStore,
  weightSuggestion,
  workspaceInviteLink,
} from '@product-res/db'
import type {
  FlowingTransferTable,
  StaticTransferTable,
  TransferBatch,
  TransferTable,
} from './types.ts'

/**
 * 流转表注册表（openspec/changes/add-workspace-data-transfer design D3、D4，tasks 3.1）。
 *
 * 逐表声明带空间列的 49 张表与 3 张间接关联表的流转语义。参与流转的表按“父先子后”排列，
 * 且批次不早于其引用的表（D8）：plan 按此顺序计算闭包与插入顺序，补偿按逆序撤销。
 * test/transfer-registry.test.ts 对照 schema 校验覆盖、引用列、唯一约束与顺序。
 */

const PRODUCT = '部署级市场商品，各空间共享引用'
const USER = '用户引用，原样保留'
const SETTING_VERSION =
  '指向源空间 scoring_setting.version，保留原值并在流转记录写入版本快照（D4.5）'

/** 升级时整表移动；选择性复制 / 移动的触发方式见 types.ts */
const flowing = (entry: Omit<FlowingTransferTable, 'flow'>): FlowingTransferTable => ({
  ...entry,
  flow: 'flowing',
})
const staticTable = (
  entry: Omit<StaticTransferTable, 'flow' | 'link'> & { link?: StaticTransferTable['link'] },
): StaticTransferTable => ({ link: 'workspace', ...entry, flow: 'none' })

/** 参与流转的 29 张表，父先子后 */
export const FLOWING_TRANSFER_TABLES: readonly FlowingTransferTable[] = [
  // —— 配置（被闭包引用时按 D4 合并或复制；配置包整表流转） ——
  flowing({
    name: 'seasonal_node',
    table: seasonalNode,
    file: 'selection',
    batch: 'config',
    move: ['referenced', 'config-pack'],
    copy: ['referenced', 'config-pack'],
    uniques: [{ name: 'seasonal_node_workspace_name_idx', scope: 'workspace' }],
    naturalKey: {
      columns: [seasonalNode.name],
      uniqueIndex: 'seasonal_node_workspace_name_idx',
    },
    conflict: { kind: 'merge', note: '同名即同一节点，以目标的日期为准；preset 行同样合并' },
    references: [],
    preserved: [],
  }),
  flowing({
    name: 'brand_entry',
    table: brandEntry,
    file: 'selection',
    batch: 'config',
    move: ['config-pack'],
    copy: ['config-pack'],
    uniques: [],
    naturalKey: {
      columns: [brandEntry.name, brandEntry.kind, brandEntry.marketplace],
      nullAsEmpty: [brandEntry.marketplace],
    },
    conflict: { kind: 'merge' },
    references: [],
    preserved: [],
  }),
  flowing({
    name: 'risk_rule',
    table: riskRule,
    file: 'selection',
    batch: 'config',
    // 风险发现的 ref 可能是规则 id：随簇流转时一并落地，保证 ref 在目标空间可解析
    move: ['referenced', 'config-pack'],
    copy: ['referenced', 'config-pack'],
    uniques: [],
    naturalKey: { columns: [riskRule.kind, riskRule.match, riskRule.level] },
    conflict: { kind: 'merge' },
    references: [],
    preserved: [],
  }),
  flowing({
    name: 'scoring_setting',
    table: scoringSetting,
    file: 'selection',
    batch: 'config',
    // 只追加、最新版本生效：给目标追加版本会改变目标当前权重，选择性操作不流转（D4.5）
    move: [],
    copy: [],
    uniques: [{ name: 'scoring_setting_workspace_version_idx', scope: 'workspace' }],
    naturalKey: {
      columns: [scoringSetting.version],
      uniqueIndex: 'scoring_setting_workspace_version_idx',
    },
    // 仅升级：开始时校验目标所有可流转表为空，版本号不会冲突
    conflict: { kind: 'none' },
    references: [],
    preserved: [{ column: scoringSetting.createdBy, reason: USER }],
  }),
  flowing({
    name: 'supplier',
    table: supplier,
    file: 'costing',
    batch: 'config',
    move: ['referenced', 'config-pack'],
    copy: ['referenced', 'config-pack'],
    uniques: [],
    naturalKey: {
      columns: [supplier.name, supplier.url, supplier.platform],
      nullAsEmpty: [supplier.url],
    },
    conflict: { kind: 'merge' },
    references: [],
    preserved: [],
  }),
  flowing({
    name: 'logistics_profile',
    table: logisticsProfile,
    file: 'costing',
    batch: 'config',
    move: ['referenced', 'config-pack'],
    copy: ['referenced', 'config-pack'],
    uniques: [{ name: 'logistics_profile_workspace_name_idx', scope: 'workspace' }],
    naturalKey: {
      columns: [logisticsProfile.name],
      uniqueIndex: 'logistics_profile_workspace_name_idx',
    },
    conflict: {
      kind: 'merge-if-equal',
      compare: [
        logisticsProfile.platform,
        logisticsProfile.type,
        logisticsProfile.transitDays,
        logisticsProfile.headFreight,
        logisticsProfile.lastMile,
        logisticsProfile.bannedAttributes,
      ],
      renameColumn: logisticsProfile.name,
    },
    references: [],
    preserved: [],
  }),
  flowing({
    name: 'cost_param',
    table: costParam,
    file: 'costing',
    batch: 'config',
    // D2：以核算方案 / 档案为根时整份带上，归入配置包触发
    move: ['config-pack'],
    copy: ['config-pack'],
    uniques: [{ name: 'cost_param_key_idx', scope: 'workspace' }],
    naturalKey: {
      columns: [costParam.platform, costParam.categoryId],
      nullAsEmpty: [costParam.categoryId],
      uniqueIndex: 'cost_param_key_idx',
    },
    // 核算方案的 result 是计算时快照，保留目标参数不影响已流转的方案
    conflict: { kind: 'keep-target' },
    references: [],
    preserved: [],
  }),

  // —— 方向闭包（每个方向一批） ——
  flowing({
    name: 'direction',
    table: direction,
    file: 'selection',
    batch: 'direction',
    move: ['closure'],
    copy: ['closure'],
    uniques: [{ name: 'direction_workspace_name_idx', scope: 'workspace' }],
    naturalKey: { columns: [direction.name], uniqueIndex: 'direction_workspace_name_idx' },
    conflict: {
      kind: 'rename',
      column: direction.name,
      // 合并：簇挂到目标方向，direction_seller 去重（目标 rejected 保持），站点 / 类目 / 关键词取并集
      alternatives: ['merge'],
    },
    references: [
      {
        column: direction.nodeIds,
        kind: 'uuid-array',
        targets: ['seasonal_node'],
        unmapped: 'drop-element',
      },
    ],
    preserved: [],
  }),
  flowing({
    name: 'direction_seller',
    table: directionSeller,
    file: 'selection',
    batch: 'direction',
    move: ['closure'],
    copy: ['closure'],
    uniques: [{ name: 'direction_seller_key_idx', scope: 'parent' }],
    naturalKey: {
      columns: [
        directionSeller.directionId,
        directionSeller.marketplace,
        directionSeller.sellerPlatformId,
      ],
      uniqueIndex: 'direction_seller_key_idx',
    },
    conflict: { kind: 'none' },
    references: [
      {
        column: directionSeller.directionId,
        kind: 'fk',
        targets: ['direction'],
        closure: true,
        unmapped: 'fail',
      },
    ],
    preserved: [],
  }),
  flowing({
    name: 'cluster',
    table: cluster,
    file: 'selection',
    batch: 'direction',
    move: ['closure'],
    copy: ['closure'],
    uniques: [],
    conflict: { kind: 'none' },
    references: [
      {
        column: cluster.directionId,
        kind: 'fk',
        targets: ['direction'],
        closure: true,
        unmapped: 'fail',
        note: '以线索 / 档案为根时方向不随簇移动，改指目标中复制或合并后的方向（D2）',
      },
      {
        column: cluster.mergedIntoId,
        kind: 'loose-uuid',
        targets: ['cluster'],
        unmapped: 'set-null',
        note: '自引用：被合并进的簇在闭包内（D2），同批先插入为空再回填',
      },
    ],
    preserved: [{ column: cluster.representativeProductId, reason: PRODUCT }],
  }),
  flowing({
    name: 'cluster_member',
    table: clusterMember,
    file: 'selection',
    batch: 'direction',
    move: ['closure'],
    copy: ['closure'],
    uniques: [{ name: 'cluster_member_cluster_product_idx', scope: 'parent' }],
    conflict: { kind: 'none' },
    references: [
      {
        column: clusterMember.clusterId,
        kind: 'fk',
        targets: ['cluster'],
        closure: true,
        unmapped: 'fail',
      },
    ],
    preserved: [{ column: clusterMember.productId, reason: PRODUCT }],
  }),
  flowing({
    name: 'cluster_signal',
    table: clusterSignal,
    file: 'selection',
    batch: 'direction',
    move: ['closure'],
    copy: ['closure'],
    // 复合主键，ID 映射以拼接键记录（D7）
    uniques: [{ name: 'cluster_signal_cluster_id_observed_on_dimension_pk', scope: 'parent' }],
    conflict: { kind: 'none' },
    references: [
      {
        column: clusterSignal.clusterId,
        kind: 'fk',
        targets: ['cluster'],
        closure: true,
        unmapped: 'fail',
      },
    ],
    preserved: [{ column: clusterSignal.inputs, reason: '输入快照引用部署级观测，原样保留（D4）' }],
  }),
  flowing({
    name: 'lead',
    table: lead,
    file: 'selection',
    batch: 'direction',
    move: ['closure'],
    copy: ['closure'],
    uniques: [{ name: 'lead_cluster_day_idx', scope: 'parent' }],
    conflict: { kind: 'none' },
    references: [
      {
        column: lead.clusterId,
        kind: 'fk',
        targets: ['cluster'],
        closure: true,
        unmapped: 'fail',
      },
      { column: lead.directionId, kind: 'fk', targets: ['direction'], unmapped: 'fail' },
    ],
    preserved: [
      { column: lead.settingVersion, reason: SETTING_VERSION },
      { column: lead.confidenceDetail, reason: '历史快照，原样保留（D4）' },
    ],
  }),
  flowing({
    name: 'lead_event',
    table: leadEvent,
    file: 'selection',
    batch: 'direction',
    move: ['closure'],
    copy: ['closure'],
    uniques: [],
    conflict: { kind: 'none' },
    references: [
      {
        column: leadEvent.leadId,
        kind: 'fk',
        targets: ['lead'],
        closure: true,
        unmapped: 'fail',
      },
      {
        column: leadEvent.clusterId,
        kind: 'fk',
        targets: ['cluster'],
        closure: true,
        unmapped: 'fail',
      },
      // 事件载荷中的空间行 id：回看提醒幂等判断（selection-review）、决定 / 组合状态事件、
      // 品类研究转线索（category.server 按 studyId 查已转出的线索）
      ...(
        [
          ['decisionId', 'decision'],
          ['scenarioId', 'costing_scenario'],
          ['studyId', 'category_study'],
          ['snapshotId', 'category_study_snapshot'],
        ] as const
      ).map(([key, target]) => ({
        column: leadEvent.payload,
        kind: 'jsonb-key' as const,
        key,
        targets: [target],
        unmapped: 'drop-key' as const,
      })),
    ],
    preserved: [{ column: leadEvent.actorUserId, reason: USER }],
    note: '业务事件流（含 review-reminder 幂等标记）随线索 / 簇流转',
  }),
  flowing({
    name: 'risk_finding',
    table: riskFinding,
    file: 'selection',
    batch: 'direction',
    move: ['closure'],
    copy: ['closure'],
    uniques: [{ name: 'risk_finding_key_idx', scope: 'parent' }],
    conflict: { kind: 'none' },
    references: [
      {
        column: riskFinding.clusterId,
        kind: 'fk',
        targets: ['cluster'],
        closure: true,
        unmapped: 'fail',
      },
      {
        column: riskFinding.ref,
        kind: 'text-ref',
        targets: ['risk_rule'],
        // ref 非空且参与唯一键，不能置空；品牌名等非 id 内容映射不到时原样保留
        unmapped: 'keep',
        note: '值为 risk_rule.id 时按映射重写',
      },
    ],
    preserved: [],
  }),
  flowing({
    name: 'supplier_quote',
    table: supplierQuote,
    file: 'costing',
    batch: 'direction',
    move: ['closure'],
    copy: ['closure'],
    uniques: [],
    conflict: { kind: 'none' },
    references: [
      {
        column: supplierQuote.clusterId,
        kind: 'fk',
        targets: ['cluster'],
        closure: true,
        unmapped: 'fail',
      },
      { column: supplierQuote.supplierId, kind: 'fk', targets: ['supplier'], unmapped: 'fail' },
    ],
    preserved: [
      { column: supplierQuote.importId, reason: '部署级 data_import，原样保留' },
      { column: supplierQuote.createdBy, reason: USER },
    ],
  }),
  flowing({
    name: 'costing_scenario',
    table: costingScenario,
    file: 'costing',
    batch: 'direction',
    move: ['closure'],
    copy: ['closure'],
    uniques: [{ name: 'costing_scenario_key_idx', scope: 'parent' }],
    conflict: { kind: 'none' },
    references: [
      {
        column: costingScenario.leadId,
        kind: 'fk',
        targets: ['lead'],
        closure: true,
        unmapped: 'fail',
      },
      {
        column: costingScenario.quoteId,
        kind: 'fk',
        targets: ['supplier_quote'],
        unmapped: 'fail',
      },
      {
        column: costingScenario.profileId,
        kind: 'fk',
        targets: ['logistics_profile'],
        unmapped: 'fail',
      },
    ],
    preserved: [],
    note: '作为根时等价于以其线索为根，最小闭包是线索所在的整个簇（D2）',
  }),
  flowing({
    name: 'decision',
    table: decision,
    file: 'costing',
    batch: 'direction',
    move: ['closure'],
    copy: ['closure'],
    uniques: [{ name: 'decision_lead_idx', scope: 'parent' }],
    conflict: { kind: 'none' },
    references: [
      {
        column: decision.leadId,
        kind: 'fk',
        targets: ['lead'],
        closure: true,
        unmapped: 'fail',
      },
      {
        column: decision.scenarioId,
        kind: 'fk',
        targets: ['costing_scenario'],
        unmapped: 'set-null',
      },
    ],
    preserved: [
      { column: decision.snapshot, reason: '决定时的历史快照，原样保留（D4）' },
      { column: decision.decidedBy, reason: USER },
    ],
    note: '档案根；作为根时最小闭包同核算方案',
  }),
  flowing({
    name: 'follow_outcome',
    table: followOutcome,
    file: 'costing',
    batch: 'direction',
    move: ['closure'],
    copy: ['closure'],
    uniques: [{ name: 'follow_outcome_key_idx', scope: 'parent' }],
    conflict: { kind: 'none' },
    references: [
      {
        column: followOutcome.decisionId,
        kind: 'fk',
        targets: ['decision'],
        closure: true,
        unmapped: 'fail',
      },
    ],
    preserved: [{ column: followOutcome.recordedBy, reason: USER }],
  }),
  // 影子验证样本：FK cluster_id / direction_id 为 restrict，移动时必须与簇在同一批次事务内移动，
  // 否则批次之间会出现跨空间引用；复制不带样本（D4.6）
  flowing({
    name: 'recommendation',
    table: recommendation,
    file: 'validation',
    batch: 'direction',
    move: ['closure'],
    copy: [],
    uniques: [
      { name: 'recommendation_lead_day_idx', scope: 'parent' },
      { name: 'recommendation_cluster_day_kind_idx', scope: 'parent' },
    ],
    conflict: { kind: 'none' },
    references: [
      {
        column: recommendation.clusterId,
        kind: 'fk',
        targets: ['cluster'],
        closure: true,
        unmapped: 'fail',
      },
      { column: recommendation.leadId, kind: 'fk', targets: ['lead'], unmapped: 'set-null' },
      { column: recommendation.directionId, kind: 'fk', targets: ['direction'], unmapped: 'fail' },
    ],
    preserved: [
      { column: recommendation.settingVersion, reason: SETTING_VERSION },
      { column: recommendation.inputs, reason: '冻结时的输入快照，原样保留（D4）' },
    ],
  }),
  flowing({
    name: 'recommendation_label',
    table: recommendationLabel,
    file: 'validation',
    batch: 'direction',
    move: ['closure'],
    copy: [],
    uniques: [{ name: 'recommendation_label_key_idx', scope: 'parent' }],
    conflict: { kind: 'none' },
    references: [
      {
        column: recommendationLabel.recommendationId,
        kind: 'fk',
        targets: ['recommendation'],
        closure: true,
        unmapped: 'fail',
      },
    ],
    preserved: [],
  }),

  // —— 店铺池与追踪商品 ——
  flowing({
    name: 'tracked_store',
    table: trackedStore,
    file: 'tracking',
    batch: 'store-pool',
    move: ['closure'],
    copy: ['closure'],
    uniques: [{ name: 'tracked_store_key_idx', scope: 'workspace' }],
    naturalKey: {
      columns: [trackedStore.marketplace, trackedStore.sellerKey],
      uniqueIndex: 'tracked_store_key_idx',
    },
    conflict: { kind: 'merge', unionColumns: [trackedStore.directionIds] },
    references: [
      {
        column: trackedStore.directionIds,
        kind: 'uuid-array',
        targets: ['direction'],
        unmapped: 'drop-element',
        note: '只保留本次流转中的方向（D2）',
      },
    ],
    preserved: [],
  }),
  flowing({
    name: 'tracked_product',
    table: trackedProduct,
    file: 'tracking',
    batch: 'tracked-product',
    move: ['closure'],
    copy: ['closure'],
    uniques: [{ name: 'tracked_product_key_idx', scope: 'workspace' }],
    naturalKey: { columns: [trackedProduct.productId], uniqueIndex: 'tracked_product_key_idx' },
    conflict: {
      kind: 'merge',
      note: 'tier 取更热的档位（hot > normal > cold），tier_reason 记为 transfer',
    },
    references: [
      {
        column: trackedProduct.originRef,
        kind: 'loose-uuid',
        targets: ['tracked_store', 'lead'],
        unmapped: 'set-null',
      },
    ],
    preserved: [{ column: trackedProduct.productId, reason: PRODUCT }],
  }),

  // —— 品类研究 ——
  flowing({
    name: 'category_study',
    table: categoryStudy,
    file: 'insight',
    batch: 'category-study',
    move: ['closure'],
    copy: ['closure'],
    uniques: [{ name: 'category_study_workspace_name_idx', scope: 'workspace' }],
    naturalKey: {
      columns: [categoryStudy.name],
      uniqueIndex: 'category_study_workspace_name_idx',
    },
    conflict: { kind: 'rename', column: categoryStudy.name, alternatives: [] },
    references: [],
    preserved: [{ column: categoryStudy.createdBy, reason: USER }],
  }),
  flowing({
    name: 'category_study_snapshot',
    table: categoryStudySnapshot,
    file: 'insight',
    batch: 'category-study',
    move: ['closure'],
    copy: ['closure'],
    uniques: [],
    conflict: { kind: 'none' },
    references: [
      {
        column: categoryStudySnapshot.studyId,
        kind: 'fk',
        targets: ['category_study'],
        closure: true,
        unmapped: 'fail',
      },
    ],
    preserved: [
      { column: categoryStudySnapshot.modules, reason: '引用部署级观测的报告快照，原样保留' },
    ],
  }),

  // —— 验证 / 抽检（仅升级） ——
  flowing({
    name: 'readiness_stat',
    table: readinessStat,
    file: 'validation',
    batch: 'validation',
    // 派生统计；move 完成后在两边重算（D8）
    move: [],
    copy: [],
    uniques: [{ name: 'readiness_stat_key_idx', scope: 'workspace' }],
    conflict: { kind: 'none' },
    references: [
      {
        column: readinessStat.directionId,
        kind: 'fk',
        targets: ['direction'],
        closure: true,
        unmapped: 'fail',
      },
    ],
    preserved: [],
  }),
  flowing({
    name: 'weight_suggestion',
    table: weightSuggestion,
    file: 'validation',
    batch: 'validation',
    // 基于整空间样本拟合，部分流转后失效；move 后源空间未处理的建议作废（D8）
    move: [],
    copy: [],
    uniques: [],
    conflict: { kind: 'none' },
    references: [],
    preserved: [{ column: weightSuggestion.resolvedBy, reason: USER }],
  }),
  flowing({
    name: 'accuracy_audit',
    table: accuracyAudit,
    file: 'accuracy',
    batch: 'validation',
    // 一致率汇总进部署级 source_qualification，复制会重复计数（D4.7）
    move: [],
    copy: [],
    uniques: [{ name: 'accuracy_audit_week_idx', scope: 'workspace' }],
    naturalKey: { columns: [accuracyAudit.weekOf], uniqueIndex: 'accuracy_audit_week_idx' },
    conflict: { kind: 'none' },
    references: [],
    preserved: [{ column: accuracyAudit.submittedBy, reason: USER }],
  }),
  flowing({
    name: 'accuracy_audit_item',
    table: accuracyAuditItem,
    file: 'accuracy',
    batch: 'validation',
    move: [],
    copy: [],
    uniques: [{ name: 'accuracy_audit_item_key_idx', scope: 'parent' }],
    conflict: { kind: 'none' },
    references: [
      {
        column: accuracyAuditItem.auditId,
        kind: 'fk',
        targets: ['accuracy_audit'],
        closure: true,
        unmapped: 'fail',
      },
    ],
    preserved: [
      { column: accuracyAuditItem.productId, reason: PRODUCT },
      { column: accuracyAuditItem.checkedBy, reason: USER },
    ],
  }),
]

const CREDITS = '积分不随数据走（D9）'
const BILLING = '账单与支付关系不随数据走（D9）'

/** 不流转的 20 张空间表与 3 张间接关联表 */
export const STATIC_TRANSFER_TABLES: readonly StaticTransferTable[] = [
  staticTable({
    name: 'member',
    table: member,
    file: 'tenancy',
    reason: '目标成员关系独立管理；升级时只新建发起人的 owner 行',
  }),
  staticTable({ name: 'invitation', table: invitation, file: 'tenancy', reason: '成员邀请' }),
  staticTable({
    name: 'workspace_invite_link',
    table: workspaceInviteLink,
    file: 'tenancy',
    reason: '成员邀请链接',
  }),
  staticTable({
    name: 'ai_conversation',
    table: aiConversation,
    file: 'ai',
    reason: '个人对话；ai_message.hold_id 指向源空间积分预扣',
  }),
  staticTable({ name: 'ai_message', table: aiMessage, file: 'ai', reason: '随 ai_conversation' }),
  staticTable({
    name: 'ai_task',
    table: aiTask,
    file: 'ai',
    reason: 'hold_id 指向源空间积分；产物在 file',
  }),
  staticTable({
    name: 'file',
    table: file,
    file: 'files',
    reason: 'r2_key 含源空间 id，复制需搬对象，本期不做',
  }),
  staticTable({ name: 'credit_grant', table: creditGrant, file: 'credits', reason: CREDITS }),
  staticTable({ name: 'credit_hold', table: creditHold, file: 'credits', reason: CREDITS }),
  staticTable({ name: 'credit_debt', table: creditDebt, file: 'credits', reason: CREDITS }),
  staticTable({
    name: 'credit_ledger',
    table: creditLedger,
    file: 'credits',
    reason: '账本只追加',
  }),
  staticTable({
    name: 'billing_customer',
    table: billingCustomer,
    file: 'billing',
    reason: BILLING,
  }),
  staticTable({ name: 'subscription', table: subscription, file: 'billing', reason: BILLING }),
  staticTable({ name: 'purchase', table: purchase, file: 'billing', reason: BILLING }),
  staticTable({ name: 'payment', table: payment, file: 'billing', reason: BILLING }),
  staticTable({ name: 'payment_refund', table: paymentRefund, file: 'billing', reason: BILLING }),
  staticTable({ name: 'refund_request', table: refundRequest, file: 'billing', reason: BILLING }),
  staticTable({
    name: 'billing_compensation',
    table: billingCompensation,
    file: 'billing-compensation',
    reason: BILLING,
  }),
  staticTable({
    name: 'audit_log',
    table: auditLog,
    file: 'platform',
    reason: '已有审计留在原空间，流转另在两边写新行（D10）',
  }),
  staticTable({ name: 'notification', table: notification, file: 'platform', reason: '用户通知' }),
  staticTable({
    name: 'credit_hold_allocation',
    table: creditHoldAllocation,
    file: 'credits',
    link: 'indirect',
    reason: '无空间列，随 credit_hold',
  }),
  staticTable({
    name: 'apikey',
    table: apikey,
    file: 'auth',
    link: 'indirect',
    reason: '空间记在 metadata；升级后个人空间 Key 仍指向个人空间，提示在团队空间重新创建',
  }),
  staticTable({
    name: 'session',
    table: session,
    file: 'auth',
    link: 'indirect',
    reason: '升级完成后只改发起人会话的 active_organization_id，不随数据流转',
  }),
]

export const TRANSFER_TABLES: readonly TransferTable[] = [
  ...FLOWING_TRANSFER_TABLES,
  ...STATIC_TRANSFER_TABLES,
]

/** 用户可选的根条目（D2）：closureVia 表示以该表的哪一行作为闭包起点 */
export const TRANSFER_ROOTS = {
  direction: { table: 'direction' },
  store: { table: 'tracked_store' },
  trackedProduct: { table: 'tracked_product' },
  categoryStudy: { table: 'category_study' },
  // 最小闭包是线索所在的整个簇；方向按 D4.1 在目标中复制或合并，不随簇移动
  costingScenario: { table: 'costing_scenario', closureVia: 'lead' },
  decision: { table: 'decision', closureVia: 'lead' },
  configPack: {
    tables: [
      'seasonal_node',
      'brand_entry',
      'risk_rule',
      'logistics_profile',
      'cost_param',
      'supplier',
    ],
  },
} as const

const byName = new Map(FLOWING_TRANSFER_TABLES.map((entry) => [entry.name, entry]))

/** 按 SQL 表名查找参与流转的表 */
export function flowingTransferTable(name: string): FlowingTransferTable | undefined {
  return byName.get(name)
}

/** 某批次内的表，按父先子后排列 */
export function transferTablesInBatch(batch: TransferBatch): readonly FlowingTransferTable[] {
  return FLOWING_TRANSFER_TABLES.filter((entry) => entry.batch === batch)
}
