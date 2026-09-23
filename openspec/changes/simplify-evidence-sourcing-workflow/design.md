## Context
参见 proposal.md。现有 FastAPI 通用 SQLite entity 存储与 execute 命令保证工作区隔离、事务、幂等和版本；前端 React 按阶段展示。已确认项目标准不应被准备表单隐式修改。

## Goals / Non-Goals
交付可用补证工作台和结构化采购资料；保留正式初筛、评估、决策边界。不发送询盘、不采购、不绕过平台登录，不宣称官方连接已授权。

## Decisions
1. 新增 `/candidates/{id}/sourcing` GET 返回 profile、records、requirements、tasks、connectors。POST `/sourcing-profile` 保存独立准备信息；POST `/sourcing-records` 追加结构化记录及对应证据。均受 candidate.expected_version、execute 和 contributor 权限校验，profile 限项目 analyst。读写均使用当前工作区 store。
2. Profile: product_type `OEM|LISTED|BENCHMARK`（默认 LISTED）；stage `RESEARCH|SAMPLE|LAUNCH`（默认 RESEARCH）；benchmark_candidate_id 可空且必须同项目非自身；target_market/brand/model/year/trim/seat_type 文本可空。profile 是 candidate.sourcing_profile，变更更新候选版本但不改历史标准/决策。车辆配置发生变化时，追加空值证据撤回原实车适配并要求重新初筛；核验通过的实车记录必须与当前目标配置相符。
3. Record 通用字段：kind `QUOTE|FITMENT|PRICE`，source_locator、observed_at、valid_until（可空）、verification `UNVERIFIED|VERIFIED`（默认未核验）、verification_note；supersedes_record_id 可空且必须同候选同 kind 最新记录。记录不可覆盖。接口拒绝空字符串/非有限金额/无单位正式报价，已核验必须说明依据。payload 类型如下：
   - QUOTE: supplier_name、supplier_channel `OFFLINE|1688|YIWUGO|ALIBABA|OTHER`、supplier_contact（可空）、product_url（可空）、supplier_sku（可空）、quote_basis `PUBLIC_REFERENCE|SUPPLIER_CONFIRMED`、amount（十进制正数字符串）、currency、price_unit `piece|set`、pieces_per_set（整数，set 必需）、moq（正整数）、moq_unit `piece|set`、lead_time_days（可空非负整数）、trade_terms/tax_shipping_note/notes（可空文本）。PUBLIC_REFERENCE 永远仅生成 procurement_reference_price/moq_reference 未核验证据；SUPPLIER_CONFIRMED 生成 procurement_cost/moq，按原核验状态保存；报价单位 per_item 或 per_set_Npcs，MOQ 单位 piece 或 set_Npcs，不得套装拆价推断。
   - FITMENT: brand/model/year/trim/seat_type、method `DESK_REVIEW|PHYSICAL_TEST`、result `PENDING|PASS|FAIL`、sample_ref（可空）、checks 文本（必填）、notes（可空）。桌面仅生成 fitment_desk_review；只有 PHYSICAL_TEST + PASS + VERIFIED 且 sample_ref 存在才生成有效 vehicle_fitment，其他实车结果保留未知/不通过，不得误判适配。
   - PRICE: price_basis `ACTUAL_OFFER|TARGET_ESTIMATE`、amount、currency、price_unit、pieces_per_set、notes。实际价映射 price/currency；目标价只映射 target_price，不填实际 price。
4. 结构化记录显式生成 evidence 引用 sourcing_record_id。修订记录只能替代该旧记录对应当前证据（验证没有分叉）；独立记录保持独立观察，不能悄悄覆盖。canonical 证据依然参与原有 screening。保存不自动完成任务或批准采购。研究阶段的参考价、参考 MOQ、目标价任务可由负责人引用当前无冲突、未过期材料完成收集，记录 RESEARCH_MATERIAL_ONLY，绝不提升材料核验状态。
5. Requirements 是即时派生，使用当前未被替代证据、期限、FACT/VERIFIED、冲突判断，不依赖旧 screening。每项 field/label/status `MISSING|UNVERIFIED|CONFLICT|EXPIRED|READY`、reason、form_kind `QUOTE|FITMENT|PRICE|GENERAL`、evidence_ids、tasks。OEM RESEARCH 要求供应参考价与 MOQ（可接受保留为未核验的参考资料，状态清晰）及适配桌面记录，目标价为估算准备；SAMPLE 要求正式采购价、MOQ、明确车辆配置，实车适配列为下一阶段；LAUNCH 另要求实车适配与实际售价。LISTED 使用现有标准必需字段。返回 stage_ready 仅代表材料齐全，formal_screening_status 单独展示。研究参考值可用于研究准备，但绝不改为 VERIFIED。
6. 前端第一屏按字段列出缺口、负责人与下一步。一次只打开一个专用表单。OEM 设置、已录材料、通用证据、AI、初筛详情、历史按需展开。待补证队列从所有活动补证任务展示责任信息，候选缺口仍可打开工作台，不把一条任务当全部。
7. 新增 `/sourcing/link-preview?url=` 只解析 allowlist 主机与商品 ID，无网络请求；1688 detail.1688.com/offer/{id}.html、义乌购 /product/detail/{id}.html 或 /products/{id}、Alibaba /product-detail/..._{id}.html。拒绝不安全/未知URL，不伪造标题价格MOQ。connectors 返回 AUTHORIZATION_REQUIRED，提供官方网址。网页参考值与线下厂商均可在 QUOTE 表单输入；参考价不等于已报价。

## Risks / Trade-offs
- 阶段准备与正式筛选并列可能误读 → 文案明确“材料准备，不代表批准采购”，展示现有标准仍缺字段，后续版本必须由决策人确认。
- 无供应商凭据无法自动下载商品详情 → 本轮仅自动识别来源/商品编号，字段人工填写；研究报告记录授权路径。
- 长表单负担 → 表单分采购核心与可选细节，仅当前选中项展开，移动端单列。

## Migration Plan
增量 entity 及 candidate payload，无破坏性数据迁移。旧候选默认 LISTED；不按标题推断 OEM。部署前备份现有数据库，保留 18000 token 配置。新版本 smoke 后仅将既有 OEM 候选显式配置为 RESEARCH 并关联原对标，不写虚构报价/适配/采购决策。回滚镜像保留新增记录，可导出读取。
