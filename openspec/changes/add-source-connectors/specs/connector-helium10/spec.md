# Spec Delta

## Purpose

定义 Helium 10 数据的接入方式：本期以导出文件导入为主，接口待确认。

## ADDED Requirements

### Requirement: 预置导入模板
系统 SHALL 为 Helium 10 的 Black Box、Xray、Cerebro、Magnet 导出文件预置导入模板，包括列映射、单位和必填上下文（站点、日期、查询条件）。模板 SHALL 以真实导出样例校准。

#### Scenario: 导入 Xray 导出
- **WHEN** 上传一份 Xray 导出文件并选择对应模板
- **THEN** 列自动映射，补填站点和日期后可入库，销量估算来源为 Helium 10、获取方式为手工导入

#### Scenario: 导出格式变化
- **WHEN** 导出文件多了一列模板中没有的列
- **THEN** 该列标为未映射并提示，不影响其他列导入

### Requirement: 接口状态说明
在确认 Helium 10 提供可用接口前，数据中心 SHALL 将其显示为“文件导入”类型数据源，MUST NOT 显示同步频率或自动同步状态。

#### Scenario: 数据源卡片
- **WHEN** 查看数据中心的 Helium 10 卡片
- **THEN** 显示最近导入时间和记录数，而非同步频率
