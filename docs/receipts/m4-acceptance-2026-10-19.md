# M4 验收记录：add-category-insight 4.1（2026-10-19）

目标：用夹具市场数据新建品类研究并生成报告，从竞品矩阵转为线索，候选可见，归档后在档案库可见。

## 命令

```
PRODUCT_RES_PG_CONTAINER=saas-template-pg bash scripts/orca/setup.sh
pnpm --filter @product-res/db db:migrate
# apps/web/.dev.vars 的 APP_URL 临时改为本 worktree 端口 23650，结束后改回 http://localhost:3000
cd apps/web && pnpm exec playwright test e2e/category-acceptance.spec.ts
```

用例：`apps/web/e2e/category-acceptance.spec.ts`（数据来自 `apps/web/test/fixtures/category-insight-data.ts`）。结果：1 passed。

## 步骤与结果

| 步骤 | 操作 | 结果 | 截图 |
|---|---|---|---|
| 1 | 品牌选品页新建研究“宠物慢食碗验收”（amazon-us、类目 + 关键词、头部 10） | 自动生成报告 | m4-acceptance-2026-10-19/01-report.png |
| 2 | 检查报告各模块 | 同比覆盖 9 个月；退货率、评论主题与建议显示“无数据来源”；竞品矩阵 10 行；各模块非空白 | 同上 |
| 3 | 竞品矩阵第一行“转为线索”，同款微改良，改良点已填 | 行显示“已转线索” | 02-converted.png |
| 4 | 跟卖候选（Amazon）列表 | 该商品簇作为候选出现（1 个成员） | 03-follow-candidates.png |
| 5 | 进入线索详情“核算”标签 | 显示“线索默认：同款微改良” | 04-lead-costing-tab.png |
| 6 | 报告页“归档到档案库” | 报告标记已归档 | 无 |
| 7 | 选品档案库“品类研究报告” | 出现该研究，可点“查看报告”回到报告 | 05-archive.png |

## 说明

- 跟卖候选列表本身没有“跟卖方式”列，微改良在线索详情核算标签的“线索默认”处确认。未改代码。
- 未运行其他已有 e2e，docs/receipts 下旧截图未变。
