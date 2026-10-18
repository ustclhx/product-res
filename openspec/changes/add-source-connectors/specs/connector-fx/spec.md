# Spec Delta

## Purpose

定义汇率数据的获取与人工覆盖。

## ADDED Requirements

### Requirement: 每日汇率
系统 SHALL 每日从公开来源获取 USD、EUR、GBP、JPY 对 CNY 的汇率并按日期保存。获取失败时 SHALL 沿用最近一个可用日期的汇率，并 MUST 标明所用日期。

#### Scenario: 获取失败
- **WHEN** 当日汇率获取失败
- **THEN** 核算使用前一日汇率，并显示“汇率日期：前一日日期”

### Requirement: 人工覆盖
团队 SHALL 能手填某日某币种的汇率，手填值优先于公开来源，获取方式为手工导入。

#### Scenario: 手填覆盖
- **WHEN** 团队手填当日 USD/CNY 汇率
- **THEN** 当日核算使用手填值，公开来源的值仍保留可查
