## Purpose

将授权的 Amazon 美国站与美国 Google Shopping 查询结果转为可追溯的候选和证据，使业务人员能理解数据覆盖、观察时间、缺失项与来源限制，而不把公开搜索线索误认为真实成交。

## ADDED Requirements

### Requirement: Two configured US market sources
系统 SHALL 支持 DataForSEO Amazon US 和 SerpApi Google Shopping US 的有界手动查询，保存市场、查询、地点、来源及时间；搜索结果、失败、无覆盖和限流 SHALL 分开呈现，不宣称覆盖全市场或真实销量。

#### Scenario: Successful Shopping query
- **WHEN** 已授权用户在独立站项目选择美国市场并发起查询
- **THEN** 系统展示供应商实际返回的有限商品、商家和价格线索，缺失字段显示未知，未选择商品不自动纳入

#### Scenario: Upstream returns no matches
- **WHEN** 查询成功但上游返回空结果
- **THEN** 系统记录真实空结果并允许改方向或手工导入，不用样例填充

### Requirement: Immutable discovery batches and selection
每次查询 SHALL 生成绑定工作区、项目和来源的不可变结果批次；纳入商品必须依据该批次条目校验身份、渠道、市场和来源。相似标题不自动合并，跨来源标识不得混用。

#### Scenario: Tampered selection
- **WHEN** 浏览器提交另一项目的条目 ID 或篡改来源字段
- **THEN** 系统拒绝纳入，不创建候选或证据

#### Scenario: Repeat selection from same batch
- **WHEN** 同一批次条目被重复提交
- **THEN** 系统复用已有候选和来源，不增加重复证据权重

### Requirement: Source semantics and evidence normalization
数据 SHALL 保存身份命名空间、站点、原值、币种/单位、观测/采集时间、来源批次、映射版本和质量状态。标价、运费、税、销量标签和估算不得自动互换；外部获取成功不等于已人工核验。原始材料留存必须符合已确认授权范围，过期清理状态可见。

#### Scenario: Advertised price with unknown delivery charge
- **WHEN** 上游只返回标价而未提供运费
- **THEN** 系统保存标价且运费保持未知，不自动计算到手价或完整贡献利润

#### Scenario: Supplier cost is missing
- **WHEN** 市场 API 返回零售价但没有采购报价和 MOQ
- **THEN** 系统保留市场观察并生成补证需要，不从零售价推算已核验采购成本

### Requirement: Measured and bounded acquisition
系统 SHALL 记录每次采集状态、请求定位、耗时、已知费用/配额及重试；按需执行并限制结果范围，不默认开启后台全量抓取。费用未知必须显示未知。

#### Scenario: Rate limit or quota exhaustion
- **WHEN** 上游限流或额度不足
- **THEN** 系统停止本次无限重试，保留错误及可操作恢复说明，不自动充值
