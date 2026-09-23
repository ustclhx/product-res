# 平台原生 Agent 与数据接口证据

调研日期：2026-09-16。来源为公开官方页面与文档；没有登录产品或实测。动态页面部分通过搜索引擎返回的官方页面正文核对。

## Amazon：Seller Assistant + Product Opportunity Explorer

- **产品定位**：Seller Assistant 是经营助手，Product Opportunity Explorer（POE）是机会发现工具；两者不能直接当作单一全自动选品产品。
- **当前证据**：官方 Seller Assistant 页面介绍基于卖家业务提供建议并在许可后执行；POE 部分说明利用搜索、点击、购买信号，结合既有产品组合，给出相近但有差异的新品建议。来源：[Amazon 官方产品页](https://sellingpartners.aboutamazon.com/seller-assistant)。
- **工作流**：POE 按搜索后浏览或购买的产品聚类需求细分市场；卖家按品类、关键词或产品发现机会，再观察需求与竞争。低于基准的转化率是识别未满足需求的信号之一，不是对盈利的保证。来源：[POE 产品说明](https://sell.amazon.com/tools/product-opportunity-explorer)。
- **执行边界**：官方公告列出库存、账户健康、促销等能力，同时混用已上线与将推出表述；不能把所有路线图能力都算作全量上线。[Agentic AI 公告](https://www.aboutamazon.com/news/innovation-at-amazon/seller-assistant-agentic-ai)。官方论坛则明确写到已能经批准处理部分违规、FBA 附加费用和促销：[功能更新](https://sellercentral.amazon.com/seller-forums/discussions/t/3fdebe3b-0565-4760-9342-0a204bcd94ac?mons_sel_locale=en_US)。
- **闭环判断（研究者推断）**：平台拥有市场行为与卖家经营数据，已经能形成部分经营反馈闭环；具体新品建议如何受某次推荐后的净利润、退货率影响，公开材料没有披露完整机制或因果效果。
- **更直接的个性化推荐证据**：Amazon B2B 机会报告的 `depersonalized` 参数说明默认推荐会考虑 seller history。此为 B2B 推荐接口，不应外推为所有 Seller Assistant/POE 功能。[B2B Product Opportunities Reports](https://developer-docs.amazon/sp-api/docs/report-type-values-b2b-product-opportunities)。

## Shopify：Sidekick / Pulse

- **已文档化能力**：读取商店上下文、分析数据、处理订单或商品、创建内容和应用、与第三方应用交互；在应用变更前让用户复核。[Sidekick 帮助中心](https://help.shopify.com/en/manual/ai-powered-tools/sidekick)。
- **Pulse 工作流**：主动分析近期有销售活动的店铺 → 最多五个建议卡 → 点击后生成待办 → 用户批准后执行。文档标注 early access，仅向部分商家开放，要求管理员权限及启用 Network Intelligence。
- **真实反馈证据**：用户可拒绝建议并填写原因，Sidekick 用该反馈个性化后续建议。短摘：“uses this feedback to personalize future recommendations”。这是偏好反馈证据，不等于利润驱动的新品排序学习。[Pulse 帮助文档](https://help.shopify.com/en/manual/ai-powered-tools/sidekick/pulse)。
- **商店数据证据**：官方列明真实 sales、inventory、customer data，并给出滞销、缺货、低转化流量来源等用例。[官方应用说明](https://www.shopify.com/enterprise/blog/sidekick-ai-questions)。
- **判断**：经营反馈和偏好反馈相对明确；跨站新品发现并非其主要定位，也没有足够证据支持“按新品测试利润自动迭代跨境选品策略”。

## Alibaba：Accio / Accio Work / Sourcing Toolkit

- **当前形态**：从采购搜索扩展到带连接器、浏览器操作、定时任务及独立 Agent 记忆的工作台。官网描述 Shopify 建店、供应商邮件、库存检查、市场研究等工作流。[功能页](https://www.accio.com/work/feature)。
- **具体数据与供应链能力**：Sourcing Toolkit 帮助文档明确列出 Jungle Scout 与 Alibaba.com 数据、官方 Alibaba.com connector；可做供应商匹配/比较、批量联系、议价与下单。文档要求 Accio Work 0.22.0 或以上及连接 Alibaba.com 账户。[Sourcing Toolkit 文档](https://www.accio.com/work/doc?slug=help-accio-sourcing-toolkit)。
- **典型流程**：需求、图片/视频链接或定时信号 → 市场机会分析 → 货源匹配 → 供应商资质、报价、MOQ、交期比较 → 联系/议价 → 关键决策由用户把关。此流程基于上述官方文档，未实测。
- **店铺接入**：中文操作文档描述通过 Shopify agent 配置自定义应用、连接第三方服务后操作应用。[常用操作](https://zh.accio.com/wow/doc-help-common-ops.html)。
- **记忆边界**：独立 Agent 记忆与偏好学习有文档，不代表已披露以销售结果训练选品策略。[创建 Agent](https://zh.accio.com/wow/doc-help-create-agent.html)。
- **判断**：供应链执行链证据强于“研究后只交报告”的工具；具备连接经营数据的条件。但尚未查到将某一选品建议、真实销售/退款/净利润、后续候选排序逐一关联的可验证机制。

## 数据来源与局限

| 数据层 | 一手证据 | 可以支持的判断 | 不能直接推出的结论 |
| --- | --- | --- | --- |
| Amazon 搜索漏斗 | [SP-API Analytics Reports](https://developer-docs.amazon/sp-api/docs/report-type-values-analytics) | SQP 有曝光、点击、加购、购买；受 Brand Analytics 角色、品牌备案及站点/周期限制 | 获得全站任意竞争者的精确订单和利润 |
| 评论/退货主题 | [Customer Feedback API](https://developer-docs.amazon/sp-api/docs/customer-feedback-api) | 评论洞察可到 ASIN/类目；退货洞察只到类目；每周刷新 | 任意竞品 ASIN 的真实退货率 |
| Amazon 历史行情 | [Keepa API](https://keepa.com/api-docs/) | 商品、价格历史、报价、榜单、卖家信息，可经 API/MCP 调用 | 商家私有成本与真实净利润 |
| 搜索热度 | [Google Trends FAQ](https://support.google.com/trends/answer/4365533?hl=en) | 搜索样本、地区/时段归一化的 0–100 指数 | 绝对搜索量、订单量 |
| 内容广告 | [TikTok Creative Center](https://ads.tiktok.com/help/article/creative-center?redirected=2)、[Top Ads 说明](https://ads.tiktok.com/resources/help/article/how-to-use-the-top-ads-dashboard?lang=lv-LV) | 精选广告、互动、CTR/CVR 等创意信号和相对表现 | 全市场的完整经营表现，或爆款视频必然带来商品盈利 |
| 自有 Shopify 商店 | [API access scopes](https://shopify.dev/docs/api/usage/access-scopes) | 按授权范围访问商品、订单等经营数据 | 连接一个账号即拥有所有商家的数据 |
| 自有 TikTok Shop 商店 | [Seller authorization guide](https://partner.tiktokshop.com/docv2/page/seller-authorization-guide) | 商家授权第三方应用读取其允许范围内的业务数据 | 第三方分析网站展示的竞品 GMV 必然来自官方订单 API |

闭环不以重新训练基础大模型为必要条件；更新规则、商品评分、店铺记忆或下一轮动作也可以形成闭环。关键是能否证实经营结果返回并改变决策，而不只是“数据库每天更新”或“拥有长期记忆”。
