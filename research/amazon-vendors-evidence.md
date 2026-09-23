# Amazon 第三方 AI 选品 / 电商 Agent 证据备忘录

**时间基准：2026-09-16；视角：中国跨境卖家。** 仅核验厂商官网、官方帮助中心、官方公告/产品页；没有登录或实测。文中“官方声明”是页面直接声称；“可验证能力”是文档给出的具体输入、输出或动作；“推断”是基于这些证据的分析。估算市场数据与已授权自有店铺实绩分开写。

## 快速结论

- **Helium 10 Helium Agent** 是本组中对“自有账户回流”描述最具体的产品：Diamond+ 授权后读取自有 Seller/Ads 数据，覆盖广告、P&L、市场研究，并有关键词包和 Listing Builder 的引导工作流；但官方明确“只读”，没有证据证明系统会把结果自动写回选品模型，形成下一轮候选排序闭环。
- **Jungle Scout AI / MCP** 面向 Cobalt/企业市场情报用户，能用自然语言查询估算市场数据，也可按订阅接入已连接的销售与广告数据；官方的“Assess → Diagnose → Act”框架和产品推荐输出说明决策支持，但没有证明 AI 自动执行选品、采购、投放或把执行结果自动反馈到下一轮选品。
- **SmartScout MCP** 是给外部 AI 的只读连接器：可查询产品、品牌、卖家、类目、关键词、广告侦察等 Amazon 市场估算，强调“20 个只读工具”。官方公告未显示回写、广告/退货/利润闭环。
- **Data Dive AI Product Brief** 是评论驱动的产品研究辅助：选择竞争 ASIN 后读取公开评论、listing 属性和定位，产出客户画像、正负反馈模式和产品方向。它能把研究结果用于 listing/PPC/产品设计，但没有自有店铺授权数据、执行回写或下一轮选品学习的证据。
- **SellerApp**：主代理补查确认有 ML/AI 驱动的 Opportunity Score（SellMetric）与商品研究流程，应归为算法评分型选品工具；独立自然语言 Agent 与销售结果反馈选品机制仍未证实。

## 1. Helium 10：Helium Agent（重点）

**当前可用性与用户。** 官方帮助页发布日期为 **2026-08-27**，写明 Helium Agent 面向 Amazon 业务，Premium agents（Ads、Commerce、Research、Billing）为 Diamond+；免费/低阶仅 Knowledge Agent。目标用户是已使用 Helium 10、愿意授权账户数据的卖家/团队，子用户权限取决于主账号计划。来源：[Helium Agent 帮助文档](https://kb.helium10.com/hc/en-us/articles/53970835595931-Helium-Agent)（官方原文短摘：“Helium Agent puts the power of conversational AI to work for your Amazon business”；定位 lines 14–27、59–87）。

**实际工作流与输入。**

1. 登录 Helium 10、打开聊天入口；首次使用点击授权，让 Agent 读取账户数据（帮助文档 lines 64–87）。
2. 用自然语言提问；系统在一个界面路由到 Knowledge、Ads、Commerce、Research、Billing 五类 specialist agent。Research Agent 声称覆盖关键词发现、竞品跟踪、listing benchmarking；Commerce Agent读取 P&L、产品排名、费用与利润率；Ads Agent分析 Amazon/Walmart 广告（lines 27–56）。
3. 研究技能：输入竞争 ASIN 或 seed keyword；Agent 自动发现竞争者并建 keyword bank；用户复核 negative keywords；输出按 campaign type 组织的 keyword pack 和 4 个 CSV（lines 131–144）。
4. 新产品 Listing Builder：上传最多 5 张产品图，AI 提取属性；选择关键词来源并给竞争 ASIN；生成 title/bullets/description；编辑迭代；官方称可直接发布到 Amazon 或导出（lines 146–159）。已有 listing 则拉取当前 live listing、审图并只重写选定字段；发布更新需 seller SKU（lines 161–167）。

**数据边界。** 一类是已授权自有数据：首次授权后“analysis from your own data”（lines 64–87），Ads/Commerce 可用账户广告、销售/P&L/费用等。另一类是外部/估算研究数据：Research Agent 的市场情报、关键词和竞品跟踪；文档没有把每个指标的估算方法写清楚。竞争 ASIN、seed keyword、上传图片属于用户显式输入。帮助文档另称默认使用 **14 天归因窗口**，与 Seller Central 的窗口/刷新时间可能不同（lines 186–187）。

**执行动作与回流判断。** 官方明确：Helium Agent “always read-only”，不会改变 settings、bids、budgets、暂停 campaigns 或修改 account data（lines 21–26、182–184）。Listing Builder Skill 页面虽声称可直接发布/更新 Amazon listing，但这是受控工作流的 listing 写入，不等于广告或选品模型自动执行。官方证明了“账户数据 → 分析/建议”和“用户确认后 listing 发布”；**未找到**“建议/结果自动写入候选产品评分、下一轮自动重排”的文档。广告、退货、利润：Ads 有广告表现分析；Commerce 有利润/P&L；本页没有退货数据流程，也没有证据说明这些结果会自动回流到下一轮选品。结论是“有自有店铺实绩读取，有建议和部分 listing 执行；闭环回流未证实”。

## 2. Jungle Scout：AI Solutions / Ask Cobalt / Jungle Scout MCP

**当前可用性与用户。** 官方 AI Solutions 页面和 MCP 产品页在 2026-09 可见；MCP 由 Cobalt Amazon intelligence 驱动，官方称新客户需 demo，既有客户联系 CSM/账号代表，功能依订阅与组织配置而异。[AI Solutions](https://www.junglescout.com/ai-use-cases/)（原文短摘：“Just ask. Jungle Scout AI helps you answer…grounded in real Amazon marketplace data”，lines 2–8）；[MCP campaign](https://www.junglescout.com/campaign/jungle-scout-mcp/)（lines 73–103）。目标用户主要是品牌、零售商、代理机构和 Cobalt 企业团队；Listing Builder 的 AI Assist 则面向 Suite/Professional 订阅卖家，生成 listing 内容。[Listing Builder](https://www.junglescout.com/features/listing-builder/)（lines 13–29）。

**实际工作流与输入。**

1. 用户以自然语言提出商业问题，无需 SQL、dashboard 配置或手工导出（MCP 页 lines 37–40）。
2. AI 从 Cobalt 拉取相关 Amazon intelligence：market share、category growth、competitors、pricing、keywords、products、attributes、sellers、brand performance；依订阅还可含 connected sales and advertising data（lines 42–49、79–89）。
3. 用户继续追问驱动因素（竞争移动、价格带、品类空白、搜索可见性、卖家活动、新品）；输出可为 category brief、QBR summary、scorecard、spreadsheet、alert、planning document 或 product recommendation（lines 47–54）。
4. 对新/成长卖家，Opportunity Finder 是非 AI 的基线选品工作流：按品类、月销量、价格、搜索量、趋势、Niche Score、竞争、季节性等过滤，再用 Extension/Product Tracker 验证（[官方帮助](https://support.junglescout.com/hc/en-us/articles/360037689513-Opportunity-Finder)，lines 26–54）。AI Assist 属于 listing 生成/评分：用 Keyword Bank 生成 title、description、features；AI-driven Listing Optimization Score 评价 title、description、features、keywords、images（[Listing Builder](https://www.junglescout.com/features/listing-builder/)，lines 17–29）。

**数据边界。** Jungle Scout 明确其核心为十年以上 Amazon marketplace intelligence、跟踪 600M+ 产品；MCP 既可访问市场估算（竞争者销售、类目增长、价格、关键词/Share of Voice），也可在有权限时访问已连接的自有销售与广告数据。官方帮助的区分是：竞品为 sales estimates，自有账户为 integrated accounts 的 sales/advertising data。[平台帮助](https://support.junglescout.com/hc/en-us/articles/37123724151319-Choosing-the-Right-Jungle-Scout-Platform-Catalyst-Cobalt-MCP)（官方原文短摘：“Competitor product data: Sales estimates for products you don't own”；“Your product data: Sales and advertising data from integrated accounts”）。因此不能把竞品估算与自有实绩混为一谈。

**执行动作与回流判断。** MCP 页称 AI 可以把发现转成 briefing、alert、planning doc、product recommendation；与 Cowork 等 agent 配对时可起草 brief、发 Slack、保存 Drive（lines 105–119），这些是外部工作流输出，并非 Amazon 账户动作。MCP 本身是数据连接/问答层；官方明确不替代 Cobalt（lines 91–103）。Listing Builder 可与 Seller Central 拉取/同步 listing（lines 41–43），但这是 listing 操作而不是选品/广告自动执行。官方 AI Solutions 用“Assess → Diagnose → Act”描述决策循环（[页面](https://www.junglescout.com/ai-use-cases/)，lines 45–66），且官方列出“Product Innovation”“Keyword Opportunity”“Ad Performance”等 use cases；**但未找到**自动将销售、广告、退货或利润结果写入下一轮 AI 选品候选排序的技术证据。退货回流亦未在这些页面出现。

## 3. SmartScout：SmartScout MCP（及 AI 可见性公告）

**当前可用性与用户。** 官方 2026-05-15 公告称 SmartScout 提供 MCP connector；要求 Business 或 Enterprise 订阅，连接 Claude Desktop/Claude.ai/Claude Code，公告另称现兼容 OpenAI、Microsoft、Cursor、Gemini。[官方公告](https://www.smartscout.com/blog/introducing-our-mcp-server-for-the-api)（lines 1–5、28–44）。目标用户是需要 Amazon 市场情报的品牌、代理和研究型卖家；不是面向普通账号自动运营的 agent。

**实际工作流与输入/数据。** 用户在 AI 客户端添加 `https://mcp.smartscout.com/`，完成 SmartScout 授权；随后用自然语言提问。官方称 MCP 暴露 **20 个只读工具**，覆盖产品、品牌、卖家、子类目、搜索词和 ad-spy 数据。示例包括：关键词分析（估算搜索量、CPC、竞品品牌数、赞助广告景观）、品牌报告（收入历史、子类目销售拆分、Top 10 产品、竞争集合）、竞争格局（月收入、品牌份额、Amazon vs 3P 收入占比、平均价格）、ASIN 有机排名、类目趋势/季节性（lines 16–27）。这些主要是外部市场估算/平台数据；公告没有声称读取用户 Seller Central 实际销售、广告、利润或退货数据。

**执行动作与回流判断。** 官方数据处理段落明确 MCP “read-only”，不能修改 SmartScout 账号、创建资源或写入数据（lines 45–47）。因此执行动作止于 AI 返回分析/用户自行采取行动；无 Amazon listing、广告、采购或库存写入证据。公告没有退货/利润数据源，也没有“执行结果进入下一次选品”的证据。SmartScout 另有 2026-04-22 公告列出 “AI Visibility Monitor / Amazon AI Scorecard”，但公告索引只有功能名称和日期，无法据此推断具体输入、动作或回流；应标为未核验，而非当作完整产品能力。[公告索引](https://www.smartscout.com/announcements)（lines 29–45）。

## 4. Data Dive：AI Product Brief

**当前可用性与用户。** Data Dive 官方页面标注文章日期 2026-04-10，定位 Amazon 卖家用 AI 将竞品评论研究压缩成 structured product brief。[官方产品说明](https://datadive.tools/ai-product-brief-amazon-research-tool/)（lines 17–41）。

**实际工作流与输入/数据。** 用户选择 top-performing competitor listings；系统读取其公开 Amazon customer feedback/reviews、listing attributes、positioning（lines 44–52）。AI 识别多 listing 的正负反馈模式、组织结构化输出，并连接反馈与竞品 positioning（lines 62–82）。官方进一步称会生成基于真实评论语言的 customer avatars（年龄范围、兴趣、需求、购买动机），并可用于 listing copy、PPC targeting、creative strategy、产品设计（lines 85–98）。这里的市场数据是公开评论/页面属性，属于外部研究信号；没有自有店铺授权或 Seller Central 实绩读取声明。

**执行动作与回流判断。** 官方表述是把 brief 用于“optimize your listings to sell more”以及 listing/PPC/product design；没有声明自动改 listing、创建广告、下单、改库存，也没有利润或退货接口。**未找到**产品发布后的销售、广告、退货、利润回写，以及这些结果影响下一轮候选产品/brief 的证据。因而可归类为“AI 辅助定性研究与建议”，不是已证明的闭环电商 agent。

## 5. SellerApp：ML/AI 商品机会评分，不能与 Agent 混为一谈

主代理补充核验：[Amazon Product Ideas](https://www.sellerapp.com/amazon-product-ideas.html) 和 [Opportunity Score 说明](https://www.sellerapp.com/blog/sellmetric-amazon-product-opportunity-score/) 明确介绍 ML/AI 驱动的 SellMetric，结合需求、竞争、收入潜力、评价等指标评估商品。工作流为发现商品→查看 Opportunity Score→下钻数据→持续追踪商品趋势；参见 [Product Intelligence 帮助](https://www.sellerapp.com/help/article/how-does-product-intelligence-data-help-optimize-product-listing/)。这修正了初次检索“只有博客摘要 AI 标签”的判断。可证实算法辅助选品，但这些文档尚不能证明存在可自主规划执行的选品 Agent，或用户自有利润/退货结果自动更新下一轮商品排序。

## 对中国跨境卖家的可比判断

| 玩家 | 主要 AI 形态 | 市场估算 vs 自有实绩 | 执行动作 | 销售/广告/退货/利润回流至下一轮选品 |
|---|---|---|---|---|
| Helium 10 | 账户内多 specialist agent；Research/Commerce/Ads + guided skills | 两者都有：授权自有账户；研究/竞品侧仍有外部市场数据 | 只读分析；Listing Builder 受控发布/更新 | 广告、P&L 可读；退货未证实；自动影响下一轮选品未证实 |
| Jungle Scout | Cobalt AI/MCP 问答；AI Assist listing | 竞品销售为估算；可选接入自有 sales/ads | brief、scorecard、alert、recommendation；listing 可同步 | 自有 sales/ads 依权限可读；退货和自动闭环未证实 |
| SmartScout | 外部 AI 的 MCP 只读工具 | 主要是 Amazon 市场估算 | 无写入；返回研究答案 | 未证实任何自有实绩或回流 |
| Data Dive | 评论聚合与产品 brief | 公开竞品评论/页面属性 | 研究输出供 listing/PPC/产品设计人工使用 | 未证实 |
| SellerApp | ML/AI 商品机会评分 | 市场/商品/评价等数据；逐字段来源需核验 | 评分、分析、跟踪 | 自有经营结果反馈选品未证实 |

### 未实测与风险

1. 所有结论来自公开官方页面；没有登录、订阅、真实 ASIN 测试、Seller Central 授权或 API 调用验证。
2. “能生成 product recommendation/brief”不等于能自动采购、建品、投放或写回账户；需按产品页面的明确动作边界解读。
3. 官方页面可能按套餐、地区、组织配置、日期滚动更新；Jungle Scout MCP 明确 availability/functionality varies，Helium 10 明确 Diamond+ 限制。
4. 未找到退货数据或闭环回流证据时，仅记录“未找到/未证实”，不推断功能不存在。
