# 验收回执：M2 跟卖选品端到端（add-follow-selection 5.1）

- 日期：2026-10-19（本机 Orca worktree，隔离库 `product_res_wt_agent_a67447abfc689ddf9`，web 端口 25700）
- 数据：直接写入隔离库的市场数据（等同模拟连接器写入的 `marketplace_product` 与 `observation`，
  来源 `ebay-browse`，同日价格另有 `dataforseo`），不调用真实数据源，不使用示例数据
- 用例：`apps/web/e2e/follow-acceptance.spec.ts`

## 命令

```bash
PRODUCT_RES_PG_CONTAINER=saas-template-pg bash scripts/orca/setup.sh
pnpm --filter @product-res/db db:migrate
# apps/web/.dev.vars 的 APP_URL 临时改为 http://localhost:25700，结束后已改回 3000
cd apps/web && pnpm exec playwright test e2e/follow-acceptance.spec.ts
```

结果：`1 passed`（单测约 27 s）；流水线日志 `selection.direction_done clusters=2 createdClusters=2 leads=2`。

## 步骤与结果

| # | 步骤 | 结果 |
|---|---|---|
| 1 | 注册新空间；设置页“品牌库”新增 VeRO 品牌 Acmeknife | 通过 |
| 2 | 方向页新建方向“厨房收纳（验收）”：eBay US、唯一类目、返校季节点；添加种子店铺 kitchen_pro | 通过（截图 01） |
| 3 | 写入 3 个 eBay 商品（两个 GTIN 等价的竹制香料架、一个 Acmeknife 磨刀器）与 30 天累计已售、价格、评论数观测 | 通过 |
| 4 | `runSelectionForWorkspace` 只运行本空间（不处理库里其他空间的方向） | 2 个簇、2 条线索，无失败 |
| 5 | 候选列表 eBay：2 行；香料架“未验证”（冷启动）；Acmeknife 行“不推荐”并标 VeRO | 通过（截图 02） |
| 6 | 香料架详情：综合分可算；市场需求理由“7 天销量增量约 … 件”、同行扩散“对标店铺上架同簇商品”，来源标“eBay Browse API”；利润空间“无数据”（未核算，不按 0 计）；来源对比显示 DataForSEO 与 eBay Browse API 两个价格；置信度明细含“成本确定性（未核算）”；2 个成员 | 通过（截图 03） |
| 7 | Acmeknife 详情：风险卡片说明 VeRO 命中，合规维度理由“一票否决” | 通过（截图 04） |

## 截图

- `docs/receipts/m2-acceptance-2026-10-19/01-direction-configured.png`
- `docs/receipts/m2-acceptance-2026-10-19/02-candidates.png`
- `docs/receipts/m2-acceptance-2026-10-19/03-cluster-detail.png`
- `docs/receipts/m2-acceptance-2026-10-19/04-vetoed-detail.png`

## 未覆盖

- 真实数据源（5.2，依赖 M1b 凭据）。
- 通过 jobs 定时任务触发流水线：本用例直接调用 `packages/follow` 的入口，计划注册已由
  `apps/jobs/test/selection-schedule.unit.test.ts` 覆盖。
