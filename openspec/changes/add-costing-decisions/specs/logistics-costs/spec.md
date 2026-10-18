# Spec Delta

## Purpose

配置物流方案与成本参数。

## ADDED Requirements

### Requirement: 物流方案
团队 SHALL 能维护物流方案：平台、类型（eBay 直发 / 海外仓、Amazon FBA 头程 / FBM 直发）、时效天数、计费公式（首重续重、体积重系数、按方）与禁运属性。与商品属性冲突的禁运方案 MUST 在矩阵中标为不可用。

#### Scenario: 体积重
- **WHEN** 方案体积重系数 6000，商品 30×20×10 cm、实重 0.8 kg
- **THEN** 计费重量取 1.0 kg

### Requirement: 成本参数与费用来源
成本参数 SHALL 按平台与类目配置佣金率、固定费、广告率、退货预留率与 Amazon 仓储、入库配置费；类目未配置时使用平台默认。FBA 配送费 SHALL 优先使用 SP-API 预估，取不到时使用费率表并标注来源。

#### Scenario: 类目回退
- **WHEN** 类目没有单独的佣金率
- **THEN** 使用该平台默认佣金率，核算明细标注“平台默认”
