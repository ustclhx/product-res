# Spec Delta

## Purpose

把不同店铺、不同平台上的同款商品归并为商品簇，信号按簇计算。

## ADDED Requirements

### Requirement: 自动归并
系统 SHALL 依次用平台 ID、GTIN/UPC/ePID、标题相似（同类目）归并商品，并为每个成员记录归并方式与置信度。跨平台的同款 SHALL 作为簇的属性展示，信号仍按平台分别计算。

#### Scenario: GTIN 相同归为一簇
- **WHEN** 两个店铺的商品 GTIN 相同
- **THEN** 它们进入同一商品簇，归并方式为 gtin，置信度 0.95

#### Scenario: 标题相似但类目不同不归并
- **WHEN** 两个商品标题相似度 0.7 但类目不同
- **THEN** 不归并

### Requirement: 手动拆分与合并
团队 SHALL 能把成员从簇中拆出或把两个簇合并。手动修正 MUST 被记录，且之后的自动归并 MUST NOT 覆盖已锁定的成员。

#### Scenario: 拆分后不被自动合回
- **WHEN** 团队把一个成员拆出并次日流水线再次运行
- **THEN** 该成员仍不在原簇中
