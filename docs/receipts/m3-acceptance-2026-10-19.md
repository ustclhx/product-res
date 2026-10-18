# M3 验收记录：add-costing-decisions 5.1（2026-10-19）

目标：一条线索从发现 → 核算 → 待决定 → 跟卖 → 档案库的端到端链路。

## 命令

```
PRODUCT_RES_PG_CONTAINER=saas-template-pg bash scripts/orca/setup.sh
pnpm --filter @product-res/db db:migrate
# apps/web/.dev.vars 的 APP_URL 临时改为本 worktree 端口 23650，结束后改回 http://localhost:3000
cd apps/web && pnpm exec playwright test e2e/costing-acceptance.spec.ts
```

用例：`apps/web/e2e/costing-acceptance.spec.ts`。结果：1 passed。

## 步骤与结果

夹具只写入线索本身：方向、节点（45 天后）、商品簇、3 个成员、价格观测、USD/CNY 汇率、状态 new 的线索（分数 77、置信度 0.68）。其余均走页面。

| 步骤 | 操作 | 结果 | 截图 |
|---|---|---|---|
| 1 | 商品簇详情“核算”标签新增供应商与两档阶梯报价 | 报价行 1 条，线索进入“核算中” | m3-acceptance-2026-10-19/01-quote-entered.png |
| 2 | 设置页新增物流方案“云途专线”（eBay 直发，12 天） | 方案出现在列表 | 02-logistics-profile.png |
| 3 | 设置页新增 eBay 平台成本参数（佣金 13.6%、固定费 0.30、广告 6%、退货 3%） | 参数行 1 条 | 03-cost-params.png |
| 4 | 回到核算标签，计划数量 300，重新计算，选定最优组合 | 矩阵 1 格并高亮最优，成本瀑布渲染，线索进入“待决定” | 04-scenario-selected.png |
| 5 | 工作台首页 | 待决定队列出现该线索，显示毛利率与落地成本 | 05-queue.png |
| 6 | 行内“跟卖”，首批数量预填 300，填计划上架日并确认 | 队列清空 | 06-decision-form.png |
| 7 | 选品档案库，查看快照 | 记录为“跟卖”，快照显示分数 77、置信度 68%、权重版本 v1、同款同货源、售价 USD 21.49、落地成本 USD 5.04、毛利率 52.6%、保本价 USD 6.90 | 07-archive-snapshot.png |
| 8 | 再打开线索核算标签 | 已决定后不再提供“选定此组合”（核算锁定） | 无 |

## 说明

- 成本参数表单默认平台为 Amazon，eBay 线索需手动切换平台，否则矩阵提示“缺少：佣金率、固定费…”。用例已处理，行为符合设计，未改代码。
- 未运行其他已有 e2e，docs/receipts 下旧截图未变。
