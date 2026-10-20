## ADDED Requirements

### Requirement: 观测可信度分级
每条观测 SHALL 记录可信度层级（T0 真值、T1 平台官方、T2 平台页面展示、T3 第三方估算、T4 系统推算），以及经由渠道。已有观测 MUST 按获取方式回填层级。

#### Scenario: 写入经 AIsa 采集的页面展示值
- **WHEN** 连接器经 AIsa 写入 Amazon 价格观测
- **THEN** 该观测层级为 T2，渠道为 aisa

### Requirement: 区间值
区间型信号 SHALL 以下界和上界保存，上界开放时为空；`value` 存区间的对数中点。页面 MUST 显示区间，不得只显示下界。缺失 MUST 保持为缺失，不补零。

#### Scenario: Amazon 销量徽标
- **WHEN** 采集到 "100+ bought in past month"
- **THEN** 观测的下界为 100、上界为 200，页面显示 "100–200"

### Requirement: 主值按层级选取
读取主值时，系统 SHALL 先选层级最高的来源（T0 优先于 T1，依次类推）；同层级按来源优先级排序。失去主值资格的来源 MUST 被跳过。读取结果 SHALL 同时返回全部来源的值、区间与层级。

#### Scenario: 官方值与页面展示值并存
- **WHEN** 同一商品同一天同时有 T1 和 T2 的价格
- **THEN** 主值取 T1，T2 并列返回

### Requirement: 人工抽检与准确率
系统 SHALL 每周从被追踪商品中随机抽取 20 个，生成核对清单。人工填写实际值后，系统 SHALL 计算各来源各字段的一致率，并在数据中心显示近 4 次的准确率。某来源某字段在样本 ≥ 20 时一致率低于 95%，该来源对该字段 MUST 失去主值资格，直到之后的抽检一致率回到 95% 以上。

#### Scenario: 一致率不达标
- **WHEN** SerpApi 的 bought 字段近 4 次抽检共 20 个样本，一致率为 90%
- **THEN** SerpApi 的 bought 值不再作为主值，数据中心标红
