# fx-rates Specification

## Purpose
TBD - created by archiving change add-fx-rates. Update Purpose after archive.

## Requirements

### Requirement: 参考汇率获取与回退
系统 SHALL 能够以 USD 为基准获取各货币的参考汇率：优先使用未过期的缓存，缓存未命中时请求服务商并写入缓存；服务商不可用、超时或响应不合法时 MUST 回退到调用方提供的参考值，并标记来源为 `fallback`，且 MUST NOT 把回退结果写入缓存。

#### Scenario: 缓存未命中时拉取实时汇率
- **WHEN** 缓存为空且服务商返回合法响应
- **THEN** 返回来源为 `live` 的汇率表，并写入缓存

#### Scenario: 缓存命中时不请求服务商
- **WHEN** 缓存中存在来源为 `live` 的汇率表
- **THEN** 直接返回缓存结果，不发起网络请求

#### Scenario: 服务商失败时回退
- **WHEN** 服务商返回错误、超时或不合法的响应
- **THEN** 返回参考值，来源标记为 `fallback`，缓存保持为空

### Requirement: 响应校验
服务商响应 SHALL 满足：结果为成功、基准为 USD、每个汇率为正的有限数、货币代码为三位大写字母。任一不满足时整体视为失败。

#### Scenario: 货币代码不合法
- **WHEN** 响应中包含小写或非三位的货币代码
- **THEN** 视为失败并回退

### Requirement: 服务商署名
使用实时汇率的页面 SHALL 显示服务商要求的署名文字，并链接到服务商站点。模块 SHALL 导出该署名常量供页面使用。

#### Scenario: 署名常量
- **WHEN** 项目读取署名常量
- **THEN** 得到服务商名称与站点地址
