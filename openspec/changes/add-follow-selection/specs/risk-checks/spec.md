# Spec Delta

## Purpose

在推荐前提示品牌、侵权、类目准入与物流禁运风险。

## ADDED Requirements

### Requirement: 风险规则库
团队 SHALL 能维护品牌库（品牌、VeRO 权利人、Amazon 品牌备案）与风险规则（受限类目、认证要求、危险品、禁运属性），每条有等级和说明。

#### Scenario: 新增品牌后生效
- **WHEN** 团队把 “Acme” 加入品牌库
- **THEN** 次日流水线中标题或品牌属性命中 “Acme” 的簇出现品牌风险

### Requirement: 风险发现
系统 SHALL 对每个商品簇检查品牌/商标、跟卖品牌备案 ASIN、外观专利迹象（同簇只有一个主卖家且卖家有品牌店）、类目准入/认证、物流禁运；每条发现附依据。品牌备案 ASIN 的直接跟卖与高风险品牌命中 MUST 一票否决。外观专利只提示人工检索并附 Google Patents 链接。

#### Scenario: 品牌备案 ASIN
- **WHEN** Amazon 商品属于品牌备案品牌
- **THEN** 风险等级高，合规维度为 0，线索被否决，提示“同款独立建 listing 更安全”

#### Scenario: 无品牌商品
- **WHEN** 商品品牌为 Unbranded/Generic 且未命中任何规则
- **THEN** 没有品牌风险发现
